import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { insertTwinEdge } from '../../src/edges/store.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

function insertMemory(id: string): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(id, `topic-${id}`, `decision-${id}`, `reasoning-${id}`, 0.8, 1_000, 1_000);
}

function insertRaw(id: string): string {
  return upsertConnectorEventIndex(getAdapter(), {
    source_connector: 'slack',
    source_type: 'message',
    source_id: id,
    content: `raw content ${id}`,
    event_datetime: 1_000,
  }).event_index_id;
}

function twinEdgeCount(): number {
  const row = getAdapter().prepare('SELECT COUNT(*) AS count FROM twin_edges').get() as {
    count: number;
  };
  return row.count;
}

describe('Story M3.1: Twin Edge Ledger', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('twin-edge-store');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM twin_edges').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
    adapter.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: typed memory->raw derived_from edge insert/read', () => {
    it('inserts a typed edge and returns parsed JSON plus a 32-byte content hash', () => {
      insertMemory('mem-derived');
      const rawId = insertRaw('raw-derived');

      const edge = insertTwinEdge(getAdapter(), {
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-derived' },
        object_ref: { kind: 'raw', id: rawId },
        relation_attrs: { excerpt: 'source line' },
        confidence: 0.92,
        source: 'code',
        reason_text: 'deterministic replay from connector payload',
        evidence_refs: [{ kind: 'raw', id: rawId }],
      });

      expect(edge).toMatchObject({
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-derived' },
        object_ref: { kind: 'raw', id: rawId },
        relation_attrs: { excerpt: 'source line' },
        confidence: 0.92,
        source: 'code',
        reason_text: 'deterministic replay from connector payload',
        evidence_refs: [{ kind: 'raw', id: rawId }],
      });
      expect(edge.content_hash).toBeInstanceOf(Buffer);
      expect(edge.content_hash.byteLength).toBe(32);
    });
  });

  describe('AC #2: model-run edge idempotency', () => {
    it('returns the existing edge for the same model run and edge idempotency key', () => {
      insertMemory('mem-agent');
      const rawId = insertRaw('raw-agent');

      const first = insertTwinEdge(getAdapter(), {
        edge_id: 'edge_first',
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-agent' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'agent',
        agent_id: 'agent-m3',
        model_run_id: 'mr-1',
        envelope_hash: 'env-1',
        edge_idempotency_key: 'edge-key-1',
      });

      const second = insertTwinEdge(getAdapter(), {
        edge_id: 'edge_second',
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-agent' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'agent',
        agent_id: 'agent-m3',
        model_run_id: 'mr-1',
        envelope_hash: 'env-1',
        edge_idempotency_key: 'edge-key-1',
      });

      expect(second.edge_id).toBe(first.edge_id);
      expect(second.edge_id).toBe('edge_first');
      expect(twinEdgeCount()).toBe(1);
    });

    it('returns the existing edge for a null-model-run idempotent retry', () => {
      insertMemory('mem-null-model-run');
      const rawId = insertRaw('raw-null-model-run');

      const first = insertTwinEdge(getAdapter(), {
        edge_id: 'edge_null_model_first',
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-null-model-run' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'code',
        reason_text: 'connector replay',
        edge_idempotency_key: 'edge-key-null-model',
      });

      const second = insertTwinEdge(getAdapter(), {
        edge_id: 'edge_null_model_second',
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-null-model-run' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'code',
        reason_text: 'connector replay',
        edge_idempotency_key: 'edge-key-null-model',
      });

      expect(second.edge_id).toBe(first.edge_id);
      expect(twinEdgeCount()).toBe(1);
    });
  });

  describe('AC #3: request idempotency key derives distinct per-edge keys', () => {
    it('allows one request idempotency key to write five distinct edges', () => {
      insertMemory('mem-request');

      const edges = Array.from({ length: 5 }, (_, index) => {
        const rawId = insertRaw(`raw-request-${index}`);
        return insertTwinEdge(getAdapter(), {
          edge_type: 'derived_from',
          subject_ref: { kind: 'memory', id: 'mem-request' },
          object_ref: { kind: 'raw', id: rawId },
          relation_attrs: { ordinal: index },
          source: 'code',
          reason_text: 'batch connector replay',
          request_idempotency_key: 'request-1',
        });
      });

      expect(twinEdgeCount()).toBe(5);
      expect(new Set(edges.map((edge) => edge.edge_idempotency_key)).size).toBe(5);
      expect(edges.map((edge) => edge.request_idempotency_key)).toEqual([
        'request-1',
        'request-1',
        'request-1',
        'request-1',
        'request-1',
      ]);
    });

    it('derives distinct keys when persisted agent audit metadata differs', () => {
      insertMemory('mem-agent-audit');
      const rawId = insertRaw('raw-agent-audit');

      const first = insertTwinEdge(getAdapter(), {
        edge_id: 'edge_agent_audit_first',
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-agent-audit' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'agent',
        agent_id: 'agent-a',
        model_run_id: 'mr-audit',
        envelope_hash: 'env-a',
        request_idempotency_key: 'request-audit',
      });
      const second = insertTwinEdge(getAdapter(), {
        edge_id: 'edge_agent_audit_second',
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-agent-audit' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'agent',
        agent_id: 'agent-b',
        model_run_id: 'mr-audit',
        envelope_hash: 'env-b',
        request_idempotency_key: 'request-audit',
      });

      expect(second.edge_id).toBe('edge_agent_audit_second');
      expect(second.edge_idempotency_key).not.toBe(first.edge_idempotency_key);
      expect(twinEdgeCount()).toBe(2);
    });

    it('derives distinct keys when persisted human audit metadata differs', () => {
      insertMemory('mem-human-audit');
      const rawId = insertRaw('raw-human-audit');

      const first = insertTwinEdge(getAdapter(), {
        edge_id: 'edge_human_audit_first',
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-human-audit' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'human',
        human_actor_id: 'user-a',
        human_actor_role: 'commander',
        authority_scope_json: { scopes: [{ kind: 'project', id: 'alpha' }] },
        reason_classification: 'factual_correction',
        request_idempotency_key: 'request-human-audit',
      });
      const second = insertTwinEdge(getAdapter(), {
        edge_id: 'edge_human_audit_second',
        edge_type: 'derived_from',
        subject_ref: { kind: 'memory', id: 'mem-human-audit' },
        object_ref: { kind: 'raw', id: rawId },
        source: 'human',
        human_actor_id: 'user-b',
        human_actor_role: 'configurator_elevated',
        authority_scope_json: { scopes: [{ kind: 'project', id: 'beta' }] },
        reason_classification: 'state_override',
        request_idempotency_key: 'request-human-audit',
      });

      expect(second.edge_id).toBe('edge_human_audit_second');
      expect(second.edge_idempotency_key).not.toBe(first.edge_idempotency_key);
      expect(twinEdgeCount()).toBe(2);
    });
  });

  describe('AC #4: source-specific metadata validation', () => {
    it('rejects a human edge without authority metadata before inserting a row', () => {
      insertMemory('mem-human');
      const rawId = insertRaw('raw-human');

      expect(() =>
        insertTwinEdge(getAdapter(), {
          edge_type: 'derived_from',
          subject_ref: { kind: 'memory', id: 'mem-human' },
          object_ref: { kind: 'raw', id: rawId },
          source: 'human',
          human_actor_id: 'user-1',
        })
      ).toThrow(/human_actor_role|authority_scope_json|reason_classification/i);
      expect(twinEdgeCount()).toBe(0);
    });

    it('rejects unknown human actor roles and reason classifications', () => {
      insertMemory('mem-human-enum');
      const rawId = insertRaw('raw-human-enum');

      expect(() =>
        insertTwinEdge(getAdapter(), {
          edge_type: 'derived_from',
          subject_ref: { kind: 'memory', id: 'mem-human-enum' },
          object_ref: { kind: 'raw', id: rawId },
          source: 'human',
          human_actor_id: 'user-1',
          human_actor_role: 'owner' as never,
          authority_scope_json: { scopes: [{ kind: 'project', id: 'alpha' }] },
          reason_classification: 'other',
        })
      ).toThrow(/human_actor_role/i);

      expect(() =>
        insertTwinEdge(getAdapter(), {
          edge_type: 'derived_from',
          subject_ref: { kind: 'memory', id: 'mem-human-enum' },
          object_ref: { kind: 'raw', id: rawId },
          source: 'human',
          human_actor_id: 'user-1',
          human_actor_role: 'commander',
          authority_scope_json: { scopes: [{ kind: 'project', id: 'alpha' }] },
          reason_classification: 'because' as never,
        })
      ).toThrow(/reason_classification/i);
      expect(twinEdgeCount()).toBe(0);
    });

    it('rejects raw subjects at runtime before inserting a row', () => {
      insertMemory('mem-raw-subject');
      const rawId = insertRaw('raw-subject');

      expect(() =>
        insertTwinEdge(getAdapter(), {
          edge_type: 'derived_from',
          subject_ref: { kind: 'raw', id: rawId } as never,
          object_ref: { kind: 'memory', id: 'mem-raw-subject' },
          source: 'code',
          reason_text: 'raw refs are object-only',
        })
      ).toThrow(/subject_ref\.kind cannot be raw/i);
      expect(twinEdgeCount()).toBe(0);
    });
  });
});
