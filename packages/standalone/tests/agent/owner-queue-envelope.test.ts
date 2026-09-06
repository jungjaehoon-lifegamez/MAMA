import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { resetGlobalLaneManager } from '../../src/concurrency/index.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';
import type { PromptOptions } from '../../src/agent/model-runner.js';

afterEach(() => {
  resetGlobalLaneManager();
});

describe('TG-05/TG-06: one owner queue execution-time authority', () => {
  it('issues envelopes after queue wait and admits owner input before queued maintenance', async () => {
    const loop = new AgentLoop({} as never, { useLanes: true });
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executed: string[] = [];
    const prompt = vi.fn(async (text: string, _callbacks: unknown, options?: PromptOptions) => {
      executed.push(text);
      if (text === 'report') {
        started();
        await gate;
      } else expect(options?.toolExecutionContext?.envelope?.signature).toBeDefined();
      return { response: text, usage: { input_tokens: 0, output_tokens: 0 } };
    });
    (loop as unknown as { agent: unknown }).agent = { prompt };
    const common = { sessionKey: 'owner:runtime', source: 'operator', modelRunId: 'test-run' };
    const first = loop.run('report', common);
    await running;
    const issue = vi.fn(() =>
      makeSignedEnvelope({ expires_at: new Date(Date.now() + 630_000).toISOString() })
    );
    const background = loop.run('maintenance', { ...common, prepareEnvelope: issue });
    const owner = loop.runWithContent([{ type: 'text', text: 'owner' }], {
      ...common,
      lanePriority: 100,
      prepareEnvelope: issue,
    });
    expect(issue).not.toHaveBeenCalled();
    release();
    await Promise.all([first, background, owner]);
    expect(executed).toEqual(['report', 'owner', 'maintenance']);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('does not call the model or fall back to old authority after issuance fails', async () => {
    const loop = new AgentLoop({} as never, { useLanes: true });
    const prompt = vi.fn();
    (loop as unknown as { agent: unknown }).agent = { prompt };
    await expect(
      loop.run('report', {
        sessionKey: 'owner:runtime',
        modelRunId: 'test-run',
        envelope: makeSignedEnvelope(),
        prepareEnvelope: () => {
          throw new Error('issuance unavailable');
        },
      })
    ).rejects.toThrow('issuance unavailable');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('does not start a model when stopped while an asynchronous issuer is pending', async () => {
    const loop = new AgentLoop({} as never, { useLanes: true });
    const prompt = vi.fn(async () => ({
      response: 'unexpected',
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
    (loop as unknown as { agent: unknown }).agent = { prompt, stop: async () => {} };
    let release!: () => void;
    const pending = loop.run('report', {
      sessionKey: 'owner:runtime',
      modelRunId: 'test-run',
      prepareEnvelope: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return makeSignedEnvelope();
      },
    });
    const stopped = loop.stop();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_STOPPED' });
    await stopped;
    expect(prompt).not.toHaveBeenCalled();
  });
});
