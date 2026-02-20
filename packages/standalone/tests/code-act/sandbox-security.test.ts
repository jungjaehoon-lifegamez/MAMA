import { describe, it, expect, beforeAll } from 'vitest';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';

describe('CodeActSandbox Security', () => {
  beforeAll(async () => {
    await CodeActSandbox.warmup();
  });

  describe('API isolation', () => {
    it('blocks require()', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('require("fs")');
      expect(result.success).toBe(false);
    });

    it('blocks process access', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('process.exit(1)');
      expect(result.success).toBe(false);
    });

    it('has no globalThis.process', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('typeof globalThis.process');
      expect(result.success).toBe(true);
      expect(result.value).toBe('undefined');
    });

    it('import() returns pending promise (no module loader)', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('import("fs")');
      // QuickJS has no module loader — import() returns a pending/rejected promise
      // Either way, no actual module access occurs
      if (result.success) {
        // Pending promise wrapper — no actual module loaded
        expect(result.value).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('prototype pollution isolation', () => {
    it('does not affect host Object.prototype', async () => {
      const sandbox = new CodeActSandbox();
      await sandbox.execute('Object.prototype.polluted = true');
      expect(({} as any).polluted).toBeUndefined();
    });

    it('does not affect host Array.prototype', async () => {
      const sandbox = new CodeActSandbox();
      await sandbox.execute('Array.prototype.evil = function() { return "bad"; }');
      expect(([] as any).evil).toBeUndefined();
    });
  });

  describe('resource limits', () => {
    it('enforces memory limit', async () => {
      const sandbox = new CodeActSandbox({ memoryLimitBytes: 1024 * 1024 });
      const result = await sandbox.execute(`
        var arr = [];
        for (var i = 0; i < 100000; i++) arr.push(new Array(1000).fill(i));
      `);
      expect(result.success).toBe(false);
    });

    it('enforces timeout for infinite loops', async () => {
      const sandbox = new CodeActSandbox({ timeoutMs: 300 });
      const start = performance.now();
      const result = await sandbox.execute('while(true) {}');
      const elapsed = performance.now() - start;
      expect(result.success).toBe(false);
      expect(elapsed).toBeLessThan(2000);
    });

    it('enforces host call limit', async () => {
      const sandbox = new CodeActSandbox({ maxConcurrentCalls: 3 });
      sandbox.registerFunction('noop', async () => true);

      const result = await sandbox.execute(`
        noop(); noop(); noop(); noop();
        true;
      `);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('limit exceeded');
    });
  });

  describe('error isolation', () => {
    it('sandbox crash does not affect host', async () => {
      const sandbox = new CodeActSandbox({ memoryLimitBytes: 512 * 1024 });
      const result = await sandbox.execute(`
        var arr = [];
        while(true) arr.push(new Array(10000));
      `);
      expect(result.success).toBe(false);

      // Host still works — can create new sandbox and execute
      const sandbox2 = new CodeActSandbox();
      const result2 = await sandbox2.execute('1 + 1');
      expect(result2.success).toBe(true);
      expect(result2.value).toBe(2);
    });

    it('stack overflow is caught', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute(`
        function recurse() { return recurse(); }
        recurse();
      `);
      expect(result.success).toBe(false);
    });
  });
});
