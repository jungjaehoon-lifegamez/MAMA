/**
 * Story OPS-0: workerRun primitive (plan v6 S0-T1)
 *
 * A maintenance stimulus is handled by the same durable owner runtime. The
 * owner agent may use native subagents itself when the work warrants it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { projectCodeActToolPolicy } from '../../src/agent/code-act/tool-policy.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { AgentContext } from '../../src/agent/types.js';
import { buildTurnAgentPolicy } from '../../src/cli/commands/start.js';
import type { ConnectorConfigLoadResult } from '../../src/connectors/config-loader.js';
import {
  resolvePrivateConnectorPolicy,
  type PrivateConnectorPolicy,
} from '../../src/connectors/private-connector-policy.js';
import { makeEnvelope } from '../envelope/fixtures.js';
import {
  buildWorkerSessionKey,
  attachWorkOrderAttemptContext,
  workerRun,
  type WorkerRunner,
} from '../../src/operator/worker-run.js';

const PRIVATE_TOOLS = [
  'kagemusha_overview',
  'kagemusha_entities',
  'kagemusha_tasks',
  'kagemusha_messages',
] as const;

function enabledPrivatePolicy(): PrivateConnectorPolicy {
  const result: ConnectorConfigLoadResult = {
    ok: true,
    config: {
      kagemusha: {
        enabled: true,
        pollIntervalMinutes: 60,
        channels: {},
        auth: { type: 'none' },
      },
    },
    enabledNames: ['kagemusha'],
  };
  return resolvePrivateConnectorPolicy(result);
}

function makeRunner(response = 'worker output'): WorkerRunner & {
  calls: Array<{ content: string; options: Record<string, unknown> }>;
} {
  const calls: Array<{ content: string; options: Record<string, unknown> }> = [];
  return {
    calls,
    runWithContent: vi.fn(async (content, options) => {
      calls.push({
        content: content.map((block) => ('text' in block ? block.text : '')).join('\n'),
        options: options as unknown as Record<string, unknown>,
      });
      return { response };
    }),
  };
}

describe('Story OPS-0: workerRun primitive', () => {
  describe('AC #1: briefed run with explicit lane identity', () => {
    it('composes brief + work order and pins the one owner runtime identity', async () => {
      const runner = makeRunner('board updated');
      const result = await workerRun(runner, {
        kind: 'board',
        brief: 'You update the owner board slots.',
        input: 'Refresh the pipeline slot.',
      });

      // No usage from the runner -> no fabricated tokensUsed; the exact brief is still stamped.
      expect(result).toEqual({
        response: 'board updated',
        briefHash: createHash('sha256')
          .update('You update the owner board slots.')
          .digest('hex')
          .slice(0, 16),
      });
      expect(runner.calls).toHaveLength(1);
      const { content, options } = runner.calls[0];
      expect(content).toContain('You update the owner board slots.');
      expect(content).toContain('Work order:\nRefresh the pipeline slot.');
      expect(options.sessionKey).toBe('owner:runtime');
      expect(options.source).toBe('operator');
      expect(options.channelId).toBe('worker:board');
      expect(options).not.toHaveProperty('freshSession');
    });

    it('sums runner totalUsage into tokensUsed for activity telemetry', async () => {
      const runner: WorkerRunner = {
        runWithContent: vi.fn(async () => ({
          response: 'done',
          totalUsage: { input_tokens: 40_000, output_tokens: 3_000 },
        })),
      };
      const result = await workerRun(runner, {
        kind: 'board',
        brief: 'brief',
        input: 'input',
      });
      expect(result).toEqual({
        response: 'done',
        tokensUsed: 43_000,
        briefHash: createHash('sha256').update('brief').digest('hex').slice(0, 16),
      });
    });

    it('drops non-finite usage instead of fabricating a number', async () => {
      const runner: WorkerRunner = {
        runWithContent: vi.fn(async () => ({
          response: 'done',
          totalUsage: { input_tokens: Number.NaN, output_tokens: 3 },
        })),
      };
      const result = await workerRun(runner, { kind: 'board', brief: 'b', input: 'i' });
      expect(result).toEqual({
        response: 'done',
        briefHash: createHash('sha256').update('b').digest('hex').slice(0, 16),
      });
    });

    it('changes the stamp when the brief content changes', async () => {
      const runner = makeRunner('done');
      const first = await workerRun(runner, { kind: 'board', brief: 'brief A', input: 'input' });
      const second = await workerRun(runner, { kind: 'board', brief: 'brief B', input: 'input' });

      expect(first.briefHash).not.toBe(second.briefHash);
    });

    it('does not turn maintenance kinds into model identities', () => {
      expect(buildWorkerSessionKey('wiki')).toBe('owner:runtime');
      expect(buildWorkerSessionKey('memory-curation')).toBe('owner:runtime');
    });
  });

  describe('AC #3: failures propagate loudly, never silently', () => {
    it('rejects invalid kind, empty brief, and empty input', async () => {
      const runner = makeRunner();
      await expect(workerRun(runner, { kind: 'Board!', brief: 'b', input: 'i' })).rejects.toThrow(
        /invalid worker kind/
      );
      await expect(workerRun(runner, { kind: 'board', brief: '  ', input: 'i' })).rejects.toThrow(
        /empty brief/
      );
      await expect(workerRun(runner, { kind: 'board', brief: 'b', input: ' ' })).rejects.toThrow(
        /empty input/
      );
      expect(runner.calls).toHaveLength(0);
    });

    it('propagates runner failure to the caller', async () => {
      const runner: WorkerRunner = {
        runWithContent: vi.fn().mockRejectedValue(new Error('lane exploded')),
      };
      await expect(workerRun(runner, { kind: 'board', brief: 'b', input: 'i' })).rejects.toThrow(
        'lane exploded'
      );
    });

    it('treats an empty response as a loud failure', async () => {
      const runner = makeRunner('   ');
      await expect(workerRun(runner, { kind: 'board', brief: 'b', input: 'i' })).rejects.toThrow(
        /empty response/
      );
    });

    it('propagates owner-runtime recovery durability state', async () => {
      const runner: WorkerRunner = {
        runWithContent: vi.fn().mockResolvedValue({
          response: 'completed work',
          ownerJournalProvenance: 'commit_failed',
        }),
      };

      const result = await workerRun(runner, { kind: 'board', brief: 'b', input: 'i' });

      expect(result.ownerJournalProvenance).toBe('commit_failed');
    });
  });
});

/**
 * Story S2-T4: runOptions passthrough - identity fields always win (plan E7/G3).
 */
