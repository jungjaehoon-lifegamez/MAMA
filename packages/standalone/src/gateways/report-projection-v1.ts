/**
 * TG-05/TG-06 Projection V1: fully deterministic, bounded rendering of
 * delivered-pending owner reports for the model prompt
 * (docs/development/telegram-outbound-context-inbox-design.md, Decision 5).
 *
 * Every limit counts Unicode code points with no Unicode or newline
 * normalization. Hashes are lowercase hexadecimal SHA-256 over exact UTF-8
 * bytes. Selection uses monotonic seq, never timestamps. Any change to the
 * rendered bytes (including wrapUntrustedContent's) requires a new projection
 * version.
 */

import { createHash } from 'node:crypto';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';

export interface ProjectionSourceEvent {
  seq: number;
  deliveryId: string;
  mode: 'digest' | 'full';
  deliveredAtIso: string;
  text: string;
}

export interface ProjectionV1Result {
  version: 'v1';
  /** The exact complete combined block; empty string for an empty selection. */
  text: string;
  /** Lowercase hex SHA-256 over the exact UTF-8 bytes of `text`. */
  projectionHash: string;
  /** Ordered delivery IDs actually rendered - the only IDs that may be consumed. */
  selectedDeliveryIds: string[];
  /** Pending events left unselected by the turn budget. */
  omittedCount: number;
}

const EVENT_CAP_CP = 8_000;
const COMBINED_CAP_CP = 24_000;
const MAX_EVENTS = 32;
const HEAD_CP = 3_000;
const TAIL_CP = 3_000;

const OPEN_TAG = '<recent_owner_reports projection="v1">';
const CLOSE_TAG = '</recent_owner_reports>';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * One-pass code point statistics: total count, the UTF-16 offset after the
 * first `headCp` code points, and the UTF-16 offset where the final `tailCp`
 * code points begin. Never materializes a per-code-point array copy.
 */
function codePointStats(
  text: string,
  headCp: number,
  tailCp: number
): { count: number; headEnd: number; tailStart: number } {
  const ring = new Array<number>(tailCp);
  let count = 0;
  let headEnd = text.length;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) as number;
    ring[count % tailCp] = index;
    count += 1;
    index += codePoint > 0xffff ? 2 : 1;
    if (count === headCp) {
      headEnd = index;
    }
  }
  const tailStart = count > tailCp ? ring[count % tailCp] : 0;
  return { count, headEnd, tailStart };
}

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

function renderWithBody(source: ProjectionSourceEvent, body: string): string {
  const deliveryHash = sha256Hex(source.deliveryId);
  const header = `[owner report seq=${source.seq} mode=${source.mode} delivered_at=${source.deliveredAtIso} delivery_sha256=${deliveryHash}]`;
  return `${header}\n${wrapUntrustedContent(`telegram-owner-report:${deliveryHash}`, body)}`;
}

/** Render one event within the 8,000-code-point event cap. */
export function renderOwnerReportEventV1(source: ProjectionSourceEvent): string {
  const exact = renderWithBody(source, source.text);
  if (countCodePoints(exact) <= EVENT_CAP_CP) {
    return exact;
  }
  const stats = codePointStats(source.text, HEAD_CP, TAIL_CP);
  const omitted = stats.count - HEAD_CP - TAIL_CP;
  const marker = `[... omitted ${omitted} Unicode code points; exact_text_sha256=${sha256Hex(source.text)} ...]`;
  const body = `${source.text.slice(0, stats.headEnd)}\n${marker}\n${source.text.slice(stats.tailStart)}`;
  return renderWithBody(source, body);
}

function gapMarker(omitted: number): string {
  return `[... ${omitted} pending owner reports omitted by turn budget ...]`;
}

function assemble(items: string[]): string {
  if (items.length === 0) {
    return '';
  }
  return `${OPEN_TAG}\n${items.join('\n\n')}\n${CLOSE_TAG}`;
}

/**
 * Deterministic selection (design Decision 5): when the whole backlog fits,
 * render everything oldest to newest. Otherwise reserve the oldest pending
 * complete rendered event as the anchor, fill the remaining budget with the
 * newest complete suffix that fits, and mark the chronological gap. The
 * 24,000-code-point cap includes outer tags, separators, and the gap marker;
 * the 32-event cap includes the anchor but not the gap marker.
 */
export function buildOwnerReportProjectionV1(events: ProjectionSourceEvent[]): ProjectionV1Result {
  if (events.length === 0) {
    return {
      version: 'v1',
      text: '',
      projectionHash: sha256Hex(''),
      selectedDeliveryIds: [],
      omittedCount: 0,
    };
  }

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const rendered = new Map<number, string>();
  const renderOf = (entry: ProjectionSourceEvent): string => {
    const cached = rendered.get(entry.seq);
    if (cached !== undefined) {
      return cached;
    }
    const value = renderOwnerReportEventV1(entry);
    rendered.set(entry.seq, value);
    return value;
  };

  const buildResult = (
    selected: ProjectionSourceEvent[],
    omitted: number,
    markerAfterAnchor: boolean
  ): ProjectionV1Result => {
    const items: string[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      items.push(renderOf(selected[index]));
      if (markerAfterAnchor && index === 0) {
        items.push(gapMarker(omitted));
      }
    }
    if (markerAfterAnchor && selected.length === 0) {
      items.push(gapMarker(omitted));
    }
    const text = assemble(items);
    return {
      version: 'v1',
      text,
      projectionHash: sha256Hex(text),
      selectedDeliveryIds: selected.map((entry) => entry.deliveryId),
      omittedCount: omitted,
    };
  };

  // Whole backlog first: no anchor split, no gap marker.
  if (ordered.length <= MAX_EVENTS) {
    const full = buildResult(ordered, 0, false);
    if (countCodePoints(full.text) <= COMBINED_CAP_CP) {
      return full;
    }
  }

  // Anchored selection: oldest complete event reserved, newest suffix fills
  // the remainder. Suffix length shrinks until the assembled block fits.
  const anchor = ordered[0];
  const candidates = ordered.slice(1);
  let suffixLength = Math.min(candidates.length, MAX_EVENTS - 1);
  while (suffixLength >= 0) {
    const suffix = candidates.slice(candidates.length - suffixLength);
    const omitted = candidates.length - suffixLength;
    const result = buildResult([anchor, ...suffix], omitted, omitted > 0);
    if (countCodePoints(result.text) <= COMBINED_CAP_CP) {
      return result;
    }
    suffixLength -= 1;
  }

  // The anchor alone always fits: one event is capped at 8,000 code points
  // plus bounded marker/tag overhead within the 24,000 budget.
  return buildResult([anchor], candidates.length, candidates.length > 0);
}
