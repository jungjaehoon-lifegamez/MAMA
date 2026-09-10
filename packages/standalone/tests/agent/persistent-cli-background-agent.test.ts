/**
 * The Claude CLI's OWN delegation, observed from the one stream it gives us.
 *
 * The event sequence below is the measured one (live flags, persona spawning a background
 * Agent and ending its turn). It is replayed verbatim: a spawn is announced, the child's
 * tool calls and final text arrive on the PARENT stream, the notification lands, and then
 * the CLI opens a turn of its own with no stdin behind it. What this pins is that the host
 * sees the spawn once, never mistakes the child's calls for the parent's unfinished work,
 * and never lets the CLI-initiated turn's result resolve a stdin request.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PersistentClaudeProcess,
  type PromptResult,
  type StreamMessage,
} from '../../src/agent/persistent-cli-process.js';
import type { PromptCallbacks } from '../../src/agent/types.js';

type TestableProcess = {
  state: 'idle' | 'busy' | 'starting' | 'dead';
  currentResolve: ((result: PromptResult) => void) | null;
  currentReject: ((error: Error) => void) | null;
  currentCallbacks: PromptCallbacks | null;
  processEvent(event: StreamMessage): void;
};

const AGENT_ITEM = 'toolu_agent_01';
const CHILD_CALL = 'toolu_child_01';
const AGENT_ID = 'agent_7f3a21';

function systemEvent(subtype: string, extra: Partial<StreamMessage> = {}): StreamMessage {
  return { type: 'system', subtype, ...extra };
}

function assistantText(text: string, parentToolUseId?: string | null): StreamMessage {
  return {
    type: 'assistant',
    ...(parentToolUseId === undefined ? {} : { parent_tool_use_id: parentToolUseId }),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** The measured stream, in order, from the spawn to the end of the CLI's own turn. */
function measuredSequence(): StreamMessage[] {
  return [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: AGENT_ITEM,
            name: 'Agent',
            input: {
              description: 'list the open board rows',
              prompt: 'list the open board rows',
              run_in_background: true,
            },
          },
        ],
      },
    },
    systemEvent('background_tasks_changed'),
    systemEvent('task_started', { task_id: 'task_01' }),
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: AGENT_ITEM,
            content: `Async agent launched successfully. agentId: ${AGENT_ID}`,
            is_error: false,
          },
        ],
      },
    },
    systemEvent('task_summary'),
    assistantText('LAUNCHED'),
    // The CHILD's tool call, on the parent stream, stamped with the Agent tool_use id.
    {
      type: 'assistant',
      parent_tool_use_id: AGENT_ITEM,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: CHILD_CALL,
            name: 'mcp__code-act__code_act',
            input: { code: 'await board_read()' },
          },
        ],
      },
    },
    systemEvent('task_progress'),
    {
      type: 'user',
      parent_tool_use_id: AGENT_ITEM,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: CHILD_CALL, content: '{"rows":2}', is_error: false },
        ],
      },
    },
    systemEvent('post_turn_summary'),
    {
      type: 'result',
      subtype: 'success',
      result: 'LAUNCHED',
      session_id: 'bg-session',
      duration_ms: 4621,
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    systemEvent('task_summary'),
    // The child's final text, still on the parent stream and NOT stamped.
    assistantText('The returned list has 2 open rows.'),
    systemEvent('background_tasks_changed'),
    systemEvent('task_updated'),
    systemEvent('task_notification', { task_id: 'task_01' }),
    // A turn the CLI begins by itself: no stdin request is behind this init.
    systemEvent('init'),
    assistantText('CHILD_DONE: [2 open rows]'),
    systemEvent('post_turn_summary'),
    {
      type: 'result',
      subtype: 'success',
      result: 'CHILD_DONE: [2 open rows]',
      session_id: 'bg-session',
      duration_ms: 2457,
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  ];
}

