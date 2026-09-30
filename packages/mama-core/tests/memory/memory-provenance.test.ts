import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB } from '../../src/db-manager.js';
import {
  ingestConversation,
  ingestMemory,
  saveJudgmentRecord,
  saveMemory,
} from '../../src/memory/api.js';
import { getMemoryProvenance } from '../../src/memory/provenance-query.js';
import { normalizeMemoryWriteProvenance } from '../../src/memory/provenance.js';
import { listMemoryEventsForMemory } from '../../src/memory/event-store.js';
import { queryRelevantTruth } from '../../src/memory/truth-store.js';
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
  // Capture the pre-suite value so teardown restores it instead of unconditionally
  // deleting the process-level variable a neighboring file may have set (singleFork
  // shares one process). Same pattern as unit/memory-v2-api.test.ts.
  const originalForceTier3 = process.env.MAMA_FORCE_TIER_3;
  beforeEach(async () => {
    await closeDB();
    cleanupDb();
    process.env.MAMA_DB_PATH = TEST_DB;
    process.env.MAMA_FORCE_TIER_3 = 'true';
    await initDB();
  });

  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    if (originalForceTier3 === undefined) {
      delete process.env.MAMA_FORCE_TIER_3;
    } else {
      process.env.MAMA_FORCE_TIER_3 = originalForceTier3;
    }
    cleanupDb();
  });

  describe('AC: action writes persist compact provenance and save events', () => {
    it('records a save memory event and nullable provenance columns for an action save', async () => {
      const result = await saveJudgmentRecord(
        getAdapter(),
        {
          topic: 'm2_provenance_contract',
          kind: 'decision',
          summary: 'Memory writes should explain origin',
          details: 'Operators need memory origin for correction',
          confidence: 0.9,
          scopes: [PROJECT_SCOPE],
          source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        },
        { principalId: 'agent-main', agentId: 'agent-main', scopes: [PROJECT_SCOPE] },
        'test-cmd-provenance',
        {
          actor: 'main_agent',
          envelopeHash: 'env_test_hash',
          toolName: 'mama_save',
          gatewayCallId: 'gw_test_1',
          sourceTurnId: 'turn_test_1',
          sourceMessageRef: 'discord:channel:turn_test_1',
          sourceRefs: ['conversation:test'],
        }
      );

      const provenance = await getMemoryProvenance(getAdapter(), result.id);
      expect(provenance?.memory_id).toBe(result.id);
      expect(provenance?.agent_id).toBe('agent-main');
      expect(provenance?.envelope_hash).toBe('env_test_hash');
      expect(provenance?.gateway_call_id).toBe('gw_test_1');
      expect(provenance?.source_refs).toEqual(['conversation:test']);
      expect(provenance?.latest_event?.event_type).toBe('save');
      expect(provenance?.latest_event?.actor).toBe('main_agent');
      expect(provenance?.latest_event?.source_turn_id).toBe('turn_test_1');
    });

    it('sanitizes non-allowlisted fields from write provenance', async () => {
      const normalized = normalizeMemoryWriteProvenance({
        actor: 'main_agent',
        envelope_hash: 'env_sanitized',
        tool_name: 'mama_save',
        prompt: 'raw prompt must not persist',
        messages: [{ role: 'user', content: 'secret' }],
        tool_args: { topic: 'secret' },
        result: { ok: true },
        unsupported_field: 'must not persist',
        source_refs: ['message:test'],
      } as never);

      expect(normalized.provenance).toMatchObject({
        actor: 'main_agent',
        envelope_hash: 'env_sanitized',
        tool_name: 'mama_save',
      });
      expect(normalized.provenance).not.toHaveProperty('prompt');
      expect(normalized.provenance).not.toHaveProperty('messages');
      expect(normalized.provenance).not.toHaveProperty('tool_args');
      expect(normalized.provenance).not.toHaveProperty('result');
      expect(normalized.provenance).not.toHaveProperty('unsupported_field');
      expect(normalized.source_refs).toEqual(['message:test']);
    });

    it('preserves context_packet_id in compact provenance only', async () => {
      const result = await saveJudgmentRecord(
        getAdapter(),
        {
          topic: 'context_packet_provenance_contract',
          kind: 'decision',
          summary: 'Context packets can own downstream write provenance',
          details: 'The packet id belongs in compact provenance, not source refs',
          scopes: [PROJECT_SCOPE],
          source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        },
        { principalId: 'agent-main', agentId: 'agent-main', scopes: [PROJECT_SCOPE] },
        'test-cmd-context-packet',
        {
          actor: 'main_agent',
          envelopeHash: 'env_context_packet',
          modelRunId: 'mr_parent_context_packet',
          toolName: 'mama_save',
          gatewayCallId: 'gw_context_packet',
          contextPacketId: 'ctxp_trusted_packet',
          sourceRefs: ['memory:mem-1'],
        }
      );

      const provenance = await getMemoryProvenance(getAdapter(), result.id);
      expect(provenance?.provenance).toMatchObject({
        context_packet_id: 'ctxp_trusted_packet',
      });
      expect(provenance?.source_refs).toEqual(['memory:mem-1']);

      const row = getAdapter()
        .prepare('SELECT source_refs_json, provenance_json FROM decisions WHERE id = ?')
        .get(result.id) as { source_refs_json: string; provenance_json: string };
      expect(JSON.parse(row.source_refs_json)).toEqual(['memory:mem-1']);
      expect(JSON.parse(row.provenance_json)).toMatchObject({
        context_packet_id: 'ctxp_trusted_packet',
      });
    });

    it('keeps a stale decision out of current truth', async () => {
      const stagedMemory = await saveMemory(getAdapter(), {
        topic: 'manual_staged_truth_projection_contract',
        kind: 'decision',
        summary: 'Stage reviewed manual memory before cursor commit',
        details: 'The staged memory must not appear in truth snapshots before promotion.',
        confidence: 0.9,
        status: 'stale',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
      });

      expect(
        getAdapter().prepare('SELECT status FROM decisions WHERE id = ?').get(stagedMemory.id)
      ).toEqual({ status: 'stale' });
      expect(
        (
          await queryRelevantTruth(getAdapter(), {
            query: 'manual staged truth projection',
            scopes: [PROJECT_SCOPE],
            includeHistory: true,
          })
        ).some((row) => row.memory_id === stagedMemory.id)
      ).toBe(true);
      expect(
        (
          await queryRelevantTruth(getAdapter(), {
            query: 'manual staged truth projection',
            scopes: [PROJECT_SCOPE],
            includeHistory: false,
          })
        ).some((row) => row.memory_id === stagedMemory.id)
      ).toBe(false);
    });
  });

  describe('AC: direct public writes get honest fallback provenance', () => {
    it('inserts a save event with actor:direct_client and no fabricated ids', async () => {
      const result = await saveMemory(getAdapter(), {
        topic: 'direct_save_fallback',
        kind: 'decision',
        summary: 'Direct saves still get a save event',
        details: 'Fallback provenance is honest and nullable',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
      });

      const provenance = await getMemoryProvenance(getAdapter(), result.id);
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
        provenance: {
          envelope_hash: 'attacker_env',
          gateway_call_id: 'attacker_gw',
          context_packet_id: 'ctxp_attacker',
        },
      } as never);

      const provenance = await getMemoryProvenance(getAdapter(), result.id);
      expect(provenance?.envelope_hash).toBeNull();
      expect(provenance?.gateway_call_id).toBeNull();
      expect(provenance?.provenance).not.toHaveProperty('context_packet_id');
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
      const result = await ingestMemory(getAdapter(), {
        content: 'Public ingest should not trust caller provenance',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        provenance: { envelope_hash: 'attacker_env', gateway_call_id: 'attacker_gw' },
      } as never);

      // Raw ingest stores an observation, not a judgment: no decisions row
      // exists for the observation id, so decision provenance stays null.
      expect(await getMemoryProvenance(getAdapter(), result.id)).toBeNull();
      const events = await listMemoryEventsForMemory(getAdapter(), result.id);
      expect(events[0]?.actor).toBe('actor:direct_client');
      const observation = getAdapter()
        .prepare('SELECT metadata_json FROM observation_versions WHERE observation_id = ?')
        .get(result.id) as { metadata_json: string } | undefined;
      expect(observation?.metadata_json).toBeDefined();
      expect(observation!.metadata_json).not.toContain('attacker_env');
      expect(observation!.metadata_json).not.toContain('attacker_gw');
    });
  });

  describe('AC: ingest conversation stores raw observations only', () => {
    it('stores one observation and rejects extraction', async () => {
      const result = await ingestConversation(getAdapter(), {
        messages: [{ role: 'user', content: 'We decided to keep provenance compact.' }],
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
      });

      expect(result.extractedMemories).toEqual([]);
      // The raw observation is evidence, not a judgment: no decisions row, so
      // decision-level provenance queries return nothing for it.
      expect(await getMemoryProvenance(getAdapter(), result.rawId)).toBeNull();
      expect(
        getAdapter()
          .prepare('SELECT COUNT(*) AS n FROM observation_versions WHERE observation_id = ?')
          .get(result.rawId)
      ).toEqual({ n: 1 });
      const events = await listMemoryEventsForMemory(getAdapter(), result.rawId);
      expect(events[0]?.actor).toBe('actor:direct_client');

      // The removed extract option is rejected before any write.
      const before = {
        observations: (
          getAdapter().prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as {
            n: number;
          }
        ).n,
        decisions: (
          getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get() as {
            n: number;
          }
        ).n,
      };
      await expect(
        ingestConversation(getAdapter(), {
          messages: [{ role: 'user', content: 'Extract attempt must not write.' }],
          scopes: [PROJECT_SCOPE],
          source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
          extract: { enabled: true, apiKey: 'test-key' },
        } as never)
      ).rejects.toThrow(/extract/);
      expect(
        (
          getAdapter().prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as {
            n: number;
          }
        ).n
      ).toBe(before.observations);
      expect(
        (getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n
      ).toBe(before.decisions);
    });

    it('keeps public ingestConversation caller-supplied provenance out of stored provenance', async () => {
      const result = await ingestConversation(getAdapter(), {
        messages: [{ role: 'user', content: 'Public ingest conversation spoof attempt.' }],
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
        provenance: { envelope_hash: 'attacker_env', gateway_call_id: 'attacker_gw' },
      } as never);

      expect(await getMemoryProvenance(getAdapter(), result.rawId)).toBeNull();
      const events = await listMemoryEventsForMemory(getAdapter(), result.rawId);
      expect(events[0]?.actor).toBe('actor:direct_client');
      const observation = getAdapter()
        .prepare('SELECT metadata_json FROM observation_versions WHERE observation_id = ?')
        .get(result.rawId) as { metadata_json: string } | undefined;
      expect(observation?.metadata_json).toBeDefined();
      expect(observation!.metadata_json).not.toContain('attacker_env');
      expect(observation!.metadata_json).not.toContain('attacker_gw');
    });
  });

  describe('AC: event readers expose memory-specific save events', () => {
    it('lists memory events by memory id newest first', async () => {
      const result = await saveMemory(getAdapter(), {
        topic: 'memory_event_reader_contract',
        kind: 'decision',
        summary: 'Events can be read by memory id',
        details: 'Operator provenance views need the latest save event',
        scopes: [PROJECT_SCOPE],
        source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
      });

      const events = await listMemoryEventsForMemory(getAdapter(), result.id);
      expect(events[0]).toMatchObject({
        event_type: 'save',
        memory_id: result.id,
        actor: 'actor:direct_client',
      });
    });
  });
});
