import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';
import { beginModelRunInAdapter, commitModelRunInAdapter } from '../../src/model-runs/store.js';
import {
  canonicalizeContextScopes,
  derivePrimaryContextScope,
} from '../../src/context-compile/visibility.js';
import type {
  ContextPacket,
  ContextPacketRecord,
  ContextRef,
} from '../../src/context-compile/types.js';
import {
  getContextPacket,
  getContextPacketForTrustedUse,
  insertContextPacket,
  listContextPacketsForModelRun,
} from '../../src/context-compile/packet-store.js';
import * as packetStore from '../../src/context-compile/packet-store.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempPaths = new Set<string>();

const SCOPES: MemoryScopeRef[] = [
  { kind: 'user', id: 'user-a' },
  { kind: 'project', id: 'repo-a' },
  { kind: 'channel', id: 'slack:eng' },
];

const SOURCE_REFS: ContextRef[] = [
  { kind: 'memory', id: 'mem-a' },
  { kind: 'raw', connector: 'slack', raw_id: 'raw-a', channel_id: 'slack:eng' },
];

function tempDbPath(): string {
  const path = join(os.tmpdir(), `test-context-packet-store-${randomUUID()}.db`);
  tempPaths.add(path);
  return path;
}

function cleanupDb(path: string): void {
  for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

function createAdapter(): DatabaseAdapter {
  const adapter = new NodeSQLiteAdapter({ dbPath: tempDbPath() }) as unknown as DatabaseAdapter;
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  return adapter;
}

function packet(overrides: Partial<ContextPacket> = {}): ContextPacket {
  const scopeInfo = canonicalizeContextScopes(SCOPES);
  return {
    packet_id: 'ctxp_a',
    task: 'compile branch context',
    scopes: scopeInfo.scopes,
    scope_hash: scopeInfo.scopeHash,
    generated_at: '2026-05-01T00:00:00.000Z',
    source_refs: SOURCE_REFS,
    selected_evidence: [
      {
        ref: SOURCE_REFS[0],
        title: 'Stored decision',
        excerpt: 'Use committed child model runs for context_compile.',
        score: 0.92,
        reasons: ['seed_match'],
        retrieval_diagnostics: { retrieval_source: 'memory' },
      },
    ],
    evidence_clusters: [{ id: 'cluster-a', refs: ['memory:mem-a'] }],
    related_decisions: [],
    rejected_refs: [],
    rejected_summary: [],
    missing_context: [],
    caveats: [],
    expansion_trace: [{ step: 'seed', refs: SOURCE_REFS.length }],
    retrieval_diagnostics: { strictness: 'medium' },
    budget: {
      max_tool_calls: 6,
      used_tool_calls: 2,
      max_ms: 8_000,
      elapsed_ms: 300,
      max_tokens: 8_000,
      estimated_tokens: 600,
    },
    ...overrides,
  };
}

function record(overrides: Partial<ContextPacketRecord> = {}): ContextPacketRecord {
  const scopeInfo = canonicalizeContextScopes(SCOPES);
  const primaryScope = derivePrimaryContextScope(scopeInfo.scopes);
  const storedPacket = packet({
    packet_id: overrides.packet_id ?? 'ctxp_a',
    task: overrides.task ?? 'compile branch context',
    scopes: scopeInfo.scopes,
    scope_hash: scopeInfo.scopeHash,
  });
  return {
    packet_id: storedPacket.packet_id,
    task: storedPacket.task,
    packet_json: JSON.stringify(storedPacket),
    packet: storedPacket,
    scope_json: scopeInfo.scopeJson,
    scopes: scopeInfo.scopes,
    scope_hash: scopeInfo.scopeHash,
    envelope_hash: 'env-a',
    model_run_id: 'mr-ctx-a',
    agent_id: 'agent-a',
    input_snapshot_ref: 'snapshot:turn-a',
    source_refs_json: JSON.stringify(SOURCE_REFS),
    source_refs: SOURCE_REFS,
    tenant_id: 'default',
    project_id: 'repo-a',
    memory_scope_kind: primaryScope.kind,
    memory_scope_id: primaryScope.id,
    created_at: 1_000,
    ...overrides,
  };
}

describe('STORY-CC-B2: Context packet append-only store - AC1, AC2, AC3', () => {
  afterEach(() => {
    for (const path of tempPaths) {
      cleanupDb(path);
    }
    tempPaths.clear();
  });

  describe('AC1: packet persistence is append-only and lossless', () => {
    it('inserts and reads packet JSON, source refs, and multi-scope visibility fields', () => {
      const adapter = createAdapter();
      const inserted = insertContextPacket(adapter, record());

      expect(inserted).toMatchObject({
        packet_id: 'ctxp_a',
        task: 'compile branch context',
        envelope_hash: 'env-a',
        model_run_id: 'mr-ctx-a',
        agent_id: 'agent-a',
        input_snapshot_ref: 'snapshot:turn-a',
        tenant_id: 'default',
        project_id: 'repo-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'repo-a',
      });

      const found = getContextPacket(adapter, 'ctxp_a');
      expect(found?.packet).toEqual(inserted.packet);
      expect(found?.scopes).toEqual(canonicalizeContextScopes(SCOPES).scopes);
      expect(found?.source_refs).toEqual(SOURCE_REFS);
      expect(found?.scope_hash).toBe(canonicalizeContextScopes(SCOPES).scopeHash);
    });

    it('rejects duplicate packet ids and leaves the original packet untouched', () => {
      const adapter = createAdapter();
      insertContextPacket(adapter, record());

      expect(() =>
        insertContextPacket(
          adapter,
          record({
            task: 'mutated task',
            packet_json: JSON.stringify(packet({ task: 'mutated task' })),
          })
        )
      ).toThrow(/constraint|unique/i);

      expect(getContextPacket(adapter, 'ctxp_a')?.task).toBe('compile branch context');
      expect(getContextPacket(adapter, 'ctxp_a')?.packet.task).toBe('compile branch context');
    });

    it('keeps two packets for the same task when packet ids differ', () => {
      const adapter = createAdapter();
      insertContextPacket(adapter, record({ packet_id: 'ctxp_a', created_at: 1_000 }));
      insertContextPacket(adapter, record({ packet_id: 'ctxp_b', created_at: 1_100 }));

      expect(
        listContextPacketsForModelRun(adapter, 'mr-ctx-a').map((row) => row.packet_id)
      ).toEqual(['ctxp_b', 'ctxp_a']);
    });

    it('exports no update helper for context packets', () => {
      expect('updateContextPacket' in packetStore).toBe(false);
      expect('upsertContextPacket' in packetStore).toBe(false);
    });
  });

  describe('AC2: storage failures are explicit', () => {
    it('validates packet JSON before inserting a context packet row', () => {
      const adapter = createAdapter();

      expect(() => insertContextPacket(adapter, record({ packet_json: '{not-json' }))).toThrow(
        /packet_json/
      );

      const row = adapter.prepare('SELECT COUNT(*) AS count FROM context_packets').get() as {
        count: number;
      };
      expect(row.count).toBe(0);
    });

    it('validates created_at before inserting a context packet row', () => {
      const adapter = createAdapter();

      expect(() =>
        insertContextPacket(
          adapter,
          record({ created_at: 'not-a-date' as unknown as ContextPacketRecord['created_at'] })
        )
      ).toThrow(/created_at/);

      const row = adapter.prepare('SELECT COUNT(*) AS count FROM context_packets').get() as {
        count: number;
      };
      expect(row.count).toBe(0);
    });

    it('throws instead of returning fallback fields when stored packet JSON is corrupt', () => {
      const adapter = createAdapter();
      insertContextPacket(adapter, record());

      adapter
        .prepare('UPDATE context_packets SET packet_json = ? WHERE packet_id = ?')
        .run('{not-json', 'ctxp_a');

      expect(() => getContextPacket(adapter, 'ctxp_a')).toThrow(/packet_json/);
    });
  });

  describe('AC3: trusted lookup validates envelope and committed model run ownership', () => {
    it('returns committed packets and rejects running or wrong-envelope packets', () => {
      const adapter = createAdapter();
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr-ctx-a',
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        input_snapshot_ref: 'snapshot:turn-a',
      });
      commitModelRunInAdapter(adapter, 'mr-ctx-a', 'context packet created');
      insertContextPacket(adapter, record());

      expect(
        getContextPacketForTrustedUse(adapter, {
          packetId: 'ctxp_a',
          envelopeHash: 'env-a',
          modelRunId: 'mr-ctx-a',
        })?.packet_id
      ).toBe('ctxp_a');

      expect(() =>
        getContextPacketForTrustedUse(adapter, {
          packetId: 'ctxp_a',
          envelopeHash: 'env-b',
          modelRunId: 'mr-ctx-a',
        })
      ).toThrow(/envelope/i);

      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr-ctx-running',
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        input_snapshot_ref: 'snapshot:turn-running',
      });
      insertContextPacket(
        adapter,
        record({
          packet_id: 'ctxp_running',
          model_run_id: 'mr-ctx-running',
          input_snapshot_ref: 'snapshot:turn-running',
        })
      );

      expect(() =>
        getContextPacketForTrustedUse(adapter, {
          packetId: 'ctxp_running',
          envelopeHash: 'env-a',
          modelRunId: 'mr-ctx-running',
        })
      ).toThrow(/committed/i);
    });

    it('allows trusted packet reuse by descendants and siblings in the same model-run lineage', () => {
      const adapter = createAdapter();
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr_parent',
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        input_snapshot_ref: 'snapshot:parent',
      });
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr_context_child',
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        parent_model_run_id: 'mr_parent',
        input_snapshot_ref: 'context_compile:ctxp_a',
      });
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr_grandchild',
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        parent_model_run_id: 'mr_context_child',
        input_snapshot_ref: 'snapshot:grandchild',
      });
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr_sibling',
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        parent_model_run_id: 'mr_parent',
        input_snapshot_ref: 'snapshot:sibling',
      });
      beginModelRunInAdapter(adapter, {
        model_run_id: 'mr_other_root',
        envelope_hash: 'env-a',
        agent_id: 'agent-a',
        input_snapshot_ref: 'snapshot:other-root',
      });
      commitModelRunInAdapter(adapter, 'mr_context_child', 'context packet created');
      insertContextPacket(adapter, record({ model_run_id: 'mr_context_child' }));

      expect(
        getContextPacketForTrustedUse(adapter, {
          packetId: 'ctxp_a',
          envelopeHash: 'env-a',
          callerModelRunId: 'mr_grandchild',
        })?.packet_id
      ).toBe('ctxp_a');
      expect(
        getContextPacketForTrustedUse(adapter, {
          packetId: 'ctxp_a',
          envelopeHash: 'env-a',
          callerModelRunId: 'mr_sibling',
        })?.packet_id
      ).toBe('ctxp_a');
      expect(() =>
        getContextPacketForTrustedUse(adapter, {
          packetId: 'ctxp_a',
          envelopeHash: 'env-a',
          callerModelRunId: 'mr_other_root',
        })
      ).toThrow(/lineage/i);
    });
  });
});
