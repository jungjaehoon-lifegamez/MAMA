/**
 * Story OPS-0: per-run state scoping + operator global lane
 *
 * The operator global lane legalizes report/worker runs overlapping owner
 * chat turns on the SAME AgentLoop instance. That is only safe because
 * per-run state (stream callbacks, tier) lives in a RunScope threaded through
 * the run, never on the instance. These tests pin both halves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import type { OAuthManager } from '../../src/auth/index.js';
import type { StreamCallbacks } from '../../src/agent/types.js';

interface PromptCall {
  resolve: (value: unknown) => void;
  promptText: string;
}

const promptGate: { pending: PromptCall[] } = {
  pending: [],
};

vi.mock('../../src/agent/claude-cli-wrapper.js', () => ({
  ClaudeCLIWrapper: vi.fn().mockImplementation(() => ({
    resetSession: vi.fn(),
    setSystemPrompt: vi.fn(),
    setSessionId: vi.fn(),
    prompt: vi.fn(),
  })),
}));

vi.mock('../../src/agent/persistent-cli-adapter.js', () => ({
  PersistentCLIAdapter: vi.fn().mockImplementation(() => ({
    prompt: vi.fn().mockImplementation((promptText: string) => {
      return new Promise((resolve) => {
        promptGate.pending.push({ resolve, promptText: String(promptText) });
      });
    }),
    setSessionId: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('../../src/agent/session-pool.js', () => ({
  SessionPool: vi.fn().mockImplementation(() => ({
    getSession: vi.fn().mockReturnValue({ sessionId: 'test-session', isNew: true }),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    updateTokens: vi.fn().mockReturnValue({ totalTokens: 100, nearThreshold: false }),
    releaseSession: vi.fn(),
    resetSession: vi.fn(),
  })),
  getSessionPool: vi.fn().mockReturnValue({
    getSession: vi.fn().mockReturnValue({ sessionId: 'test-session', isNew: true }),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    updateTokens: vi.fn().mockReturnValue({ totalTokens: 100, nearThreshold: false }),
    releaseSession: vi.fn(),
    resetSession: vi.fn(),
  }),
  buildChannelKey: vi.fn((source: string, channelId: string) => `${source}:${channelId}`),
}));

// Lane manager as pass-through: both runs enter runWithContentInternal
// concurrently, which is exactly the overlap AC(7) must survive.
vi.mock('../../src/concurrency/index.js', () => ({
  LaneManager: vi.fn(),
  getGlobalLaneManager: vi.fn().mockReturnValue({
    enqueueWithSession: vi.fn((_: unknown, fn: () => unknown) => fn()),
  }),
}));

function flushPrompt(match: string, response: unknown): void {
  const idx = promptGate.pending.findIndex((c) => c.promptText.includes(match));
  if (idx === -1) {
    throw new Error(
      `no pending prompt call matching "${match}" (pending: ${promptGate.pending
        .map((c) => c.promptText.slice(0, 40))
        .join(' | ')})`
    );
  }
  const [call] = promptGate.pending.splice(idx, 1);
  call.resolve(response);
}

function makeCallbacks(label: string, log: string[]): StreamCallbacks {
  return {
    onDelta: () => {
      log.push(`${label}:delta`);
    },
    onToolUse: (name: string) => {
      log.push(`${label}:toolUse:${name}`);
    },
    onToolComplete: (name: string) => {
      log.push(`${label}:toolComplete:${name}`);
    },
  };
}

const mockOAuth = {
  getToken: vi.fn().mockResolvedValue('sk-ant-oat01-test'),
} as unknown as OAuthManager;

const modelRunRow = {
  model_run_id: 'mr_run_scope',
  model_id: null,
  model_provider: null,
  prompt_version: null,
  tool_manifest_version: null,
  output_schema_version: null,
  agent_id: null,
  instance_id: null,
  envelope_hash: null,
  parent_model_run_id: null,
  input_snapshot_ref: null,
  input_refs_json: null,
  input_refs: null,
  completion_summary: null,
  status: 'running',
  error_summary: null,
  token_count: 0,
  cost_estimate: null,
  created_at: 1,
  completed_at: null,
};

const mockApi = {
  save: vi.fn().mockResolvedValue({ success: true, id: 'decision_x', type: 'decision' }),
  saveCheckpoint: vi.fn().mockResolvedValue({ success: true, id: 'cp_x', type: 'checkpoint' }),
  listDecisions: vi.fn().mockResolvedValue([]),
  suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
  updateOutcome: vi.fn().mockResolvedValue({ success: true }),
  loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
  beginModelRun: vi.fn().mockResolvedValue(modelRunRow),
  commitModelRun: vi.fn().mockResolvedValue({ ...modelRunRow, status: 'committed' }),
  failModelRun: vi.fn().mockResolvedValue({ ...modelRunRow, status: 'failed' }),
  appendToolTrace: vi.fn().mockResolvedValue({
    trace_id: 'trace_run_scope',
    model_run_id: 'mr_run_scope',
    gateway_call_id: null,
    tool_name: 'noop',
    input_summary: null,
    output_summary: null,
    execution_status: 'completed',
    duration_ms: 0,
    envelope_hash: null,
    created_at: 1,
  }),
};

describe('Story OPS-0: per-run scope + operator global lane', () => {
  beforeEach(() => {
    promptGate.pending = [];
  });

  describe('AC #1: operator session keys map to the operator global lane', () => {
    it('routes operator:* to the operator lane and chat keys to the default', () => {
      const loop = new AgentLoop(mockOAuth, { gateway: ['*'] }, {}, { mamaApi: mockApi });
      const resolve = (
        loop as unknown as { resolveGlobalLaneForSession(key: string): string | undefined }
      ).resolveGlobalLaneForSession.bind(loop);

      expect(resolve('operator:report')).toBe('operator');
      expect(resolve('operator:worker:board')).toBe('operator');
      expect(resolve('viewer:main')).toBe('viewer');
      expect(resolve('system:conductor-audit')).toBe('system');
      // Chat transports fall through to the shared 'main' default lane.
      expect(resolve('telegram:7777:42')).toBeUndefined();
      expect(resolve('default:default')).toBeUndefined();
    });
  });

  describe('AC #2: concurrent runs do not cross stream callbacks', () => {
    it('keeps tool-use streaming on the owning run while another run starts and finishes', async () => {
      const loop = new AgentLoop(mockOAuth, { gateway: ['*'] }, {}, { mamaApi: mockApi });
      const log: string[] = [];

      // Run A starts first and parks inside its first prompt() call.
      const runA = loop.runWithContent([{ type: 'text', text: 'report work' }], {
        streamCallbacks: makeCallbacks('A', log),
        source: 'operator',
        channelId: 'report',
      });
      await vi.waitFor(() => {
        expect(promptGate.pending.length).toBe(1);
      });

      // Run B starts, completes fully, and (pre-fix) would have cleared the
      // instance-level callbacks in its finally block.
      const runB = loop.runWithContent([{ type: 'text', text: 'chat turn' }], {
        streamCallbacks: makeCallbacks('B', log),
        source: 'telegram',
        channelId: '7777',
      });
      await vi.waitFor(() => {
        expect(promptGate.pending.length).toBe(2);
      });
      flushPrompt('chat turn', {
        response: 'chat answer',
        usage: { input_tokens: 5, output_tokens: 5 },
        session_id: 'test-session',
      });
      await runB;

      // Run A now resumes with a tool_use turn: its streaming events must fire
      // on A's callbacks even though run B started AND finished in between.
      flushPrompt('report work', {
        response:
          'Searching now.\n```tool_call\n{"name": "mama_search", "input": {"query": "x"}}\n```',
        usage: { input_tokens: 5, output_tokens: 5 },
        session_id: 'test-session',
      });
      await vi.waitFor(() => {
        expect(promptGate.pending.length).toBe(1);
      });
      await vi.waitFor(() => {
        expect(promptGate.pending.length).toBe(1);
      });
      flushPrompt('', {
        response: 'done',
        usage: { input_tokens: 5, output_tokens: 5 },
        session_id: 'test-session',
      });
      await runA;

      const aToolEvents = log.filter((entry) => entry.startsWith('A:tool'));
      const bToolEvents = log.filter((entry) => entry.startsWith('B:tool'));
      expect(aToolEvents).toContain('A:toolUse:mama_search');
      expect(aToolEvents.some((entry) => entry.startsWith('A:toolComplete:mama_search'))).toBe(
        true
      );
      expect(bToolEvents).toEqual([]);
    });
  });
});
