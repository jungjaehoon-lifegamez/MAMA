import { describe, it, expect, beforeAll } from 'vitest';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';

describe('CodeActSandbox', () => {
  beforeAll(async () => {
    await CodeActSandbox.warmup();
  });

  describe('basic execution', () => {
    it('evaluates simple expressions', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('1 + 2');
      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
    });

    it('returns object literals', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('({ a: 1, b: "hello" })');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ a: 1, b: 'hello' });
    });

    it('captures console.log', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute(`
        console.log("hello", 42);
        console.log("world");
        true;
      `);
      expect(result.success).toBe(true);
      expect(result.logs).toEqual(['hello 42', 'world']);
    });

    it('returns metrics', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('1 + 1');
      expect(result.metrics.durationMs).toBeGreaterThan(0);
      expect(result.metrics.hostCallCount).toBe(0);
    });
  });

  describe('async host functions', () => {
    it('calls a registered async host function', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('greet', async (name: unknown) => {
        return `Hello ${name}`;
      });

      const result = await sandbox.execute('greet("World")');
      expect(result.success).toBe(true);
      expect(result.value).toBe('Hello World');
    });

    it('returns JSON from host function', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('get_data', async () => {
        return [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ];
      });

      const result = await sandbox.execute('get_data()');
      expect(result.success).toBe(true);
      expect(result.value).toEqual([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]);
    });

    it('handles sequential host function calls', async () => {
      const sandbox = new CodeActSandbox();
      const callLog: string[] = [];

      sandbox.registerFunction('step', async (name: unknown) => {
        callLog.push(String(name));
        return `done_${name}`;
      });

      const result = await sandbox.execute(`
        var a = step("first");
        var b = step("second");
        var c = step("third");
        ({ a: a, b: b, c: c })
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        a: 'done_first',
        b: 'done_second',
        c: 'done_third',
      });
      expect(callLog).toEqual(['first', 'second', 'third']);
      expect(result.metrics.hostCallCount).toBe(3);
    });

    it('passes object arguments to host function', async () => {
      const sandbox = new CodeActSandbox();
      let receivedOpts: unknown = null;

      sandbox.registerFunction('send', async (opts: unknown) => {
        receivedOpts = opts;
        return true;
      });

      await sandbox.execute('send({ channel: "dev", message: "hi" })');
      expect(receivedOpts).toEqual({ channel: 'dev', message: 'hi' });
    });

    it('returns boolean values correctly', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('yes', async () => true);
      sandbox.registerFunction('no', async () => false);

      const r1 = await sandbox.execute('yes()');
      expect(r1.value).toBe(true);

      const r2 = await sandbox.execute('no()');
      expect(r2.value).toBe(false);
    });

    it('returns null/undefined correctly', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('nothing', async () => undefined);
      sandbox.registerFunction('nil', async () => null);

      const r1 = await sandbox.execute('nothing()');
      expect(r1.success).toBe(true);

      const r2 = await sandbox.execute('nil()');
      expect(r2.success).toBe(true);
    });

    it('tracks host call count in metrics', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('noop', async () => true);

      const result = await sandbox.execute(`
        noop(); noop(); noop(); noop(); noop();
        true;
      `);
      expect(result.metrics.hostCallCount).toBe(5);
    });
  });

  describe('data transformation in sandbox', () => {
    it('filters and maps data from host function', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('get_scores', async () => {
        return [
          { name: 'Alice', score: 90 },
          { name: 'Bob', score: 60 },
          { name: 'Charlie', score: 85 },
        ];
      });

      const result = await sandbox.execute(`
        var data = get_scores();
        var high = data.filter(function(d) { return d.score >= 80; });
        ({ count: high.length, names: high.map(function(d) { return d.name; }) })
      `);

      expect(result.success).toBe(true);
      expect(result.value).toEqual({ count: 2, names: ['Alice', 'Charlie'] });
    });
  });

  describe('error handling', () => {
    it('catches syntax errors', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('var x = {;');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.name).toMatch(/SyntaxError/);
    });

    it('catches runtime errors', async () => {
      const sandbox = new CodeActSandbox();
      const result = await sandbox.execute('undefinedVar.foo');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('propagates host function errors', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('fail', async () => {
        throw new Error('Host error');
      });

      const result = await sandbox.execute('fail()');
      expect(result.success).toBe(false);
    });

    it('allows try-catch in sandbox for host errors', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('may_fail', async (shouldFail: unknown) => {
        if (shouldFail) throw new Error('Intentional');
        return 'ok';
      });

      const result = await sandbox.execute(`
        var result;
        try { result = may_fail(true); } catch(e) { result = "caught: " + e.message; }
        result;
      `);
      expect(result.success).toBe(true);
      expect(result.value).toContain('caught');
    });
  });

  describe('function management', () => {
    it('lists registered functions', () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('fn_a', async () => 1);
      sandbox.registerFunction('fn_b', async () => 2);
      expect(sandbox.getRegisteredFunctions()).toEqual(['fn_a', 'fn_b']);
    });

    it('unregisters functions', () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('temp', async () => 1);
      expect(sandbox.getRegisteredFunctions()).toContain('temp');
      sandbox.unregisterFunction('temp');
      expect(sandbox.getRegisteredFunctions()).not.toContain('temp');
    });
  });
});
