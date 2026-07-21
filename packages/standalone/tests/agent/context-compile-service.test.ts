import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginModelRunInAdapter,
  commitModelRunInAdapter,
  getContextPacket,
  getModelRunInAdapter,
  type ContextCompileInput,
  type ContextPacket,
} from '../../../mama-core/src/index.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';

import { createContextCompileService } from '../../src/agent/context-compile-service.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

const FIXED_NOW_MS = Date.parse('2026-04-30T09:00:00.000Z');

function makePacket(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    packet_id: 'ctxp_service_test',
    task: 'compile branch context',
    scopes: [{ kind: 'project', id: '/workspace/project-a' }],
    scope_hash: 'scope-hash',
    generated_at: new Date(FIXED_NOW_MS).toISOString(),
    source_refs: [{ kind: 'memory', id: 'mem-alpha' }],
    selected_evidence: [
      {
        ref: { kind: 'memory', id: 'mem-alpha' },
        title: 'Alpha',
        excerpt: 'Visible evidence',
        score: 0.91,
      },
    ],
    evidence_clusters: [],
    related_decisions: [],
    rejected_refs: [],
    rejected_summary: [],
    missing_context: [],
    caveats: [],
    expansion_trace: [],
    retrieval_diagnostics: { retrieval_source: 'test' },
    budget: {
      used_tool_calls: 1,
      elapsed_ms: 5,
      estimated_tokens: 32,
      budget_exhausted: false,
    },
    mode: 'general',
    compiler_version: 'context-compile-v0',
    rejected_refs_truncated: false,
    budget_manifest: { budget_exhausted: false, skipped_operators: [] },
    ...overrides,
  };
}

