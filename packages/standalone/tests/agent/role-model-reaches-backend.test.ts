import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayToolExecutor } from '../../src/agent/index.js';
import type { AgentLoopOptions } from '../../src/agent/types.js';
import type { OAuthManager } from '../../src/auth/index.js';
import type { MAMAConfig } from '../../src/cli/config/types.js';
import { initMainAgentLoop } from '../../src/cli/runtime/agent-loop-init.js';
import { hashSessionPolicyFingerprint } from '../../src/gateways/message-router.js';
import type { MetricsStore } from '../../src/observability/metrics-store.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';

interface CapturedRpcMessage {
  method?: string;
  params?: Record<string, unknown>;
}

const roots: string[] = [];
const loops: Array<{ stop(): Promise<void> }> = [];

let originalHome: string | undefined;
let originalPath: string | undefined;

function installFakeCodexAppServer(root: string): string {
  const binDir = join(root, 'bin');
  const command = join(binDir, 'codex');
  const capture = join(root, 'codex-rpc.ndjson');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    command,
    `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const capture = ${JSON.stringify(capture)};
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
const fullThread = (id, cwd) => ({
  id,
  sessionId: 'session-' + id,
  forkedFromId: null,
  parentThreadId: null,
  preview: '',
  ephemeral: false,
  modelProvider: 'openai',
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  status: { type: 'idle' },
  path: null,
  cwd,
  cliVersion: '0.144.0',
  source: 'appServer',
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
});
const fullTurn = (id, status = 'inProgress') => ({
  id,
  items: [],
  itemsView: 'full',
  status,
  error: null,
  startedAt: 1,
  completedAt: status === 'inProgress' ? null : 2,
  durationMs: status === 'inProgress' ? null : 1,
});
const threadResult = (id, params) => ({
  thread: fullThread(id, params.cwd),
  model: params.model,
  modelProvider: 'openai',
  serviceTier: null,
  cwd: params.cwd,
  instructionSources: [],
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  sandbox: {
    type: 'workspaceWrite',
    writableRoots: [params.cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  reasoningEffort: null,
});
let thread = 0;
let turn = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(capture, JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') {
    return send({
      id: message.id,
      result: {
        userAgent: 'fake-codex',
        codexHome: process.env.CODEX_HOME,
        platformFamily: 'unix',
        platformOs: 'test',
      },
    });
  }
  if (message.method === 'thread/start') {
    return send({ id: message.id, result: threadResult('thread-' + (++thread), message.params) });
  }
  if (message.method === 'thread/resume') {
    return send({ id: message.id, result: threadResult(message.params.threadId, message.params) });
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn-' + (++turn);
    send({ id: message.id, result: { turn: fullTurn(turnId) } });
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: message.params.threadId, turnId, delta: 'ok' },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: message.params.threadId,
        turnId,
        tokenUsage: { last: { inputTokens: 3, outputTokens: 1, cachedInputTokens: 0 } },
      },
    });
    return send({
      method: 'turn/completed',
      params: { threadId: message.params.threadId, turn: fullTurn(turnId, 'completed') },
    });
  }
  if (message.method === 'turn/interrupt') {
    return send({ id: message.id, result: {} });
  }
});
process.on('SIGTERM', () => process.exit(0));
`,
    { mode: 0o700 }
  );
  chmodSync(command, 0o700);
  return capture;
}

function createConfig(model: string): MAMAConfig {
  return {
    version: 1,
    agent: {
      backend: 'codex',
      model,
      timeout: 2_000,
      max_turns: 2,
      tools: {},
    },
    database: { path: ':memory:' },
    multi_agent: {
      agents: {
        'os-agent': { useCodeAct: false },
      },
    },
  } as unknown as MAMAConfig;
}

function createRuntime(bootModel: string): ReturnType<typeof initMainAgentLoop> {
  const runtime = initMainAgentLoop(
    createConfig(bootModel),
    { getToken: vi.fn() } as unknown as OAuthManager,
    {} as SQLiteDatabase,
    null as MetricsStore | null,
    'codex',
    new GatewayToolExecutor({})
  );
  loops.push(runtime.agentLoop);
  return runtime;
}