describe('Story S2-T4: workerRun runOptions merge order', () => {
  it('passes extra run options through but never lets them override identity', async () => {
    let captured: Record<string, unknown> = {};
    const runner = {
      runWithContent: async (
        _content: unknown,
        options: Record<string, unknown>
      ): Promise<{ response: string }> => {
        captured = options;
        return { response: 'ok' };
      },
    };
    const override = (): void => {};
    await workerRun(runner as never, {
      kind: 'board',
      brief: 'brief text',
      input: 'work',
      runOptions: {
        reportPublisherOverride: override,
        // Hostile/buggy override attempts - identity must win:
        sessionKey: 'chat:main:hijack',
        source: 'telegram',
        channelId: 'other-lane',
        freshSession: false,
      },
    });

    expect(captured.reportPublisherOverride).toBe(override);
    expect(captured.sessionKey).toBe('owner:runtime');
    expect(captured.source).toBe('operator');
    expect(captured.channelId).toBe('worker:board');
    expect(captured).not.toHaveProperty('freshSession');
  });

  it('preserves the host-issued attempt id through the generic options merge', async () => {
    const runner = makeRunner();
    const runOptions = attachWorkOrderAttemptContext({ workorderAttemptId: 999 }, 148);

    await workerRun(runner, {
      kind: 'board',
      brief: 'brief text',
      input: 'work',
      runOptions,
    });

    expect(runner.calls[0].options.workorderAttemptId).toBe(148);
  });

  it('rejects an invalid host-issued attempt id before the worker starts', () => {
    expect(() => attachWorkOrderAttemptContext({}, 0)).toThrow(/positive integer/);
    expect(() => attachWorkOrderAttemptContext({}, 1.5)).toThrow(/positive integer/);
  });
});

