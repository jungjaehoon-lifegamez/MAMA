/**
 * TG-05/TG-06: owner-report inbox - the read surface a verified owner turn
 * uses to consume delivered-pending reports as bounded model context
 * (docs/development/telegram-outbound-context-inbox-design.md, Decision 5-6).
 *
 * Lookup must happen only after the Telegram owner-console trust check; the
 * caller (MessageRouter) gates on the resolved role, and the store scopes
 * every read to one exact target.
 */

import { createHash } from 'node:crypto';
import type {
  ReportContextTarget,
  TelegramReportContextStore,
} from './telegram-report-context-store.js';
import type { ConversationTurn } from './types.js';
import { buildOwnerReportProjectionV1 } from './report-projection-v1.js';

/** Design Decision 7 startup-history caps. */
const HISTORY_CAP_CP = 48_000;
const HISTORY_MAX_EVENTS = 64;
const HISTORY_MAX_RECEIPTS = 5;

const HISTORY_OPEN_TAG = '<recent_owner_report_history projection="v1">';
const HISTORY_CLOSE_TAG = '</recent_owner_report_history>';

function countCodePoints(text: string): number {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) as number;
    count += 1;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return count;
}

export interface OwnerReportSnapshot {
  version: 'v1';
  /** The exact complete Projection V1 block. */
  text: string;
  /** Lowercase hex SHA-256 over the exact UTF-8 bytes of `text`. */
  projectionHash: string;
  /** Ordered delivery IDs rendered in the block - the only consumable set. */
  deliveryIds: string[];
}

export interface OwnerReportInboxPort {
  snapshot(target: ReportContextTarget): OwnerReportSnapshot | null;
  /** Committed-projection history for an actual new backend conversation. */
  historyBlock(target: ReportContextTarget, turns: ConversationTurn[], nowIso?: string): string;
}

export class OwnerReportInbox implements OwnerReportInboxPort {
  constructor(private readonly store: TelegramReportContextStore) {}

  snapshot(target: ReportContextTarget): OwnerReportSnapshot | null {
    const pending = this.store.listDeliveredPending(target);
    if (pending.length === 0) {
      return null;
    }
    const projection = buildOwnerReportProjectionV1(pending);
    if (projection.text === '' || projection.selectedDeliveryIds.length === 0) {
      return null;
    }
    return {
      version: 'v1',
      text: projection.text,
      projectionHash: projection.projectionHash,
      deliveryIds: projection.selectedDeliveryIds,
    };
  }

  /**
   * Startup restoration for an actual new backend conversation (design
   * Decision 7): emit the already-committed Projection V1 text of the
   * restored final turns' receipts, grouped in messenger-turn order. Bounded
   * by 48,000 code points, 64 events, and five normal receipts; the newest
   * complete receipt suffix that fits is taken and a receipt projection is
   * never sliced. Returns '' when nothing restores.
   */
  historyBlock(target: ReportContextTarget, turns: ConversationTurn[], nowIso?: string): string {
    const now = nowIso ?? new Date().toISOString();
    const refs = turns
      .filter((turn) => turn.state !== 'provisional' && turn.sourceMessageRef)
      .map((turn) => turn.sourceMessageRef as string);
    const receipts = refs.length > 0 ? this.store.listReceiptsByRefs(refs) : [];
    const legacy = this.store.listLegacyRestorations(target, now);
    if (receipts.length === 0 && legacy.length === 0) {
      return '';
    }

    // Merge by (consumedAt ?? deliveredAt, deliveryId) for legacy records
    // against receipt commit times, legacy BEFORE a normal turn on an equal
    // timestamp (design Decision 7/8).
    type HistoryGroup = {
      kind: 'receipt' | 'legacy';
      time: string;
      tieBreak: string;
      eventCount: number;
      render: string;
    };
    const groups: HistoryGroup[] = [
      ...legacy.map((entry) => ({
        kind: 'legacy' as const,
        time: entry.consumedAtIso ?? entry.deliveredAtIso,
        tieBreak: entry.deliveryId,
        eventCount: 1,
        render: `[legacy_v2_consumed delivery_sha256=${sha256Hex(entry.deliveryId)} consumed_at=${entry.consumedAtIso}]\n${entry.restorationText}`,
      })),
      ...receipts.map((receipt) => ({
        kind: 'receipt' as const,
        time: receipt.committedAtIso,
        tieBreak: receipt.sourceMessageRef,
        eventCount: receipt.deliveryIds.length,
        render: `[before_turn source_message_ref_sha256=${sha256Hex(receipt.sourceMessageRef)}]\n${receipt.projectionText}`,
      })),
    ].sort((a, b) => {
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      if (a.kind !== b.kind) return a.kind === 'legacy' ? -1 : 1;
      return a.tieBreak < b.tieBreak ? -1 : 1;
    });

    // Newest complete suffix under the caps: 48k code points and 64 events in
    // aggregate, at most five NORMAL receipts. A group is never sliced.
    const selected: HistoryGroup[] = [];
    let eventCount = 0;
    let receiptCount = 0;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      if (group.kind === 'receipt' && receiptCount + 1 > HISTORY_MAX_RECEIPTS) {
        break;
      }
      if (eventCount + group.eventCount > HISTORY_MAX_EVENTS) {
        break;
      }
      const candidate = [group, ...selected];
      if (countCodePoints(renderHistoryBlock(candidate)) > HISTORY_CAP_CP) {
        break;
      }
      selected.unshift(group);
      eventCount += group.eventCount;
      if (group.kind === 'receipt') {
        receiptCount += 1;
      }
    }
    if (selected.length === 0) {
      return '';
    }
    return renderHistoryBlock(selected);
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function renderHistoryBlock(groups: Array<{ render: string }>): string {
  return `${HISTORY_OPEN_TAG}\n${groups.map((group) => group.render).join('\n\n')}\n${HISTORY_CLOSE_TAG}`;
}
