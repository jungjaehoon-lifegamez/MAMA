import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeOperationalIssue,
  ensureOperationalIssuesTable,
  getOperationalIssue,
  listOpenOperationalIssues,
  recordOperationalIssue,
  redactIssueError,
} from '../../src/observability/operational-issues.js';

let db: Database.Database;
const adapter = () => ({ prepare: (sql: string) => db.prepare(sql) });

beforeEach(() => {
  db = new Database(':memory:');
  ensureOperationalIssuesTable(adapter());
});
afterEach(() => db.close());

describe('Story ONE-MAMA-P3 Task 2: operational issues', () => {
  it('AC #1 same surface+signature aggregates into one row; first_seen stays, last_seen advances', () => {
    const a = recordOperationalIssue(adapter(), {
      surface: 'gateway',
      signature: 'context_compile:worker_envelope_scope_denied',
      severity: 'warn',
      error: 'scope outside envelope',
      nowMs: 1_000,
    });
    const b = recordOperationalIssue(adapter(), {
      surface: 'gateway',
      signature: 'context_compile:worker_envelope_scope_denied',
      severity: 'error',
      error: 'scope outside envelope again',
      nowMs: 2_000,
    });
    expect(b.issueId).toBe(a.issueId);
    expect(b.occurrences).toBe(2);
    const rows = listOpenOperationalIssues(adapter());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occurrences: 2,
      firstSeenAt: 1_000,
      lastSeenAt: 2_000,
      severity: 'error',
    });
    expect(rows[0].signature).toBe('context_compile:worker_envelope_scope_denied');
  });

  it('AC #2 different signatures produce different rows', () => {
    recordOperationalIssue(adapter(), {
      surface: 'gateway',
      signature: 'a',
      severity: 'info',
      error: 'x',
    });
    recordOperationalIssue(adapter(), {
      surface: 'gateway',
      signature: 'b',
      severity: 'info',
      error: 'x',
    });
    recordOperationalIssue(adapter(), {
      surface: 'inbox',
      signature: 'a',
      severity: 'info',
      error: 'x',
    });
    expect(listOpenOperationalIssues(adapter())).toHaveLength(3);
  });

  it('AC #3 a token-shaped error stores [redacted: ...] and zero original characters', () => {
    // assembled at runtime so the source never contains a token-shaped literal
    const secret = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab'].join('_');
    const raw = `request failed with token ${secret} at step 3`;
    const stored = redactIssueError(raw);
    expect(stored.startsWith('[redacted:')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('request failed');
    recordOperationalIssue(adapter(), {
      surface: 'delivery',
      signature: 'telegram',
      severity: 'error',
      error: raw,
    });
    const all = db.prepare('SELECT last_error FROM awareness_operational_issues').all() as Array<{
      last_error: string;
    }>;
    expect(all[0].last_error).not.toContain(secret);
  });

  it('AC #4 a clean error longer than 2000 chars is truncated to exactly 2000', () => {
    const stored = redactIssueError('e'.repeat(5_000));
    expect(stored).toHaveLength(2_000);
  });

  it('AC #5 sourceRef is stored digested, never in clear', () => {
    recordOperationalIssue(adapter(), {
      surface: 'inbox',
      signature: 'dead_batch',
      severity: 'error',
      error: 'dead',
      sourceRef: 'chatwork:room-private-id',
    });
    const row = db.prepare('SELECT source_delta_id FROM awareness_operational_issues').get() as {
      source_delta_id: string;
    };
    expect(row.source_delta_id).toMatch(/^sha256:[0-9a-f]{24}$/);
    expect(row.source_delta_id).not.toContain('room-private-id');
  });

  it('AC #6 list orders error > warn > info then most recent, caps, and excludes closed', () => {
    recordOperationalIssue(adapter(), {
      surface: 'gateway',
      signature: 'i1',
      severity: 'info',
      error: 'x',
      nowMs: 5,
    });
    recordOperationalIssue(adapter(), {
      surface: 'gateway',
      signature: 'w1',
      severity: 'warn',
      error: 'x',
      nowMs: 4,
    });
    recordOperationalIssue(adapter(), {
      surface: 'gateway',
      signature: 'e1',
      severity: 'error',
      error: 'x',
      nowMs: 1,
    });
    recordOperationalIssue(adapter(), {
      surface: 'gateway',
      signature: 'e2',
      severity: 'error',
      error: 'x',
      nowMs: 3,
    });
    const closed = recordOperationalIssue(adapter(), {
      surface: 'ledger',
      signature: 'c',
      severity: 'error',
      error: 'x',
      nowMs: 9,
    });
    closeOperationalIssue(adapter(), closed.issueId, 'signature quiet since release');
    expect(listOpenOperationalIssues(adapter()).map((r) => r.signature)).toEqual([
      'e2',
      'e1',
      'w1',
      'i1',
    ]);
    expect(listOpenOperationalIssues(adapter(), 2).map((r) => r.signature)).toEqual(['e2', 'e1']);
    // an old error is never hidden behind newer info rows, and minSeverity skips info
    for (let i = 0; i < 80; i += 1) {
      recordOperationalIssue(adapter(), {
        surface: 'gateway',
        signature: `noise-${i}`,
        severity: 'info',
        error: 'x',
        nowMs: 100 + i,
      });
    }
    expect(listOpenOperationalIssues(adapter(), 3).map((r) => r.signature)).toEqual([
      'e2',
      'e1',
      'w1',
    ]);
    expect(listOpenOperationalIssues(adapter(), 20, 'warn').map((r) => r.severity)).not.toContain(
      'info'
    );
    expect(getOperationalIssue(adapter(), 'iss_nope')).toBeNull();
  });

  it('AC #7 closing an unknown id throws; a recurrence reopens a closed issue', () => {
    expect(() => closeOperationalIssue(adapter(), 'iss_nope', 'x')).toThrow(/not found/);
    const r = recordOperationalIssue(adapter(), {
      surface: 'envelope',
      signature: 's',
      severity: 'warn',
      error: 'x',
      nowMs: 1,
    });
    closeOperationalIssue(adapter(), r.issueId, 'fixed');
    expect(listOpenOperationalIssues(adapter())).toHaveLength(0);
    recordOperationalIssue(adapter(), {
      surface: 'envelope',
      signature: 's',
      severity: 'warn',
      error: 'x',
      nowMs: 2,
    });
    expect(listOpenOperationalIssues(adapter())).toHaveLength(1);
  });

  it('AC #8 ensure is idempotent and adds occurrences to an installed table without it', () => {
    const old = new Database(':memory:');
    old.exec(`CREATE TABLE awareness_operational_issues (
      issue_id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, surface TEXT NOT NULL,
      severity TEXT NOT NULL, status TEXT NOT NULL, source_delta_id TEXT,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, next_retry_at INTEGER,
      last_error TEXT, owner_agent TEXT);
      INSERT INTO awareness_operational_issues (issue_id, dedupe_key, surface, severity, status, first_seen_at, last_seen_at)
        VALUES ('iss_old', 'k', 'gateway', 'warn', 'open', 1, 2);`);
    const a = { prepare: (sql: string) => old.prepare(sql) };
    ensureOperationalIssuesTable(a);
    ensureOperationalIssuesTable(a);
    const cols = (
      old.prepare('PRAGMA table_info(awareness_operational_issues)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain('occurrences');
    expect(listOpenOperationalIssues(a)).toHaveLength(1);
    old.close();
  });
});
