import { describe, expect, it } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import { connectorEventIndexId } from '@jungjaehoon/mama-core/connectors/event-index';

import {
  commitConnectorIngressNoUpdateBatch,
  createConnectorIngressManualNoUpdateCommitProvider,
  type ConnectorIngressManualCommitInput,
} from '../../src/operator-vnext/connector-ingress-manual-commit.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';
import { countRows, makeOperatorVNextDb } from './fixtures.js';

function insertRawEvent(
  db: SQLiteDatabase,
  overrides: {
    connector?: string;
    sourceId: string;
    channel?: string;
    timestampMs: number;
  }
): string {
  const connector = overrides.connector ?? 'slack';
  const channel = overrides.channel ?? 'C_PUBLIC_SYNTHETIC';
  const eventIndexId = connectorEventIndexId(connector, overrides.sourceId);
  db.prepare(
    `INSERT INTO connector_event_index (
      event_index_id, source_connector, source_type, source_id, source_locator,
      channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
      metadata_json, content_hash, indexed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventIndexId,
    connector,
    'message',
    overrides.sourceId,
    `${connector}:${channel}:${overrides.sourceId}`,
    channel,
    'synthetic-user',
    null,
    `synthetic public rollout event ${overrides.sourceId}`,
    overrides.timestampMs,
    new Date(overrides.timestampMs).toISOString().slice(0, 10),
    overrides.timestampMs,
    JSON.stringify({ synthetic: true }),
    Buffer.alloc(32, 3),
    '2026-07-03T00:00:00.000Z',
    '2026-07-03T00:00:00.000Z'
  );
  return eventIndexId;
}

function makeInput(
  db: SQLiteDatabase,
  eventIndexIds: string[],
  overrides: Partial<ConnectorIngressManualCommitInput> = {}
): ConnectorIngressManualCommitInput {
  return {
    rawAdapter: db,
    operatorDb: db,
    connector: 'slack',
    channel: 'C_PUBLIC_SYNTHETIC',
    expectedAdvancedThroughSeq: 0,
    eventIndexIds,
    nowMs: () => 1710000000000,
    ...overrides,
  };
}

function cursorRow(db: SQLiteDatabase) {
  return db
    .prepare(
      `SELECT cursor_name, last_change_seq, last_idempotency_key
       FROM vnext_operator_cursors
       WHERE cursor_name = ?`
    )
    .get('connector:slack:channel:C_PUBLIC_SYNTHETIC');
}

describe('STORY-VNEXT-PR10-MANUAL-INGRESS: connector ingress manual no-update commit', () => {
  describe('AC: reviewed no-update batches advance only the connector/channel cursor', () => {
    it('commits reviewed connector events as no-updates without exposing raw connector content', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });

      const result = await commitConnectorIngressNoUpdateBatch(makeInput(db, [first, second]));

      expect(result).toEqual({
        ok: true,
        mode: 'manual_no_update_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 2,
        processed: 2,
        advancedThroughSeq: 2,
        firstSeq: 1,
        lastSeq: 2,
        commits: [
          { seq: 1, status: 'no_update', outcome: 'committed', cursorAdvanced: true },
          { seq: 2, status: 'no_update', outcome: 'committed', cursorAdvanced: true },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('synthetic public rollout event');
      expect(JSON.stringify(result)).not.toContain('synthetic-user');
      expect(JSON.stringify(result)).not.toContain('metadata_json');
      expect(cursorRow(db)).toEqual({
        cursor_name: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        last_change_seq: 2,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(2);
      expect(countRows(db, 'operator_no_updates')).toBe(2);
      expect(db.prepare('SELECT DISTINCT status FROM vnext_operator_commits').all()).toEqual([
        { status: 'no_update' },
      ]);

      db.close();
    });

    it('replays duplicate reviewed batches idempotently without inserting duplicate rows', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const input = makeInput(db, [first, second]);

      await commitConnectorIngressNoUpdateBatch(input);
      const replay = await commitConnectorIngressNoUpdateBatch(input);

      expect(replay).toMatchObject({
        ok: true,
        status: 'committed',
        requestedCount: 2,
        processed: 2,
        advancedThroughSeq: 2,
        commits: [
          { seq: 1, outcome: 'already_committed', cursorAdvanced: false },
          { seq: 2, outcome: 'already_committed', cursorAdvanced: false },
        ],
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(2);
      expect(countRows(db, 'operator_no_updates')).toBe(2);

      db.close();
    });

    it('commits the next surviving indexed event without requiring rowid-contiguous seqs', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const deleted = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const surviving = insertRawEvent(db, { sourceId: 'msg-3', timestampMs: 1710000003000 });

      await commitConnectorIngressNoUpdateBatch(makeInput(db, [first]));
      db.prepare('DELETE FROM connector_event_index WHERE event_index_id = ?').run(deleted);

      const result = await commitConnectorIngressNoUpdateBatch(
        makeInput(db, [surviving], { expectedAdvancedThroughSeq: 1 })
      );

      expect(result).toMatchObject({
        ok: true,
        status: 'committed',
        processed: 1,
        advancedThroughSeq: 3,
        firstSeq: 3,
        lastSeq: 3,
        commits: [{ seq: 3, outcome: 'committed', cursorAdvanced: true }],
      });
      expect(cursorRow(db)).toEqual({
        cursor_name: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        last_change_seq: 3,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:3-3',
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(2);
      expect(countRows(db, 'operator_no_updates')).toBe(2);

      db.close();
    });

    it('rejects concurrent stale reviewed batches after revalidating under the cursor lock', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });

      const firstCommit = commitConnectorIngressNoUpdateBatch(makeInput(db, [first]));
      const staleBatch = commitConnectorIngressNoUpdateBatch(makeInput(db, [first, second]));

      await expect(firstCommit).resolves.toMatchObject({
        status: 'committed',
        processed: 1,
        advancedThroughSeq: 1,
      });
      await expect(staleBatch).rejects.toThrow(/stale/i);
      expect(cursorRow(db)).toEqual({
        cursor_name: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        last_change_seq: 1,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(1);
      expect(countRows(db, 'operator_no_updates')).toBe(1);

      db.close();
    });

    it('does not report a stale changed commit as a manual no-update replay', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      db.prepare(
        `INSERT INTO vnext_operator_cursors (
          cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
        ) VALUES (?, ?, ?, ?)`
      ).run(
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        1,
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
        1710000000000
      );
      db.prepare(
        `INSERT INTO vnext_operator_commits (
          commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
          status, changed_refs_json, source_refs_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'commit:changed-existing',
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
        1,
        1,
        'changed',
        JSON.stringify(['os_task:synthetic-task']),
        JSON.stringify([`raw:slack:${first}`]),
        1710000000000
      );

      await expect(commitConnectorIngressNoUpdateBatch(makeInput(db, [first]))).rejects.toThrow(
        /non-no-update/i
      );
      expect(countRows(db, 'operator_no_updates')).toBe(0);

      db.close();
    });
  });

  describe('AC: stale or unsafe commit requests fail closed', () => {
    it('rejects reordered reviewed batches without durable writes', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const lateBackfill = insertRawEvent(db, { sourceId: 'msg-0', timestampMs: 1710000000000 });

      await expect(
        commitConnectorIngressNoUpdateBatch(makeInput(db, [first, lateBackfill, second]))
      ).rejects.toThrow(/reviewed event ids do not match/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'operator_no_updates')).toBe(0);
      expect(countRows(db, 'vnext_operator_cursors')).toBe(0);

      db.close();
    });

    it('rejects reviewed batches that skip a surviving connector event in the cursor range', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const third = insertRawEvent(db, { sourceId: 'msg-3', timestampMs: 1710000003000 });

      await expect(
        commitConnectorIngressNoUpdateBatch(makeInput(db, [first, third]))
      ).rejects.toThrow(/cover the current connector cursor range/i);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'operator_no_updates')).toBe(0);
      expect(countRows(db, 'vnext_operator_cursors')).toBe(0);

      db.close();
    });

    it('uses cursor-scoped idempotency keys so connector seqs cannot collide across channels', async () => {
      const db = makeOperatorVNextDb();
      const publicEvent = insertRawEvent(db, {
        sourceId: 'msg-public-1',
        channel: 'C_PUBLIC_SYNTHETIC',
        timestampMs: 1710000001000,
      });
      const otherEvent = insertRawEvent(db, {
        sourceId: 'msg-other-1',
        channel: 'C_OTHER_SYNTHETIC',
        timestampMs: 1710000001000,
      });

      await commitConnectorIngressNoUpdateBatch(makeInput(db, [publicEvent]));
      await commitConnectorIngressNoUpdateBatch(
        makeInput(db, [otherEvent], { channel: 'C_OTHER_SYNTHETIC' })
      );

      const keys = db
        .prepare('SELECT idempotency_key FROM vnext_operator_commits ORDER BY idempotency_key')
        .all() as Array<{ idempotency_key: string }>;
      expect(keys).toEqual([
        { idempotency_key: 'cursor:connector:slack:channel:C_OTHER_SYNTHETIC:seq:1-1' },
        { idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1' },
      ]);

      db.close();
    });

    it('keeps a committed prefix when a later reviewed event cannot be committed', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      db.prepare(
        `INSERT INTO vnext_operator_cursors (
          cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
        ) VALUES (?, ?, ?, ?)`
      ).run('connector:slack:channel:C_PUBLIC_SYNTHETIC', 0, null, 1710000000000);
      db.prepare(
        `INSERT INTO vnext_operator_commits (
          commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
          status, changed_refs_json, source_refs_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'commit:preexisting-conflict',
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
        2,
        2,
        'no_update',
        JSON.stringify([]),
        JSON.stringify(['raw:slack:conflicting-synthetic-event']),
        1710000000000
      );

      const result = await commitConnectorIngressNoUpdateBatch(makeInput(db, [first, second]));

      expect(result).toMatchObject({
        ok: false,
        status: 'partial_failure',
        requestedCount: 2,
        processed: 1,
        advancedThroughSeq: 1,
        failedSeq: 2,
        error: 'Manual no-update commit partially failed.',
        commits: [{ seq: 1, status: 'no_update', outcome: 'committed', cursorAdvanced: true }],
      });
      expect(cursorRow(db)).toEqual({
        cursor_name: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        last_change_seq: 1,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
      });
      expect(
        db
          .prepare(
            `SELECT idempotency_key, status
             FROM vnext_operator_commits
             WHERE cursor_name = ?
             ORDER BY first_change_seq`
          )
          .all('connector:slack:channel:C_PUBLIC_SYNTHETIC')
      ).toEqual([
        {
          idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
          status: 'no_update',
        },
        {
          idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
          status: 'no_update',
        },
      ]);
      expect(countRows(db, 'operator_no_updates')).toBe(1);

      db.close();
    });

    it('creates a provider locked to one configured connector/channel', async () => {
      const db = makeOperatorVNextDb();
      const eventIndexId = insertRawEvent(db, {
        sourceId: 'msg-public-1',
        channel: 'C_PUBLIC_SYNTHETIC',
        timestampMs: 1710000001000,
      });
      const provider = createConnectorIngressManualNoUpdateCommitProvider({
        rawAdapter: db,
        operatorDb: db,
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        nowMs: () => 1710000000000,
      });

      await expect(
        provider({
          connector: 'slack',
          channel: 'C_OTHER_SYNTHETIC',
          expectedAdvancedThroughSeq: 0,
          eventIndexIds: [eventIndexId],
        })
      ).rejects.toThrow(/configured connector\/channel/i);
      const committed = await provider({
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        expectedAdvancedThroughSeq: 0,
        eventIndexIds: [eventIndexId],
      });
      expect(committed.status).toBe('committed');

      db.close();
    });
  });
});
