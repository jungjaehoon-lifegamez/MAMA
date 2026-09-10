/**
 * The Claude runner's subagent surface, in the shape the host already consumes.
 *
 * `attachSubagentWake` subscribes to a runner's `subagent` events and knows only the Codex
 * `SubagentEvent` shape. These pin that the Claude adapter declares the capability and
 * emits that same shape - and that a completion the CLI answered with its own turn is
 * reported as observed, not as a wake, so the owner never gets two turns for one child.
 */

import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';

import { PersistentCLIAdapter } from '../../src/agent/persistent-cli-adapter.js';
import {
  attachSubagentWake,
  type SubagentEvent,
} from '../../src/operator/subagent-stimulus.js';
import { OWNER_RUNTIME_SESSION_KEY } from '../../src/operator/owner-runtime.js';

class FakeProcess extends EventEmitter {
  constructor(private readonly live: boolean) {
    super();
  }
  getSessionId(): string {
    return 'cli-session-1';
  }
  getRunContextKey(): string | null {
    return null;
  }
  hasLiveBackgroundAgents(): boolean {
    return this.live;
  }
  finishChild(): void {
    (this as { live: boolean }).live = false;
    this.emit('subagent', { kind: 'completed', agentThreadId: 'agent_1', itemId: 'toolu_1' });
  }
}

function wire(adapter: PersistentCLIAdapter, proc: FakeProcess, sessionKey: string): void {
  (
    adapter as unknown as {
      wireSubagentEvents(proc: unknown, channelKey: string): void;
    }
  ).wireSubagentEvents(proc, sessionKey);
}

describe('PersistentCLIAdapter native subagent events', () => {
  it('declares the native subagent capability', () => {
    expect(new PersistentCLIAdapter().supportsNativeSubagents).toBe(true);
  });

  it('re-emits a spawn in the shape the owner wake consumes', () => {
    const adapter = new PersistentCLIAdapter();
    const proc = new FakeProcess(true);
    wire(adapter, proc, OWNER_RUNTIME_SESSION_KEY);
    const seen: SubagentEvent[] = [];
    adapter.on('subagent', (event: SubagentEvent) => seen.push(event));

    proc.emit('subagent', {
      kind: 'started',
      agentThreadId: 'agent_1',
      agentPath: 'board sweep',
      itemId: 'toolu_1',
      wakeRequired: false,
    });

    expect(seen).toEqual([
      {
        kind: 'started',
        sessionKey: OWNER_RUNTIME_SESSION_KEY,
        parentThreadId: 'cli-session-1',
        agentThreadId: 'agent_1',
        agentPath: 'board sweep',
      },
    ]);
  });

  it('wakes the owner when the host owns the wake', async () => {
    const adapter = new PersistentCLIAdapter();
    const proc = new FakeProcess(false);
    wire(adapter, proc, OWNER_RUNTIME_SESSION_KEY);
    const woken: SubagentEvent[] = [];
    const detach = attachSubagentWake(
      adapter,
      async (event) => {
        woken.push(event);
      },
      () => {}
    );

    proc.emit('subagent', {
      kind: 'completed',
      agentThreadId: 'agent_1',
      agentPath: 'board sweep',
      itemId: 'toolu_1',
      status: 'completed',
      finalText: 'two rows',
      wakeRequired: true,
    });
    await Promise.resolve();
    detach();

    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({
      sessionKey: OWNER_RUNTIME_SESSION_KEY,
      agentThreadId: 'agent_1',
      status: 'completed',
      finalText: 'two rows',
    });
  });

  it("reports a completion the CLI already answered as observed, not as a wake", async () => {
    const adapter = new PersistentCLIAdapter();
    const proc = new FakeProcess(false);
    wire(adapter, proc, OWNER_RUNTIME_SESSION_KEY);
    const woken: SubagentEvent[] = [];
    const observed: SubagentEvent[] = [];
    adapter.on('subagentObserved', (event: SubagentEvent) => observed.push(event));
    const detach = attachSubagentWake(
      adapter,
      async (event) => {
        woken.push(event);
      },
      () => {}
    );

    proc.emit('subagent', {
      kind: 'completed',
      agentThreadId: 'agent_1',
      agentPath: 'board sweep',
      itemId: 'toolu_1',
      status: 'completed',
      finalText: 'two rows',
      wakeRequired: false,
    });
    await Promise.resolve();
    detach();

    expect(woken).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'completed', agentThreadId: 'agent_1' });
  });

  it('passes the CLI-initiated turn through to the host', () => {
    const adapter = new PersistentCLIAdapter();
    const proc = new FakeProcess(true);
    wire(adapter, proc, OWNER_RUNTIME_SESSION_KEY);
    const turns: Array<Record<string, unknown>> = [];
    const results: Array<Record<string, unknown>> = [];
    adapter.on('autonomousTurn', (event: Record<string, unknown>) => turns.push(event));
    adapter.on('autonomousTurnResult', (event: Record<string, unknown>) => results.push(event));

    proc.emit('autonomousTurn', {
      agentThreadId: 'agent_1',
      agentPath: 'board sweep',
      itemId: 'toolu_1',
    });
    proc.emit('autonomousTurnResult', {
      agentThreadId: 'agent_1',
      agentPath: 'board sweep',
      itemId: 'toolu_1',
      text: 'CHILD_DONE',
      isError: false,
    });

    expect(turns[0]).toMatchObject({
      agentThreadId: 'agent_1',
      sessionKey: OWNER_RUNTIME_SESSION_KEY,
    });
    expect(results[0]).toMatchObject({ text: 'CHILD_DONE', isError: false });
  });
});

describe('PersistentCLIAdapter turn admission with a live background child', () => {
  function waiter(adapter: PersistentCLIAdapter, proc: FakeProcess): Promise<void> {
    return (
      adapter as unknown as {
        waitForLiveBackgroundAgents(proc: unknown, key: string): Promise<void>;
      }
    ).waitForLiveBackgroundAgents(proc, 'ctx-1');
  }

  it('does not wait when no child is live', async () => {
    const adapter = new PersistentCLIAdapter();
    let settled = false;
    await waiter(adapter, new FakeProcess(false)).then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
  });

  it('holds the next turn until the child reports finished', async () => {
    const adapter = new PersistentCLIAdapter();
    const proc = new FakeProcess(true);
    let settled = false;
    const pending = waiter(adapter, proc).then(() => {
      settled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    proc.finishChild();
    await pending;
    expect(settled).toBe(true);
    expect(proc.listenerCount('subagent')).toBe(0);
  });
});