describe('Story TG-03/TG-04/TG-05: maintenance stays inside One MAMA', () => {
  it('does not construct or inject a worker system persona in production', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).not.toContain('buildWorkerSystemPrompt');
    expect(startSource).toContain('gatewayToolsPrompt: workOrderPolicy.gatewayToolsPrompt');
    expect(startSource).toContain('sessionPolicyRole: ownerRole');
  });

  it('drops a legacy caller system prompt while preserving bounded tool projection', async () => {
    const runner = makeRunner();

    await workerRun(runner, {
      kind: 'board',
      brief: 'Maintain the board as the accountable owner.',
      input: 'Inspect the selected rows.',
      runOptions: {
        systemPrompt: 'You are a separate system worker.',
        gatewayToolsPrompt: '# bounded tools',
      },
    });

    expect(runner.calls[0].options).not.toHaveProperty('systemPrompt');
    expect(runner.calls[0].options.gatewayToolsPrompt).toBe('# bounded tools');
    expect(runner.calls[0].options.sessionKey).toBe('owner:runtime');
  });

  it.each([
    { backend: 'claude' as const, rawConnectors: [], privateVisible: false },
    { backend: 'codex' as const, rawConnectors: [], privateVisible: false },
    { backend: 'claude' as const, rawConnectors: ['kagemusha'], privateVisible: true },
    { backend: 'codex' as const, rawConnectors: ['kagemusha'], privateVisible: true },
  ])(
    'TG-06 keeps the $backend temporal catalog and authorization aligned',
    async ({ backend, rawConnectors, privateVisible }) => {
      const privatePolicy = enabledPrivatePolicy();
      const policy = buildTurnAgentPolicy(
        'temporal',
        'worker-model',
        backend,
        privatePolicy,
        rawConnectors
      );
      const runner = makeRunner();

      await workerRun(runner, {
        kind: 'temporal',
        brief: 'Reconcile one temporal task.',
        input: 'Check the bound source and commit one receipt.',
        runOptions: {
          gatewayToolsPrompt: policy.gatewayToolsPrompt,
          agentContext: policy.agentContext,
          workOrderBriefProjectionPolicy: policy.briefProjectionPolicy,
        },
      });

      const capturedContext = runner.calls[0].options.agentContext as AgentContext;
      const projected = projectCodeActToolPolicy({
        tier: capturedContext.tier,
        role: capturedContext.role,
      });
      const privateCatalog = PRIVATE_TOOLS.filter((tool) => projected.names.includes(tool));
      expect(privateCatalog).toEqual(privateVisible ? PRIVATE_TOOLS : []);
      expect(policy.gatewayToolsPrompt.includes('kagemusha_')).toBe(privateVisible);
      expect(runner.calls[0].options.gatewayToolsPrompt).toBe(policy.gatewayToolsPrompt);

      const executor = new GatewayToolExecutor({
        envelopeIssuanceMode: 'off',
        privateConnectorPolicy: privatePolicy,
      });
      const authorization = await executor.execute(
        'code_act',
        {
          code: `({ overview: typeof kagemusha_overview, entities: typeof kagemusha_entities, tasks: typeof kagemusha_tasks, messages: typeof kagemusha_messages })`,
        },
        {
          agentId: 'mama-owner',
          source: 'operator',
          channelId: 'worker:temporal',
          agentContext: capturedContext,
          envelope: makeEnvelope({
            agent_id: 'mama-owner',
            source: 'watch',
            channel_id: 'worker:temporal',
            scope: {
              project_refs: [{ kind: 'project', id: '/workspace/MAMA' }],
              raw_connectors: rawConnectors,
              memory_scopes: [{ kind: 'project', id: '/workspace/MAMA' }],
              allowed_destinations: [],
            },
          }),
          executionSurface: 'model_tool',
        }
      );
      const value = JSON.parse(String(authorization.message)).value as Record<string, string>;
      expect(Object.values(value)).toEqual(
        Array.from({ length: PRIVATE_TOOLS.length }, () =>
          privateVisible ? 'function' : 'undefined'
        )
      );
    }
  );
});
