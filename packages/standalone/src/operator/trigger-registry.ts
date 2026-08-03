/**
 * TriggerRegistry - operator-owned persistence for agent-authored triggers.
 *
 * The agent authors triggers (trigger-author.ts); this store only persists/lists them.
 * Ports Kagemusha `WorkflowContractRegistry`
 * (~/project/mama-suite/apps/kagemusha/src/agent/contracts/workflow-registry.ts) but with the
 * human-approval lifecycle removed: `create` yields `status:'active'` immediately (G4 unfrozen).
 * There is no `needs_review`/`approvedBy` - that gate does not exist here by construction.
 *
 * Personal triggers live in the operator DB under `~/.mama`; this source is generic.
 */

import type { SQLiteDatabase } from '../sqlite.js';
import type { CreateTriggerInput, TriggerRecord, TriggerStatus } from './trigger-types.js';

interface TriggerRow {
  id: string;
  kind: string;
  memory_query: string;
  match_json: string;
  procedure_json: string;
  required_evidence_json: string;
  status: string;
  authored_by: string;
  created_at: number;
  updated_at: number;
  provenance_json: string;
  disabled_reason: string | null;
  fired: number;
  succeeded: number;
  failed: number;
  reviewed_fired: number;
}

const REVIEW_RETRY_BASE_MS = 6 * 60 * 60 * 1000;
const REVIEW_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const AUTHOR_RETRY_BASE_MS = 6 * 60 * 60 * 1000;
const AUTHOR_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

