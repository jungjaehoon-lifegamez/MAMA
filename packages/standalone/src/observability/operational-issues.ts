/**
 * Operational issues: the system's own failures as first-class evidence.
 *
 * Every place a failure already passes through (gateway tool failure, envelope scope
 * mismatch, dead owner-event batch, ledger stagnation) records one row here, aggregated
 * by (surface, signature). Every packet carries the open rows, so the agent sees what is
 * broken before it judges anything; the daily self-check turn triages them.
 *
 * Stored error text passes the secret scan first and FAILS CLOSED: a non-clean scan stores
 * no original characters. This table is read into every prompt, which makes it a new place
 * for credentials to land.
 *
 * Table: awareness_operational_issues in the mama-core database (migration 066 creates it
 * on a fresh install; an installed table without `occurrences` gets the column here).
 */
import { createHash } from 'node:crypto';
import { scanForSecrets } from '../memory/secret-filter.js';

export type IssueSurface = 'gateway' | 'envelope' | 'inbox' | 'ledger' | 'budget' | 'delivery';
export type IssueSeverity = 'info' | 'warn' | 'error';
export type IssueStatus = 'open' | 'repair_requested' | 'closed';

export interface RecordIssueInput {
  surface: IssueSurface;
  /** Stable, low-cardinality. NEVER free error text: that is what makes dedupe work. */
  signature: string;
  severity: IssueSeverity;
  /** Raw text; redacted and bounded before storage. */
  error: string;
  /** Digested before storage. */
  sourceRef?: string;
  ownerAgent?: string;
  nowMs?: number;
}

export interface OperationalIssue {
  issueId: string;
  surface: IssueSurface;
  severity: IssueSeverity;
  status: IssueStatus;
  signature: string;
  lastError: string | null;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface IssueAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get?(...params: unknown[]): unknown;
  };
}

const SURFACES: ReadonlySet<string> = new Set([
  'gateway',
  'envelope',
  'inbox',
  'ledger',
  'budget',
  'delivery',
]);
const SEVERITIES: ReadonlySet<string> = new Set(['info', 'warn', 'error']);
const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 0, warn: 1, info: 2 };
export const MAX_ISSUE_ERROR_CHARS = 2_000;
const MAX_SIGNATURE_CHARS = 120;

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS awareness_operational_issues (
    issue_id TEXT PRIMARY KEY,
    dedupe_key TEXT UNIQUE NOT NULL,
    surface TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    source_delta_id TEXT,
    first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
    last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
    next_retry_at INTEGER,
    last_error TEXT,
    owner_agent TEXT,
    occurrences INTEGER NOT NULL DEFAULT 1
  )`;

/** Idempotent: creates the table on a bare DB, adds `occurrences` to an installed one. */
export function ensureOperationalIssuesTable(db: IssueAdapter): void {
  db.prepare(TABLE_DDL).run();
  const columns = db.prepare('PRAGMA table_info(awareness_operational_issues)').all() as Array<{
    name?: unknown;
  }>;
  if (!columns.some((column) => column.name === 'occurrences')) {
    db.prepare(
      'ALTER TABLE awareness_operational_issues ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1'
    ).run();
  }
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_awareness_operational_issues_status_seen
       ON awareness_operational_issues(status, last_seen_at DESC)`
  ).run();
}