interface Replay {
  process: PersistentClaudeProcess;
  testable: TestableProcess;
  parentResult: PromptResult;
  starts: Array<{ agentThreadId: string; agentPath: string; itemId: string }>;
  subagentEvents: Array<Record<string, unknown>>;
  autonomousTurns: Array<Record<string, unknown>>;
  autonomousResults: Array<Record<string, unknown>>;
}

async function replayMeasuredSequence(): Promise<Replay> {
  const process = new PersistentClaudeProcess({ sessionId: 'bg-session' });
  const testable = process as unknown as TestableProcess;
  const starts: Replay['starts'] = [];
  const subagentEvents: Array<Record<string, unknown>> = [];
  const autonomousTurns: Array<Record<string, unknown>> = [];
  const autonomousResults: Array<Record<string, unknown>> = [];
  process.on('subagent', (event: Record<string, unknown>) => subagentEvents.push(event));
  process.on('autonomousTurn', (event: Record<string, unknown>) => autonomousTurns.push(event));
  process.on('autonomousTurnResult', (event: Record<string, unknown>) =>
    autonomousResults.push(event)
  );

  testable.state = 'busy';
  testable.currentCallbacks = {
    onSubagentStart: (info) => {
      starts.push(info);
    },
  };
  const parentResult = new Promise<PromptResult>((resolve, reject) => {
    testable.currentResolve = resolve;
    testable.currentReject = reject;
  });
  for (const event of measuredSequence()) {
    testable.processEvent(event);
  }
  return {
    process,
    testable,
    parentResult: await parentResult,
    starts,
    subagentEvents,
    autonomousTurns,
    autonomousResults,
  };
}

