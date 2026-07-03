import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import { connectorEventIndexId } from '@jungjaehoon/mama-core/connectors/event-index';
import type { MemoryProvenanceRecord, TrustedMemoryWriteOptions } from '@jungjaehoon/mama-core';

import {
  commitConnectorIngressMemoryBatch,
  type ConnectorIngressManualMemoryCommitInput,
  type ManualMemorySaveInput,
} from '../../src/operator-vnext/connector-ingress-manual-memory-commit.js';
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
    Buffer.alloc(32, 5),
    '2026-07-03T00:00:00.000Z',
    '2026-07-03T00:00:00.000Z'
  );
  return eventIndexId;
}

function makeMemory(overrides: Partial<ManualMemorySaveInput> = {}): ManualMemorySaveInput {
  return {
    topic: 'operator/manual-memory',
    kind: 'decision',
    summary: 'Manual reviewed memory should be committed through the operator.',
    details: 'The admin reviewed the connector event and approved this memory.',
    confidence: 0.82,
    scopes: [{ kind: 'project', id: 'project_public_synthetic' }],
    ...overrides,
  };
}

function memoryPayloadHash(memories: readonly ManualMemorySaveInput[]): string {
  const payloadJson = JSON.stringify(
    memories.map((memory) => {
      const payload: Record<string, unknown> = {
        topic: memory.topic,
        kind: memory.kind,
        summary: memory.summary,
        details: memory.details,
        scopes: memory.scopes.map((scope) => ({ kind: scope.kind, id: scope.id })),
      };
      if (memory.confidence !== undefined) {
        payload.confidence = memory.confidence;
      }
      if (memory.status !== undefined) {
        payload.status = memory.status;
      }
      if (memory.eventDate !== undefined) {
        payload.eventDate = memory.eventDate;
      }
      if (memory.eventDateTime !== undefined) {
        payload.eventDateTime = memory.eventDateTime;
      }
      return payload;
    })
  );
  return `sha256:${crypto.createHash('sha256').update(payloadJson).digest('hex')}`;
}

function makeCapability(): TrustedMemoryWriteOptions['capability'] {
  return Object.freeze({
    __trustedProvenanceCapability: 'mama-core',
  }) as TrustedMemoryWriteOptions['capability'];
}

