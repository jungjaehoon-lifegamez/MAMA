import { describe, expect, it } from 'vitest';
import {
  createCatalog,
  createDispatcher,
  type ActionDispatcher,
  type ActionRegistration,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import { codeActRegistration, runCodeAct } from '../../src/api/code-act-actions.js';

const echo = (name: string): ActionRegistration => ({
  contract: {
    name,
    summary: `Return what ${name} was given. Second sentence stays out of help.`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  },
  exec: async (input, context) => ({ name, input, operationId: context.operationId }),
});

function surface(actions: string[]) {
  const catalog = createCatalog([
    echo('work.list'),
    echo('schedule.upcoming'),
    echo('memory.read:provenance'),
    echo('admin.only'),
    codeActRegistration(() => dispatch),
  ]);
  const dispatch: ActionDispatcher = createDispatcher(catalog);
  const access: JudgmentAccess = {
    principalId: 'owner',
    agentId: 'agent',
    scopes: [],
    actions,
  };
  return (code: string) =>
    dispatch({ action: 'code_act', input: { code }, operationId: 'op-1' }, { access });
}

describe('code_act', () => {
  it('makes several granted actions in one call with the caller context', async () => {
    const run = surface(['code_act', 'work.list', 'schedule.upcoming', 'memory.read:provenance']);
    const result = await run(
      'const [a, b] = await Promise.all([work.list({ value: "x" }), schedule.upcoming({})]); const c = await memory["read:provenance"]({ value: "y" }); console.log("done"); return { a, b, c };'
    );
    expect(result.status).toBe('completed');
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ success: true, logs: ['done'], hostCallCount: 3 });
    const value = data.value as Record<string, { name: string; operationId: string }>;
    expect(value.a).toMatchObject({ name: 'work.list', input: { value: 'x' } });
    expect(value.b.name).toBe('schedule.upcoming');
    expect(value.c.name).toBe('memory.read:provenance');
    // Every inner call is its own operation under the caller's.
    expect(new Set([value.a.operationId, value.b.operationId, value.c.operationId]).size).toBe(3);
    expect(value.a.operationId).toMatch(/^op-1#\d$/);
  });

  it('gives the code only what the caller is granted, and never code_act itself', async () => {
    const run = surface(['code_act', 'work.list']);
    for (const name of ['admin.only', 'code_act']) {
      const denied = await run(`return await callTool("${name}", { code: "return 1" });`);
      expect(
        (denied as { data: { success: boolean; error: { message: string } } }).data
      ).toMatchObject({
        success: false,
        error: { message: `action_not_granted: ${name}` },
      });
    }
    const names = await run(
      'return [typeof work.list, typeof schedule, typeof admin, typeof code_act];'
    );
    expect((names as { data: { value: unknown } }).data.value).toEqual([
      'function',
      'undefined',
      'undefined',
      'undefined',
    ]);
  });

  it('returns an error thrown by the code instead of failing the call', async () => {
    const run = surface(['code_act']);
    const result = await run('throw new RangeError("bad input");');
    expect((result as { data: unknown }).data).toMatchObject({
      success: false,
      error: { name: 'RangeError', message: 'bad input' },
    });
  });

  it('reaches no files or processes even when the code escapes the vm namespace', async () => {
    const run = surface(['code_act']);
    const result = await run(
      'const p = this.constructor.constructor("return process")(); try { p.mainModule; return p.binding("fs") ? "fs" : "none"; } catch (e) { return e.code || e.message; }'
    );
    const outcome = (result as { data: { value?: unknown; error?: unknown } }).data;
    expect(JSON.stringify(outcome)).not.toContain('"value":"fs"');
    const read = await run(
      'const p = this.constructor.constructor("return process")(); return p.getBuiltinModule("node:fs").readFileSync("/etc/hosts", "utf8").length;'
    );
    expect((read as { data: { success: boolean; error: { message: string } } }).data).toMatchObject(
      {
        success: false,
        error: { message: expect.stringContaining('Access to this API has been restricted') },
      }
    );
  });

  it('gives an escaped script no inherited environment', async () => {
    process.env.CODE_ACT_TEST_SECRET = 'must-not-leak';
    try {
      const run = surface(['code_act']);
      const env = await run(
        'const p = this.constructor.constructor("return process")(); return Object.keys(p.env);'
      );
      // The OS may add its own (macOS sets __CF_USER_TEXT_ENCODING); nothing is inherited.
      const keys = (env as { data: { value: string[] } }).data.value;
      for (const inherited of ['CODE_ACT_TEST_SECRET', 'PATH', 'HOME'])
        expect(keys).not.toContain(inherited);
    } finally {
      delete process.env.CODE_ACT_TEST_SECRET;
    }
  });

  it('returns a single expression, with or without its closing semicolon', async () => {
    const run = surface(['code_act', 'work.list']);
    for (const code of ['work.list({ value: "x" })', 'work.list({ value: "x" });']) {
      const result = await run(code);
      expect((result as { data: { value: { input: unknown } } }).data.value.input).toEqual({
        value: 'x',
      });
    }
    const inString = await run('work.list({ value: "a;b" })');
    expect((inString as { data: { value: { input: unknown } } }).data.value.input).toEqual({
      value: 'a;b',
    });
  });

  it('kills a worker that never finishes', async () => {
    const result = await runCodeAct(
      'await new Promise(() => {});',
      { functions: [], call: async () => null },
      500
    );
    expect(result).toMatchObject({ success: false, error: { name: 'TimeoutError' } });
  });
});
