import { createHash } from 'node:crypto';
import {
  ownerActionOriginMatch,
  verifyOwnerActionContext,
  type OwnerActionEffectStoragePort,
} from '@jungjaehoon/mama-core/operations/owner-action-effects';

import {
  applyOwnerActionEffectsMigration,
  OWNER_ACTION_EFFECTS_TABLE,
} from '../db/migrations/owner-action-effects.js';
import type { SQLiteDatabase } from '../sqlite.js';
import type { OwnerEventEffectBeginResult } from './owner-event-effects.js';

/**
 * Input-independent identity of one owner action (Task E).
 *
 * Every field is a TRUSTED host identity. `ownerScope` is the authenticated
 * owner namespace; `occurrenceKey` is derived from stable message / event /
 * workorder occurrence identity and is shared by every retry of that
 * occurrence. The origin names the current authorized attempt and is recorded
 * for audit only: it never widens or narrows which receipt an occurrence
 * resolves to. At least one of `modelRunId` (model-backed / legacy path) and
 * `operationId` (service/CLI operation path) MUST be present and nonempty.
 * `envelopeHash` names the signed authority. None of these may come from model
 * text.
 */
export interface OwnerActionContext {
  ownerScope: string;
  occurrenceKey: string;
  /** Model-run origin. Model-backed and legacy callers set this. */
  modelRunId?: string;
  /** Service/CLI operation origin. Set instead of (or beside) modelRunId. */
  operationId?: string;
  envelopeHash: string;
  workOrderAttemptId?: number;
}

/** Same state / intent / result shape as the legacy owner-event ledger. */
export type OwnerActionEffectBeginResult = OwnerEventEffectBeginResult;

export type OwnerActionEffectState = 'transmitting' | 'unknown' | 'confirmed';

/** Bounded metadata read for the retry handler. Intent bodies are deliberately absent. */
export interface OwnerActionPendingEffect {
  actionKey: string;
  effectKind: string;
  state: Exclude<OwnerActionEffectState, 'confirmed'>;
  /**
   * A row may carry BOTH origins: its execution operation (`originOperationId`)
   * and the causal model run (`originModelRunId`) that drove the attempt. A
   * legacy model-backed row carries only the model run; either may be null, but
   * never both (the at-least-one-origin CHECK).
   */
  originModelRunId: string | null;
  originOperationId: string | null;
}

export interface OwnerActionPendingPage {
  items: OwnerActionPendingEffect[];
  /** Stable position even when previously returned effects settle between pages. */
  nextCursor: { createdAt: number; actionKey: string } | null;
}

export const OWNER_ACTION_PENDING_DEFAULT_LIMIT = 20;
export const OWNER_ACTION_PENDING_MAX_LIMIT = 100;
const IDENTITY_MAX_LENGTH = 512;
const ERROR_MAX_LENGTH = 2_000;

interface StoredRow {
  effect_kind: string;
  status: OwnerActionEffectState;
  intent_json: string;
  result_json: string | null;
}

/**
 * Canonical JSON: object keys sorted recursively, arrays kept in order. Two
 * intents that differ only in key order are the same intent; anything that
 * cannot round-trip through JSON (functions, undefined, bigint) is refused so
 * a stored intent is exactly what was compared.
 */
export function canonicalizeOwnerActionValue(value: unknown, path = '$'): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`owner action intent ${path} must be a finite number`);
      }
      return value;
    case 'object':
      if (Array.isArray(value)) {
        return value.map((item, index) => canonicalizeOwnerActionValue(item, `${path}[${index}]`));
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`owner action intent ${path} must be a plain JSON object`);
      }
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [
            key,
            canonicalizeOwnerActionValue((value as Record<string, unknown>)[key], `${path}.${key}`),
          ])
      );
    default:
      throw new Error(`owner action intent ${path} is not JSON-representable (${typeof value})`);
  }
}