function countRows(table: string): number {
  return (getAdapter().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

describe('STORY-B5: context compile shared service - AC1-AC6', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('context-compile-service');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM context_packets').run();
    adapter.prepare('DELETE FROM model_runs').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('AC: creates a dedicated committed child model_run and leaves the parent run running', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    beginModelRunInAdapter(adapter, {
      model_run_id: 'mr_parent_agent_loop',
      agent_id: envelope.agent_id,
      instance_id: envelope.instance_id,
      envelope_hash: envelope.envelope_hash,
      input_snapshot_ref: 'agent-loop:turn-1',
      input_refs: { tool: 'agent.loop', turn_id: 'turn-1' },
    });
    const compileContext = vi.fn(
      async (input: ContextCompileInput, deps: { packetId?: () => string }) =>
        makePacket({
          packet_id: deps.packetId?.() ?? 'ctxp_child_owned',
          task: input.task,
          scopes: input.scopes,
        })
    );
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      now: () => FIXED_NOW_MS,
      childModelRunId: () => 'mr_context_child',
      packetId: () => 'ctxp_child_owned',
    });

    const result = await service.compileAndPersistContext({
      caller: 'gateway',
      envelope,
      modelRunId: 'mr_parent_agent_loop',
      input: {
        task: 'compile branch context',
        limit: 5,
        max_tool_calls: 2,
      },
    });

    expect(result.packet.packet_id).toBe('ctxp_child_owned');
    expect(compileContext).toHaveBeenCalledTimes(1);
    expect(compileContext.mock.calls[0][0]).toMatchObject({
      task: 'compile branch context',
      scopes: [{ kind: 'project', id: '/workspace/project-a' }],
      connectors: ['telegram'],
      project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
      tenant_id: 'default',
      limit: 5,
      max_tool_calls: 2,
    });
    expect(compileContext.mock.calls[0][1]).toMatchObject({
      boundary: {
        scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        connectors: ['telegram'],
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        tenant_id: 'default',
      },
    });

    expect(getModelRunInAdapter(adapter, 'mr_parent_agent_loop')).toMatchObject({
      status: 'running',
    });
    expect(getModelRunInAdapter(adapter, 'mr_context_child')).toMatchObject({
      status: 'committed',
      parent_model_run_id: 'mr_parent_agent_loop',
      envelope_hash: envelope.envelope_hash,
      agent_id: envelope.agent_id,
      instance_id: envelope.instance_id,
      input_snapshot_ref: 'context_compile:ctxp_child_owned',
    });
    const inserted = getContextPacket(adapter, 'ctxp_child_owned');
    expect(inserted).toMatchObject({
      packet_id: 'ctxp_child_owned',
      model_run_id: 'mr_context_child',
      envelope_hash: envelope.envelope_hash,
      agent_id: envelope.agent_id,
    });

    commitModelRunInAdapter(adapter, 'mr_parent_agent_loop', 'agent loop completed');
    expect(getModelRunInAdapter(adapter, 'mr_parent_agent_loop')).toMatchObject({
      status: 'committed',
    });
  });

  it('AC: normalizes compile filters before validation, compilation, and provenance storage', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const compileContext = vi.fn(
      async (input: ContextCompileInput, deps: { packetId?: () => string }) =>
        makePacket({
          packet_id: deps.packetId?.() ?? 'ctxp_normalized_filters',
          task: input.task,
          scopes: input.scopes,
          source_refs: input.seed_refs ?? [],
        })
    );
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      now: () => FIXED_NOW_MS,
      childModelRunId: () => 'mr_context_normalized_filters',
      packetId: () => 'ctxp_normalized_filters',
    });

    await service.compileAndPersistContext({
      caller: 'gateway',
      envelope,
      input: {
        task: ' compile branch context ',
        scopes: [{ kind: 'project', id: ' /workspace/project-a ' }],
        connectors: [' telegram '],
        project_refs: [{ kind: 'project', id: ' /workspace/project-a ' }],
        tenant_id: ' default ',
        seed_refs: [{ kind: 'memory', id: ' mem-alpha ' }],
      },
    });

    expect(compileContext.mock.calls[0][0]).toMatchObject({
      task: 'compile branch context',
      scopes: [{ kind: 'project', id: '/workspace/project-a' }],
      connectors: ['telegram'],
      project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
      tenant_id: 'default',
      seed_refs: [{ kind: 'memory', id: 'mem-alpha' }],
    });
    expect(
      getModelRunInAdapter(adapter, 'mr_context_normalized_filters')?.input_refs
    ).toMatchObject({
      task_ref: {
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        length: 'compile branch context'.length,
      },
      connectors: ['telegram'],
      project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
      tenant_id: 'default',
      seed_refs: [{ kind: 'memory', id: 'mem-alpha' }],
    });
    expect(
      getModelRunInAdapter(adapter, 'mr_context_normalized_filters')?.input_refs
    ).not.toHaveProperty('task');
  });

  it('AC: rechecks host authority after compilation and before packet persistence', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const beforePersist = vi.fn(() => {
      throw new Error('temporal authority superseded');
    });
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext: vi.fn(async (_input, deps: { packetId?: () => string }) =>
        makePacket({ packet_id: deps.packetId?.() ?? 'ctxp_revoked' })
      ),
      childModelRunId: () => 'mr_context_revoked',
      packetId: () => 'ctxp_revoked',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: { task: 'private connector evidence' },
        beforePersist,
      })
    ).rejects.toThrow('temporal authority superseded');

    expect(beforePersist).toHaveBeenCalledTimes(1);
    expect(getContextPacket(adapter, 'ctxp_revoked')).toBeNull();
    expect(getModelRunInAdapter(adapter, 'mr_context_revoked')).toMatchObject({
      status: 'failed',
    });
  });

  it('AC: does not store non-project scope ids in context packet project_id', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope({
      scope: {
        project_refs: [],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'channel', id: 'tg:1' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
      },
    });
    const compileContext = vi.fn(
      async (input: ContextCompileInput, deps: { packetId?: () => string }) =>
        makePacket({
          packet_id: deps.packetId?.() ?? 'ctxp_channel_scope',
          task: input.task,
          scopes: input.scopes,
        })
    );
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      now: () => FIXED_NOW_MS,
      childModelRunId: () => 'mr_context_channel_scope',
      packetId: () => 'ctxp_channel_scope',
    });

    await service.compileAndPersistContext({
      caller: 'gateway',
      envelope,
      input: {
        task: 'compile channel context',
      },
    });

    expect(getContextPacket(adapter, 'ctxp_channel_scope')).toMatchObject({
      project_id: '',
      memory_scope_kind: 'channel',
      memory_scope_id: 'tg:1',
    });
  });

  it('AC: clamps request as_of to the worker envelope snapshot', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
        as_of: '1970-01-01T00:00:01.500Z',
      },
    });
    const compileContext = vi.fn(
      async (input: ContextCompileInput, deps: { packetId?: () => string }) =>
        makePacket({
          packet_id: deps.packetId?.() ?? 'ctxp_asof_clamped',
          task: input.task,
          scopes: input.scopes,
        })
    );
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      childModelRunId: () => 'mr_context_asof',
      packetId: () => 'ctxp_asof_clamped',
    });

    await service.compileAndPersistContext({
      caller: 'gateway',
      envelope,
      input: {
        task: 'compile branch context',
        as_of: '1970-01-01T00:00:03.000Z',
      },
    });

    expect(compileContext.mock.calls[0][0]).toMatchObject({
      as_of: '1970-01-01T00:00:01.500Z',
    });
    expect(getModelRunInAdapter(adapter, 'mr_context_asof')?.input_refs).toMatchObject({
      as_of: '1970-01-01T00:00:01.500Z',
    });
  });

  it('AC: validates and clamps numeric compile budgets before compiling', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const compileContext = vi.fn(
      async (input: ContextCompileInput, deps: { packetId?: () => string }) =>
        makePacket({
          packet_id: deps.packetId?.() ?? 'ctxp_numeric_budget',
          task: input.task,
          scopes: input.scopes,
        })
    );
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      childModelRunId: () => 'mr_context_numeric_budget',
      packetId: () => 'ctxp_numeric_budget',
    });

    await service.compileAndPersistContext({
      caller: 'gateway',
      envelope,
      input: {
        task: 'compile branch context',
        limit: 999,
        max_tool_calls: 1.9,
        max_ms: 10.8,
        max_tokens: 42.7,
      },
    });

    expect(compileContext.mock.calls[0][0]).toMatchObject({
      limit: 100,
      max_tool_calls: 1,
      max_ms: 10,
      max_tokens: 42,
    });
  });

  it('AC: accepts public strictness names and normalizes them before compiling', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const compileContext = vi.fn(
      async (input: ContextCompileInput, deps: { packetId?: () => string }) =>
        makePacket({
          packet_id: deps.packetId?.() ?? 'ctxp_public_strictness',
          task: input.task,
          scopes: input.scopes,
        })
    );
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      now: () => FIXED_NOW_MS,
      childModelRunId: () => 'mr_context_public_strictness',
      packetId: () => 'ctxp_public_strictness',
    });

    await service.compileAndPersistContext({
      caller: 'http',
      envelope,
      input: {
        task: 'compile strict context',
        strictness: 'strict',
      },
    });

    expect(compileContext.mock.calls[0][0]).toMatchObject({
      strictness: 'strict',
    });
  });

  it('AC: rejects unknown strictness values before compiling', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const compileContext = vi.fn(async () => makePacket());
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      childModelRunId: () => 'mr_context_invalid_strictness',
      packetId: () => 'ctxp_invalid_strictness',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: {
          task: 'compile branch context',
          strictness: 'maximum' as unknown as ContextCompileInput['strictness'],
        },
      })
    ).rejects.toMatchObject({
      code: 'context_compile_input_invalid',
    });
    expect(compileContext).not.toHaveBeenCalled();
    expect(getModelRunInAdapter(adapter, 'mr_context_invalid_strictness')).toBeNull();
  });

  it('AC: rejects blank as_of strings before compiling', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const compileContext = vi.fn(async () => makePacket());
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      childModelRunId: () => 'mr_context_blank_asof',
      packetId: () => 'ctxp_blank_asof',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: {
          task: 'compile branch context',
          as_of: '   ',
        },
      })
    ).rejects.toMatchObject({
      code: 'context_compile_input_invalid',
    });
    expect(compileContext).not.toHaveBeenCalled();
    expect(getModelRunInAdapter(adapter, 'mr_context_blank_asof')).toBeNull();
  });

  it('AC: rejects persisted context packets with empty memory scopes', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const compileContext = vi.fn(
      async (
        input: ContextCompileInput,
        deps: {
          boundary?: {
            scopes?: unknown[];
            connectors?: string[];
            project_refs?: unknown[];
            tenant_id?: string | null;
          };
          packetId?: () => string;
        }
      ) => {
        expect(input).toMatchObject({
          scopes: [],
          connectors: [],
        });
        expect(deps.boundary).toMatchObject({
          scopes: envelope.scope.memory_scopes,
          connectors: envelope.scope.raw_connectors,
          project_refs: envelope.scope.project_refs,
          tenant_id: 'default',
        });
        return makePacket({
          packet_id: deps.packetId?.() ?? 'ctxp_empty_filters',
          task: input.task,
          scopes: input.scopes,
        });
      }
    );
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      childModelRunId: () => 'mr_context_empty_filters',
      packetId: () => 'ctxp_empty_filters',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: {
          task: 'compile branch context',
          scopes: [],
          connectors: [],
        },
      })
    ).rejects.toThrow(/at least one trusted memory scope/i);

    expect(compileContext).toHaveBeenCalledTimes(1);
    expect(getContextPacket(adapter, 'ctxp_empty_filters')).toBeNull();
    expect(getModelRunInAdapter(adapter, 'mr_context_empty_filters')).toMatchObject({
      status: 'failed',
    });
  });

  it('AC: rejects seed refs when explicit empty filters narrow below the envelope', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const emptyScopeService = createContextCompileService({
      memoryAdapter: adapter,
      childModelRunId: () => 'mr_context_empty_scope_seed',
      packetId: () => 'ctxp_empty_scope_seed',
    });

    await expect(
      emptyScopeService.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: {
          task: 'compile branch context',
          scopes: [],
          seed_refs: [{ kind: 'memory', id: 'mem-alpha' }],
          max_tool_calls: 0,
        },
      })
    ).rejects.toThrow(/empty requested context scope/i);
    expect(getContextPacket(adapter, 'ctxp_empty_scope_seed')).toBeNull();
    expect(getModelRunInAdapter(adapter, 'mr_context_empty_scope_seed')).toMatchObject({
      status: 'failed',
    });

    const emptyConnectorService = createContextCompileService({
      memoryAdapter: adapter,
      childModelRunId: () => 'mr_context_empty_connector_seed',
      packetId: () => 'ctxp_empty_connector_seed',
    });

    await expect(
      emptyConnectorService.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: {
          task: 'compile branch context',
          connectors: [],
          seed_refs: [{ kind: 'raw', connector: 'telegram', raw_id: 'raw-alpha' }],
          max_tool_calls: 0,
        },
      })
    ).rejects.toThrow(/empty requested connector/i);
    expect(getContextPacket(adapter, 'ctxp_empty_connector_seed')).toBeNull();
    expect(getModelRunInAdapter(adapter, 'mr_context_empty_connector_seed')).toMatchObject({
      status: 'failed',
    });
  });

  it('AC: rejects seed refs when the worker envelope has no memory scopes', async () => {
    const adapter = getAdapter();
    adapter
      .prepare(
        `
          INSERT INTO decisions (
            id, topic, decision, reasoning, confidence, created_at, updated_at,
            kind, status, summary, event_datetime
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        'mem-no-scope-seed',
        'context compile no scope seed',
        'No-scope envelope must not trust seed refs.',
        'Empty worker memory scopes mean there is no readable memory window.',
        0.8,
        1_200,
        1_200,
        'decision',
        'active',
        'No-scope envelope must not trust seed refs.',
        1_200
      );
    const envelope = makeSignedEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
        as_of: '2026-04-30T09:00:00.000Z',
      },
    });
    const service = createContextCompileService({
      memoryAdapter: adapter,
      childModelRunId: () => 'mr_context_no_scope_seed',
      packetId: () => 'ctxp_no_scope_seed',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: {
          task: 'compile branch context',
          seed_refs: [{ kind: 'memory', id: 'mem-no-scope-seed' }],
          max_tool_calls: 0,
        },
      })
    ).rejects.toThrow(/empty requested context scope/i);
    expect(getContextPacket(adapter, 'ctxp_no_scope_seed')).toBeNull();
    expect(getModelRunInAdapter(adapter, 'mr_context_no_scope_seed')).toMatchObject({
      status: 'failed',
    });
  });

  it('AC: rejects raw seed refs when the worker envelope has no raw connectors', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope({
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: [],
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:1' }],
        as_of: '2026-04-30T09:00:00.000Z',
      },
    });
    const service = createContextCompileService({
      memoryAdapter: adapter,
      childModelRunId: () => 'mr_context_no_connector_seed',
      packetId: () => 'ctxp_no_connector_seed',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: {
          task: 'compile branch context',
          seed_refs: [{ kind: 'raw', connector: 'slack', raw_id: 'raw-no-connector' }],
          max_tool_calls: 0,
        },
      })
    ).rejects.toThrow(/connector/i);
    expect(getContextPacket(adapter, 'ctxp_no_connector_seed')).toBeNull();
    expect(getModelRunInAdapter(adapter, 'mr_context_no_connector_seed')).toBeNull();
  });

  it('AC: rejects parent runs outside the worker envelope before compiling', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    beginModelRunInAdapter(adapter, {
      model_run_id: 'mr_other_envelope',
      agent_id: envelope.agent_id,
      instance_id: envelope.instance_id,
      envelope_hash: 'env_other',
      input_snapshot_ref: 'agent-loop:other',
      input_refs: { tool: 'agent.loop' },
    });
    const compileContext = vi.fn(async (_input, deps: { packetId?: () => string }) =>
      makePacket({ packet_id: deps.packetId?.() ?? 'ctxp_denied' })
    );
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext,
      childModelRunId: () => 'mr_context_denied',
      packetId: () => 'ctxp_denied',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        modelRunId: 'mr_other_envelope',
        input: { task: 'compile branch context' },
      })
    ).rejects.toMatchObject({
      code: 'context_compile_parent_model_run_denied',
      status: 403,
    });
    expect(compileContext).not.toHaveBeenCalled();
    expect(countRows('context_packets')).toBe(0);
    expect(getModelRunInAdapter(adapter, 'mr_context_denied')).toBeNull();
  });

  it('AC: validates requested scopes, connectors, and raw seed refs against the envelope', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext: vi.fn(async (_input, deps: { packetId?: () => string }) =>
        makePacket({ packet_id: deps.packetId?.() ?? 'ctxp_validation' })
      ),
      childModelRunId: () => 'mr_context_validation',
      packetId: () => 'ctxp_validation',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: { task: 'compile', scopes: [{ kind: 'project', id: '/workspace/project-b' }] },
      })
    ).rejects.toMatchObject({ code: 'worker_envelope_scope_denied' });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: { task: 'compile', connectors: ['slack'] },
      })
    ).rejects.toMatchObject({ code: 'worker_envelope_connector_denied' });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: {
          task: 'compile',
          seed_refs: [{ kind: 'raw', connector: 'slack', raw_id: 'raw-hidden' }],
        },
      })
    ).rejects.toMatchObject({
      code: 'context_compile_input_invalid',
      status: 400,
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: { task: 'compile', max_tool_calls: '0' as unknown as number },
      })
    ).rejects.toMatchObject({
      code: 'context_compile_input_invalid',
      status: 400,
    });

    expect(countRows('context_packets')).toBe(0);
    expect(countRows('model_runs')).toBe(0);
  });

  it('AC: fails the owned child run when compile fails before packet insert', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext: vi.fn(async () => {
        throw new Error('compile exploded');
      }),
      childModelRunId: () => 'mr_context_compile_failed',
      packetId: () => 'ctxp_compile_failed',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'http',
        envelope,
        input: { task: 'compile branch context' },
      })
    ).rejects.toThrow('compile exploded');

    expect(countRows('context_packets')).toBe(0);
    expect(getModelRunInAdapter(adapter, 'mr_context_compile_failed')).toMatchObject({
      status: 'failed',
      error_summary: 'compile exploded',
    });
  });

  it('AC: retains the inserted packet when child commit fails and marks a running child failed', async () => {
    const baseAdapter = getAdapter();
    const commitFailingAdapter = {
      prepare(sql: string) {
        const statement = baseAdapter.prepare(sql);
        if (sql.includes("SET status = 'committed'")) {
          return {
            run: (..._args: unknown[]) => {
              throw new Error('commit store unavailable');
            },
            get: (...args: unknown[]) => statement.get(...args),
            all: (...args: unknown[]) => statement.all(...args),
          };
        }
        return statement;
      },
      transaction<T>(fn: () => T): T {
        return baseAdapter.transaction(fn);
      },
    };
    const envelope = makeSignedEnvelope();
    const service = createContextCompileService({
      memoryAdapter: commitFailingAdapter,
      compileContext: vi.fn(async (_input, deps: { packetId?: () => string }) =>
        makePacket({ packet_id: deps.packetId?.() ?? 'ctxp_commit_failed' })
      ),
      childModelRunId: () => 'mr_context_commit_failed',
      packetId: () => 'ctxp_commit_failed',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'http',
        envelope,
        input: { task: 'compile branch context' },
      })
    ).rejects.toThrow('commit store unavailable');

    expect(getContextPacket(baseAdapter, 'ctxp_commit_failed')).toMatchObject({
      packet_id: 'ctxp_commit_failed',
      model_run_id: 'mr_context_commit_failed',
    });
    expect(getModelRunInAdapter(baseAdapter, 'mr_context_commit_failed')).toMatchObject({
      status: 'failed',
      error_summary: 'commit store unavailable',
    });
  });

  it('AC: keeps the packet and does not fail an already-terminal child after commit races', async () => {
    const baseAdapter = getAdapter();
    const racingAdapter = {
      prepare(sql: string) {
        const statement = baseAdapter.prepare(sql);
        if (sql.includes("SET status = 'committed'")) {
          return {
            run: (..._args: unknown[]) => {
              baseAdapter
                .prepare(
                  `
                    UPDATE model_runs
                    SET status = 'committed',
                        completion_summary = 'external completion',
                        completed_at = ?
                    WHERE model_run_id = 'mr_context_raced' AND status = 'running'
                  `
                )
                .run(FIXED_NOW_MS + 1);
              return { changes: 0 };
            },
            get: (...args: unknown[]) => statement.get(...args),
            all: (...args: unknown[]) => statement.all(...args),
          };
        }
        return statement;
      },
      transaction<T>(fn: () => T): T {
        return baseAdapter.transaction(fn);
      },
    };
    const envelope = makeSignedEnvelope();
    const service = createContextCompileService({
      memoryAdapter: racingAdapter,
      compileContext: vi.fn(async (_input, deps: { packetId?: () => string }) =>
        makePacket({ packet_id: deps.packetId?.() ?? 'ctxp_raced' })
      ),
      childModelRunId: () => 'mr_context_raced',
      packetId: () => 'ctxp_raced',
    });

    await expect(
      service.compileAndPersistContext({
        caller: 'gateway',
        envelope,
        input: { task: 'compile branch context' },
      })
    ).rejects.toThrow('already committed');

    expect(getContextPacket(baseAdapter, 'ctxp_raced')).toMatchObject({
      packet_id: 'ctxp_raced',
      model_run_id: 'mr_context_raced',
    });
    expect(getModelRunInAdapter(baseAdapter, 'mr_context_raced')).toMatchObject({
      status: 'committed',
      completion_summary: 'external completion',
      error_summary: null,
    });
  });

  it('AC: sanitizes hidden identifiers before returning and storing the packet', async () => {
    const adapter = getAdapter();
    const envelope = makeSignedEnvelope();
    const service = createContextCompileService({
      memoryAdapter: adapter,
      compileContext: vi.fn(async (_input, deps: { packetId?: () => string }) =>
        makePacket({
          packet_id: deps.packetId?.() ?? 'ctxp_sanitized',
          retrieval_diagnostics: {
            hidden: { visible: false, id: 'secret-memory-id', reason: 'scope' },
            leak: 'secret-memory-id',
            safe: 'ok',
          },
          caveats: ['safe caveat', 'secret-memory-id should not leak'],
        })
      ),
      childModelRunId: () => 'mr_context_sanitized',
      packetId: () => 'ctxp_sanitized',
    });

    const result = await service.compileAndPersistContext({
      caller: 'http',
      envelope,
      input: { task: 'compile branch context' },
    });

    expect(JSON.stringify(result.packet)).not.toContain('secret-memory-id');
    expect(JSON.stringify(getContextPacket(adapter, 'ctxp_sanitized')?.packet)).not.toContain(
      'secret-memory-id'
    );
    expect(result.packet.retrieval_diagnostics).toEqual({ safe: 'ok' });
    expect(result.packet.caveats).toEqual(['safe caveat']);
  });
});
