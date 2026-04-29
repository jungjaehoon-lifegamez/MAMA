import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import {
  backfillConnectorEventScopeMetadata,
  backfillLegacyMemoryProvenance,
} from '../../src/memory/scope-backfill.js';
import { getMemoryProvenance } from '../../src/memory/provenance-query.js';

function insertDecision(input: {
  id: string;
  provenanceJson?: string | null;
  sourceRefsJson?: string | null;
}): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO decisions (
          id, topic, decision, reasoning, confidence, user_involvement, status, created_at,
          updated_at, source_refs_json, provenance_json
        )
        VALUES (?, 'm2/backfill', 'legacy memory', 'seeded', 0.8, 'approved', 'active', ?, ?, ?, ?)
      `
    )
    .run(
      input.id,
      Date.parse('2026-04-29T04:00:00.000Z'),
      Date.parse('2026-04-29T04:00:00.000Z'),
      input.sourceRefsJson ?? null,
      input.provenanceJson ?? null
    );
}

describe('Story M2.3: Scope and provenance backfill', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('scope-backfill');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM connector_event_index_cursors').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
    adapter.prepare('DELETE FROM memory_events').run();
    adapter.prepare('DELETE FROM memory_scope_bindings').run();
    adapter.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: legacy memory rows are marked without fake runtime evidence', () => {
    it('backfills null decision provenance as legacy and leaves model/envelope ids unset', async () => {
      insertDecision({ id: 'mem-legacy-1' });
      insertDecision({
        id: 'mem-trusted-1',
        provenanceJson: JSON.stringify({ actor: 'main_agent', source_type: 'gateway' }),
        sourceRefsJson: JSON.stringify(['raw:already-trusted']),
      });

      const result = await backfillLegacyMemoryProvenance();

      expect(result).toEqual({ scanned: 1, updated: 1 });
      const legacy = await getMemoryProvenance('mem-legacy-1');
      expect(legacy).toMatchObject({
        memory_id: 'mem-legacy-1',
        agent_id: null,
        model_run_id: null,
        envelope_hash: null,
        gateway_call_id: null,
        source_refs: [],
      });
      expect(legacy?.provenance).toEqual({
        actor: 'actor:legacy',
        source_type: 'legacy',
      });

      const trusted = await getMemoryProvenance('mem-trusted-1');
      expect(trusted?.provenance).toEqual({
        actor: 'main_agent',
        source_type: 'gateway',
      });
      expect(trusted?.source_refs).toEqual(['raw:already-trusted']);
    });
  });

  describe('AC #2: connector-event backfill preserves raw evidence hashes', () => {
    it('fills only explicit scope/cursor metadata and keeps content_hash unchanged', async () => {
      const adapter = getAdapter();
      const before = upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'slack-msg-1',
        content: 'legacy connector event',
        event_datetime: Date.parse('2026-04-29T04:00:00.000Z'),
      });

      const result = await backfillConnectorEventScopeMetadata({
        source_connector: 'slack',
        source_id: 'slack-msg-1',
        source_cursor: 'cursor-legacy',
        tenant_id: 'tenant-alpha',
        project_id: 'project-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'scope-project-a',
      });

      expect(result).toEqual({ scanned: 1, updated: 1 });
      const row = adapter
        .prepare(
          `
            SELECT content_hash, source_cursor, tenant_id, project_id, memory_scope_kind,
                   memory_scope_id
            FROM connector_event_index
            WHERE source_connector = 'slack' AND source_id = 'slack-msg-1'
          `
        )
        .get() as {
        content_hash: Buffer;
        source_cursor: string;
        tenant_id: string;
        project_id: string;
        memory_scope_kind: string;
        memory_scope_id: string;
      };

      expect(Buffer.from(row.content_hash).equals(before.content_hash)).toBe(true);
      expect(row.source_cursor).toBe('cursor-legacy');
      expect(row.tenant_id).toBe('tenant-alpha');
      expect(row.project_id).toBe('project-a');
      expect(row.memory_scope_kind).toBe('project');
      expect(row.memory_scope_id).toBe('scope-project-a');
    });
  });
});