export function canonicalOwnerActionJson(value: Record<string, unknown>): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error('owner action intent must be a plain JSON object');
  }
  return JSON.stringify(canonicalizeOwnerActionValue(value));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`owner action ${field} must be a non-blank string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) {
    throw new Error(`owner action ${field} must be a non-blank string without surrounding space`);
  }
  if (trimmed.length > IDENTITY_MAX_LENGTH) {
    throw new Error(`owner action ${field} must be at most ${IDENTITY_MAX_LENGTH} characters`);
  }
  return trimmed;
}

interface VerifiedContext {
  ownerScope: string;
  occurrenceKey: string;
  modelRunId: string | null;
  operationId: string | null;
  envelopeHash: string;
  workOrderAttemptId: number | null;
}

function verifyContext(context: OwnerActionContext): VerifiedContext {
  return verifyOwnerActionContext(context);
}

/**
 * Origin guard for release. Execution origin takes PRECEDENCE over causal model
 * provenance; the two are never ORed. A single row may carry BOTH a service
 * operation (its execution origin) and a causal model run id, so an OR would let
 * one operation — or a model-only caller — release another operation's
 * reservation merely by sharing the causal model.
 *
 * If the caller carries an `operationId`, that is its execution origin: release
 * matches that operation alone (`origin_operation_id = ?`), regardless of any
 * causal model, and never matches a legacy row whose operation origin is NULL.
 * A model-only (legacy) caller may release only a legacy row that has NO
 * operation origin and whose model run matches (`origin_operation_id IS NULL AND
 * origin_model_run_id = ?`); a causal model id thus never authorizes release of
 * an operation-origin row. The bound value is always the caller's nonempty
 * execution origin, so the equality is never a NULL = ? comparison.
 */
function originMatch(verified: VerifiedContext): { clause: string; params: string[] } {
  return ownerActionOriginMatch(verified);
}

/**
 * Durable host ledger for owner actions keyed by (owner namespace, occurrence,
 * logical action) rather than by trigger path or model attempt.
 *
 * `begin` reserves `transmitting` BEFORE the effect runs. Any later caller for
 * the same (scope, occurrence, action) never receives `execute` again: it gets
 * `reconcile` (effect started, outcome not yet proven) or `confirmed` with the
 * original receipt. `markUnknown` records that the outcome could not be
 * proven; it is an observation, never permission to run the effect again.
 * `confirm` is final and refuses a conflicting receipt.
 *
 * The ledger does not decide whether a shell command or upload succeeded. It
 * gives the host durable started / unknown / confirmed state so automatic
 * replay can be blocked until the actual outcome has been inspected.
 */

/**
 * Rows a replay may never be blocked by. `native_run` is the admission marker of one model
 * run. A `native_tool` row whose tool is a delegation spawn (Claude `Agent`/`Task`, Codex
 * `spawn_agent`/`send_input`/`resume_agent`) is an admission too: the child's own effects
 * carry their own rows. Confirmed receipts are immutable, so rows already written under the
 * old classification (measured live 2026-09-10: `Agent` under `workorder:board:full:repair`
 * blocked board orders #4805-#4807) are excluded here rather than rewritten.
 */
const REPLAY_NEUTRAL_ROW_SQL = `(effect_kind = 'native_run'
  OR (effect_kind = 'native_tool'
      AND IFNULL(lower(json_extract(intent_json, '$.toolName')), '') IN
        ('agent', 'task', 'spawn_agent', 'collabagenttoolcall', 'send_input', 'resume_agent')))`;

export class OwnerActionEffectLedger implements OwnerActionEffectStoragePort {
  constructor(
    private readonly db: SQLiteDatabase,
    private readonly clock: () => number = () => Date.now()
  ) {
    applyOwnerActionEffectsMigration(this.db);
  }

  begin(
    context: OwnerActionContext,
    actionKey: string,
    effectKind: string,
    intent: Record<string, unknown> = {}
  ): OwnerActionEffectBeginResult {
    const verified = verifyContext(context);
    const key = requireIdentity(actionKey, 'actionKey');
    const kind = requireIdentity(effectKind, 'effectKind');
    const canonical = canonicalOwnerActionJson(intent);
    const digest = sha256(canonical);
    const run = this.db.transaction((): OwnerActionEffectBeginResult => {
      const now = this.clock();
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO ${OWNER_ACTION_EFFECTS_TABLE}
             (owner_scope, occurrence_key, action_key, effect_kind, status,
              intent_json, intent_sha256, origin_model_run_id, origin_operation_id,
              origin_envelope_hash, origin_workorder_attempt_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'transmitting', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          verified.ownerScope,
          verified.occurrenceKey,
          key,
          kind,
          canonical,
          digest,
          verified.modelRunId,
          verified.operationId,
          verified.envelopeHash,
          verified.workOrderAttemptId,
          now,
          now
        );
      if (inserted.changes === 1) {
        return { state: 'execute', intent: JSON.parse(canonical) as Record<string, unknown> };
      }
      const row = this.loadRow(verified, key);
      if (!row) {
        throw new Error('owner action effect reservation disappeared');
      }
      this.assertKind(row, key, kind);
      if (row.intent_json !== canonical) {
        throw new Error(
          `owner action ${key} intent mismatch: the reserved payload for this occurrence differs`
        );
      }
      return this.project(row);
    }, 'immediate');
    return run();
  }

  inspect(
    context: OwnerActionContext,
    actionKey: string,
    effectKind: string
  ): OwnerActionEffectBeginResult | null {
    const verified = verifyContext(context);
    const key = requireIdentity(actionKey, 'actionKey');
    const kind = requireIdentity(effectKind, 'effectKind');
    const row = this.loadRow(verified, key);
    if (!row) {
      return null;
    }
    this.assertKind(row, key, kind);
    return this.project(row);
  }

  /**
   * Final receipt for a reserved effect. Confirming twice with the SAME
   * canonical result is idempotent (a repeated successful reconcile returns
   * the same receipt); a different result is a receipt conflict and is refused.
   */
  confirm(
    context: OwnerActionContext,
    actionKey: string,
    effectKind: string,
    result: Record<string, unknown> | null
  ): void {
    const verified = verifyContext(context);
    const key = requireIdentity(actionKey, 'actionKey');
    const kind = requireIdentity(effectKind, 'effectKind');
    const canonicalResult = result === null ? null : canonicalOwnerActionJson(result);
    const run = this.db.transaction(() => {
      const row = this.loadRow(verified, key);
      if (!row) {
        throw new Error(`owner action ${key} confirmation was not reserved for this occurrence`);
      }
      this.assertKind(row, key, kind);
      if (row.status === 'confirmed') {
        if (row.result_json === canonicalResult) {
          return;
        }
        throw new Error(
          `owner action ${key} already holds a confirmed receipt; a different result cannot replace it`
        );
      }
      const updated = this.db
        .prepare(
          `UPDATE ${OWNER_ACTION_EFFECTS_TABLE}
              SET status = 'confirmed', result_json = ?, last_error = NULL,
                  settled_model_run_id = ?, updated_at = ?
            WHERE owner_scope = ? AND occurrence_key = ? AND action_key = ?
              AND effect_kind = ? AND status != 'confirmed'`
        )
        .run(
          canonicalResult,
          verified.modelRunId,
          this.clock(),
          verified.ownerScope,
          verified.occurrenceKey,
          key,
          kind
        );
      if (updated.changes !== 1) {
        throw new Error(`owner action ${key} confirmation was not reserved for this occurrence`);
      }
    }, 'immediate');
    run();
  }

  /**
   * The effect started but its outcome could not be proven. The row stays
   * reconcile-only; a confirmed receipt is never demoted.
   */
  markUnknown(
    context: OwnerActionContext,
    actionKey: string,
    effectKind: string,
    error: string
  ): void {
    const verified = verifyContext(context);
    const key = requireIdentity(actionKey, 'actionKey');
    const kind = requireIdentity(effectKind, 'effectKind');
    const message = typeof error === 'string' ? error.slice(0, ERROR_MAX_LENGTH) : '';
    const run = this.db.transaction(() => {
      const row = this.loadRow(verified, key);
      if (!row) {
        throw new Error(`owner action ${key} was not reserved for this occurrence`);
      }
      this.assertKind(row, key, kind);
      if (row.status === 'confirmed') {
        throw new Error(
          `owner action ${key} already holds a confirmed receipt and cannot be marked unknown`
        );
      }
      this.db
        .prepare(
          `UPDATE ${OWNER_ACTION_EFFECTS_TABLE}
              SET status = 'unknown', last_error = ?, settled_model_run_id = ?, updated_at = ?
            WHERE owner_scope = ? AND occurrence_key = ? AND action_key = ?
              AND effect_kind = ? AND status != 'confirmed'`
        )
        .run(
          message,
          verified.modelRunId,
          this.clock(),
          verified.ownerScope,
          verified.occurrenceKey,
          key,
          kind
        );
    }, 'immediate');
    run();
  }

  /**
   * Unsettled effects of one occurrence, oldest first, for the retry handler.
   * Returns action identity, kind, state and the originating run only - no
   * intent bodies. `nextCursor` is set when more rows exist.
   */
  releaseUnstarted(context: OwnerActionContext, actionKey: string, effectKind: string): void {
    const verified = verifyContext(context);
    const origin = originMatch(verified);
    const result = this.db
      .prepare(
        `DELETE FROM ${OWNER_ACTION_EFFECTS_TABLE}
      WHERE owner_scope = ? AND occurrence_key = ? AND action_key = ? AND effect_kind = ?
        AND status = 'transmitting' AND ${origin.clause}`
      )
      .run(
        verified.ownerScope,
        verified.occurrenceKey,
        requireIdentity(actionKey, 'actionKey'),
        requireIdentity(effectKind, 'effectKind'),
        ...origin.params
      );
    if (result.changes !== 1) {
      throw new Error('Only the current unstarted reservation can be released');
    }
  }

  atomic(
    context: OwnerActionContext,
    key: string,
    kind: string,
    intent: Record<string, unknown>,
    perform: () => Record<string, unknown>
  ): Record<string, unknown> {
    return this.db.transaction(() => {
      const reservation = this.begin(context, key, kind, intent);
      if (reservation.state === 'confirmed' && reservation.result) {
        return reservation.result;
      }
      if (reservation.state !== 'execute') {
        throw new Error('Owner action is awaiting reconciliation');
      }
      const result = perform();
      this.confirm(context, key, kind, result);
      return result;
    }, 'immediate')();
  }

  confirmedKindsForOccurrence(occurrenceKey: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT effect_kind FROM ${OWNER_ACTION_EFFECTS_TABLE}
      WHERE occurrence_key = ? AND status = 'confirmed' AND effect_kind NOT IN
      ('native_run', 'native_tool', 'telegram_send', 'slack_send', 'discord_send', 'webchat_send')`
        )
        .all(requireIdentity(occurrenceKey, 'occurrenceKey')) as Array<{ effect_kind: string }>
    ).map((row) => row.effect_kind);
  }

  /**
   * True when some effect of this occurrence started and has no proven outcome.
   * The `native_run` admission marker is excluded for the same reason it is
   * excluded from `hasUnsafeReplayEffects`: it names no external effect, and
   * every caller of this predicate (owner-event-loop quarantine,
   * workorder-consumer failure paths - wired in start.ts) turns it into the same
   * permanent replay block. An interrupted run leaving only `native_run|unknown`
   * therefore used to kill the occurrence forever with nothing unproven.
   */
  hasUnsettledEffects(occurrenceKey: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM ${OWNER_ACTION_EFFECTS_TABLE}
      WHERE occurrence_key = ? AND status != 'confirmed'
        AND NOT ${REPLAY_NEUTRAL_ROW_SQL} LIMIT 1`
        )
        .get(requireIdentity(occurrenceKey, 'occurrenceKey'))
    );
  }

  /**
   * True when replaying this occurrence could re-execute an effect whose outcome
   * is not already proven. Only CONFIRMED rows of the listed kinds are safe:
   * `native_run` is the admission marker for one model run and names no effect
   * of its own; `task_create` is executed through `atomic` keyed by the caller's
   * `creation_key`, so a replay short-circuits on the confirmed row and returns
   * the stored receipt instead of creating a second task. Every other kind stays
   * blocked - `native_tool` is only observed after the fact, and gateway `Bash`
   * (and the other workspace effects) dedup on the exact command, so a replayed
   * turn that emits a different command runs it for real. Any unsettled row of
   * any OTHER kind blocks regardless of kind; `native_run` never blocks at any
   * status, because an interrupted run records `native_run|unknown` while every
   * real effect it started carries its own row, so the marker alone proves
   * nothing is unproven.
   * Task deduplication is key-bound, not semantic: a different creation_key can
   * create another task. Multiple legitimate tasks per occurrence remain allowed.
   */
  hasUnsafeReplayEffects(occurrenceKey: string): boolean {
    const key = requireIdentity(occurrenceKey, 'occurrenceKey');
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM ${OWNER_ACTION_EFFECTS_TABLE}
       WHERE occurrence_key = ? AND NOT ${REPLAY_NEUTRAL_ROW_SQL}
         AND (effect_kind != 'task_create' OR status != 'confirmed') LIMIT 1`
        )
        .get(key)
    );
  }

  pending(
    context: OwnerActionContext,
    options: { limit?: number; cursor?: { createdAt: number; actionKey: string } } = {}
  ): OwnerActionPendingPage {
    const verified = verifyContext(context);
    const limit = clampPage(options.limit, OWNER_ACTION_PENDING_DEFAULT_LIMIT, 'limit');
    const cursor = options.cursor;
    if (
      cursor &&
      (!Number.isSafeInteger(cursor.createdAt) ||
        typeof cursor.actionKey !== 'string' ||
        !cursor.actionKey.trim())
    ) {
      throw new Error('owner action pending cursor requires a valid createdAt and actionKey');
    }
    const rows = this.db
      .prepare(
        `SELECT action_key, effect_kind, status, origin_model_run_id, origin_operation_id, created_at
           FROM ${OWNER_ACTION_EFFECTS_TABLE}
          WHERE owner_scope = ? AND occurrence_key = ? AND status != 'confirmed'
            ${cursor ? 'AND (created_at > ? OR (created_at = ? AND action_key > ?))' : ''}
          ORDER BY created_at ASC, action_key ASC
          LIMIT ?`
      )
      .all(
        verified.ownerScope,
        verified.occurrenceKey,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.actionKey] : []),
        limit + 1
      ) as Array<{
      action_key: string;
      effect_kind: string;
      status: 'transmitting' | 'unknown';
      origin_model_run_id: string | null;
      origin_operation_id: string | null;
      created_at: number;
    }>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => ({
        actionKey: row.action_key,
        effectKind: row.effect_kind,
        state: row.status,
        originModelRunId: row.origin_model_run_id,
        originOperationId: row.origin_operation_id,
      })),
      nextCursor: hasMore
        ? {
            createdAt: page[page.length - 1].created_at,
            actionKey: page[page.length - 1].action_key,
          }
        : null,
    };
  }

  private loadRow(verified: VerifiedContext, actionKey: string): StoredRow | undefined {
    const origin =
      verified.operationId !== null
        ? { clause: 'origin_operation_id = ?', params: [verified.operationId] }
        : { clause: 'origin_operation_id IS NULL', params: [] };
    return this.db
      .prepare(
        `SELECT effect_kind, status, intent_json, result_json
           FROM ${OWNER_ACTION_EFFECTS_TABLE}
          WHERE owner_scope = ? AND occurrence_key = ? AND action_key = ?
            AND ${origin.clause}`
      )
      .get(verified.ownerScope, verified.occurrenceKey, actionKey, ...origin.params) as
      | StoredRow
      | undefined;
  }

  private assertKind(row: StoredRow, actionKey: string, effectKind: string): void {
    if (row.effect_kind !== effectKind) {
      throw new Error(`owner action ${actionKey} is already bound to ${row.effect_kind}`);
    }
  }

  private project(row: StoredRow): OwnerActionEffectBeginResult {
    const intent = JSON.parse(row.intent_json) as Record<string, unknown>;
    if (row.status !== 'confirmed') {
      return { state: 'reconcile', intent };
    }
    return {
      state: 'confirmed',
      intent,
      result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
    };
  }
}

function clampPage(
  value: number | undefined,
  fallback: number,
  field: 'limit' | 'offset',
  allowZero = false
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(
      `owner action pending ${field} must be a ${allowZero ? 'non-negative' : 'positive'} integer`
    );
  }
  return field === 'limit' ? Math.min(value, OWNER_ACTION_PENDING_MAX_LIMIT) : value;
}
