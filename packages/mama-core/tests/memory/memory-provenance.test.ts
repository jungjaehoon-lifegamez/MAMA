import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter } from '../../src/db-manager.js';
import {
  ingestConversation,
  ingestConversationWithTrustedProvenance,
  ingestMemory,
  saveMemory,
  saveMemoryWithTrustedProvenance,
  setExtractionFn,
} from '../../src/memory/api.js';
import {
  getMemoryProvenance,
  listMemoriesByGatewayCallId,
} from '../../src/memory/provenance-query.js';
import { createTrustedProvenanceCapability } from '../../src/memory/provenance.js';
import { listMemoryEventsForMemory } from '../../src/memory/event-store.js';
import mama from '../../src/mama-api.js';

const TEST_DB = path.join(os.tmpdir(), `test-memory-provenance-${randomUUID()}.db`);
const PROJECT_SCOPE = { kind: 'project' as const, id: 'repo:m2-provenance' };

function cleanupDb(): void {
  for (const file of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // cleanup best effort
    }
  }
}

describe('Story M2.1: Memory Write Provenance Foundation', () => {
  beforeEach(async () => {
    await closeDB();
    cleanupDb();
    process.env.MAMA_DB_PATH = TEST_DB;
    process.env.MAMA_FORCE_TIER_3 = 'true';
  });

  afterEach(async () => {
    setExtractionFn(null);
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    delete process.env.MAMA_FORCE_TIER_3;
    cleanupDb();
  });

  describe('AC: trusted writes persist compact provenance and save events', () => {
    it('records a save memory event and nullable provenance columns for a trusted save', async () => {
      const capability = createTrustedProvenanceCapability();

      const result = await saveMemoryWithTrustedProvenance(
        {
          topic: 'm2_provenance_contract',
          kind: 'decision',
          summary: 'Memory writes should explain origin',
          details: 'Operators need memory origin for correction',
          confidence: 0.9,
          scopes: [PROJECT_SCOPE],
          source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        },
        {
          capability,
          provenance: {
            actor: 'main_agent',
            agent_id: 'agent-main',
            envelope_hash: 'env_test_hash',
            tool_name: 'mama_save',
            gateway_call_id: 'gw_test_1',
            source_turn_id: 'turn_test_1',
            source_message_ref: 'discord:channel:turn_test_1',
            source_refs: ['conversation:test'],
          },
        }
      );

      const provenance = await getMemoryProvenance(result.id);
      expect(provenance?.memory_id).toBe(result.id);
      expect(provenance?.agent_id).toBe('agent-main');
      expect(provenance?.envelope_hash).toBe('env_test_hash');
      expect(provenance?.gateway_call_id).toBe('gw_test_1');
      expect(provenance?.source_refs).toEqual(['conversation:test']);
      expect(provenance?.latest_event?.event_type).toBe('save');
      expect(provenance?.latest_event?.actor).toBe('main_agent');
      expect(provenance?.latest_event?.source_turn_id).toBe('turn_test_1');
    });

    it('rejects plain-object capability spoofing for trusted writes', async () => {
      await expect(
        saveMemoryWithTrustedProvenance(
          {
            topic: 'plain_object_capability_spoof',
            kind: 'decision',
            summary: 'Plain JSON must not unlock trusted provenance',
            details: 'The trusted path requires a non-serializable capability',
            scopes: [PROJECT_SCOPE],
            source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
          },
          {
            capability: {} as never,
            provenance: {
              actor: 'main_agent',
              envelope_hash: 'env_spoof',
            },
          }
        )
      ).rejects.toThrow(/trusted provenance capability/i);
    });

    it('sanitizes non-allowlisted fields from trusted provenance', async () => {
      const capability = createTrustedProvenanceCapability();

      const result = await saveMemoryWithTrustedProvenance(
        {
          topic: 'provenance_payload_boundary',
          kind: 'decision',
          summary: 'Provenance stays compact',
          details: 'Prompt and tool payloads do not belong in memory provenance',
          scopes: [PROJECT_SCOPE],
          source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        },
        {
          capability,
          provenance: {
            actor: 'main_agent',
            envelope_hash: 'env_sanitized',
            tool_name: 'mama_save',
            prompt: 'raw prompt must not persist',
            messages: [{ role: 'user', content: 'secret' }],
            tool_args: { topic: 'secret' },
            result: { ok: true },
            unsupported_field: 'must not persist',
            source_refs: ['message:test'],
          } as never,
        }
      );

      const provenance = await getMemoryProvenance(result.id);
      expect(provenance?.provenance).toMatchObject({
        actor: 'main_agent',
        envelope_hash: 'env_sanitized',
        tool_name: 'mama_save',
      });
      expect(provenance?.provenance).not.toHaveProperty('prompt');
      expect(provenance?.provenance).not.toHaveProperty('messages');
      expect(provenance?.provenance).not.toHaveProperty('tool_args');
      expect(provenance?.provenance).not.toHaveProperty('result');
      expect(provenance?.provenance).not.toHaveProperty('unsupported_field');
    });
  });

  describe('AC: direct public writes get honest fallback provenance', () => {
    it('inserts a save event with actor:direct_client and no fabricated ids', async () => {
      const result = await saveMemory({
        topic: 'direct_save_fallback',
        kind: 'decision',
        summary: 'Direct saves still get a save event',
        details: 'Fallback provenance is honest and nullable',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
      });

      const provenance = await getMemoryProvenance(result.id);
      expect(provenance?.latest_event?.event_type).toBe('save');
      expect(provenance?.latest_event?.actor).toBe('actor:direct_client');
      expect(provenance?.envelope_hash).toBeNull();
      expect(provenance?.gateway_call_id).toBeNull();
      expect(provenance?.model_run_id).toBeNull();
    });

    it('keeps public mama.save caller-supplied provenance out of stored provenance', async () => {
      const result = await mama.save({
        topic: 'public_spoofing_boundary',
        decision: 'Public callers cannot choose envelope evidence',
        reasoning: 'Only internal trusted options can set provenance ids',
        confidence: 0.8,
        scopes: [PROJECT_SCOPE],
        provenance: { envelope_hash: 'attacker_env', gateway_call_id: 'attacker_gw' },
      } as never);

      const provenance = await getMemoryProvenance(result.id);
      expect(provenance?.envelope_hash).toBeNull();
      expect(provenance?.gateway_call_id).toBeNull();
      expect(provenance?.latest_event?.actor).toBe('actor:direct_client');
    });

    it('preserves existing public save fields while stripping caller provenance', async () => {
      const observedAt = Date.parse('2026-04-29T10:00:00.000Z');
      const result = await mama.saveMemory({
        topic: 'public_wrapper_compatibility',
        kind: 'decision',
        summary: 'Public wrappers preserve existing fields',
        details: 'Compatibility wrappers strip only provenance',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        eventDateTime: observedAt,
        entityObservationIds: [],
        timelineEvent: {
          event_type: 'project_update',
          summary: 'Compatibility event',
        },
        excludeIds: [],
        provenance: { envelope_hash: 'attacker_env' },
      } as never);

      const row = getAdapter()
        .prepare('SELECT event_datetime, envelope_hash FROM decisions WHERE id = ?')
        .get(result.id) as { event_datetime: number | null; envelope_hash: string | null };
      expect(row.event_datetime).toBe(observedAt);
      expect(row.envelope_hash).toBeNull();
    });

    it('keeps public ingestMemory caller-supplied provenance out of stored provenance', async () => {
      const result = await ingestMemory({
        content: 'Public ingest should not trust caller provenance',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        provenance: { envelope_hash: 'attacker_env', gateway_call_id: 'attacker_gw' },
      } as never);

      const provenance = await getMemoryProvenance(result.id);
      expect(provenance?.envelope_hash).toBeNull();
      expect(provenance?.gateway_call_id).toBeNull();
      expect(provenance?.latest_event?.actor).toBe('actor:direct_client');
    });
  });

  describe('AC: ingest conversation provenance covers raw and extracted memories', () => {
    it('propagates trusted provenance to raw and extracted memories with raw source refs', async () => {
      setExtractionFn(async () => [
        {
          topic: 'extracted_fact',
          kind: 'fact',
          summary: 'Extracted fact summary',
          details: 'Extracted fact details',
          confidence: 0.7,
        },
      ]);

      const capability = createTrustedProvenanceCapability();
      const result = await ingestConversationWithTrustedProvenance(
        {
          messages: [{ role: 'user', content: 'We decided to keep provenance compact.' }],
          scopes: [PROJECT_SCOPE],
          source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
          extract: { enabled: true, apiKey: 'test-key' },
        },
        {
          capability,
          provenance: {
            actor: 'main_agent',
            envelope_hash: 'env_ingest',
            gateway_call_id: 'gw_ingest_1',
            tool_name: 'ingest_conversation',
            source_refs: ['message:conversation'],
          },
        }
      );

      expect(result.extractedMemories).toHaveLength(1);
      const rawProvenance = await getMemoryProvenance(result.rawId);
      const extractedProvenance = await getMemoryProvenance(result.extractedMemories[0].id);
      expect(rawProvenance?.gateway_call_id).toBe('gw_ingest_1');
      expect(extractedProvenance?.gateway_call_id).toBe('gw_ingest_1');
      expect(extractedProvenance?.source_refs).toContain(`raw_memory:${result.rawId}`);

      const byGatewayCall = await listMemoriesByGatewayCallId('gw_ingest_1');
      expect(byGatewayCall.map((item) => item.memory_id).sort()).toEqual(
        [result.rawId, result.extractedMemories[0].id].sort()
      );
    });

    it('keeps public ingestConversation caller-supplied provenance out of stored provenance', async () => {
      const result = await ingestConversation({
        messages: [{ role: 'user', content: 'Public ingest conversation spoof attempt.' }],
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        extract: { enabled: false },
        provenance: { envelope_hash: 'attacker_env', gateway_call_id: 'attacker_gw' },
      } as never);

      const provenance = await getMemoryProvenance(result.rawId);
      expect(provenance?.envelope_hash).toBeNull();
      expect(provenance?.gateway_call_id).toBeNull();
      expect(provenance?.latest_event?.actor).toBe('actor:direct_client');
    });
  });

  describe('AC: event readers expose memory-specific save events', () => {
    it('lists memory events by memory id newest first', async () => {
      const result = await saveMemory({
        topic: 'memory_event_reader_contract',
        kind: 'decision',
        summary: 'Events can be read by memory id',
        details: 'Operator provenance views need the latest save event',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
      });

      const events = await listMemoryEventsForMemory(result.id);
      expect(events[0]).toMatchObject({
        event_type: 'save',
        memory_id: result.id,
        actor: 'actor:direct_client',
      });
    });
  });
});
