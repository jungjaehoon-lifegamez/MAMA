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
}

export class TriggerRegistry {
  private db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) {
    this.db = db;
    this.runMigration();
  }

  private runMigration(): void {
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
        failed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_operator_triggers_status ON operator_triggers(status);
    `);
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

  getById(id: string): TriggerRecord | null {
    const row = this.db.prepare(`SELECT * FROM operator_triggers WHERE id = ?`).get(id) as
      | TriggerRow
      | undefined;
    return row ? rowToRecord(row) : null;
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
  };
}
