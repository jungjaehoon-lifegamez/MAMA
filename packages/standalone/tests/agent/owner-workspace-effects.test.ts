import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { OwnerActionEffectLedger } from '../../src/operator/owner-action-effects.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

// TG-04/TG-06: real shell/file effects and SQLite reservations; no external sends.
describe('owner workspace effect replay', () => {
  const roots: string[] = [];
  afterEach(() =>
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  );
  it.each(['discord_send', 'slack_send', 'webchat_send'] as const)(
    'TG-06 releases a proven preflight failure for %s',
    async (tool) => {
      const db = new Database(':memory:');
      try {
        const envelope = makeSignedEnvelope();
        const ledger = new OwnerActionEffectLedger(db);
        const executor = new GatewayToolExecutor({
          mamaApi: {
            appendToolTrace: async () => ({}),
            getModelRun: async () => ({ status: 'running', envelope_hash: envelope.envelope_hash }),
          } as never,
        });
        executor.setOwnerActionEffectLedger(ledger);
        const context = {
          envelope,
          modelRunId: 'mr-preflight',
          sourceMessageRef: 'message:preflight',
        };
        const input = tool === 'webchat_send' ? {} : { channel_id: 'test' };
        expect(await executor.execute(tool, input as never, context)).toMatchObject({
          success: false,
        });
        expect(await executor.execute(tool, input as never, context)).toMatchObject({
          success: false,
        });
        expect(ledger.hasUnsafeReplayEffects(context.sourceMessageRef)).toBe(false);
        expect(db.prepare('SELECT count(*) n FROM owner_action_effects').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    }
  );

  it('TG-06 releases a shell reservation only when the process could not start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-effect-'));
    roots.push(root);
    const db = new Database(':memory:');
    try {
      const envelope = makeSignedEnvelope();
      const ledger = new OwnerActionEffectLedger(db);
      const executor = new GatewayToolExecutor({
        mamaApi: {
          appendToolTrace: async () => ({}),
          getModelRun: async () => ({ status: 'running', envelope_hash: envelope.envelope_hash }),
        } as never,
      });
      executor.setOwnerActionEffectLedger(ledger);
      expect(
        await executor.execute(
          'Bash',
          { command: 'printf x', workdir: join(root, 'missing') },
          { envelope, modelRunId: 'mr-no-spawn', sourceMessageRef: 'message:no-spawn' }
        )
      ).toMatchObject({ success: false });
      expect(ledger.hasUnsafeReplayEffects('message:no-spawn')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('TG-05 persists admission before native notifications and refuses an unsettled final response', () => {
    const db = new Database(':memory:');
    try {
      const ledger = new OwnerActionEffectLedger(db);
      const executor = new GatewayToolExecutor();
      executor.setOwnerActionEffectLedger(ledger);
      const observer = executor.createNativeEffectObserver({
        envelope: makeSignedEnvelope(),
        modelRunId: 'mr-native',
        sourceMessageRef: 'message:native',
      })!;
      // The admission row is persisted before any notification, but the marker
      // alone is not an unsettled external effect.
      expect(
        db
          .prepare(
            "SELECT status FROM owner_action_effects WHERE occurrence_key = 'message:native' AND effect_kind = 'native_run'"
          )
          .get()
      ).toEqual({ status: 'transmitting' });
      expect(ledger.hasUnsettledEffects('message:native')).toBe(false);
      observer.started('commandExecution', { nativeToolUseId: 'cmd-1' });
      expect(() => observer.finished?.()).toThrow(/did not settle/);
      observer.settled('commandExecution', 'cmd-1', false);
      observer.finished?.();
      expect(ledger.hasUnsettledEffects('message:native')).toBe(false);
      expect(ledger.hasUnsafeReplayEffects('message:native')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('TG-04 creates one task per logical key and rejects changed retry payloads', async () => {
    const db = new Database(':memory:');
    try {
      const tasks = new TaskLedger(db);
      const envelope = makeSignedEnvelope();
      const executor = new GatewayToolExecutor({
        mamaApi: {
          appendToolTrace: async () => ({}),
          getModelRun: async () => ({ status: 'running', envelope_hash: envelope.envelope_hash }),
        } as never,
      });
      executor.setTaskLedger(tasks);
      executor.setOwnerActionEffectLedger(new OwnerActionEffectLedger(db));
      const context = { envelope, modelRunId: 'mr-create', sourceMessageRef: 'message:create' };
      const input = {
        title: 'deliver report',
        completion_criteria: 'report delivered',
        creation_key: 'report',
      };
      const first = await executor.execute('task_create', input as never, context);
      expect(await executor.execute('task_create', input as never, context)).toEqual(first);
      await expect(
        executor.execute('task_create', { ...input, title: 'changed intent' } as never, context)
      ).rejects.toThrow(/intent|different/);
      expect(
        (
          db.prepare("SELECT count(*) n FROM operator_tasks WHERE kind = 'owner'").get() as {
            n: number;
          }
        ).n
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('does not execute a confirmed shell append twice in the same occurrence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-effect-'));
    roots.push(root);
    const db = new Database(':memory:');
    try {
      const envelope = makeSignedEnvelope();
      const ledger = new OwnerActionEffectLedger(db);
      const executor = new GatewayToolExecutor({
        mamaApi: {
          appendToolTrace: async () => ({}),
          getModelRun: async () => ({ status: 'running', envelope_hash: envelope.envelope_hash }),
        } as never,
      });
      executor.setOwnerActionEffectLedger(ledger);
      const context = {
        envelope,
        modelRunId: 'mr-effect',
        sourceMessageRef: 'workorder:effect-test',
      };
      const input = { command: 'printf x >> result.txt', workdir: root };
      expect(await executor.execute('Bash', input, context)).toMatchObject({ success: true });
      expect(await executor.execute('Bash', input, context)).toMatchObject({ success: true });
      expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('x');
      expect(ledger.hasUnsafeReplayEffects('workorder:effect-test')).toBe(true);
    } finally {
      db.close();
    }
  });
  it('quarantines a failed shell after a partial effect and refuses replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-effect-'));
    roots.push(root);
    const db = new Database(':memory:');
    try {
      const envelope = makeSignedEnvelope();
      const ledger = new OwnerActionEffectLedger(db);
      const executor = new GatewayToolExecutor({
        mamaApi: {
          appendToolTrace: async () => ({}),
          getModelRun: async () => ({ status: 'running', envelope_hash: envelope.envelope_hash }),
        } as never,
      });
      executor.setOwnerActionEffectLedger(ledger);
      const context = {
        envelope,
        modelRunId: 'mr-effect',
        sourceMessageRef: 'workorder:failed-effect',
      };
      const input = { command: 'printf x >> result.txt; exit 1', workdir: root };
      await expect(executor.execute('Bash', input, context)).rejects.toMatchObject({
        code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      });
      await expect(executor.execute('Bash', input, context)).rejects.toMatchObject({
        code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      });
      expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('x');
    } finally {
      db.close();
    }
  });
});
