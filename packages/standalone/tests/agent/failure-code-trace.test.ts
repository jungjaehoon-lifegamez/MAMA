/**
 * S2 Task 0: the thrower's closed cause reaches the tool trace.
 *
 * The failure choke already emits structured codes (envelope_missing,
 * scope denials, ...) and the sanitizer preserves them - the trace INSERT
 * was the one place that dropped the code, leaving only sha256 digests
 * (the dominant digest covered 52% of context_compile failures with no
 * name). These tests pin the carry: code present -> recorded; code absent
 * -> NULL, never invented.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';

describe('S2 Task 0: failure_code carried into tool traces', () => {
  let appendToolTrace: ReturnType<typeof vi.fn>;
  let executor: GatewayToolExecutor;

  beforeEach(() => {
    appendToolTrace = vi.fn().mockResolvedValue(undefined);
    executor = new GatewayToolExecutor({
      mamaApi: {
        search: vi.fn(),
        recallMemory: vi.fn(),
        appendToolTrace,
        beginModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_1' }),
        commitModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_1' }),
        failModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_1' }),
      } as unknown as MAMAApiInterface,
      // Envelope enforcement ON (default): a model_tool call without an
      // envelope dies 'envelope_missing' - exactly the code we assert.
    });
  });

  it('a coded refusal lands in the trace as failure_code', async () => {
    // The secret filter is a deterministic coded refusal at the choke -
    // synthetic token, same fixture style as secret-inviolability.test.ts.
    const result = (await executor.execute(
      'mama_save',
      {
        type: 'decision',
        topic: 'deploy_notes',
        decision: 'store the deploy token safely',
        reasoning: 'token is ' + ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRST123456'].join(''),
      },
      {
        agentId: 'host',
        source: 'watch',
        channelId: 'c1',
        executionSurface: 'direct',
        modelRunId: 'run_1',
      }
    )) as { success: boolean; code?: string };

    expect(result.success).toBe(false);
    expect(result.code).toBe('secret_material_refused');
    expect(appendToolTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_name: 'mama_save',
        execution_status: 'failed',
        failure_code: 'secret_material_refused',
      })
    );
  });

  it('a codeless failure stays NULL - labels are carried, never invented', async () => {
    // 'direct' surface bypasses envelope enforcement; the mocked api then
    // fails the save handler with a plain error carrying no code.
    const failingExecutor = new GatewayToolExecutor({
      mamaApi: {
        save: vi.fn().mockResolvedValue({ success: false, message: 'backend unavailable' }),
        search: vi.fn(),
        recallMemory: vi.fn(),
        appendToolTrace,
        beginModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_2' }),
        commitModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_2' }),
        failModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_2' }),
      } as unknown as MAMAApiInterface,
    });
    await failingExecutor.execute(
      'mama_save',
      { type: 'decision', topic: 't', decision: 'd', reasoning: 'r' },
      {
        agentId: 'host',
        source: 'watch',
        channelId: 'c1',
        executionSurface: 'direct',
      }
    );

    expect(appendToolTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_name: 'mama_save',
        execution_status: 'failed',
        failure_code: null,
      })
    );
  });

  it('a thrown AgentError carries its structured code - the error branch', async () => {
    // AgentErrors pass the executor's catch unwrapped, so a handler dying
    // with a closed cause reaches extractFailureCode as error.code (the
    // generic TOOL_ERROR wrapper is filtered - it names nothing).
    const { AgentError } = await import('../../src/agent/types.js');
    const throwing = new GatewayToolExecutor({
      mamaApi: {
        save: vi.fn().mockImplementation(() => {
          throw new AgentError('scope denied', 'memory_scope_out_of_scope', undefined, false);
        }),
        search: vi.fn(),
        recallMemory: vi.fn(),
        appendToolTrace,
        beginModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_3' }),
        commitModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_3' }),
        failModelRun: vi.fn().mockResolvedValue({ model_run_id: 'run_3' }),
      } as unknown as MAMAApiInterface,
    });
    await throwing
      .execute(
        'mama_save',
        { type: 'decision', topic: 't', decision: 'd', reasoning: 'r' },
        {
          agentId: 'host',
          source: 'watch',
          channelId: 'c1',
          executionSurface: 'direct',
          modelRunId: 'run_3',
        }
      )
      .catch(() => undefined);
    expect(appendToolTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_name: 'mama_save',
        execution_status: 'failed',
        failure_code: 'memory_scope_out_of_scope',
      })
    );
  });
});
