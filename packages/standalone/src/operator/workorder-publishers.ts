/**
 * Stage-2 publisher gate: pure decision + key/payload contracts for converting
 * the three system-agent run paths (dashboard/wiki/promotion) and the
 * reconcile leg into workorder enqueues.
 *
 * The gate decision is a PURE function (plan E5) so every flag x kind combo is
 * unit-testable outside the api-routes-init closures. The wiring sites call
 * resolvePublishAction and act on 'legacy' | 'enqueue' | 'both'.
 *
 * Flag: MAMA_STAGE2_WORKORDERS=off|shadow|on (tri-state; deliberate deviation
 * from the repo's `=== '1'` convention - documented in configuration-options).
 *   off    - legacy direct runs (current behavior)
 *   shadow - board ONLY dual-runs: legacy keeps publishing live AND the same
 *            occurrence is enqueued for the capture consumer. wiki/promotion
 *            stay pure legacy - their side effects (Obsidian writes, mama_save)
 *            have no capture seam and must never double-execute (plan B1/C2).
 *   on     - all three kinds (and the reconcile leg) enqueue; legacy stops.
 *
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md S2-T2
 */

import type { WorkOrderKind } from './task-ledger.js';

export const STAGE2_FLAG_ENV = 'MAMA_STAGE2_WORKORDERS';

export const STAGE2_FLAGS = ['off', 'shadow', 'on'] as const;
export type Stage2Flag = (typeof STAGE2_FLAGS)[number];

export type PublishAction = 'legacy' | 'enqueue' | 'both';

/**
 * Parse the tri-state flag. Absent/empty -> 'off'. Any other value is a
 * misconfiguration and throws at boot (no-fallback: a typo silently reverting
 * to legacy would mask a believed-active migration).
 */
export function readStage2Flag(env: NodeJS.ProcessEnv = process.env): Stage2Flag {
  const raw = (env[STAGE2_FLAG_ENV] ?? '').trim();
  if (raw === '') {
    return 'off';
  }
  if ((STAGE2_FLAGS as readonly string[]).includes(raw)) return raw as Stage2Flag;
  throw new Error(
    `${STAGE2_FLAG_ENV} must be one of ${STAGE2_FLAGS.join('|')} (or unset), got: '${raw}'`
  );
}

/** Pure gate decision for the three scheduled/boot/manual run paths. */
export function resolvePublishAction(flag: Stage2Flag, kind: WorkOrderKind): PublishAction {
  if (flag === 'off') return 'legacy';
  if (flag === 'on') return 'enqueue';
  // shadow: board dual-runs; wiki/promotion must not leak uncaptured writes.
  return kind === 'board' ? 'both' : 'legacy';
}

/**
 * The reconcile leg converts at 'on' ONLY (plan: shadow/off keep the legacy
 * bracket-verified path; its verification moves to the consumer hook at 'on').
 */
export function resolveReconcileAction(flag: Stage2Flag): 'legacy' | 'enqueue' {
  return flag === 'on' ? 'enqueue' : 'legacy';
}

// ── Occurrence keys (plan D5/M2) ──────────────────────────────────────────
// Keys identify one OCCURRENCE: same scheduled slot dedups against itself,
// the next slot (or any manual request) mints a fresh key. Terminal rows free
// their key (ledger index predicate), so retries insert fresh rows.

const BOARD_SLOT_MS = 30 * 60 * 1000;
const PROMOTION_SLOT_MS = 6 * 60 * 60 * 1000;

export function boardFullKey(now: number): string {
  return `board:full:${Math.floor(now / BOARD_SLOT_MS)}`;
}

/** Manual/forced orders get their own key (plan M2): a forced refresh must
 *  never dedup against a pending scheduled FULL that lacks force. */
export function boardManualKey(now: number): string {
  return `board:manual:${now}`;
}

export function boardReconcileKey(channelKey: string, now: number): string {
  // Timestamp, not slot (PR bot round): distinct reconciles for one channel
  // can fire within a 30-min window carrying DIFFERENT deltas - a slot key
  // would dedup the later one against the open earlier row and drop its
  // delta. The ReconcileScheduler's debounce is the coalescing layer; each
  // scheduler fire is its own occurrence.
  return `board:reconcile:${channelKey}:${now}`;
}

export function wikiBatchKey(trigger: string, now: number): string {
  return `wiki:${now}-${trigger}`;
}

export function promotionKey(now: number): string {
  return `promotion:${Math.floor(now / PROMOTION_SLOT_MS)}`;
}

export function promotionManualKey(now: number): string {
  return `promotion:manual:${now}`;
}