function makeInput(
  db: SQLiteDatabase,
  eventIndexIds: readonly string[],
  overrides: Partial<ConnectorIngressManualMemoryCommitInput> = {}
): ConnectorIngressManualMemoryCommitInput {
  const saveMemory = vi
    .fn()
    .mockImplementation(async (_input: unknown, options: TrustedMemoryWriteOptions) => ({
      success: true,
      id: `memory-${String(options.provenance.gateway_call_id).split(':').pop()}`,
    }));
  return {
    rawAdapter: db,
    operatorDb: db,
    connector: 'slack',
    channel: 'C_PUBLIC_SYNTHETIC',
    expectedAdvancedThroughSeq: 0,
    eventMemories: eventIndexIds.map((eventIndexId) => ({
      eventIndexId,
      memories: [makeMemory()],
    })),
    saveMemory,
    createTrustedProvenanceCapability: makeCapability,
    listMemoriesByGatewayCallId: vi.fn().mockResolvedValue([]),
    setMemoryStatus: vi.fn().mockResolvedValue(undefined),
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

describe('STORY-VNEXT-PR13-MANUAL-MEMORY: connector ingress manual memory commit', () => {
  describe('AC: reviewed events commit source-linked memories through a recoverable operator path', () => {
    it('commits reviewed event memories as changed operator commits without exposing raw content', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const saveMemory = vi
        .fn()
        .mockResolvedValueOnce({ success: true, id: 'memory-first' })
        .mockResolvedValueOnce({ success: true, id: 'memory-second' });
      const setMemoryStatus = vi.fn().mockResolvedValue(undefined);

      const result = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first, second], { saveMemory, setMemoryStatus })
      );

      expect(result).toEqual({
        ok: true,
        mode: 'manual_memory_commit',
        status: 'committed',
        cursorName: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        connector: 'slack',
        channel: 'C_PUBLIC_SYNTHETIC',
        requestedCount: 2,
        processed: 2,
        advancedThroughSeq: 2,
        firstSeq: 1,
        lastSeq: 2,
        memoriesSaved: 2,
        commits: [
          { seq: 1, status: 'changed', outcome: 'committed', cursorAdvanced: true },
          { seq: 2, status: 'changed', outcome: 'committed', cursorAdvanced: true },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('synthetic public rollout event');
      expect(JSON.stringify(result)).not.toContain('synthetic-user');
      expect(JSON.stringify(result)).not.toContain('metadata_json');
      expect(saveMemory).toHaveBeenCalledTimes(2);
      expect(saveMemory.mock.calls[0]?.[0]).toMatchObject({
        topic: 'operator/manual-memory',
        status: 'stale',
        source: {
          package: 'standalone',
          source_type: 'manual-connector-ingress-memory',
          channel_id: 'C_PUBLIC_SYNTHETIC',
        },
      });
      expect(saveMemory.mock.calls[0]?.[1].provenance).toMatchObject({
        actor: 'user',
        agent_id: 'operator:manual-admin',
        tool_name: 'mama_save',
        gateway_call_id: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1:memory:0',
        source_refs: [`raw:slack:${first}`],
      });
      expect(setMemoryStatus).toHaveBeenCalledWith({
        memoryId: 'memory-first',
        status: 'active',
      });
      expect(setMemoryStatus).toHaveBeenCalledWith({
        memoryId: 'memory-second',
        status: 'active',
      });
      expect(cursorRow(db)).toEqual({
        cursor_name: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        last_change_seq: 2,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(2);
      expect(countRows(db, 'operator_memory_commit_intents')).toBe(2);
      expect(
        db
          .prepare(
            `SELECT changed_refs_json, source_refs_json
             FROM vnext_operator_commits
             ORDER BY first_change_seq ASC`
          )
          .all()
      ).toEqual([
        {
          changed_refs_json: JSON.stringify(['memory:memory-first']),
          source_refs_json: JSON.stringify([`raw:slack:${first}`]),
        },
        {
          changed_refs_json: JSON.stringify(['memory:memory-second']),
          source_refs_json: JSON.stringify([`raw:slack:${second}`]),
        },
      ]);

      db.close();
    });

    it('replays duplicate reviewed memory batches without saving duplicate memories', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const saveMemory = vi.fn().mockResolvedValue({ success: true, id: 'memory-first' });
      const setMemoryStatus = vi.fn().mockResolvedValue(undefined);
      const input = makeInput(db, [first], { saveMemory, setMemoryStatus });

      await commitConnectorIngressMemoryBatch(input);
      const replay = await commitConnectorIngressMemoryBatch(input);

      expect(replay).toMatchObject({
        ok: true,
        status: 'committed',
        requestedCount: 1,
        processed: 1,
        memoriesSaved: 0,
        commits: [{ seq: 1, outcome: 'already_committed', cursorAdvanced: false }],
      });
      expect(saveMemory).toHaveBeenCalledTimes(1);
      expect(setMemoryStatus).toHaveBeenCalledTimes(1);
      expect(countRows(db, 'vnext_operator_commits')).toBe(1);
      expect(countRows(db, 'operator_memory_commit_intents')).toBe(1);

      db.close();
    });

    it('rejects divergent replays for an already committed event before saving memory', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const saveMemory = vi.fn().mockResolvedValue({ success: true, id: 'memory-first' });

      await commitConnectorIngressMemoryBatch(makeInput(db, [first], { saveMemory }));

      await expect(
        commitConnectorIngressMemoryBatch(
          makeInput(db, [first], {
            saveMemory,
            eventMemories: [
              {
                eventIndexId: first,
                memories: [
                  makeMemory({
                    summary: 'This divergent replay must not be treated as idempotent.',
                  }),
                ],
              },
            ],
          })
        )
      ).rejects.toThrow(/memory payload/i);
      expect(saveMemory).toHaveBeenCalledTimes(1);
      expect(countRows(db, 'vnext_operator_commits')).toBe(1);

      db.close();
    });

    it('recovers saved memory ids from deterministic gateway calls before committing the cursor', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const idempotencyKey = 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1';
      db.prepare(
        `INSERT INTO operator_memory_commit_intents (
          intent_id, cursor_name, idempotency_key, expected_memory_count,
          memory_payload_hash, memory_ids_json, source_refs_json, status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `memory-intent:${idempotencyKey}`,
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        idempotencyKey,
        1,
        memoryPayloadHash([makeMemory()]),
        JSON.stringify([null]),
        JSON.stringify([`raw:slack:${first}`]),
        'pending',
        1710000000000,
        1710000000000
      );
      const recovered: MemoryProvenanceRecord = {
        memory_id: 'memory-recovered',
        agent_id: 'operator:manual-admin',
        model_run_id: null,
        envelope_hash: null,
        gateway_call_id: `${idempotencyKey}:memory:0`,
        source_refs: [`raw:slack:${first}`],
        provenance: {},
      };
      const saveMemory = vi.fn();

      const result = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first], {
          saveMemory,
          listMemoriesByGatewayCallId: vi.fn().mockResolvedValue([recovered]),
        })
      );

      expect(result).toMatchObject({
        ok: true,
        status: 'committed',
        memoriesSaved: 0,
        commits: [{ seq: 1, outcome: 'committed', cursorAdvanced: true }],
      });
      expect(saveMemory).not.toHaveBeenCalled();
      expect(
        db.prepare('SELECT memory_ids_json, status FROM operator_memory_commit_intents').get()
      ).toEqual({
        memory_ids_json: JSON.stringify(['memory-recovered']),
        status: 'promoted',
      });
      expect(db.prepare('SELECT changed_refs_json FROM vnext_operator_commits').get()).toEqual({
        changed_refs_json: JSON.stringify(['memory:memory-recovered']),
      });

      db.close();
    });

    it('recovers a stale saving intent after a process crash without duplicating saves', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const idempotencyKey = 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1';
      db.prepare(
        `INSERT INTO operator_memory_commit_intents (
          intent_id, cursor_name, idempotency_key, expected_memory_count,
          memory_payload_hash, memory_ids_json, source_refs_json, status,
          claim_token, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `memory-intent:${idempotencyKey}`,
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        idempotencyKey,
        1,
        memoryPayloadHash([makeMemory()]),
        JSON.stringify([null]),
        JSON.stringify([`raw:slack:${first}`]),
        'saving',
        'claim:crashed-owner',
        1710000000000,
        1710000000000
      );
      const recovered: MemoryProvenanceRecord = {
        memory_id: 'memory-recovered-after-crash',
        agent_id: 'operator:manual-admin',
        model_run_id: null,
        envelope_hash: null,
        gateway_call_id: `${idempotencyKey}:memory:0`,
        source_refs: [`raw:slack:${first}`],
        provenance: {},
      };
      const saveMemory = vi.fn();
      const setMemoryStatus = vi.fn().mockResolvedValue(undefined);

      const result = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first], {
          saveMemory,
          listMemoriesByGatewayCallId: vi.fn().mockResolvedValue([recovered]),
          setMemoryStatus,
          nowMs: () => 1710001000001,
        })
      );

      expect(result).toMatchObject({
        ok: true,
        status: 'committed',
        memoriesSaved: 0,
        commits: [{ seq: 1, outcome: 'committed', cursorAdvanced: true }],
      });
      expect(saveMemory).not.toHaveBeenCalled();
      expect(setMemoryStatus).toHaveBeenCalledWith({
        memoryId: 'memory-recovered-after-crash',
        status: 'active',
      });
      expect(
        db
          .prepare(
            'SELECT memory_ids_json, status, claim_token FROM operator_memory_commit_intents'
          )
          .get()
      ).toEqual({
        memory_ids_json: JSON.stringify(['memory-recovered-after-crash']),
        status: 'promoted',
        claim_token: null,
      });
      expect(db.prepare('SELECT changed_refs_json FROM vnext_operator_commits').get()).toEqual({
        changed_refs_json: JSON.stringify(['memory:memory-recovered-after-crash']),
      });

      db.close();
    });

    it('does not save duplicate memories when another process already owns the save intent', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const idempotencyKey = 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1';
      db.prepare(
        `INSERT INTO operator_memory_commit_intents (
          intent_id, cursor_name, idempotency_key, expected_memory_count,
          memory_payload_hash, memory_ids_json, source_refs_json, status, claim_token,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `memory-intent:${idempotencyKey}`,
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        idempotencyKey,
        1,
        memoryPayloadHash([makeMemory()]),
        JSON.stringify([null]),
        JSON.stringify([`raw:slack:${first}`]),
        'saving',
        'claim:other-owner',
        1710000000000,
        1710000000000
      );
      const saveMemory = vi.fn().mockResolvedValue({ success: true, id: 'memory-first' });

      const result = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first], { saveMemory })
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'partial_failure',
        processed: 0,
        memoriesSaved: 0,
        failedSeq: 1,
        error: 'Manual memory commit partially failed.',
      });
      expect(saveMemory).not.toHaveBeenCalled();
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(cursorRow(db)).toBeUndefined();

      db.close();
    });

    it('returns a safe partial failure when memory save fails before cursor commit', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const saveMemory = vi.fn().mockRejectedValue(new Error('raw sensitive marker save failed'));

      const result = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first], { saveMemory })
      );

      expect(result).toMatchObject({
        ok: false,
        mode: 'manual_memory_commit',
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
        error: 'Manual memory commit partially failed.',
      });
      expect(JSON.stringify(result)).not.toContain('raw sensitive marker');
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(cursorRow(db)).toBeUndefined();

      db.close();
    });

    it('keeps a multi-event batch retryable when a later event save fails', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const second = insertRawEvent(db, { sourceId: 'msg-2', timestampMs: 1710000002000 });
      const eventMemories = [
        {
          eventIndexId: first,
          memories: [makeMemory({ topic: 'operator/manual-memory-first-event' })],
        },
        {
          eventIndexId: second,
          memories: [
            makeMemory({
              topic: 'operator/manual-memory-second-event',
              summary: 'The second reviewed event should be committed on retry.',
              details: 'The first batch attempt failed after the first event staged memory.',
            }),
          ],
        },
      ];
      const firstAttemptSave = vi
        .fn()
        .mockResolvedValueOnce({ success: true, id: 'memory-first' })
        .mockRejectedValueOnce(new Error('second event failed with synthetic marker'));
      const firstAttemptSetMemoryStatus = vi.fn().mockResolvedValue(undefined);

      const firstAttempt = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first, second], {
          eventMemories,
          saveMemory: firstAttemptSave,
          setMemoryStatus: firstAttemptSetMemoryStatus,
        })
      );

      expect(firstAttempt).toMatchObject({
        ok: false,
        status: 'partial_failure',
        requestedCount: 2,
        processed: 0,
        advancedThroughSeq: 0,
        memoriesSaved: 1,
        commits: [],
        failedSeq: 2,
        error: 'Manual memory commit partially failed.',
      });
      expect(JSON.stringify(firstAttempt)).not.toContain('synthetic marker');
      expect(firstAttemptSave).toHaveBeenCalledTimes(2);
      expect(firstAttemptSetMemoryStatus).not.toHaveBeenCalled();
      expect(cursorRow(db)).toBeUndefined();
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(
        db
          .prepare(
            `SELECT idempotency_key, memory_ids_json, status
             FROM operator_memory_commit_intents
             ORDER BY idempotency_key ASC`
          )
          .all()
      ).toEqual([
        {
          idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
          memory_ids_json: JSON.stringify(['memory-first']),
          status: 'saved',
        },
        {
          idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
          memory_ids_json: JSON.stringify([null]),
          status: 'pending',
        },
      ]);

      const retrySave = vi.fn().mockResolvedValue({ success: true, id: 'memory-second' });
      const retrySetMemoryStatus = vi.fn().mockResolvedValue(undefined);
      const retry = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first, second], {
          eventMemories,
          saveMemory: retrySave,
          setMemoryStatus: retrySetMemoryStatus,
        })
      );

      expect(retry).toMatchObject({
        ok: true,
        status: 'committed',
        requestedCount: 2,
        processed: 2,
        advancedThroughSeq: 2,
        memoriesSaved: 1,
        commits: [
          { seq: 1, status: 'changed', outcome: 'committed', cursorAdvanced: true },
          { seq: 2, status: 'changed', outcome: 'committed', cursorAdvanced: true },
        ],
      });
      expect(retrySave).toHaveBeenCalledTimes(1);
      expect(retrySave.mock.calls[0]?.[0]).toMatchObject({
        topic: 'operator/manual-memory-second-event',
      });
      expect(retrySetMemoryStatus).toHaveBeenCalledWith({
        memoryId: 'memory-first',
        status: 'active',
      });
      expect(retrySetMemoryStatus).toHaveBeenCalledWith({
        memoryId: 'memory-second',
        status: 'active',
      });
      expect(cursorRow(db)).toEqual({
        cursor_name: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        last_change_seq: 2,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:2-2',
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(2);

      db.close();
    });

    it('keeps saved memories staged when cursor commit fails after memory save', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const setMemoryStatus = vi.fn().mockResolvedValue(undefined);
      const saveMemory = vi.fn().mockImplementation(async (_memory, options) => {
        const gatewayCallId = String(options.provenance.gateway_call_id);
        const idempotencyKey = gatewayCallId.replace(/:memory:\d+$/, '');
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
          'commit:conflicting-memory',
          'connector:slack:channel:C_PUBLIC_SYNTHETIC',
          idempotencyKey,
          1,
          1,
          'changed',
          JSON.stringify(['memory:conflicting-memory']),
          JSON.stringify(options.provenance.source_refs),
          1710000000000
        );
        return { success: true, id: 'memory-first' };
      });

      const result = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first], { saveMemory, setMemoryStatus })
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'partial_failure',
        processed: 0,
        memoriesSaved: 1,
        failedSeq: 1,
      });
      expect(saveMemory.mock.calls[0]?.[0]).toMatchObject({ status: 'stale' });
      expect(saveMemory.mock.calls[0]?.[1]).toMatchObject({ projectTruth: false });
      expect(setMemoryStatus).not.toHaveBeenCalled();

      db.close();
    });

    it('reports committed promotion-pending state when status promotion fails after cursor commit', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const saveMemory = vi.fn().mockResolvedValue({ success: true, id: 'memory-first' });
      const setMemoryStatus = vi.fn().mockRejectedValue(new Error('promotion failed'));
      const input = makeInput(db, [first], { saveMemory, setMemoryStatus });

      const result = await commitConnectorIngressMemoryBatch(input);

      expect(result).toMatchObject({
        ok: true,
        status: 'committed',
        processed: 1,
        advancedThroughSeq: 1,
        memoriesSaved: 1,
        promotionPending: true,
        commits: [{ seq: 1, outcome: 'committed', cursorAdvanced: true }],
      });
      expect(cursorRow(db)).toEqual({
        cursor_name: 'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        last_change_seq: 1,
        last_idempotency_key: 'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
      });
      expect(
        db.prepare('SELECT memory_ids_json, status FROM operator_memory_commit_intents').get()
      ).toEqual({
        memory_ids_json: JSON.stringify(['memory-first']),
        status: 'saved',
      });

      setMemoryStatus.mockReset();
      setMemoryStatus.mockResolvedValue(undefined);
      const replay = await commitConnectorIngressMemoryBatch(input);

      expect(replay).toMatchObject({
        ok: true,
        status: 'committed',
        processed: 1,
        memoriesSaved: 0,
        commits: [{ seq: 1, outcome: 'already_committed', cursorAdvanced: false }],
      });
      expect(replay).not.toHaveProperty('promotionPending');
      expect(setMemoryStatus).toHaveBeenCalledWith({
        memoryId: 'memory-first',
        status: 'active',
      });
      expect(
        db.prepare('SELECT memory_ids_json, status FROM operator_memory_commit_intents').get()
      ).toEqual({
        memory_ids_json: JSON.stringify(['memory-first']),
        status: 'promoted',
      });

      db.close();
    });

    it('does not let a stale save owner overwrite a promoted intent', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const saveMemory = vi.fn().mockImplementation(async (_memory, options) => {
        const idempotencyKey = String(options.provenance.gateway_call_id).replace(
          /:memory:\d+$/,
          ''
        );
        db.prepare(
          `UPDATE operator_memory_commit_intents
           SET memory_ids_json = ?, status = 'promoted', claim_token = NULL, updated_at_ms = ?
           WHERE idempotency_key = ?`
        ).run(JSON.stringify(['memory-promoted-by-other-owner']), 1710000001001, idempotencyKey);
        return { success: true, id: 'memory-stale-owner' };
      });

      const result = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first], { saveMemory })
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'partial_failure',
        processed: 0,
        memoriesSaved: 0,
        failedSeq: 1,
      });
      expect(
        db.prepare('SELECT changed_refs_json FROM vnext_operator_commits').get()
      ).toBeUndefined();
      expect(
        db.prepare('SELECT memory_ids_json, status FROM operator_memory_commit_intents').get()
      ).toEqual({
        memory_ids_json: JSON.stringify(['memory-promoted-by-other-owner']),
        status: 'promoted',
      });

      db.close();
    });

    it('refreshes the saving intent lease while a memory save is in flight', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1710000000000);

      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      let resolveSave: ((value: { success: boolean; id: string }) => void) | null = null;
      const saveMemory = vi.fn((_memory: unknown, _options: TrustedMemoryWriteOptions) => {
        return new Promise<{ success: boolean; id: string }>((resolve) => {
          resolveSave = resolve;
        });
      });
      const resultPromise = commitConnectorIngressMemoryBatch(
        makeInput(db, [first], {
          saveMemory,
          nowMs: () => Date.now(),
        })
      );

      try {
        for (let i = 0; i < 5; i += 1) {
          await Promise.resolve();
        }

        expect(saveMemory).toHaveBeenCalledTimes(1);
        const beforeHeartbeat = db
          .prepare(
            `SELECT status, updated_at_ms
             FROM operator_memory_commit_intents`
          )
          .get() as { status: string; updated_at_ms: number };
        expect(beforeHeartbeat).toEqual({
          status: 'saving',
          updated_at_ms: 1710000000000,
        });

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

        const duringSave = db
          .prepare(
            `SELECT status, updated_at_ms
             FROM operator_memory_commit_intents`
          )
          .get() as { status: string; updated_at_ms: number };
        expect(duringSave).toEqual({
          status: 'saving',
          updated_at_ms: 1710000300000,
        });

        resolveSave?.({ success: true, id: 'memory-first' });
        const result = await resultPromise;
        expect(result).toMatchObject({
          ok: true,
          status: 'committed',
          memoriesSaved: 1,
        });
      } finally {
        resolveSave?.({ success: true, id: 'memory-first' });
        await resultPromise.catch(() => undefined);
        vi.useRealTimers();
        db.close();
      }
    });

    it('retries a partially saved multi-memory event without saving duplicate memories', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const eventMemories = [
        {
          eventIndexId: first,
          memories: [
            makeMemory({ topic: 'operator/manual-memory-first' }),
            makeMemory({
              topic: 'operator/manual-memory-second',
              summary: 'Second reviewed memory should be committed on retry.',
              details: 'The second memory failed after the first one was durably recorded.',
            }),
          ],
        },
      ];
      const firstAttemptSave = vi
        .fn()
        .mockResolvedValueOnce({ success: true, id: 'memory-first' })
        .mockRejectedValueOnce(new Error('second memory failed with synthetic marker'));
      const firstAttemptSetMemoryStatus = vi.fn().mockResolvedValue(undefined);

      const firstAttempt = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first], {
          eventMemories,
          saveMemory: firstAttemptSave,
          setMemoryStatus: firstAttemptSetMemoryStatus,
        })
      );

      expect(firstAttempt).toMatchObject({
        ok: false,
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
        error: 'Manual memory commit partially failed.',
      });
      expect(firstAttemptSave).toHaveBeenCalledTimes(2);
      expect(firstAttemptSave.mock.calls[0]?.[0]).toMatchObject({ status: 'stale' });
      expect(firstAttemptSetMemoryStatus).not.toHaveBeenCalled();
      expect(
        db.prepare('SELECT memory_ids_json, status FROM operator_memory_commit_intents').get()
      ).toEqual({
        memory_ids_json: JSON.stringify(['memory-first', null]),
        status: 'pending',
      });
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);

      const retrySave = vi.fn().mockResolvedValue({ success: true, id: 'memory-second' });
      const retrySetMemoryStatus = vi.fn().mockResolvedValue(undefined);
      const retry = await commitConnectorIngressMemoryBatch(
        makeInput(db, [first], {
          eventMemories,
          saveMemory: retrySave,
          setMemoryStatus: retrySetMemoryStatus,
        })
      );

      expect(retry).toMatchObject({
        ok: true,
        status: 'committed',
        memoriesSaved: 1,
        commits: [{ seq: 1, outcome: 'committed', cursorAdvanced: true }],
      });
      expect(retrySave).toHaveBeenCalledTimes(1);
      expect(retrySave.mock.calls[0]?.[0]).toMatchObject({
        topic: 'operator/manual-memory-second',
      });
      expect(retrySave.mock.calls[0]?.[1].provenance.gateway_call_id).toBe(
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1:memory:1'
      );
      expect(retrySetMemoryStatus).toHaveBeenCalledWith({
        memoryId: 'memory-first',
        status: 'active',
      });
      expect(retrySetMemoryStatus).toHaveBeenCalledWith({
        memoryId: 'memory-second',
        status: 'active',
      });
      expect(
        db.prepare('SELECT memory_ids_json, status FROM operator_memory_commit_intents').get()
      ).toEqual({
        memory_ids_json: JSON.stringify(['memory-first', 'memory-second']),
        status: 'promoted',
      });
      expect(db.prepare('SELECT changed_refs_json FROM vnext_operator_commits').get()).toEqual({
        changed_refs_json: JSON.stringify(['memory:memory-first', 'memory:memory-second']),
      });

      db.close();
    });
  });

  describe('AC: unsafe memory commit requests fail before durable writes', () => {
    it.each([
      [
        'out-of-range confidence',
        [{ eventIndexId: 'EVENT', memories: [makeMemory({ confidence: 2 })] }],
      ],
      [
        'unsupported kind',
        [{ eventIndexId: 'EVENT', memories: [makeMemory({ kind: 'unsupported' as never })] }],
      ],
      [
        'unsupported status',
        [{ eventIndexId: 'EVENT', memories: [makeMemory({ status: 'unsupported' as never })] }],
      ],
      ['empty scopes', [{ eventIndexId: 'EVENT', memories: [makeMemory({ scopes: [] })] }]],
      [
        'unsupported scope kind',
        [
          {
            eventIndexId: 'EVENT',
            memories: [
              makeMemory({
                scopes: [{ kind: 'workspace' as never, id: 'project_public_synthetic' }],
              }),
            ],
          },
        ],
      ],
      [
        'negative eventDateTime',
        [{ eventIndexId: 'EVENT', memories: [makeMemory({ eventDateTime: -1 })] }],
      ],
      [
        'zero eventDateTime',
        [{ eventIndexId: 'EVENT', memories: [makeMemory({ eventDateTime: 0 })] }],
      ],
      [
        'invalid eventDate',
        [{ eventIndexId: 'EVENT', memories: [makeMemory({ eventDate: 'not-a-date' })] }],
      ],
      [
        'duplicate event ids',
        [
          { eventIndexId: 'EVENT', memories: [makeMemory()] },
          { eventIndexId: 'EVENT', memories: [makeMemory()] },
        ],
      ],
      ['empty memories', [{ eventIndexId: 'EVENT', memories: [] }]],
    ])(
      'rejects invalid manual memory input before durable writes: %s',
      async (_name, eventMemories) => {
        const db = makeOperatorVNextDb();
        const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
        const saveMemory = vi.fn();
        const normalizedEventMemories = eventMemories.map((eventMemory) => ({
          ...eventMemory,
          eventIndexId: eventMemory.eventIndexId === 'EVENT' ? first : eventMemory.eventIndexId,
        }));

        await expect(
          commitConnectorIngressMemoryBatch(
            makeInput(db, [first], {
              saveMemory,
              eventMemories: normalizedEventMemories,
            })
          )
        ).rejects.toThrow();
        expect(saveMemory).not.toHaveBeenCalled();
        expect(countRows(db, 'vnext_operator_commits')).toBe(0);
        expect(countRows(db, 'operator_memory_commit_intents')).toBe(0);

        db.close();
      }
    );

    it('rejects caller-supplied source/provenance refs before saving memory', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const saveMemory = vi.fn();

      await expect(
        commitConnectorIngressMemoryBatch(
          makeInput(db, [first], {
            saveMemory,
            eventMemories: [
              {
                eventIndexId: first,
                memories: [
                  {
                    ...makeMemory(),
                    source: { package: 'standalone', source_type: 'caller-spoofed' },
                    source_refs: ['raw:slack:caller-spoofed'],
                    changedRefs: ['memory:caller-spoofed'],
                    provenance: { gateway_call_id: 'caller-spoofed' },
                  } as never,
                ],
              },
            ],
          })
        )
      ).rejects.toThrow(/memory source and refs are derived from reviewed events/i);
      expect(saveMemory).not.toHaveBeenCalled();
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'operator_memory_commit_intents')).toBe(0);

      db.close();
    });

    it('rejects caller-supplied timeline and entity refs before saving memory', async () => {
      const db = makeOperatorVNextDb();
      const first = insertRawEvent(db, { sourceId: 'msg-1', timestampMs: 1710000001000 });
      const saveMemory = vi.fn();

      await expect(
        commitConnectorIngressMemoryBatch(
          makeInput(db, [first], {
            saveMemory,
            eventMemories: [
              {
                eventIndexId: first,
                memories: [
                  {
                    ...makeMemory(),
                    timelineEvent: {
                      source_ref: 'raw:slack:caller-spoofed',
                      event_type: 'decision',
                      title: 'caller supplied timeline ref',
                    },
                    entityObservationIds: ['entity-observation:caller-spoofed'],
                  } as never,
                ],
              },
            ],
          })
        )
      ).rejects.toThrow(/memory source and refs are derived from reviewed events/i);
      expect(saveMemory).not.toHaveBeenCalled();
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);
      expect(countRows(db, 'operator_memory_commit_intents')).toBe(0);

      db.close();
    });

    it('rejects events already committed as no-update before saving memory', async () => {
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
        'commit:no-update-existing',
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
        1,
        1,
        'no_update',
        JSON.stringify([]),
        JSON.stringify([`raw:slack:${first}`]),
        1710000000000
      );
      const saveMemory = vi.fn();

      await expect(
        commitConnectorIngressMemoryBatch(makeInput(db, [first], { saveMemory }))
      ).rejects.toThrow(/non-changed operator commit/i);
      expect(saveMemory).not.toHaveBeenCalled();
      expect(countRows(db, 'operator_memory_commit_intents')).toBe(0);

      db.close();
    });

    it('rejects events already committed as wiki changes before saving memory', async () => {
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
        'commit:wiki-existing',
        'connector:slack:channel:C_PUBLIC_SYNTHETIC',
        'cursor:connector:slack:channel:C_PUBLIC_SYNTHETIC:seq:1-1',
        1,
        1,
        'changed',
        JSON.stringify(['wiki_page:projects/existing.md']),
        JSON.stringify([`raw:slack:${first}`]),
        1710000000000
      );
      const saveMemory = vi.fn();

      await expect(
        commitConnectorIngressMemoryBatch(makeInput(db, [first], { saveMemory }))
      ).rejects.toThrow(/non-memory changed operator commit/i);
      expect(saveMemory).not.toHaveBeenCalled();
      expect(countRows(db, 'operator_memory_commit_intents')).toBe(0);

      db.close();
    });
  });
});
