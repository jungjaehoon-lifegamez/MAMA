import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { beginModelRun, type DatabaseInstance, type Knowledge } from '@jungjaehoon/mama-core';
import { NativeEffectReplayBoundary } from '@jungjaehoon/mama-core/runtime/native-session';
import { CodexAppServerProcess } from '@jungjaehoon/mama-core/runtime/drivers/codex-app-server-process';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { createNativeSession } from '../../src/runtime/native-session.js';
import type { IModelRunner, PromptCallbacks } from '@jungjaehoon/mama-core/runtime/drivers/types';
function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrations = join(__dirname, '../../../mama-core/db/migrations');
  for (const file of readdirSync(migrations)
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort())
    db.exec(readFileSync(join(migrations, file), 'utf8'));
  const surface = createActionSurface({
    timeZone: createTimeZoneSetting('UTC'),
    runtimeRoot: '/tmp/mama-test-runtime',
    configPath: '/tmp/mama-test-config.yaml',
    isOwnerMessageTurn: () => true,
    adapter: db as unknown as DatabaseInstance,
    knowledge: {} as Knowledge,
    ownerPrincipalId: 'owner',
    agentId: 'agent',
  });
  return { db, surface };
}
describe('native tool trace assembly', () => {
  it('records every action code_act makes as its own trace row in the calling model run', async () => {
    const { db, surface } = fixture();
    const run = await beginModelRun(db as unknown as DatabaseInstance, { model_id: 'fixture' });
    const result = await surface.hostToolCall(
      'code_act',
      {
        code: 'const [a, b] = await Promise.all([memory.checkpoint.list({}), memory.checkpoint.list({})]); return [a, b].length;',
      },
      'op-code-act',
      { session: { modelRunId: run.model_run_id } }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { success: true, value: 2, hostCallCount: 2 },
    });
    const rows = db
      .prepare(
        'SELECT tool_name, execution_status FROM tool_traces WHERE model_run_id = ? ORDER BY tool_name'
      )
      .all(run.model_run_id) as Array<{ tool_name: string; execution_status: string }>;
    expect(rows.map((row) => row.tool_name)).toEqual([
      'code_act',
      'memory.checkpoint.list',
      'memory.checkpoint.list',
    ]);
    expect(rows.every((row) => row.execution_status === 'completed')).toBe(true);
  });

  it('persists paired owner and child observations with bounded redacted inputs and statuses', async () => {
    const { db, surface } = fixture();
    const home = mkdtempSync(join(tmpdir(), 'native-traces-'));
    const run = await beginModelRun(db as unknown as DatabaseInstance, { model_id: 'fixture' });
    const secret = 'sk-' + 'ant-' + 'a'.repeat(32);
    const digest = 'a'.repeat(64);
    let callbacks: PromptCallbacks | undefined;
    const agent = {
      backendType: 'codex',
      reportsModelRuns: false,
      supportsNativeSubagents: true,
      prompt: async (_content: string, observed?: PromptCallbacks) => {
        callbacks = observed;
        for (const name of [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'WebFetch',
          'WebSearch',
          'commandExecution',
          'fileChange',
          'webSearch',
        ]) {
          observed?.onToolUse?.(name, {
            nativeToolUseId: name,
            command: `SERVICE_TOKEN=${secret} digest=${digest}`,
            nested: { password: 'synthetic-private' },
            ...(name === 'Read' ? { subagentItemId: 'child' } : {}),
            content: 'x'.repeat(6000),
          });
          observed?.onToolComplete?.(name, name, name === 'Write');
        }
        observed?.onToolUse?.('Read', { nativeToolUseId: 'unfinished', file_path: 'note.md' });
        return {
          response: 'answer',
          session_id: 'fixture',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      setSessionId: vi.fn(),
      setSystemPrompt: vi.fn(),
      isHealthy: () => true,
      getMetrics: vi.fn(),
      stop: vi.fn(),
    } as unknown as IModelRunner;
    const session = createNativeSession({
      backend: 'codex',
      model: 'fixture',
      workspaceDir: home,
      runtimeRoot: home,
      actionSurface: surface,
      agent,
      timeout: 1000,
      maxTurns: 2,
    });
    try {
      await session.runTurn([{ type: 'text', text: 'fixture' }], { modelRunId: run.model_run_id });
      callbacks?.onToolUse?.('shell', {
        nativeToolUseId: 'late-child',
        subagentThreadId: 'child',
        command: 'pwd',
      });
      callbacks?.onToolComplete?.('shell', 'late-child', false);
      await Promise.resolve();
      const rows = db.prepare('SELECT * FROM tool_traces ORDER BY rowid').all() as Array<{
        model_run_id: string;
        input_summary: string;
        duration_ms: number;
        tool_name: string;
        execution_status: string;
        gateway_call_id: string;
      }>;
      expect(rows).toHaveLength(11);
      expect(rows.every((row) => row.model_run_id === run.model_run_id)).toBe(true);
      expect(rows.every((row) => row.input_summary.length <= 4000)).toBe(true);
      expect(
        rows.every(
          (row) =>
            !row.input_summary.includes(secret) && !row.input_summary.includes('synthetic-private')
        )
      ).toBe(true);
      expect(rows[0].input_summary).toContain(digest);
      expect(rows.every((row) => Number.isInteger(row.duration_ms) && row.duration_ms >= 0)).toBe(
        true
      );
      expect(rows.find((row) => row.tool_name === 'Write').execution_status).toBe('failed');
      expect(rows.find((row) => row.gateway_call_id === 'unfinished').execution_status).toBe(
        'unknown'
      );
      expect(rows.find((row) => row.gateway_call_id === 'late-child').execution_status).toBe(
        'completed'
      );
    } finally {
      await session.stop();
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('keeps identical provider item IDs separate across a parent and two native children', async () => {
    const { db, surface } = fixture();
    const run = await beginModelRun(db as unknown as DatabaseInstance, { model_id: 'fixture' });
    const boundary = new NativeEffectReplayBoundary(
      surface.createNativeEffectObserver(run.model_run_id)
    );
    type Target = {
      nativeItems: Map<string, { name: string; completed: boolean }>;
      onToolUse: NonNullable<PromptCallbacks['onToolUse']>;
      onToolComplete: NonNullable<PromptCallbacks['onToolComplete']>;
    };
    const target = (): Target => ({
      nativeItems: new Map(),
      onToolUse: (name, input) => boundary.started(name, input),
      onToolComplete: (name, id, isError, outcome) => boundary.settled(name, id, isError, outcome),
    });
    const driver = Object.create(CodexAppServerProcess.prototype) as {
      observeNativeItem(
        target: Target,
        method: string,
        item: Record<string, unknown>,
        threadId: string,
        subagent?: boolean
      ): void;
      finishSubagent(threadId: string, status: 'interrupted'): void;
      subagents: Map<string, unknown>;
      finishedSubagents: Set<string>;
      options: Record<string, unknown>;
    };
    const parent = target();
    const childA = target();
    const childB = target();
    driver.options = {};
    driver.finishedSubagents = new Set();
    driver.subagents = new Map([
      [
        'child-b',
        {
          ...childB,
          parentThreadId: 'parent',
          sessionKey: 'fixture',
          agentPath: 'child-b',
          finalText: '',
          authority: Promise.resolve(null),
        },
      ],
    ]);
    try {
      const item = { id: 'same-item', type: 'commandExecution', command: 'pwd' };
      for (const [thread, context, child] of [
        ['parent', parent, false],
        ['child-a', childA, true],
        ['child-b', childB, true],
      ] as const) {
        driver.observeNativeItem(context, 'item/started', item, thread, child);
        driver.observeNativeItem(context, 'item/started', item, thread, child);
      }
      driver.observeNativeItem(
        childA,
        'item/completed',
        { ...item, status: 'failed', exitCode: 1 },
        'child-a',
        true
      );
      driver.observeNativeItem(
        parent,
        'item/completed',
        { ...item, status: 'completed', exitCode: 0 },
        'parent'
      );
      driver.observeNativeItem(
        parent,
        'item/completed',
        { ...item, status: 'completed', exitCode: 0 },
        'parent'
      );
      driver.finishSubagent('child-b', 'interrupted');
      await Promise.resolve();
      const rows = db
        .prepare(
          'SELECT model_run_id, gateway_call_id, input_summary, execution_status FROM tool_traces ORDER BY rowid'
        )
        .all() as Array<{
        model_run_id: string;
        gateway_call_id: string;
        input_summary: string;
        execution_status: string;
      }>;
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.execution_status)).toEqual(['completed', 'failed', 'unknown']);
      expect(rows.map((row) => row.gateway_call_id)).toEqual(
        ['parent', 'child-a', 'child-b'].map((thread) => JSON.stringify([thread, 'same-item']))
      );
      expect(rows.every((row) => row.model_run_id === run.model_run_id)).toBe(true);
      expect(
        rows.every((row) => JSON.parse(row.input_summary).providerToolUseId === 'same-item')
      ).toBe(true);
    } finally {
      db.close();
    }
  });
  it('redacts rejected catalog write inputs in real trace rows', async () => {
    const { db, surface } = fixture();
    const run = await beginModelRun(db as unknown as DatabaseInstance, { model_id: 'fixture' });
    const secret = 'sk-' + 'ant-' + 'a'.repeat(32);
    try {
      const result = await surface.hostToolCall(
        'memory.save',
        {
          topic: 'fixture',
          kind: 'decision',
          summary: secret,
          details: 'fixture',
          source: { package: 'fixture', source_type: 'fixture' },
        },
        'write',
        { session: { modelRunId: run.model_run_id } }
      );
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'secret_material_refused' },
      });
      const rows = db.prepare('SELECT input_summary, output_summary FROM tool_traces').all();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows).includes(secret)).toBe(false);
    } finally {
      db.close();
    }
  });
  it('pairs overlapping identical tool names by call ID and preserves settled duration', async () => {
    const { db, surface } = fixture();
    const run = await beginModelRun(db as unknown as DatabaseInstance, { model_id: 'fixture' });
    const observer = surface.createNativeEffectObserver(run.model_run_id);
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(1000);
      observer.started('Read', { nativeToolUseId: 'one' });
      observer.started('Read', { nativeToolUseId: 'two', subagentItemId: 'child' });
      clock.mockReturnValue(1020);
      observer.settled('Read', 'two', true);
      clock.mockReturnValue(1050);
      observer.settled('Read', 'one', false);
      observer.settled('Read', 'two', true);
      observer.interrupted();
      await Promise.resolve();
      const rows = db
        .prepare(
          'SELECT gateway_call_id, execution_status, duration_ms FROM tool_traces ORDER BY rowid'
        )
        .all();
      expect(rows).toEqual([
        { gateway_call_id: 'one', execution_status: 'completed', duration_ms: 50 },
        { gateway_call_id: 'two', execution_status: 'failed', duration_ms: 20 },
      ]);
    } finally {
      clock.mockRestore();
      db.close();
    }
    expect(vi.isMockFunction(Date.now)).toBe(false);
  });
  it.each(['append', 'factory'])(
    'keeps a native turn successful when trace %s fails',
    async (mode) => {
      const { db, surface } = fixture();
      const home = mkdtempSync(join(tmpdir(), 'native-traces-'));
      db.close();
      if (mode === 'factory')
        vi.spyOn(surface, 'createNativeEffectObserver').mockImplementation(() => {
          throw new Error('storage unavailable');
        });
      const prompt = vi.fn(async (_text, callbacks) => {
        callbacks.onToolUse('Bash', { nativeToolUseId: 'call', command: 'pwd' });
        callbacks.onToolComplete('Bash', 'call', false);
        return {
          response: 'answer',
          session_id: 'fixture',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      });
      const agent = {
        backendType: 'codex',
        reportsModelRuns: false,
        prompt,
        setSessionId: vi.fn(),
        setSystemPrompt: vi.fn(),
        isHealthy: () => true,
        getMetrics: vi.fn(),
        stop: vi.fn(),
      } as unknown as IModelRunner;
      const session = createNativeSession({
        backend: 'codex',
        model: 'fixture',
        workspaceDir: home,
        runtimeRoot: home,
        actionSurface: surface,
        agent,
        timeout: 1000,
        maxTurns: 2,
      });
      try {
        const result = await session.runTurn([{ type: 'text', text: 'fixture' }], {
          modelRunId: 'parent',
        });
        expect(result.response).toBe('answer');
        expect(prompt).toHaveBeenCalledTimes(1);
      } finally {
        await session.stop();
        rmSync(home, { recursive: true, force: true });
      }
    }
  );
});