describe('native background Agent on the Claude stream', () => {
  it('reports the spawn once, with the child id from the launch result', async () => {
    const replay = await replayMeasuredSequence();

    expect(replay.starts).toEqual([
      { agentThreadId: AGENT_ID, agentPath: 'list the open board rows', itemId: AGENT_ITEM },
    ]);
    expect(replay.subagentEvents.filter((event) => event.kind === 'started')).toHaveLength(1);
  });

  it("does not count the child's tool calls as the parent's unresolved work", async () => {
    const replay = await replayMeasuredSequence();

    expect(replay.parentResult.response).toBe('LAUNCHED');
    expect(replay.parentResult.hasToolUse).toBe(false);
    expect(replay.parentResult.toolUseBlocks).toBeUndefined();
    // The Agent launch itself is a parent exchange; the child's code-act call is not.
    expect((replay.parentResult.completedToolExchanges ?? []).map((e) => e.toolUse.id)).toEqual([
      AGENT_ITEM,
    ]);
  });

  it('surfaces the CLI-initiated turn as its own event with its own text', async () => {
    const replay = await replayMeasuredSequence();

    expect(replay.autonomousTurns).toEqual([
      { agentThreadId: AGENT_ID, agentPath: 'list the open board rows', itemId: AGENT_ITEM },
    ]);
    expect(replay.autonomousResults).toHaveLength(1);
    expect(replay.autonomousResults[0]).toMatchObject({
      agentThreadId: AGENT_ID,
      text: 'CHILD_DONE: [2 open rows]',
      isError: false,
    });
  });

  it("carries the child's final text and leaves the wake to that turn", async () => {
    const replay = await replayMeasuredSequence();
    const completed = replay.subagentEvents.filter((event) => event.kind === 'completed');

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      agentThreadId: AGENT_ID,
      status: 'completed',
      finalText: 'The returned list has 2 open rows.',
      // The CLI answered the notification itself - a host wake would be a second turn.
      wakeRequired: false,
    });
  });

  it('gives a later stdin request its own result', async () => {
    const replay = await replayMeasuredSequence();

    replay.testable.state = 'busy';
    replay.testable.currentCallbacks = {};
    const next = new Promise<PromptResult>((resolve, reject) => {
      replay.testable.currentResolve = resolve;
      replay.testable.currentReject = reject;
    });
    replay.testable.processEvent({
      type: 'result',
      subtype: 'success',
      result: 'NEXT TURN',
      session_id: 'bg-session',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await expect(next).resolves.toMatchObject({ response: 'NEXT TURN' });
  });

  it('takes the wake itself when no CLI turn follows the notification', async () => {
    vi.useFakeTimers();
    try {
      const process = new PersistentClaudeProcess({ sessionId: 'bg-session' });
      const testable = process as unknown as TestableProcess;
      const events: Array<Record<string, unknown>> = [];
      process.on('subagent', (event: Record<string, unknown>) => events.push(event));
      testable.state = 'busy';
      testable.currentCallbacks = {};
      const parent = new Promise<PromptResult>((resolve, reject) => {
        testable.currentResolve = resolve;
        testable.currentReject = reject;
      });
      // Everything up to and including the notification, then silence.
      const upToNotification = measuredSequence().slice(
        0,
        measuredSequence().findIndex((event) => event.subtype === 'task_notification') + 1
      );
      for (const event of upToNotification) {
        testable.processEvent(event);
      }
      await parent;

      expect(events.filter((event) => event.kind === 'completed')).toHaveLength(0);
      vi.advanceTimersByTime(6_000);
      expect(events.filter((event) => event.kind === 'completed')).toEqual([
        expect.objectContaining({ agentThreadId: AGENT_ID, wakeRequired: true }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the CLI's own follow-up answer reaches the request that spawned the child", () => {
  it("hands the autonomous turn's text to the spawning request's onFollowUp", async () => {
    const process = new PersistentClaudeProcess({ sessionId: 'bg-session' });
    const testable = process as unknown as TestableProcess;
    const followUps: Array<{ agentThreadId: string; text: string; isError: boolean }> = [];
    testable.state = 'busy';
    testable.currentCallbacks = {
      onFollowUp: (info) => followUps.push(info),
    };
    const parentResult = new Promise<PromptResult>((resolve, reject) => {
      testable.currentResolve = resolve;
      testable.currentReject = reject;
    });
    for (const event of measuredSequence()) testable.processEvent(event);
    expect((await parentResult).response).toBe('LAUNCHED');

    expect(followUps).toEqual([
      {
        agentThreadId: AGENT_ID,
        agentPath: 'list the open board rows',
        itemId: AGENT_ITEM,
        text: 'CHILD_DONE: [2 open rows]',
        isError: false,
      },
    ]);
  });

  it('routes a CLI turn that answers an untracked task notification to the last request that asked', async () => {
    // Measured 2026-09-10 20:19 KST: a foreground child spawned grandchildren; their
    // notifications matched no tracked Agent, the CLI answered on its own, and the text went nowhere.
    const process = new PersistentClaudeProcess({ sessionId: 'bg-session' });
    const testable = process as unknown as TestableProcess;
    const followUps: Array<{ text: string; isError: boolean }> = [];
    testable.state = 'busy';
    testable.currentCallbacks = { onFollowUp: (info) => followUps.push(info) };
    const first = new Promise<PromptResult>((resolve, reject) => {
      testable.currentResolve = resolve;
      testable.currentReject = reject;
    });
    testable.processEvent(assistantText('working on it'));
    testable.processEvent({
      type: 'result',
      subtype: 'success',
      result: 'working on it',
      session_id: 'bg-session',
      duration_ms: 10,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect((await first).response).toBe('working on it');

    testable.processEvent(systemEvent('task_notification', { task_id: 'task_untracked' }));
    testable.processEvent(systemEvent('init'));
    testable.processEvent(assistantText('LATE ANSWER'));
    testable.processEvent({
      type: 'result',
      subtype: 'success',
      result: 'LATE ANSWER',
      session_id: 'bg-session',
      duration_ms: 12,
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    expect(followUps.map((f) => f.text)).toEqual(['LATE ANSWER']);
  });
});