function messages(capture: string): CapturedRpcMessage[] {
  if (!existsSync(capture)) {
    return [];
  }
  const content = readFileSync(capture, 'utf8').trim();
  return content ? content.split('\n').map((line) => JSON.parse(line) as CapturedRpcMessage) : [];
}

function turnOptions(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    disableAutoRecall: true,
    modelRunId: 'fixture-model-run',
    sessionKey: 'role-model-session',
    source: 'telegram',
    channelId: 'role-model-channel',
    ...overrides,
  };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'mama-role-model-runtime-'));
  roots.push(root);
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = root;
  process.env.PATH = `${join(root, 'bin')}:${originalPath ?? ''}`;
  installFakeCodexAppServer(root);
});

afterEach(async () => {
  for (const loop of loops.splice(0)) {
    await loop.stop();
  }
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime role model reaches the Codex session policy', () => {
  it('REGRESSION 1 sends a same-backend role override through the real AgentLoop', async () => {
    const root = roots[0];
    if (!root) {
      throw new Error('Expected a runtime fixture root');
    }
    const capture = join(root, 'codex-rpc.ndjson');
    const runtime = createRuntime('gpt-5.6-sol');

    await runtime.agentLoopClient.run(
      'Use the configured role model.',
      turnOptions({ model: 'gpt-5.4', resumeSession: false })
    );

    const starts = messages(capture).filter((message) => message.method === 'thread/start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params?.model).toBe('gpt-5.4');
  });

  it('TG-05 replaces a rescoped model session once and then continues without thrash', async () => {
    const root = roots[0];
    if (!root) {
      throw new Error('Expected a runtime fixture root');
    }
    const capture = join(root, 'codex-rpc.ndjson');
    const runtime = createRuntime('gpt-5.6-sol');
    const reset = vi.fn();
    const rebuildCurrentPolicy = vi.fn().mockResolvedValue('full gpt-5.4 role policy');
    const bootFingerprint = hashSessionPolicyFingerprint({
      baseInstructions: 'stable role instructions',
      model: 'gpt-5.6-sol',
    });
    const roleFingerprint = hashSessionPolicyFingerprint({
      baseInstructions: 'stable role instructions',
      model: 'gpt-5.4',
    });

    expect(roleFingerprint).not.toBe(bootFingerprint);

    await runtime.agentLoopClient.run(
      'Boot policy turn.',
      turnOptions({
        model: 'gpt-5.6-sol',
        sessionKey: 'tg-05-model-rescope-session',
        resumeSession: false,
        systemPrompt: 'full gpt-5.6-sol boot policy',
        sessionPolicyFingerprint: bootFingerprint,
      })
    );
    await runtime.agentLoopClient.run(
      'Rescoped policy turn.',
      turnOptions({
        model: 'gpt-5.4',
        sessionKey: 'tg-05-model-rescope-session',
        resumeSession: true,
        systemPrompt: 'minimal stale-policy continuation',
        sessionPolicyFingerprint: roleFingerprint,
        freshSessionSystemPrompt: rebuildCurrentPolicy,
        onCliSessionReset: reset,
      })
    );
    await runtime.agentLoopClient.run(
      'Unchanged role policy turn.',
      turnOptions({
        model: 'gpt-5.4',
        sessionKey: 'tg-05-model-rescope-session',
        resumeSession: true,
        systemPrompt: 'minimal current-policy continuation',
        sessionPolicyFingerprint: roleFingerprint,
        freshSessionSystemPrompt: rebuildCurrentPolicy,
        onCliSessionReset: reset,
      })
    );

    const sent = messages(capture);
    const starts = sent.filter((message) => message.method === 'thread/start');
    expect(starts).toHaveLength(2);
    expect(starts.map((message) => message.params?.model)).toEqual(['gpt-5.6-sol', 'gpt-5.4']);
    expect(starts[1]?.params?.baseInstructions).toContain('full gpt-5.4 role policy');
    expect(sent.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(sent.filter((message) => message.method === 'turn/start')).toHaveLength(3);
    expect(rebuildCurrentPolicy).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
