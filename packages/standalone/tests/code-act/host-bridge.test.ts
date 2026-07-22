import { describe, it, expect, vi, beforeAll } from 'vitest';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';
import type { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';
import { RoleManager } from '../../src/agent/role-manager.js';
import type { RoleConfig } from '../../src/cli/config/types.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

function makeExecutor(overrides?: Partial<GatewayToolExecutor>): GatewayToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as GatewayToolExecutor;
}

describe('HostBridge', () => {
  beforeAll(async () => {
    await CodeActSandbox.warmup();
  });

  describe('getAvailableFunctions', () => {
    it('returns all tools for Tier 1', () => {
      const bridge = new HostBridge(makeExecutor());
      const fns = bridge.getAvailableFunctions(1);
      expect(fns.length).toBeGreaterThanOrEqual(25);
      const names = fns.map((f) => f.name);
      expect(names).toContain('Read');
      expect(names).toContain('Write');
      expect(names).toContain('Bash');
      expect(names).toContain('mama_search');
      expect(names).toContain('discord_send');
      expect(names).toContain('browser_navigate');
      expect(names).toContain('agent_create');
      expect(names).toContain('agent_test');
      expect(names).toContain('viewer_navigate');
    });

    it('returns only read-only tools for Tier 2', () => {
      const bridge = new HostBridge(makeExecutor());
      const fns = bridge.getAvailableFunctions(2);
      const names = fns.map((f) => f.name);
      expect(names).toContain('mama_search');
      expect(names).toContain('Read');
      expect(names).toContain('mama_load_checkpoint');
      expect(names).toContain('viewer_state');
      expect(names).not.toContain('agent_get');
      expect(names).not.toContain('agent_activity');
      expect(names).not.toContain('Write');
      expect(names).not.toContain('Bash');
      expect(names).not.toContain('discord_send');
    });

    it('tier 2 includes read-only plus memory-write tools', () => {
      const bridge = new HostBridge(makeExecutor());
      const t2 = bridge.getAvailableFunctions(2);
      const t2Names = t2.map((f) => f.name);
      expect(t2Names).toContain('mama_search');
      expect(t2Names).toContain('mama_save');
      expect(t2Names).toContain('mama_update');
      expect(t2Names).not.toContain('Write');
      expect(t2Names).not.toContain('Bash');
    });

    it('tier 2 exposes the wiki write path (obsidian CLI + wiki_publish fallback)', () => {
      // The wiki agent runs at tier 2 with useCodeAct; without obsidian in the
      // sandbox every run silently degrades to the wiki_publish fallback.
      const bridge = new HostBridge(makeExecutor());
      const t2Names = bridge.getAvailableFunctions(2).map((f) => f.name);
      expect(t2Names).toContain('obsidian');
      expect(t2Names).toContain('wiki_publish');
      const t3Names = bridge.getAvailableFunctions(3).map((f) => f.name);
      expect(t3Names).not.toContain('obsidian');
      expect(t3Names).not.toContain('wiki_publish');
    });

    it('tier 3 is strictly read-only (no memory-write)', () => {
      const bridge = new HostBridge(makeExecutor());
      const t3 = bridge.getAvailableFunctions(3);
      const t3Names = t3.map((f) => f.name);
      expect(t3Names).toContain('mama_search');
      expect(t3Names).not.toContain('mama_save');
      expect(t3Names).not.toContain('mama_update');
      expect(t3Names).not.toContain('Write');
    });

    it('native task ledger: task_list read-only (tiers 2+3), writes tier-2 only', () => {
      const bridge = new HostBridge(makeExecutor());
      const t2 = bridge.getAvailableFunctions(2).map((f) => f.name);
      const t3 = bridge.getAvailableFunctions(3).map((f) => f.name);
      expect(t2).toContain('task_list');
      expect(t2).toContain('task_create');
      expect(t2).toContain('task_update');
      expect(t3).toContain('task_list');
      expect(t3).not.toContain('task_create');
      expect(t3).not.toContain('task_update');

      const create = bridge.getAvailableFunctions(2).find((fn) => fn.name === 'task_create');
      const update = bridge.getAvailableFunctions(2).find((fn) => fn.name === 'task_update');
      const list = bridge.getAvailableFunctions(3).find((fn) => fn.name === 'task_list');
      expect(create?.params.map((param) => param.name)).toContain('due_at');
      expect(update?.params.map((param) => param.name)).toContain('due_at');
      expect(list?.returnType).toContain('temporal_state');
    });

    it('kagemusha query tools are read-only: available at tier 2 AND tier 3', () => {
      // The dashboard agent (tier 2) reads real task lifecycle state through these;
      // they are pure queries against the kagemusha bridge db, so tier 3 gets them too.
      const bridge = new HostBridge(makeExecutor());
      const queryTools = [
        'kagemusha_overview',
        'kagemusha_entities',
        'kagemusha_tasks',
        'kagemusha_messages',
      ];
      for (const tier of [2, 3] as const) {
        const names = bridge.getAvailableFunctions(tier).map((f) => f.name);
        for (const tool of queryTools) {
          expect(names, `tier ${tier} should expose ${tool}`).toContain(tool);
        }
      }
    });

    it('returns FunctionDescriptor shape', () => {
      const bridge = new HostBridge(makeExecutor());
      const [fn] = bridge.getAvailableFunctions(1);
      expect(fn).toHaveProperty('name');
      expect(fn).toHaveProperty('params');
      expect(fn).toHaveProperty('returnType');
      expect(fn).toHaveProperty('description');
      expect(fn).toHaveProperty('category');
    });

    it('advertises scopes for mama_search', () => {
      const bridge = new HostBridge(makeExecutor());
      const mamaSearch = bridge.getAvailableFunctions(1).find((fn) => fn.name === 'mama_search');
      expect(mamaSearch?.params.map((param) => param.name)).toContain('scopes');
    });
  });

  describe('injectInto', () => {
    it('injects all Tier 1 functions into sandbox', () => {
      const bridge = new HostBridge(makeExecutor());
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);
      const registered = sandbox.getRegisteredFunctions();
      expect(registered).toContain('Read');
      expect(registered).toContain('Bash');
      expect(registered).toContain('mama_search');
      expect(registered).toContain('agent_create');
      expect(registered).toContain('agent_test');
    });

    it('injects only read-only functions for Tier 2', () => {
      const bridge = new HostBridge(makeExecutor());
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 2);
      const registered = sandbox.getRegisteredFunctions();
      expect(registered).toContain('mama_search');
      expect(registered).toContain('Read');
      expect(registered).not.toContain('Write');
      expect(registered).not.toContain('Bash');
    });

    it('filters by role when RoleManager provided', () => {
      const role: RoleConfig = {
        allowedTools: ['Read', 'mama_search'],
      };
      const roleManager = new RoleManager();
      const bridge = new HostBridge(makeExecutor(), roleManager);
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1, role);
      const registered = sandbox.getRegisteredFunctions();
      expect(registered).toContain('Read');
      expect(registered).toContain('mama_search');
      expect(registered).not.toContain('Bash');
      expect(registered).not.toContain('Write');
    });

    it('registers exactly an already-projected name set', () => {
      const bridge = new HostBridge(makeExecutor(), new RoleManager());
      const sandbox = new CodeActSandbox();

      bridge.injectInto(sandbox, ['mama_search', 'Read'], { allowedTools: ['Write'] });

      expect(sandbox.getRegisteredFunctions().sort()).toEqual(['Read', 'mama_search']);
    });
  });

  describe('tool execution via sandbox', () => {
    it('calls executor.execute with correct args', async () => {
      const executeFn = vi.fn().mockResolvedValue({
        success: true,
        results: [{ id: '1', topic: 'test' }],
        count: 1,
      });
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }));
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute('mama_search({ query: "test" })');
      expect(result.success).toBe(true);
      expect(executeFn).toHaveBeenCalledWith('mama_search', { query: 'test' });
    });

    it('forwards execution context to executor calls when provided', async () => {
      const executeFn = vi.fn().mockResolvedValue({
        success: true,
        results: [],
        count: 0,
      });
      const executionContext: GatewayToolExecutionContext = {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'tg:1',
        envelope: makeSignedEnvelope({
          source: 'telegram',
          channel_id: 'tg:1',
        }),
        executionSurface: 'code_act',
      };
      const bridge = new HostBridge(
        makeExecutor({ execute: executeFn }),
        undefined,
        executionContext
      );
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute('mama_search({ query: "test" })');

      expect(result.success).toBe(true);
      expect(executeFn).toHaveBeenCalledWith(
        'mama_search',
        { query: 'test' },
        expect.objectContaining(executionContext)
      );
      expect(executeFn.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('propagates the sandbox deadline and bounds browser waits to the remaining time', async () => {
      let observedAbort = false;
      const executeFn = vi
        .fn()
        .mockImplementation(
          async (
            _toolName: string,
            _input: Record<string, unknown>,
            context: GatewayToolExecutionContext
          ) => {
            await new Promise<void>((_resolve, reject) => {
              context.signal?.addEventListener(
                'abort',
                () => {
                  observedAbort = true;
                  reject(context.signal?.reason);
                },
                { once: true }
              );
            });
          }
        );
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }), undefined, {
        executionSurface: 'code_act',
      });
      // Leave enough budget for per-execution QuickJS module initialization on slow CI runners.
      // This test still relies on the sandbox's own deadline to abort the active host call.
      const sandbox = new CodeActSandbox({ timeoutMs: 1_000 });
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute('browser_wait_for("#late", 999999)');

      expect(result.success).toBe(false);
      expect(observedAbort).toBe(true);
      expect(executeFn.mock.calls[0]?.[1]).toMatchObject({ selector: '#late' });
      const boundedTimeout = Number(executeFn.mock.calls[0]?.[1]?.timeout);
      expect(boundedTimeout).toBeGreaterThan(0);
      expect(boundedTimeout).toBeLessThanOrEqual(1_000);
    });

    it('does not report a timed-out mutation before an abort-ignoring send settles', async () => {
      let sent = false;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const executeFn = vi.fn().mockImplementation(async () => {
        markStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 150));
        sent = true;
        return { success: true };
      });
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }), undefined, {
        executionSurface: 'code_act',
      });
      const sandbox = new CodeActSandbox({ timeoutMs: 1_000 });
      bridge.injectInto(sandbox, 1);

      const controller = new AbortController();
      const run = sandbox.execute('telegram_send("chat-1", "hello")', {
        signal: controller.signal,
      });
      await started;
      const abortedAt = Date.now();
      controller.abort(new Error('owning turn stopped'));
      const result = await run;

      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(140);
      expect(sent).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('may be committed');
      expect(result.error?.message).toContain('do not retry');
    });

    it('treats local artifact producers as settlement-required operations', async () => {
      let fileCreated = false;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const executeFn = vi.fn().mockImplementation(async () => {
        markStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 150));
        fileCreated = true;
        return { success: true, result: { path: '/private/workspace/download.png' } };
      });
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }), undefined, {
        executionSurface: 'code_act',
      });
      const sandbox = new CodeActSandbox({
        timeoutMs: 1_000,
        mutationSettlementGraceMs: 500,
      });
      bridge.injectInto(sandbox, 1);

      const controller = new AbortController();
      const run = sandbox.execute("drive_download({ fileId: 'file-1' })", {
        signal: controller.signal,
      });
      await started;
      const abortedAt = Date.now();
      controller.abort(new Error('owning turn stopped'));
      const result = await run;

      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(140);
      expect(fileCreated).toBe(true);
      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT',
          retryable: false,
        },
      });
    });

    it('passes positional args mapped to param names', async () => {
      const executeFn = vi.fn().mockResolvedValue({ success: true });
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }));
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      await sandbox.execute('Read("/tmp/test.txt")');
      expect(executeFn).toHaveBeenCalledWith('Read', { path: '/tmp/test.txt' });
    });

    it('propagates executor errors to sandbox', async () => {
      const executeFn = vi.fn().mockResolvedValue({
        success: false,
        message: 'Permission denied',
      });
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }));
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute('Read("/secret")');
      expect(result.success).toBe(false);
    });

    it('allows try-catch for executor errors in sandbox', async () => {
      const executeFn = vi.fn().mockResolvedValue({
        success: false,
        message: 'Not found',
      });
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }));
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute(`
        var out;
        try { out = Read("/missing"); } catch(e) { out = "caught: " + e.message; }
        out;
      `);
      expect(result.success).toBe(true);
      expect(result.value).toContain('caught');
    });

    it('returns complex results from executor', async () => {
      const executeFn = vi.fn().mockResolvedValue({
        success: true,
        results: [
          { id: 'dec_1', topic: 'auth', decision: 'Use JWT' },
          { id: 'dec_2', topic: 'db', decision: 'Use SQLite' },
        ],
        count: 2,
      });
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }));
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute(`
        var r = mama_search({ query: "test" });
        ({ count: r.count, first: r.results[0].topic });
      `);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ count: 2, first: 'auth' });
    });

    it('passes agent management tool calls through to the executor', async () => {
      const executeFn = vi.fn().mockResolvedValue({
        success: true,
        id: 'qa-monitor-e2e',
        version: 1,
      });
      const bridge = new HostBridge(makeExecutor({ execute: executeFn }));
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute(`
        agent_create({
          id: "qa-monitor-e2e",
          name: "QA Monitor E2E",
          model: "claude-sonnet-4-6",
          tier: 2,
          system: "QA",
          backend: "claude"
        })
      `);

      expect(result.success).toBe(true);
      expect(executeFn).toHaveBeenCalledWith('agent_create', {
        id: 'qa-monitor-e2e',
        name: 'QA Monitor E2E',
        model: 'claude-sonnet-4-6',
        tier: 2,
        system: 'QA',
        backend: 'claude',
      });
    });
  });

  describe('static getToolRegistry', () => {
    it('returns complete registry', () => {
      const registry = HostBridge.getToolRegistry();
      expect(registry.length).toBeGreaterThanOrEqual(25);
      expect(registry.every((t) => t.name && t.description && t.category)).toBe(true);
    });

    it('describes the real owner workflow handler signatures', () => {
      const registry = new Map(HostBridge.getToolRegistry().map((tool) => [tool.name, tool]));

      expect(registry.get('mama_recall')).toMatchObject({
        params: [
          { name: 'query', type: 'string', required: true },
          {
            name: 'scopes',
            type: "Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>",
            required: false,
          },
        ],
        returnType: expect.stringContaining('graph_context'),
        category: 'memory',
      });
      expect(registry.get('board_read')).toMatchObject({
        params: [],
        returnType: '{ slots: Record<string, { html: string; updatedAt?: string | null }> }',
        category: 'os',
      });
      expect(registry.get('audit_findings_read')).toMatchObject({
        params: [],
        returnType: '{ findings: unknown; message?: string }',
        category: 'os',
      });
      expect(registry.get('report_request')).toMatchObject({
        params: [],
        returnType: '{ message: string }',
        category: 'os',
      });
      expect(registry.get('workorder_request')).toMatchObject({
        params: [
          {
            name: 'kind',
            type: "'board' | 'wiki' | 'memory-curation'",
            required: true,
          },
        ],
        returnType: '{ message: string }',
        category: 'os',
      });
      expect(registry.get('workorder_status')).toMatchObject({
        params: [],
        returnType: expect.stringContaining('failedCount'),
        category: 'os',
      });
      expect(registry.get('workorder_status')?.returnType).toContain("'temporal'");
    });
  });
});
