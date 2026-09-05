/**
 * Parent-fix P1 — TaskLedger.itemsPage/overview must read one SQLite snapshot per
 * call, so the returned generation/count/rows cannot straddle a write from another
 * connection. Real file-backed WAL, a second connection, and a deterministic
 * interleave: a TEMP view shadows operator_tasks and wraps `revision` in a UDF that
 * commits the other connection's insert DURING the first generation read. No mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';

const NOW = Date.parse('2026-07-21T12:00:00Z');

// Every column of operator_tasks, with revision wrapped by the probe UDF so a read
// of it fires the interleaved write exactly once.
const SHADOW_VIEW = `
  CREATE TEMP VIEW operator_tasks AS SELECT
    id, title, status, priority, kind, payload, assignee, deadline, source_channel,
    source_event_id, latest_event, auto_created, confirmed, due_at,
    deadline_offset_minutes, probe(revision) AS revision, temporal_epoch,
    temporal_reconciled_occurrence_key, last_temporal_checked_at,
    next_temporal_check_at, last_temporal_attempt_id, review_started_at,
    review_anchor_event_id, created_at, updated_at
  FROM main.operator_tasks`;

let dir: string;
let file: string;
let ledgerDb: Database;
let other: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mama-ledger-snap-'));
  file = join(dir, 'operator.db');
  ledgerDb = new Database(file);
  ledgerDb.pragma('journal_mode = WAL');
});
afterEach(() => {
  if (other?.open) other.close();
  if (ledgerDb?.open) ledgerDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P1: itemsPage reads one snapshot even when another connection commits mid-read', () => {
  it('returns a consistent generation/total/rows, and the next call sees the interleaved write', () => {
    const ledger = new TaskLedger(ledgerDb, { now: () => NOW, timeZone: 'UTC' });
    ledger.create({ title: 'row-1' });
    ledger.create({ title: 'row-2' });
    ledger.create({ title: 'row-3' });

    other = new Database(file);
    other.pragma('busy_timeout = 5000');

    let fired = 0;
    // The UDF runs on the ledger's reading connection; on its first invocation
    // (the generation SUM(revision)) it commits an insert on the OTHER connection.
    ledgerDb.unsafeRawHandle.function('probe', (revision: unknown) => {
      if (fired === 0) {
        fired += 1;
        other
          .prepare(
            `INSERT INTO operator_tasks (title, kind, status, priority, revision, created_at, updated_at)
             VALUES ('injected', 'owner', 'pending', 'normal', 0, ?, ?)`
          )
          .run(NOW, NOW);
      }
      return revision as number;
    });
    ledgerDb.exec(SHADOW_VIEW);

    const first = ledger.itemsPage({ limit: 25 });
    // The interleaved write happened during the read...
    expect(fired).toBe(1);
    // ...but this call's snapshot is consistent: it still describes exactly 3 rows.
    expect(first.total).toBe(3);
    expect(first.returned).toBe(3);

    // A fresh call establishes a new snapshot and sees the committed 4th row.
    const second = ledger.itemsPage({ limit: 25 });
    expect(second.total).toBe(4);
    expect(second.readVersion).not.toBe(first.readVersion);
  });
});