/** Redaction gate, fail closed: a non-clean scan stores none of the original characters. */
export function redactIssueError(raw: string): string {
  const scan = scanForSecrets(raw);
  if (!scan.clean) {
    return `[redacted: ${scan.matches.join(',')}]`;
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ISSUE_ERROR_CHARS);
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

export function issueDedupeKey(surface: string, signature: string): string {
  return createHash('sha256').update(`${surface}\0${signature}`).digest('hex');
}

export function recordOperationalIssue(
  db: IssueAdapter,
  input: RecordIssueInput
): { issueId: string; occurrences: number } {
  if (!SURFACES.has(input.surface)) {
    throw new Error(`operational issue: unknown surface ${String(input.surface)}`);
  }
  if (!SEVERITIES.has(input.severity)) {
    throw new Error(`operational issue: unknown severity ${String(input.severity)}`);
  }
  const signature = input.signature.replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNATURE_CHARS);
  if (!signature) {
    throw new Error('operational issue: signature is required');
  }
  const now = input.nowMs ?? Date.now();
  const dedupeKey = issueDedupeKey(input.surface, signature);
  const lastError = redactIssueError(input.error);
  const sourceRef = input.sourceRef ? digest(input.sourceRef) : null;
  const existing = db
    .prepare(
      `SELECT issue_id, occurrences, status FROM awareness_operational_issues WHERE dedupe_key = ?`
    )
    .all(dedupeKey) as Array<{ issue_id: string; occurrences: number; status: string }>;
  if (existing.length > 0) {
    const row = existing[0];
    // A closed issue that recurs reopens: closure was a claim about the signature going quiet.
    db.prepare(
      `UPDATE awareness_operational_issues
          SET last_seen_at = MAX(last_seen_at, ?), occurrences = occurrences + 1,
              last_error = ?, severity = ?, source_delta_id = COALESCE(?, source_delta_id),
              owner_agent = COALESCE(?, owner_agent),
              status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
        WHERE dedupe_key = ?`
    ).run(
      now,
      `${signature} | ${lastError}`,
      input.severity,
      sourceRef,
      input.ownerAgent ?? null,
      dedupeKey
    );
    return { issueId: row.issue_id, occurrences: row.occurrences + 1 };
  }
  const issueId = `iss_${dedupeKey.slice(0, 16)}`;
  db.prepare(
    `INSERT INTO awareness_operational_issues
       (issue_id, dedupe_key, surface, severity, status, source_delta_id, first_seen_at,
        last_seen_at, next_retry_at, last_error, owner_agent, occurrences)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, NULL, ?, ?, 1)`
  ).run(
    issueId,
    dedupeKey,
    input.surface,
    input.severity,
    sourceRef,
    now,
    now,
    `${signature} | ${lastError}`,
    input.ownerAgent ?? null
  );
  return { issueId, occurrences: 1 };
}

function rowToIssue(row: Record<string, unknown>): OperationalIssue {
  const stored = typeof row.last_error === 'string' ? row.last_error : '';
  const separator = stored.indexOf(' | ');
  return {
    issueId: String(row.issue_id),
    surface: String(row.surface) as IssueSurface,
    severity: String(row.severity) as IssueSeverity,
    status: String(row.status) as IssueStatus,
    signature: separator > 0 ? stored.slice(0, separator) : stored,
    lastError: separator > 0 ? stored.slice(separator + 3) : stored || null,
    occurrences: Number(row.occurrences ?? 1),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

/**
 * Open issues: error before warn before info, then most recent, capped - ordered in SQL so an
 * old error is never hidden behind newer info rows. `minSeverity` lets packets and the
 * self-check turn skip designed refusals (info) while the table keeps counting them.
 */
export function listOpenOperationalIssues(
  db: IssueAdapter,
  limit = 20,
  minSeverity: IssueSeverity = 'info'
): OperationalIssue[] {
  const maxRank = SEVERITY_RANK[minSeverity] ?? 2;
  const rows = db
    .prepare(
      `SELECT * FROM awareness_operational_issues
        WHERE status <> 'closed'
          AND (CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END) <= ?
        ORDER BY (CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END) ASC,
                 last_seen_at DESC
        LIMIT ?`
    )
    .all(maxRank, Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>;
  return rows.map(rowToIssue);
}

/** One issue by id, or null; the repair path checks existence before writing a bundle. */
export function getOperationalIssue(db: IssueAdapter, issueId: string): OperationalIssue | null {
  const rows = db
    .prepare(`SELECT * FROM awareness_operational_issues WHERE issue_id = ?`)
    .all(issueId) as Array<Record<string, unknown>>;
  return rows.length > 0 ? rowToIssue(rows[0]) : null;
}

export function setOperationalIssueStatus(
  db: IssueAdapter,
  issueId: string,
  status: IssueStatus
): void {
  const result = db
    .prepare(`UPDATE awareness_operational_issues SET status = ? WHERE issue_id = ?`)
    .run(status, issueId) as { changes?: number };
  if (!result || result.changes !== 1) {
    throw new Error(`operational issue not found: ${issueId}`);
  }
}

/** Closing is a claim that the signature went quiet; an unknown id is an error, not a no-op. */
export function closeOperationalIssue(db: IssueAdapter, issueId: string, reason: string): void {
  if (!reason.trim()) {
    throw new Error('operational issue: a close reason is required');
  }
  setOperationalIssueStatus(db, issueId, 'closed');
}