export class TriggerRegistry {
  private db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) {
    this.db = db;
    this.runMigration();
  }

  private runMigration(): void {
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operator_triggers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        memory_query TEXT NOT NULL,
        match_json TEXT NOT NULL,
        procedure_json TEXT NOT NULL,
        required_evidence_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        authored_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        provenance_json TEXT NOT NULL,
        disabled_reason TEXT,
        fired INTEGER NOT NULL DEFAULT 0,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        reviewed_fired INTEGER NOT NULL DEFAULT 0,
        review_failures INTEGER NOT NULL DEFAULT 0,
        review_retry_after INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_operator_triggers_status ON operator_triggers(status);
      CREATE TABLE IF NOT EXISTS operator_trigger_author_state (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        window_fingerprint TEXT NOT NULL,
        failures INTEGER NOT NULL,
        retry_after INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.migrateReviewWatermark();
  }

  /**
   * Existing fired rows were already reviewed repeatedly by the legacy loop. Baseline them at
   * their current fire count so an upgrade cannot immediately fan out one review call per row.
   */
  private migrateReviewWatermark(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare(`PRAGMA table_info(operator_triggers)`).all() as Array<{
        name: string;
      }>;
      const names = new Set(columns.map((column) => column.name));
      if (!names.has('reviewed_fired')) {
        this.db.exec(
          `ALTER TABLE operator_triggers ADD COLUMN reviewed_fired INTEGER NOT NULL DEFAULT 0`
        );
        this.db.exec(`UPDATE operator_triggers SET reviewed_fired = fired`);
      }
      if (!names.has('review_failures')) {
        this.db.exec(
          `ALTER TABLE operator_triggers ADD COLUMN review_failures INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!names.has('review_retry_after')) {
        this.db.exec(`ALTER TABLE operator_triggers ADD COLUMN review_retry_after INTEGER`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Persist an agent-authored trigger. Self-activates (G4): status is 'active' at birth. */
  create(input: CreateTriggerInput): TriggerRecord {
    const now = Date.now();
    const record: TriggerRecord = {
      ...input,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      stats: { fired: 0, succeeded: 0, failed: 0 },
    };
    this.db
      .prepare(
        `INSERT INTO operator_triggers
           (id, kind, memory_query, match_json, procedure_json, required_evidence_json,
            status, authored_by, created_at, updated_at, provenance_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.kind,
        record.memoryQuery,
        JSON.stringify(record.match),
        JSON.stringify(record.procedure),
        JSON.stringify(record.requiredEvidence),
        record.status,
        record.authoredBy,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record.provenance)
      );
    return record;
  }

  listActive(): TriggerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM operator_triggers WHERE status = 'active' ORDER BY created_at DESC`)
      .all() as TriggerRow[];
    return rows.map(rowToRecord);
  }

  /** Active triggers with fire evidence that has not yet reached the review pass. */
  listReviewCandidates(limit = Number.MAX_SAFE_INTEGER, nowMs = Date.now()): TriggerRecord[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('listReviewCandidates: limit must be a positive integer');
    }
    if (!Number.isFinite(nowMs)) throw new Error('listReviewCandidates: nowMs must be finite');
    const rows = this.db
      .prepare(
        `SELECT * FROM operator_triggers
         WHERE status = 'active' AND fired > reviewed_fired
           AND (review_retry_after IS NULL OR review_retry_after <= ?)
         ORDER BY updated_at ASC, created_at ASC, id ASC
         LIMIT ?`
      )
      .all(nowMs, limit) as TriggerRow[];
    return rows.map(rowToRecord);
  }

  /** Advance the durable review watermark only after a review decision was applied. */
  markReviewed(id: string, fired: number): void {
    if (!Number.isInteger(fired) || fired < 0) {
      throw new Error(`markReviewed: fired must be a non-negative integer for ${id}`);
    }
    const result = this.db
      .prepare(
        `UPDATE operator_triggers
         SET reviewed_fired = MAX(reviewed_fired, ?), review_failures = 0,
             review_retry_after = NULL, updated_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(fired, Date.now(), id);
    if (result.changes === 0) throw new Error(`markReviewed: no active trigger with id ${id}`);
  }

  /** Back off a failed provider/parse attempt without blocking later review candidates. */
  recordReviewFailure(id: string, nowMs = Date.now()): void {
    if (!Number.isFinite(nowMs))
      throw new Error(`recordReviewFailure: nowMs must be finite for ${id}`);
    const row = this.db
      .prepare(`SELECT review_failures FROM operator_triggers WHERE id = ? AND status = 'active'`)
      .get(id) as { review_failures: number } | undefined;
    if (!row) throw new Error(`recordReviewFailure: no active trigger with id ${id}`);
    const failures = row.review_failures + 1;
    const retryDelay = Math.min(REVIEW_RETRY_BASE_MS * 2 ** (failures - 1), REVIEW_RETRY_MAX_MS);
    const retryAfter = nowMs + retryDelay;
    this.db
      .prepare(
        `UPDATE operator_triggers
         SET review_failures = ?, review_retry_after = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(failures, retryAfter, nowMs, id);
  }

  /** A provider outage or poison author window must not be resent on every cadence. */
  canAttemptAuthor(nowMs = Date.now()): boolean {
    if (!Number.isFinite(nowMs)) throw new Error('canAttemptAuthor: nowMs must be finite');
    const row = this.db
      .prepare(`SELECT retry_after FROM operator_trigger_author_state WHERE singleton_id = 1`)
      .get() as { retry_after: number } | undefined;
    return row === undefined || row.retry_after <= nowMs;
  }

  /** Persist a process-independent exponential backoff for the structured author call. */
  recordAuthorFailure(windowFingerprint: string, nowMs = Date.now()): void {
    if (windowFingerprint.trim() === '') {
      throw new Error('recordAuthorFailure: window fingerprint must be non-empty');
    }
    if (!Number.isFinite(nowMs)) throw new Error('recordAuthorFailure: nowMs must be finite');
    const row = this.db
      .prepare(`SELECT failures FROM operator_trigger_author_state WHERE singleton_id = 1`)
      .get() as { failures: number } | undefined;
    const failures = (row?.failures ?? 0) + 1;
    const retryDelay = Math.min(AUTHOR_RETRY_BASE_MS * 2 ** (failures - 1), AUTHOR_RETRY_MAX_MS);
    this.db
      .prepare(
        `INSERT INTO operator_trigger_author_state
           (singleton_id, window_fingerprint, failures, retry_after, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           window_fingerprint = excluded.window_fingerprint,
           failures = excluded.failures,
           retry_after = excluded.retry_after,
           updated_at = excluded.updated_at`
      )
      .run(windowFingerprint, failures, nowMs + retryDelay, nowMs);
  }

  /** A successful author decision clears the provider/parse failure streak. */
  clearAuthorFailure(): void {
    this.db.prepare(`DELETE FROM operator_trigger_author_state WHERE singleton_id = 1`).run();
  }

  /** Every trigger regardless of status (owner tray view). id DESC breaks same-ms ties. */
  listAll(): TriggerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM operator_triggers ORDER BY created_at DESC, id DESC`)
      .all() as TriggerRow[];
    return rows.map(rowToRecord);
  }

  getById(id: string): TriggerRecord | null {
    const row = this.db.prepare(`SELECT * FROM operator_triggers WHERE id = ?`).get(id) as
      | TriggerRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Record that a trigger FIRED (read-only surface loop) - bumps `fired` only.
   * Distinct from recordOutcome: a fire is not a success/failure judgment, and the
   * read-only loop must never fabricate one (M1-T2).
   */
  recordFire(id: string): void {
    const result = this.db
      .prepare(`UPDATE operator_triggers SET fired = fired + 1, updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
    if (result.changes === 0) throw new Error(`recordFire: no trigger with id ${id}`);
  }

  /** Record an intervention outcome - the G2 evolution feed (Task 4 reads stats). */
  recordOutcome(id: string, outcome: 'succeeded' | 'failed'): void {
    const column = outcome === 'succeeded' ? 'succeeded' : 'failed';
    const result = this.db
      .prepare(
        `UPDATE operator_triggers
         SET fired = fired + 1, ${column} = ${column} + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(Date.now(), id);
    if (result.changes === 0) throw new Error(`recordOutcome: no trigger with id ${id}`);
  }

  /** Retire a trigger (agent-judged in Task 4; here it's the mechanical write). */
  disable(id: string, reason: string): TriggerRecord {
    const result = this.db
      .prepare(
        `UPDATE operator_triggers SET status = 'disabled', disabled_reason = ?, updated_at = ? WHERE id = ?`
      )
      .run(reason, Date.now(), id);
    if (result.changes === 0) throw new Error(`disable: no trigger with id ${id}`);
    const record = this.getById(id);
    if (!record) throw new Error(`disable: trigger ${id} missing after update`);
    return record;
  }

  /** Agent retirement must never overwrite a durable owner disable that won the race (TG-06). */
  retireActive(id: string, reason: string): TriggerRecord {
    const result = this.db
      .prepare(
        `UPDATE operator_triggers
         SET status = 'disabled', disabled_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(reason, Date.now(), id);
    if (result.changes === 0) throw new Error(`retireActive: no active trigger with id ${id}`);
    const record = this.getById(id);
    if (!record) throw new Error(`retireActive: trigger ${id} missing after update`);
    return record;
  }

  /** Disable the original and insert its replacement as one rollback-safe decision. */
  refine(id: string, reason: string, replacement: CreateTriggerInput): TriggerRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          `UPDATE operator_triggers
           SET status = 'disabled', disabled_reason = ?, updated_at = ?
           WHERE id = ? AND status = 'active'`
        )
        .run(reason, Date.now(), id);
      if (result.changes === 0) throw new Error(`refine: no active trigger with id ${id}`);
      const created = this.create(replacement);
      this.db.exec('COMMIT');
      return created;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: TriggerRow): TriggerRecord {
  return {
    id: row.id,
    kind: row.kind,
    memoryQuery: row.memory_query,
    match: JSON.parse(row.match_json),
    procedure: JSON.parse(row.procedure_json),
    requiredEvidence: JSON.parse(row.required_evidence_json),
    status: row.status as TriggerStatus,
    authoredBy: row.authored_by as 'agent' | 'seed',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provenance: JSON.parse(row.provenance_json),
    stats: { fired: row.fired, succeeded: row.succeeded, failed: row.failed },
    disabledReason: row.disabled_reason ?? undefined,
  };
}