// ── Payload schemas (plan G6) ─────────────────────────────────────────────

export interface BoardPayload {
  mode: 'full' | 'reconcile';
  /** Owner-forced refresh: brief must publish even on NO_UPDATE. */
  force?: boolean;
  channelKey?: string;
  deltaLines?: string[];
}

export interface WikiPayload {
  batchId: string;
  /** Trigger provenance; the run does its own novelty check, events carry no content. */
  events: string[];
}

export interface PromotionPayload {
  scheduledAt: string;
}

export interface TemporalPayload {
  generationKey: string;
  taskId: number;
  temporalEpoch: number;
  occurrenceKey: string;
  checkAt: number;
  sourceChannel: string | null;
  sourceEventId: string | null;
}

const PAYLOAD_KEYS: Record<WorkOrderKind, readonly string[]> = {
  board: ['mode', 'force', 'channelKey', 'deltaLines'],
  wiki: ['batchId', 'events'],
  'memory-curation': ['scheduledAt'],
  temporal: [
    'generationKey',
    'taskId',
    'temporalEpoch',
    'occurrenceKey',
    'checkAt',
    'sourceChannel',
    'sourceEventId',
  ],
};

/**
 * Validate a payload at enqueue time. Unknown fields are rejected LOUDLY -
 * a misspelled field silently dropped would surface as a wrong run later.
 * `attempts` is ledger-managed and is never valid publisher input.
 */
export function validateWorkOrderPayload(
  kind: WorkOrderKind,
  payload: Record<string, unknown>
): void {
  if (Object.prototype.hasOwnProperty.call(payload, 'attempts')) {
    throw new Error(`workorder payload (${kind}): attempts is ledger-managed`);
  }
  const allowed = PAYLOAD_KEYS[kind];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new Error(`workorder payload (${kind}): unknown field '${key}'`);
    }
  }
  if (kind === 'board') {
    const mode = payload.mode;
    if (mode !== 'full' && mode !== 'reconcile') {
      throw new Error(
        `workorder payload (board): mode must be 'full'|'reconcile', got: ${String(mode)}`
      );
    }
    if (payload.force !== undefined && typeof payload.force !== 'boolean') {
      throw new Error(`workorder payload (board): force must be a boolean`);
    }
    if (mode === 'reconcile') {
      if (typeof payload.channelKey !== 'string' || payload.channelKey === '') {
        throw new Error(`workorder payload (board reconcile): channelKey required`);
      }
      if (!Array.isArray(payload.deltaLines) || payload.deltaLines.length === 0) {
        throw new Error(`workorder payload (board reconcile): non-empty deltaLines[] required`);
      }
    } else if (payload.channelKey !== undefined || payload.deltaLines !== undefined) {
      // Reconcile-only fields on a full run signal a caller bug - loud.
      throw new Error(`workorder payload (board full): channelKey/deltaLines are reconcile-only`);
    }
  } else if (kind === 'wiki') {
    if (typeof payload.batchId !== 'string' || payload.batchId === '') {
      throw new Error(`workorder payload (wiki): batchId required`);
    }
    if (
      !Array.isArray(payload.events) ||
      payload.events.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error(`workorder payload (wiki): events[] of strings required`);
    }
  } else if (kind === 'memory-curation') {
    if (typeof payload.scheduledAt !== 'string' || payload.scheduledAt === '') {
      throw new Error(`workorder payload (memory-curation): scheduledAt required`);
    }
  } else {
    const boundedString = (field: 'generationKey' | 'occurrenceKey', max: number): void => {
      const value = payload[field];
      if (typeof value !== 'string' || value.length < 1 || value.length > max) {
        throw new Error(`workorder payload (temporal): ${field} must contain 1-${max} characters`);
      }
    };
    boundedString('generationKey', 500);
    boundedString('occurrenceKey', 300);
    if (!Number.isSafeInteger(payload.taskId) || (payload.taskId as number) < 1) {
      throw new Error(`workorder payload (temporal): taskId must be a positive integer`);
    }
    if (!Number.isSafeInteger(payload.temporalEpoch) || (payload.temporalEpoch as number) < 0) {
      throw new Error(`workorder payload (temporal): temporalEpoch must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(payload.checkAt)) {
      throw new Error(`workorder payload (temporal): checkAt must be an epoch millisecond integer`);
    }
    for (const field of ['sourceChannel', 'sourceEventId'] as const) {
      const value = payload[field];
      if (value !== null && (typeof value !== 'string' || value.length < 1 || value.length > 300)) {
        throw new Error(`workorder payload (temporal): ${field} must be null or 1-300 characters`);
      }
    }
  }
}
