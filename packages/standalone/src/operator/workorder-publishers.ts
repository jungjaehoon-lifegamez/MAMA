/**
 * Stage-2 workorder publishers: key/payload contracts for the system run paths
 * (dashboard/wiki/promotion, plus the reconcile leg) enqueued into the ledger.
 *
 * The workorder pipeline is the ONLY run path since v0.28.0. The former
 * MAMA_STAGE2_WORKORDERS tri-state (off = legacy persona runs, shadow = board
 * dual-run against a capture store) and the legacy executeValidatedRun paths
 * it gated were removed after the 2026-07-22 production cutover to 'on'
 * (migration plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md).
 */

import type { WorkOrderKind } from './task-ledger.js';

export const STAGE2_FLAG_ENV = 'MAMA_STAGE2_WORKORDERS';

/**
 * Boot guard for the retired flag. Unset or 'on' is fine (the pipeline always
 * runs); 'off'/'shadow' request the removed legacy behavior and must fail the
 * boot loudly (no-fallback: silently running the pipeline against an explicit
 * legacy pin would mask the operator's intent).
 */
export function assertStage2FlagCompatible(env: NodeJS.ProcessEnv = process.env): void {
  const raw = (env[STAGE2_FLAG_ENV] ?? '').trim();
  if (raw === '' || raw === 'on') return;
  throw new Error(
    `${STAGE2_FLAG_ENV}='${raw}' is no longer supported: legacy persona runs and shadow ` +
      `capture were removed in v0.28.0 (workorders are the only run path). Unset the ` +
      `variable or set it to 'on'.`
  );
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
