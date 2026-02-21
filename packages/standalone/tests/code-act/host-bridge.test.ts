import { describe, it, expect, vi, beforeAll } from 'vitest';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';
import type { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { RoleManager } from '../../src/agent/role-manager.js';
import type { RoleConfig } from '../../src/cli/config/types.js';

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
    });

    it('returns only read-only tools for Tier 2', () => {
      const bridge = new HostBridge(makeExecutor());
      const fns = bridge.getAvailableFunctions(2);
      const names = fns.map((f) => f.name);
      expect(names).toContain('mama_search');
      expect(names).toContain('Read');
      expect(names).toContain('mama_load_checkpoint');
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

    it('tier 3 is strictly read-only (no memory-write)', () => {
      const bridge = new HostBridge(makeExecutor());
      const t3 = bridge.getAvailableFunctions(3);
      const t3Names = t3.map((f) => f.name);
      expect(t3Names).toContain('mama_search');
      expect(t3Names).not.toContain('mama_save');
      expect(t3Names).not.toContain('mama_update');
      expect(t3Names).not.toContain('Write');
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
  });

  describe('static getToolRegistry', () => {
    it('returns complete registry', () => {
      const registry = HostBridge.getToolRegistry();
      expect(registry.length).toBeGreaterThanOrEqual(25);
      expect(registry.every((t) => t.name && t.description && t.category)).toBe(true);
    });
  });
});
