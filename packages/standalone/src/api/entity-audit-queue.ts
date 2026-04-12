import { randomUUID } from 'node:crypto';

export type EntityAuditRunStatus = 'running' | 'complete' | 'failed' | 'timeout';

export interface EntityAuditQueueAdapter {
  prepare(sql: string): {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
}

export interface EntityAuditRunSpec {
  reason?: string;
  baseline_run_id?: string | null;
}

export interface EntityAuditRunRow {
  id: string;
  status: EntityAuditRunStatus;
  baseline_run_id: string | null;
  classification: 'improved' | 'stable' | 'regressed' | 'inconclusive' | null;
  metric_summary_json: string | null;
  reason: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface EntityAuditQueueOptions {
  adapter: EntityAuditQueueAdapter;
  timeBudgetMs?: number;
  now?: () => number;
}

export const DEFAULT_AUDIT_TIME_BUDGET_MS = 5 * 60 * 1000;

export class AuditRunInProgressError extends Error {
  readonly code = 'entity.audit_run_in_progress';
  readonly doc_section = '#audit-run-in-progress';
  constructor() {
    super('Another entity audit run is already in progress.');
    this.name = 'AuditRunInProgressError';
  }

  toErrorEnvelope(): {
    error: { code: string; message: string; hint: string; doc_url: string };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: 'Wait for the current audit to finish, or inspect GET /api/entities/audit/runs.',
        doc_url: `docs/operations/entity-substrate-runbook.md${this.doc_section}`,
      },
    };
  }
}

function mapRow(row: Record<string, unknown>): EntityAuditRunRow {
  return {
    id: String(row.id),
    status: row.status as EntityAuditRunStatus,
    baseline_run_id: typeof row.baseline_run_id === 'string' ? row.baseline_run_id : null,
    classification:
      typeof row.classification === 'string'
        ? (row.classification as EntityAuditRunRow['classification'])
        : null,
    metric_summary_json:
      typeof row.metric_summary_json === 'string' ? row.metric_summary_json : null,
    reason: typeof row.reason === 'string' ? row.reason : null,
    created_at: Number(row.created_at),
    completed_at:
      typeof row.completed_at === 'number'
        ? row.completed_at
        : row.completed_at !== null && row.completed_at !== undefined
          ? Number(row.completed_at)
          : null,
  };
}

export class EntityAuditRunQueue {
  private readonly adapter: EntityAuditQueueAdapter;
  private readonly timeBudgetMs: number;
  private readonly now: () => number;

  constructor(opts: EntityAuditQueueOptions) {
    this.adapter = opts.adapter;
    this.timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_AUDIT_TIME_BUDGET_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Insert a fresh `running` audit run. A second concurrent insert fails loudly
   * via the migration 028 partial unique index and is surfaced as
   * AuditRunInProgressError by this method.
   */
  enqueue(spec: EntityAuditRunSpec = {}): { run_id: string; created_at: number } {
    const id = `audit_${randomUUID()}`;
    const createdAt = this.now();
    try {
      this.adapter
        .prepare(
          `INSERT INTO entity_audit_runs (id, status, baseline_run_id, reason, created_at)
           VALUES (?, 'running', ?, ?, ?)`
        )
        .run(id, spec.baseline_run_id ?? null, spec.reason ?? null, createdAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE') || message.includes('constraint')) {
        throw new AuditRunInProgressError();
      }
      throw error;
    }
    return { run_id: id, created_at: createdAt };
  }

  getStatus(runId: string): EntityAuditRunRow | null {
    const row = this.adapter.prepare(`SELECT * FROM entity_audit_runs WHERE id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  list(limit = 25): EntityAuditRunRow[] {
    const rows = this.adapter
      .prepare(`SELECT * FROM entity_audit_runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  complete(
    runId: string,
    result: {
      classification: 'improved' | 'stable' | 'regressed' | 'inconclusive';
      metric_summary: unknown;
    }
  ): void {
    this.adapter
      .prepare(
        `UPDATE entity_audit_runs
         SET status = 'complete', classification = ?, metric_summary_json = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(result.classification, JSON.stringify(result.metric_summary), this.now(), runId);
  }

  fail(runId: string, reason: string): void {
    this.adapter
      .prepare(
        `UPDATE entity_audit_runs
         SET status = 'failed', reason = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(reason, this.now(), runId);
  }

  markTimeout(runId: string, reason = 'time_budget_exceeded'): void {
    this.adapter
      .prepare(
        `UPDATE entity_audit_runs
         SET status = 'timeout', reason = ?, completed_at = ?
         WHERE id = ?`
      )
      .run(reason, this.now(), runId);
  }

  /**
   * Called on boot. Any runs in `running` status survived a crash/restart and
   * must be marked failed so the partial unique index does not remain held.
   */
  recoverOrphans(reason = 'standalone_restart'): number {
    const res = this.adapter
      .prepare(
        `UPDATE entity_audit_runs
         SET status = 'failed', reason = ?, completed_at = ?
         WHERE status = 'running'`
      )
      .run(reason, this.now());
    return Number(res.changes ?? 0);
  }

  getTimeBudgetMs(): number {
    return this.timeBudgetMs;
  }
}
