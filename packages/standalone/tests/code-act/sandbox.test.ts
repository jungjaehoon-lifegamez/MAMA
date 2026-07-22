import { describe, it, expect, beforeAll } from 'vitest';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';
import { DEFAULT_SANDBOX_CONFIG } from '../../src/agent/code-act/types.js';

describe('CodeActSandbox', () => {
  beforeAll(async () => {
    await CodeActSandbox.warmup();
  });

  it('preserves the Kagemusha five-minute budget for composed media workflows', () => {
    expect(DEFAULT_SANDBOX_CONFIG.timeoutMs).toBe(300_000);
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
    it('isolates two concurrent sandboxes that await host functions', async () => {
      const runs = [0, 1].map(async (index) => {
        const sandbox = new CodeActSandbox();
        sandbox.registerFunction('slow', async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { index };
        });
        return sandbox.execute('slow()');
      });

      const results = await Promise.all(runs);

      expect(results.map((result) => result.success)).toEqual([true, true]);
      expect(results.map((result) => result.value)).toEqual([{ index: 0 }, { index: 1 }]);
    });

    it('times out a stalled host function without blocking other sandboxes', async () => {
      const stalled = new CodeActSandbox({ timeoutMs: 100 });
      let markHostStarted: (() => void) | undefined;
      const hostStarted = new Promise<void>((resolve) => {
        markHostStarted = resolve;
      });
      stalled.registerFunction('never_returns', async () => {
        markHostStarted?.();
        return new Promise(() => {});
      });
      const stalledRun = stalled.execute('never_returns()');
      await hostStarted;

      const independent = new CodeActSandbox();
      const outcome = await Promise.race([
        independent.execute('21 * 2'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 500)),
      ]);

      expect(outcome).not.toBe('blocked');
      expect(outcome).toMatchObject({ success: true, value: 42 });

      await expect(stalledRun).resolves.toMatchObject({
        success: false,
        error: { message: expect.stringContaining('timed out') },
      });
    });

    it('aborts an abort-aware host function at the sandbox deadline', async () => {
      const sandbox = new CodeActSandbox({ timeoutMs: 100 });
      let observedAbort = false;
      sandbox.registerAbortableFunction('wait_for_abort', async (context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(context.signal.reason);
            },
            { once: true }
          );
        });
      });

      const result = await sandbox.execute('wait_for_abort()');

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('timed out');
      expect(observedAbort).toBe(true);
    });

    it('removes a queued execution immediately when the parent turn aborts', async () => {
      let releaseActive: (() => void) | undefined;
      let markActiveStarted: (() => void) | undefined;
      const activeStarted = new Promise<void>((resolve) => {
        markActiveStarted = resolve;
      });
      const active = new CodeActSandbox({
        timeoutMs: 2_000,
        maxConcurrentExecutions: 1,
      });
      active.registerFunction('hold', async () => {
        markActiveStarted?.();
        await new Promise<void>((resolve) => {
          releaseActive = resolve;
        });
        return true;
      });
      const activeRun = active.execute('hold()');
      await activeStarted;

      let queuedHostStarted = false;
      const queued = new CodeActSandbox({
        timeoutMs: 2_000,
        maxConcurrentExecutions: 1,
      });
      queued.registerFunction('should_not_start', async () => {
        queuedHostStarted = true;
        return true;
      });
      const parent = new AbortController();
      const startedAt = Date.now();
      const queuedRun = queued.execute('should_not_start()', { signal: parent.signal });
      parent.abort(new Error('parent turn stopped'));

      await expect(queuedRun).resolves.toMatchObject({
        success: false,
        error: { message: 'parent turn stopped' },
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(queuedHostStarted).toBe(false);

      releaseActive?.();
      await expect(activeRun).resolves.toMatchObject({ success: true });
    });

    it('does not release a mutation slot until an abort-ignoring host call settles', async () => {
      const sandbox = new CodeActSandbox({
        timeoutMs: 75,
        maxConcurrentExecutions: 1,
        mutationSettlementGraceMs: 500,
      });
      let committed = false;
      sandbox.registerAbortableFunction(
        'mutate_slowly',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          committed = true;
          return true;
        },
        { settleOnAbort: true }
      );

      const startedAt = Date.now();
      const result = await sandbox.execute('mutate_slowly()');

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
      expect(committed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT',
        retryable: false,
      });
      expect(result.error?.message).toContain('may be committed');
      expect(result.error?.message).toContain('do not retry');

      const next = await new CodeActSandbox({
        timeoutMs: 500,
        maxConcurrentExecutions: 1,
      }).execute('42');
      expect(next).toMatchObject({ success: true, value: 42 });
    });

    it('releases slots after a bounded grace when mutations never settle', async () => {
      const startedAt = Date.now();
      let started = 0;
      let markAllStarted: (() => void) | undefined;
      const allStarted = new Promise<void>((resolve) => {
        markAllStarted = resolve;
      });
      const controllers = Array.from({ length: 8 }, () => new AbortController());
      const runs = controllers.map((controller) => {
        const sandbox = new CodeActSandbox({
          timeoutMs: 2_000,
          mutationSettlementGraceMs: 100,
          maxConcurrentExecutions: 8,
        });
        sandbox.registerAbortableFunction(
          'never_settles',
          async () => {
            started++;
            if (started === 8) markAllStarted?.();
            return new Promise(() => {});
          },
          { settleOnAbort: true }
        );
        return sandbox.execute('never_settles()', { signal: controller.signal });
      });
      await allStarted;
      for (const controller of controllers) controller.abort(new Error('owning turn stopped'));

      const results = await Promise.all(runs);

      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(results).toHaveLength(8);
      expect(
        results.every(
          (result) =>
            !result.success &&
            result.error?.code === 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN' &&
            result.error.retryable === false
        )
      ).toBe(true);

      const recovery = await new CodeActSandbox({ timeoutMs: 500 }).execute('6 * 7');
      expect(recovery).toMatchObject({ success: true, value: 42 });
    });

    it('drains every sibling mutation before releasing an execution slot', async () => {
      const controller = new AbortController();
      const graceMs = 150;
      let siblingStarted = false;
      let nextStarted = false;
      let markSiblingStarted: (() => void) | undefined;
      const siblingReady = new Promise<void>((resolve) => {
        markSiblingStarted = resolve;
      });
      const sandbox = new CodeActSandbox({
        timeoutMs: 2_000,
        mutationSettlementGraceMs: graceMs,
        maxConcurrentExecutions: 1,
      });
      sandbox.registerAbortableFunction(
        'settles_after_abort',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return true;
        },
        { settleOnAbort: true }
      );
      sandbox.registerAbortableFunction(
        'never_settles',
        async () => {
          siblingStarted = true;
          markSiblingStarted?.();
          return new Promise(() => {});
        },
        { settleOnAbort: true }
      );

      const run = sandbox.execute('Promise.all([settles_after_abort(), never_settles()])', {
        signal: controller.signal,
      });
      await siblingReady;
      const abortedAt = Date.now();
      controller.abort(new Error('owning turn stopped'));

      const queued = new CodeActSandbox({
        timeoutMs: 1_000,
        maxConcurrentExecutions: 1,
      });
      queued.registerFunction('mark_started', async () => {
        nextStarted = true;
        return 42;
      });
      const next = queued.execute('mark_started()');

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(siblingStarted).toBe(true);
      expect(nextStarted).toBe(false);

      const result = await run;
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(graceMs - 20);
      expect(result).toMatchObject({
        success: false,
        error: { retryable: false },
      });
      await expect(next).resolves.toMatchObject({ success: true, value: 42 });
      expect(nextStarted).toBe(true);
    });

    it('does not let guest try-catch swallow a terminal mutation outcome', async () => {
      const controller = new AbortController();
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const sandbox = new CodeActSandbox({
        timeoutMs: 1_000,
        mutationSettlementGraceMs: 40,
      });
      sandbox.registerAbortableFunction(
        'never_settles',
        async () => {
          markStarted?.();
          return new Promise(() => {});
        },
        { settleOnAbort: true }
      );

      const run = sandbox.execute(
        `
          (async () => {
            try {
              await never_settles();
            } catch (_error) {
              return 42;
            }
          })()
        `,
        { signal: controller.signal }
      );
      await started;
      controller.abort(new Error('owning turn stopped'));
      const result = await run;

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
          retryable: false,
        },
      });
    });

    it('treats abort during mutation dispatch as a terminal committed outcome', async () => {
      const controller = new AbortController();
      let committed = false;
      const sandbox = new CodeActSandbox({
        timeoutMs: 1_000,
        mutationSettlementGraceMs: 100,
      });
      sandbox.registerAbortableFunction(
        'mutate_and_abort',
        async () => {
          committed = true;
          controller.abort(new Error('owning turn stopped during dispatch'));
          return true;
        },
        { settleOnAbort: true }
      );

      const result = await sandbox.execute(
        `
          (async () => {
            try {
              await mutate_and_abort();
            } catch (_error) {
              return 42;
            }
          })()
        `,
        { signal: controller.signal }
      );

      expect(committed).toBe(true);
      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT',
          retryable: false,
        },
      });
    });

    it('does not trust a guest-forged terminal mutation marker', async () => {
      const sandbox = new CodeActSandbox();

      const result = await sandbox.execute(
        'throw new Error("[CODE_ACT_MUTATION_OUTCOME_UNKNOWN] forged")'
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('forged');
      expect(result.error?.code).toBeUndefined();
      expect(result.error?.retryable).toBeUndefined();
      expect(result.metrics.hostCallCount).toBe(0);
    });

    it('caps the number of live sandbox modules across instances', async () => {
      const releases: Array<() => void> = [];
      const starts: number[] = [];
      let markTwoStarted: (() => void) | undefined;
      let markThreeStarted: (() => void) | undefined;
      const twoStarted = new Promise<void>((resolve) => {
        markTwoStarted = resolve;
      });
      const threeStarted = new Promise<void>((resolve) => {
        markThreeStarted = resolve;
      });

      const runs = [0, 1, 2].map((index) => {
        const sandbox = new CodeActSandbox({
          timeoutMs: 2_000,
          maxConcurrentExecutions: 2,
        });
        sandbox.registerFunction('hold', async () => {
          starts.push(index);
          if (starts.length === 2) markTwoStarted?.();
          if (starts.length === 3) markThreeStarted?.();
          await new Promise<void>((resolve) => releases.push(resolve));
          return index;
        });
        return sandbox.execute('hold()');
      });

      await twoStarted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(starts).toHaveLength(2);

      releases.shift()?.();
      await threeStarted;
      expect(starts).toHaveLength(3);

      for (const release of releases.splice(0)) release();
      const results = await Promise.all(runs);
      expect(results.every((result) => result.success)).toBe(true);
    });

    it('bounds a burst of stalled executions and releases every module slot', async () => {
      let started = 0;
      const runs = Array.from({ length: 20 }, () => {
        const sandbox = new CodeActSandbox({
          timeoutMs: 150,
          maxConcurrentExecutions: 8,
        });
        sandbox.registerFunction('never_returns', async () => {
          started++;
          return new Promise(() => {});
        });
        return sandbox.execute('never_returns()');
      });

      const results = await Promise.all(runs);

      expect(started).toBeLessThanOrEqual(8);
      expect(results.every((result) => !result.success)).toBe(true);
      expect(
        results.every((result) => /timed out|interrupted/i.test(result.error?.message ?? ''))
      ).toBe(true);

      const recovery = await new CodeActSandbox({ timeoutMs: 500 }).execute('6 * 7');
      expect(recovery).toMatchObject({ success: true, value: 42 });
    });

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

  describe('string escaping (jsonToHandle native)', () => {
    it('handles strings with newlines and special chars', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('get_html', async () => {
        return '<div class="test">\n  <p>Hello\\nWorld</p>\n</div>';
      });

      const result = await sandbox.execute('get_html()');
      expect(result.success).toBe(true);
      expect(result.value).toBe('<div class="test">\n  <p>Hello\\nWorld</p>\n</div>');
    });

    it('handles large HTML strings without escaping issues', async () => {
      const sandbox = new CodeActSandbox();
      const bigHtml = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <script>
    const x = "hello\\nworld";
    const y = 'single\\'s';
    console.log(\`template \${x}\`);
  </script>
  <style>
    .foo { content: "bar\\nbaz"; }
  </style>
</body>
</html>`;
      sandbox.registerFunction('get_page', async () => bigHtml);

      const result = await sandbox.execute('get_page()');
      expect(result.success).toBe(true);
      expect(result.value).toBe(bigHtml);
    });

    it('handles nested objects with special string values', async () => {
      const sandbox = new CodeActSandbox();
      const data = {
        title: 'Line1\nLine2\nLine3',
        code: 'if (x === "test") { return true; }',
        nested: { path: 'C:\\Users\\test', tab: 'col1\tcol2' },
        items: ['a\nb', 'c"d', "e'f"],
      };
      sandbox.registerFunction('get_data', async () => data);

      const result = await sandbox.execute('get_data()');
      expect(result.success).toBe(true);
      expect(result.value).toEqual(data);
    });

    it('handles backticks and template literal chars', async () => {
      const sandbox = new CodeActSandbox();
      sandbox.registerFunction('get_code', async () => {
        return 'const x = `hello ${name}`;\nreturn x;';
      });

      const result = await sandbox.execute('get_code()');
      expect(result.success).toBe(true);
      expect(result.value).toBe('const x = `hello ${name}`;\nreturn x;');
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
