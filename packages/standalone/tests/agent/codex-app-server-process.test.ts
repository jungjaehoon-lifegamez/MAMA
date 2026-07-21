import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAppServerProcess } from '../../src/agent/codex-app-server-process.js';
import type {
  HostToolBridge,
  HostToolCallResult,
  HostToolDefinition,
} from '../../src/agent/model-runner.js';
import { CodexRuntimeProcess } from '../../src/multi-agent/runtime-process.js';
import { AgentProcessManager } from '../../src/multi-agent/agent-process-manager.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';
import type { MultiAgentConfig } from '../../src/multi-agent/types.js';

const roots: string[] = [];

interface FixtureTurn {
  id: string;
  items: unknown[];
  itemsView: 'full';
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string; codexErrorInfo: null; additionalDetails: string | null } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

interface FixtureThread {
  id: string;
  sessionId: string;
  forkedFromId: string | null;
  parentThreadId: string | null;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status: { type: 'idle' };
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: 'appServer';
  threadSource: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: null;
  name: string | null;
  turns: FixtureTurn[];
}

interface FixtureInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

interface FixtureThreadResponse {
  thread: FixtureThread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  instructionSources: string[];
  approvalPolicy: 'never';
  approvalsReviewer: 'user';
  sandbox: Record<string, unknown>;
  reasoningEffort: string | null;
}

function fixtureTurn(): FixtureTurn {
  return {
    id: '',
    items: [],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
}

function fixtureThread(root: string): FixtureThread {
  return {
    id: '',
    sessionId: 'session-1',
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
    cwd: root,
    cliVersion: '0.144.0',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

const dynamicTools: HostToolBridge['tools'] = [
  {
    type: 'function',
    name: 'report_request',
    description: 'Create a report',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      additionalProperties: true,
    },
  },
];

function hostBridge(
  execute: HostToolBridge['execute'] = async () => ({ content: 'report ready', isError: false })
): HostToolBridge {
  return { tools: dynamicTools, execute };
}

function fixture(
  mode = 'success',
  secret = ''
): {
  root: string;
  command: string;
  capture: string;
  options: ConstructorParameters<typeof CodexAppServerProcess>[0];
} {
  const root = mkdtempSync(join(tmpdir(), 'mama-codex-process-'));
  roots.push(root);
  const command = join(root, 'fake-codex.mjs');
  const capture = join(root, 'capture.ndjson');
  const codexHome = join(root, 'managed-codex');
  const initializeResponse: FixtureInitializeResponse = {
    userAgent: 'fake',
    codexHome,
    platformFamily: 'unix',
    platformOs: 'macos',
  };
  const threadFixture = fixtureThread(root);
  const turnFixture = fixtureTurn();
  const responseFixture: Omit<FixtureThreadResponse, 'thread' | 'model' | 'cwd' | 'sandbox'> = {
    modelProvider: 'openai',
    serviceTier: null,
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    reasoningEffort: null,
  };
  writeFileSync(
    command,
    `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const mode = ${JSON.stringify(mode)};
const capture = ${JSON.stringify(capture)};
fs.appendFileSync(capture, JSON.stringify({argv:process.argv.slice(2),home:process.env.HOME,codexHome:process.env.CODEX_HOME,secret:process.env.TEST_SECRET,pid:process.pid})+'\\n');
if (${JSON.stringify(secret)}) process.stderr.write(${JSON.stringify(secret)}+'\\n');
const send = value => { const wire = mode === 'no-jsonrpc' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'jsonrpc')) : value; process.stdout.write(JSON.stringify(wire)+'\\n'); };
let thread = 0;
let turn = 0;
let overloaded = false;
const toolReplies = new Map();
const fullTurn = (id,status='inProgress',error=null) => ({...${JSON.stringify(turnFixture)},id,status,error,completedAt:status==='inProgress'?null:2,durationMs:status==='inProgress'?null:1});
const fullThread = id => ({...${JSON.stringify(threadFixture)},id});
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(capture, JSON.stringify(message)+'\\n');
  if (!message.method && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
    const callback = toolReplies.get(message.id);
    if (callback) callback(message);
    if (mode === 'tool-stale' && message.id === 710) fs.writeFileSync(${JSON.stringify(join(root, 'late-tool-reply'))},'1');
    return;
  }
  if (message.method === 'initialize') {
    if (mode === 'init-timeout') return;
    if (mode === 'init-delayed') {
      fs.writeFileSync(${JSON.stringify(join(root, 'initialize-seen'))},'1');
      const interval=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, 'release-initialize'))})){clearInterval(interval);send({jsonrpc:'2.0',id:message.id,result:${JSON.stringify(initializeResponse)}});}},5);
      return;
    }
    if (mode === 'null-json') return process.stdout.write('null\\n');
    if (mode === 'bad-jsonrpc') return send({jsonrpc:'1.0',id:message.id,result:{}});
    if (mode === 'combined-shape') return send({jsonrpc:'2.0',id:message.id,method:'bad',result:{}});
    if (mode === 'version-only') return send({jsonrpc:'2.0'});
    if (mode === 'result-no-id') return send({jsonrpc:'2.0',result:{}});
    if (mode === 'error-no-id') return send({jsonrpc:'2.0',error:{code:-1,message:'bad'}});
    if (mode === 'id-only') return send({jsonrpc:'2.0',id:message.id});
    if (mode === 'bad-response') return send({jsonrpc:'2.0',id:message.id});
    if (mode === 'rpc-error') return send({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'rpc boom'}});
    const initialized=${JSON.stringify(initializeResponse)};
    if (mode === 'canonical-home') initialized.codexHome = fs.realpathSync(process.env.CODEX_HOME);
    send({jsonrpc:'2.0',id:message.id,result:initialized});
    if (mode === 'unknown-response') setTimeout(()=>send({jsonrpc:'2.0',id:999,result:{}}),5);
    return;
  }
  const threadResult = (id,params) => { const sandbox=params.sandbox === 'workspace-write'?{type:'workspaceWrite',writableRoots:[params.cwd],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}:params.sandbox === 'read-only'?{type:'readOnly',networkAccess:false}:{type:'dangerFullAccess'}; const result={...${JSON.stringify(responseFixture)},thread:fullThread(id),model:mode === 'bad-policy'?'unexpected-model':params.model,cwd:params.cwd,instructionSources:fs.existsSync(${JSON.stringify(join(root, 'bad-source'))})?['/outside/AGENTS.md']:[],sandbox}; if(mode==='bad-thread-schema') delete result.thread.sessionId; return result; };
  if (message.method === 'thread/start') return send({jsonrpc:'2.0',id:message.id,result:threadResult('thread-'+(++thread),message.params)});
  if (message.method === 'thread/resume') return send({jsonrpc:'2.0',id:message.id,result:threadResult(message.params.threadId,message.params)});
  if (message.method === 'turn/start') {
    if (mode === 'overloaded-once' && !overloaded) { overloaded = true; return send({jsonrpc:'2.0',id:message.id,error:{code:-32001,message:'Server overloaded; retry later.'}}); }
    if (mode === 'timeout') return;
    if (mode === 'timeout-once' && !fs.existsSync(${JSON.stringify(join(root, 'timed-out'))})) { fs.writeFileSync(${JSON.stringify(join(root, 'timed-out'))},'1'); return; }
    if (mode === 'exit') return process.exit(17);
    const id = 'turn-'+(++turn);
    const requestBase = 700 + turn * 10;
    const earlyTool = mode === 'tool-early';
    const toolParams = mode === 'code-act-tool-success'
      ? {threadId:message.params.threadId,turnId:id,callId:'call-1',namespace:null,tool:'code_act',arguments:{code:'({ ok: true })'}}
      : {threadId:message.params.threadId,turnId:id,callId:'call-1',namespace:null,tool:'report_request',arguments:{topic:'status'}};
    const requestTool = (requestId, params, callback) => { toolReplies.set(requestId, callback); send({jsonrpc:'2.0',id:requestId,method:'item/tool/call',params}); };
    let toolReplyCount = 0;
    const afterToolReply = () => { toolReplyCount += 1; const expected=['tool-duplicate','tool-duplicate-conflict','tool-serialized'].includes(mode) ? 2 : 1; if(toolReplyCount === expected) complete(); };
    if (earlyTool) requestTool(requestBase,toolParams,afterToolReply);
    send({jsonrpc:'2.0',id:message.id,result:{turn:mode==='bad-turn-schema'?{id}:fullTurn(id)}});
    if (mode === 'malformed') return process.stdout.write('{bad json\\n');
    send({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:message.params.threadId,delta:'missing'}});
    send({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:message.params.threadId,turnId:'prior-turn',delta:'prior'}});
    send({jsonrpc:'2.0',method:'thread/tokenUsage/updated',params:{threadId:message.params.threadId,tokenUsage:{last:{inputTokens:99,outputTokens:99}}}});
    send({jsonrpc:'2.0',method:'thread/tokenUsage/updated',params:{threadId:message.params.threadId,turnId:'prior-turn',tokenUsage:{last:{inputTokens:88,outputTokens:88}}}});
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'other',turn:fullTurn(id,'completed')}});
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:message.params.threadId,turn:fullTurn('wrong-turn','completed')}});
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:message.params.threadId,turn:fullTurn(id,'inProgress')}});
    const complete = () => {
    send({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:message.params.threadId,turnId:id,delta:'hello'}});
    send({jsonrpc:'2.0',method:'thread/tokenUsage/updated',params:{threadId:message.params.threadId,turnId:id,tokenUsage:{last:{inputTokens:3,outputTokens:2,cachedInputTokens:1}}}});
    const status=mode === 'failed' ? 'failed' : mode === 'interrupted' ? 'interrupted' : 'completed';
    const error=status==='failed'?{message:'turn boom',codexErrorInfo:null,additionalDetails:null}:null;
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:message.params.threadId,turn:fullTurn(id,status,error)}});
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:message.params.threadId,turn:fullTurn(id,'completed')}});
    if (mode === 'exit-after-turn') setTimeout(() => process.exit(23), 5);
    };
    if (['tool-success','code-act-tool-success','tool-failure','tool-null-result','tool-error-stop','tool-abort-completed-first','tool-malformed','tool-malformed-once','tool-malformed-turn','tool-malformed-call','tool-malformed-tool','tool-malformed-namespace','tool-unknown','tool-duplicate','tool-duplicate-conflict','tool-serialized','tool-queue-cancel','tool-stop','tool-stale'].includes(mode)) {
      if (mode === 'tool-stale' && fs.existsSync(${JSON.stringify(join(root, 'tool-issued'))})) { complete(); return; }
      if (mode === 'tool-stale') fs.writeFileSync(${JSON.stringify(join(root, 'tool-issued'))},'1');
      if (mode === 'tool-malformed-once' && fs.existsSync(${JSON.stringify(join(root, 'malformed-tool-issued'))})) { complete(); return; }
      if (mode === 'tool-malformed-once') fs.writeFileSync(${JSON.stringify(join(root, 'malformed-tool-issued'))},'1');
      const params=mode === 'tool-malformed' || mode === 'tool-malformed-once'?{...toolParams,arguments:[]}:mode === 'tool-malformed-turn'?{...toolParams,turnId:7}:mode === 'tool-malformed-call'?{...toolParams,callId:7}:mode === 'tool-malformed-tool'?{...toolParams,tool:7}:mode === 'tool-malformed-namespace'?{...toolParams,namespace:7}:mode === 'tool-unknown'?{...toolParams,tool:'not_advertised'}:toolParams;
      const callback=mode === 'tool-stop'?()=>{}:mode === 'tool-error-stop'?()=>send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:message.params.threadId,turn:fullTurn(id,'interrupted')}}):mode === 'tool-abort-completed-first'?()=>send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:message.params.threadId,turn:fullTurn(id,'completed')}}):afterToolReply;
      requestTool(requestBase,params,callback);
      if (mode === 'tool-duplicate') requestTool(requestBase+1,{...params},afterToolReply);
      if (mode === 'tool-duplicate-conflict') requestTool(requestBase+1,{...params,arguments:{topic:'different'}},afterToolReply);
      if (mode === 'tool-serialized') requestTool(requestBase+1,{...params,callId:'call-2'},afterToolReply);
      if (mode === 'tool-queue-cancel') {
        requestTool(requestBase+1,{...params,callId:'call-2'},()=>{});
        setTimeout(()=>send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:message.params.threadId,turn:fullTurn(id,'failed',{message:'queue canceled',codexErrorInfo:null,additionalDetails:null})}}),20);
      }
      return;
    }
    if (earlyTool) return;
    if (mode === 'delayed') { const interval=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, 'release'))})){clearInterval(interval);complete();}},5); } else if(mode === 'unknown-response') setTimeout(complete,20); else complete();
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({jsonrpc:'2.0',id:message.id,result:{} });
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:message.params.threadId,turn:fullTurn(message.params.turnId,'interrupted')}});
    return;
  }
  if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) return;
});
setTimeout(() => {
  const requests = [
    ['item/tool/requestUserInput',{answers:{}}],
    ['mcpServer/elicitation/request',{action:'decline',content:null,_meta:null}],
    ['item/tool/call',{success:false,contentItems:[{type:'inputText',text:'Native app-server tools are disabled by MAMA'}]}],
    ['item/commandExecution/requestApproval',{decision:'decline'}],
    ['item/fileChange/requestApproval',{decision:'decline'}],
    ['item/permissions/requestApproval',{permissions:{},scope:'turn',strictAutoReview:true}],
    ['applyPatchApproval',{decision:'denied'}],
    ['execCommandApproval',{decision:'denied'}],
  ];
  let id = 900;
  for (const [method] of requests) send({jsonrpc:'2.0',id:id === 900 ? 'request-900' : id,method,params:{}}), id++;
  send({jsonrpc:'2.0',id:id++,method:'unknown/request',params:{}});
}, 10);
process.on('SIGTERM', () => { if (mode !== 'ignore-term') process.exit(0); });
`,
    { mode: 0o700 }
  );
  chmodSync(command, 0o700);
  const isolatedHome = join(root, 'isolated-home');
  const registryRoot = join(root, 'runtime', 'threads');
  mkdirSync(join(root, 'source-home', '.codex'), { recursive: true });
  return {
    root,
    command,
    capture,
    options: {
      sessionKey: 'session-a',
      model: 'gpt-test',
      systemPrompt: 'system rules',
      cwd: root,
      sandbox: 'workspace-write',
      command,
      requestTimeout: 500,
      codexHome,
      isolatedHome,
      registryRoot,
    },
  };
}

function messages(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function objectResult(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  return typeof entry.result === 'object' && entry.result !== null && !Array.isArray(entry.result)
    ? (entry.result as Record<string, unknown>)
    : undefined;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Story: Codex app-server process', () => {
  it('initializes, starts a durable thread, streams a matching turn, and resumes it', async () => {
    const item = fixture();
    const first = new CodexAppServerProcess(item.options);
    const result = await first.prompt('hi');
    expect(result).toMatchObject({
      response: 'hello',
      session_id: 'thread-1',
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 },
    });
    await first.stop();

    const second = new CodexAppServerProcess(item.options);
    await expect(second.prompt('again')).resolves.toMatchObject({
      response: 'hello',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    await second.stop();
    const sent = messages(item.capture);
    expect(sent[0]).toMatchObject({
      argv: ['app-server', '--strict-config', '--stdio'],
      home: item.options.isolatedHome,
      codexHome: item.options.codexHome,
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: 'initialize',
        params: expect.objectContaining({ capabilities: { experimentalApi: true } }),
      })
    );
    expect(sent).toContainEqual({ jsonrpc: '2.0', method: 'initialized' });
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: 'thread/start',
        params: {
          model: 'gpt-test',
          cwd: item.root,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          baseInstructions: 'system rules',
          config: {},
        },
      })
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: 'thread/resume',
        params: expect.objectContaining({ threadId: 'thread-1' }),
      })
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          input: [{ type: 'text', text: 'hi', text_elements: [] }],
        }),
      })
    );
  });

  it('answers every headless server request with the exact safe body', async () => {
    const item = fixture();
    const process = new CodexAppServerProcess(item.options);
    await process.prompt('hi');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await process.stop();
    const replies = messages(item.capture).filter(
      (entry) => entry.id === 'request-900' || (typeof entry.id === 'number' && entry.id >= 901)
    );
    expect(replies[0].id).toBe('request-900');
    expect(replies.map((entry) => entry.result ?? entry.error)).toEqual([
      { answers: {} },
      { action: 'decline', content: null, _meta: null },
      {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Native app-server tools are disabled by MAMA' }],
      },
      { decision: 'decline' },
      { decision: 'decline' },
      { permissions: {}, scope: 'turn', strictAutoReview: true },
      { decision: 'denied' },
      { decision: 'denied' },
      { code: -32601, message: 'Unsupported app-server request: unknown/request' },
    ]);
  });

  it('advertises the supplied dynamic tools and executes a matching native tool call', async () => {
    const item = fixture('tool-success');
    const calls: Array<{ callId: string; name: string; input: Record<string, unknown> }> = [];
    const runner = new CodexAppServerProcess(item.options);

    await expect(
      runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async (call) => {
          calls.push(call);
          return { content: 'report ready', isError: false };
        }),
      })
    ).resolves.toMatchObject({ response: 'hello' });
    await runner.stop();

    expect(calls).toEqual([
      { callId: 'call-1', name: 'report_request', input: { topic: 'status' } },
    ]);
    const sent = messages(item.capture);
    expect(sent.find((entry) => entry.method === 'thread/start')?.params).toMatchObject({
      dynamicTools,
    });
    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      id: 710,
      result: {
        success: true,
        contentItems: [{ type: 'inputText', text: 'report ready' }],
      },
    });
  });

  it('returns a native tool failure to Codex without turning it into empty success', async () => {
    const item = fixture('tool-failure');
    const runner = new CodexAppServerProcess(item.options);
    const failure: HostToolCallResult = { content: 'gateway rejected input', isError: true };

    await expect(
      runner.prompt('hi', undefined, { hostToolBridge: hostBridge(async () => failure) })
    ).resolves.toMatchObject({ response: 'hello' });
    await runner.stop();

    expect(messages(item.capture)).toContainEqual({
      jsonrpc: '2.0',
      id: 710,
      result: {
        success: false,
        contentItems: [{ type: 'inputText', text: 'gateway rejected input' }],
      },
    });
  });

  it('returns an explicit tool failure when a host bridge produces null at runtime', async () => {
    const item = fixture('tool-null-result');
    const runner = new CodexAppServerProcess(item.options);

    await expect(
      runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(
          async () => null as unknown as Awaited<ReturnType<HostToolBridge['execute']>>
        ),
      })
    ).resolves.toMatchObject({ response: 'hello' });
    await runner.stop();

    expect(messages(item.capture)).toContainEqual({
      jsonrpc: '2.0',
      id: 710,
      result: {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Host tool returned a malformed result' }],
      },
    });
  });

  it('does not treat an errored stop result as an intentional interruption', async () => {
    const item = fixture('tool-error-stop');
    const runner = new CodexAppServerProcess(item.options);

    await expect(
      runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async () => ({
          content: 'gateway failed',
          isError: true,
          stop: true,
        })),
      })
    ).rejects.toThrow('interrupted');
    await runner.stop();

    const sent = messages(item.capture);
    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      id: 710,
      result: {
        success: false,
        contentItems: [{ type: 'inputText', text: 'gateway failed' }],
      },
    });
    expect(sent.some((entry) => entry.method === 'turn/interrupt')).toBe(false);
  });

  it.each([
    ['tool-malformed', 'arguments'],
    ['tool-malformed-turn', 'turnId'],
    ['tool-malformed-call', 'callId'],
    ['tool-malformed-tool', 'tool'],
    ['tool-malformed-namespace', 'namespace'],
    ['tool-unknown', 'not advertised'],
  ])('rejects an active %s request loudly with a JSON-RPC error', async (mode, message) => {
    const item = fixture(mode);
    const runner = new CodexAppServerProcess(item.options);

    await expect(runner.prompt('hi', undefined, { hostToolBridge: hostBridge() })).rejects.toThrow(
      message
    );
    await runner.stop();

    expect(messages(item.capture)).toContainEqual(
      expect.objectContaining({
        id: 710,
        error: expect.objectContaining({ code: -32602 }),
      })
    );
  });

  it('restarts the connection after an active tool protocol validation failure', async () => {
    const item = fixture('tool-malformed-once');
    const runner = new CodexAppServerProcess(item.options);
    const bridge = hostBridge();

    await expect(runner.prompt('bad', undefined, { hostToolBridge: bridge })).rejects.toThrow(
      'arguments'
    );
    await expect(
      runner.prompt('recovered', undefined, { hostToolBridge: bridge })
    ).resolves.toMatchObject({ response: 'hello' });
    await runner.stop();

    const launches = messages(item.capture).filter((entry) => Array.isArray(entry.argv));
    expect(launches).toHaveLength(2);
    expect(() => process.kill(Number(launches[0].pid), 0)).toThrow();
  });

  it('queues a tool call received before the turn/start response establishes the turn id', async () => {
    const item = fixture('tool-early');
    const calls: string[] = [];
    const runner = new CodexAppServerProcess(item.options);

    await expect(
      runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async (call) => {
          calls.push(call.callId);
          return { content: 'early result', isError: false };
        }),
      })
    ).resolves.toMatchObject({ response: 'hello' });
    await runner.stop();

    expect(calls).toEqual(['call-1']);
    expect(messages(item.capture)).toContainEqual(
      expect.objectContaining({ id: 710, result: expect.objectContaining({ success: true }) })
    );
  });

  it('deduplicates a repeated call id before executing its handler', async () => {
    const item = fixture('tool-duplicate');
    let executions = 0;
    const runner = new CodexAppServerProcess(item.options);

    await runner.prompt('hi', undefined, {
      hostToolBridge: hostBridge(async () => {
        executions += 1;
        return { content: 'once', isError: false };
      }),
    });
    await runner.stop();

    expect(executions).toBe(1);
    const replies = messages(item.capture).filter((entry) => entry.id === 710 || entry.id === 711);
    expect(replies).toHaveLength(2);
    expect(replies.every((entry) => objectResult(entry)?.success === true)).toBe(true);
  });

  it('fails a conflicting duplicate call id instead of reusing another request result', async () => {
    const item = fixture('tool-duplicate-conflict');
    let executions = 0;
    const runner = new CodexAppServerProcess(item.options);

    await expect(
      runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async () => {
          executions += 1;
          return { content: 'first', isError: false };
        }),
      })
    ).rejects.toThrow('conflicting request');
    await runner.stop();

    expect(executions).toBeLessThanOrEqual(1);
    expect(messages(item.capture)).toContainEqual(
      expect.objectContaining({
        id: 711,
        error: expect.objectContaining({ code: -32602 }),
      })
    );
  });

  it('serializes native tool calls within the same turn', async () => {
    const item = fixture('tool-serialized');
    let active = 0;
    let maxActive = 0;
    let releaseFirst: (() => void) | undefined;
    let signalFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const runner = new CodexAppServerProcess(item.options);
    const pending = runner.prompt('hi', undefined, {
      hostToolBridge: hostBridge(async (call) => {
        calls.push(call.callId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (call.callId === 'call-1') {
          signalFirst?.();
          await firstGate;
        }
        active -= 1;
        return { content: call.callId, isError: false };
      }),
    });

    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(['call-1']);
    releaseFirst?.();
    await expect(pending).resolves.toMatchObject({ response: 'hello' });
    expect(calls).toEqual(['call-1', 'call-2']);
    expect(maxActive).toBe(1);
    await runner.stop();
  });

  it('does not execute a queued tool after its turn fails', async () => {
    const item = fixture('tool-queue-cancel');
    const calls: string[] = [];
    let signalFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner = new CodexAppServerProcess(item.options);
    try {
      const pending = runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async (call) => {
          calls.push(call.callId);
          if (call.callId === 'call-1') {
            signalFirst?.();
            await firstGate;
          }
          return { content: call.callId, isError: false };
        }),
      });

      await firstStarted;
      await expect(pending).rejects.toThrow('queue canceled');
      releaseFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toEqual(['call-1']);
    } finally {
      releaseFirst?.();
      await runner.stop();
    }
  });

  it('keeps concurrent threads on isolated run-local handlers while allowing concurrency', async () => {
    const item = fixture('tool-success');
    let started = 0;
    let release: (() => void) | undefined;
    let signalBoth: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      signalBoth = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = { one: 0, two: 0 };
    const bridge = (name: keyof typeof calls): HostToolBridge =>
      hostBridge(async () => {
        calls[name] += 1;
        started += 1;
        if (started === 2) signalBoth?.();
        await gate;
        return { content: name, isError: false };
      });
    const runner = new CodexAppServerProcess(item.options);
    const prompts = Promise.all([
      runner.prompt('one', undefined, { sessionKey: 'one', hostToolBridge: bridge('one') }),
      runner.prompt('two', undefined, { sessionKey: 'two', hostToolBridge: bridge('two') }),
    ]);

    await bothStarted;
    expect(calls).toEqual({ one: 1, two: 1 });
    release?.();
    await expect(prompts).resolves.toHaveLength(2);
    await runner.stop();
  });

  it('treats changed normalized dynamic tool definitions as a durable policy mismatch', async () => {
    const item = fixture('tool-success');
    const boardTool: HostToolBridge['tools'][number] = {
      type: 'function',
      name: 'board_read',
      description: 'Read the board',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    };
    const initialBridge = { ...hostBridge(), tools: [dynamicTools[0], boardTool] };
    const first = new CodexAppServerProcess(item.options);
    await first.prompt('hi', undefined, { hostToolBridge: initialBridge });
    await first.stop();
    const reorderedBridge = { ...hostBridge(), tools: [boardTool, dynamicTools[0]] };
    const resumed = new CodexAppServerProcess(item.options);
    await expect(
      resumed.prompt('same policy', undefined, { hostToolBridge: reorderedBridge })
    ).resolves.toMatchObject({ response: 'hello' });
    await resumed.stop();
    const resumeRequest = messages(item.capture).find((entry) => entry.method === 'thread/resume');
    expect(resumeRequest?.params).not.toHaveProperty('dynamicTools');
    const changedTools: HostToolBridge = {
      ...initialBridge,
      tools: [{ ...dynamicTools[0], description: 'Changed report contract' }, boardTool],
    };
    const second = new CodexAppServerProcess(item.options);

    await expect(
      second.prompt('again', undefined, { hostToolBridge: changedTools })
    ).rejects.toThrow('policy mismatch');
    await second.stop();
  });

  it('snapshots dynamic tool definitions before asynchronous connection startup', async () => {
    const item = fixture('init-delayed');
    const mutableTool = JSON.parse(JSON.stringify(dynamicTools[0])) as HostToolDefinition;
    const originalTools = [JSON.parse(JSON.stringify(mutableTool)) as HostToolDefinition];
    const mutableTools: HostToolDefinition[] = [mutableTool];
    const bridge: HostToolBridge = { ...hostBridge(), tools: mutableTools };
    const first = new CodexAppServerProcess(item.options);
    const pending = first.prompt('hi', undefined, { hostToolBridge: bridge });
    await waitForFile(join(item.root, 'initialize-seen'));

    mutableTool.description = 'mutated after prompt';
    mutableTools.push({
      type: 'function',
      name: 'late_tool',
      description: 'Must not enter the snapshot',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    });
    writeFileSync(join(item.root, 'release-initialize'), '1');
    await expect(pending).resolves.toMatchObject({ response: 'hello' });
    await first.stop();

    const started = messages(item.capture).find((entry) => entry.method === 'thread/start');
    expect((started?.params as Record<string, unknown>)?.dynamicTools).toEqual(originalTools);
    const resumed = new CodexAppServerProcess(item.options);
    await expect(
      resumed.prompt('again', undefined, {
        hostToolBridge: { ...hostBridge(), tools: originalTools },
      })
    ).resolves.toMatchObject({ response: 'hello' });
    await resumed.stop();
  });

  it('interrupts and resolves an intentional stop tool without masking real interrupts', async () => {
    const item = fixture('tool-stop');
    const runner = new CodexAppServerProcess(item.options);

    await expect(
      runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async () => ({
          content: 'finished',
          isError: false,
          stop: true,
        })),
      })
    ).resolves.toMatchObject({ response: '' });
    await runner.stop();

    const sent = messages(item.capture);
    const replyIndex = sent.findIndex((entry) => entry.id === 710 && objectResult(entry)?.success);
    const interruptIndex = sent.findIndex((entry) => entry.method === 'turn/interrupt');
    expect(replyIndex).toBeGreaterThan(-1);
    expect(interruptIndex).toBeGreaterThan(replyIndex);
  });

  it('replies with a failed tool result, interrupts, and rejects a fatal host-tool abort', async () => {
    const item = fixture('tool-stop');
    const runner = new CodexAppServerProcess(item.options);

    await expect(
      runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async () => ({
          content: 'Native tool budget exceeded',
          isError: true,
          abort: true,
        })),
      })
    ).rejects.toThrow('Native tool budget exceeded');
    await runner.stop();

    const sent = messages(item.capture);
    const replyIndex = sent.findIndex(
      (entry) => entry.id === 710 && objectResult(entry)?.success === false
    );
    const interruptIndex = sent.findIndex((entry) => entry.method === 'turn/interrupt');
    expect(replyIndex).toBeGreaterThan(-1);
    expect(interruptIndex).toBeGreaterThan(replyIndex);
  });

  it('rejects a fatal host-tool abort when completed arrives before interrupt wins', async () => {
    const item = fixture('tool-abort-completed-first');
    const runner = new CodexAppServerProcess(item.options);

    await expect(
      runner.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async () => ({
          content: 'Native tool budget exceeded during race',
          isError: true,
          abort: true,
        })),
      })
    ).rejects.toThrow('Native tool budget exceeded during race');

    expect(runner.getStatus()).toMatchObject({ hasActiveTurn: false });
    await runner.stop();
  });

  it('does not send a late tool result to a replacement child after reconnect', async () => {
    const item = fixture('tool-stale');
    const sourceHome = join(item.root, 'source-home');
    const authPath = join(sourceHome, '.codex', 'auth.json');
    const previousHome = process.env.HOME;
    process.env.HOME = sourceHome;
    writeFileSync(authPath, '{"token":"first"}');
    let signalHandler: (() => void) | undefined;
    let releaseHandler: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      signalHandler = resolve;
    });
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const runner = new CodexAppServerProcess(item.options);
    try {
      const first = runner
        .prompt('first', undefined, {
          sessionKey: 'first',
          hostToolBridge: hostBridge(async () => {
            signalHandler?.();
            await handlerGate;
            return { content: 'late', isError: false };
          }),
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      await handlerStarted;
      writeFileSync(authPath, '{"token":"second"}');

      await expect(
        runner.prompt('second', undefined, { sessionKey: 'second' })
      ).resolves.toMatchObject({ response: 'hello' });
      expect(await first).toBeInstanceOf(Error);
      releaseHandler?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(existsSync(join(item.root, 'late-tool-reply'))).toBe(false);
    } finally {
      releaseHandler?.();
      process.env.HOME = previousHome;
      await runner.stop();
    }
  });

  it.each(['failed', 'interrupted'])('rejects an explicitly %s turn', async (mode) => {
    const item = fixture(mode);
    const process = new CodexAppServerProcess(item.options);
    await expect(process.prompt('hi')).rejects.toThrow(
      mode === 'failed' ? 'turn boom' : 'interrupted'
    );
    await process.stop();
  });

  it('rejects malformed stdout and request timeouts without returning empty output', async () => {
    const malformed = fixture('malformed');
    const first = new CodexAppServerProcess(malformed.options);
    await expect(first.prompt('hi')).rejects.toThrow('malformed JSON');
    await first.stop();
    const timeout = fixture('timeout');
    const second = new CodexAppServerProcess({ ...timeout.options, requestTimeout: 40 });
    await expect(second.prompt('hi')).rejects.toThrow('timed out');
    await second.stop();
  });

  it('applies a per-prompt timeout override while initialize is pending', async () => {
    const item = fixture('init-timeout');
    const runner = new CodexAppServerProcess({ ...item.options, requestTimeout: 500 });

    await expect(runner.prompt('hi', undefined, { requestTimeout: 35 })).rejects.toThrow(
      'initialize timed out after 35ms'
    );
    expect(runner.getStatus()).toMatchObject({ running: false, pendingRequestCount: 0 });
  });

  it.each(['timeout', 'init-timeout'])(
    'settles a timed-out %s operation exactly once and leaves no live child',
    async (mode) => {
      const item = fixture(mode);
      const runner = new CodexAppServerProcess({ ...item.options, requestTimeout: 35 });
      let settlements = 0;
      await runner.prompt('hi').then(
        () => {
          settlements += 1;
        },
        () => {
          settlements += 1;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(settlements).toBe(1);
      expect(() => process.kill(Number(messages(item.capture)[0].pid), 0)).toThrow();
      expect(runner.getStatus()).toMatchObject({
        running: false,
        pendingRequestCount: 0,
        hasActiveTurn: false,
        stdoutListenerCount: 0,
        stderrListenerCount: 0,
        shutdownTimerActive: false,
      });
    }
  );

  it('rejects malformed protocol responses and unexpected process exits', async () => {
    const malformed = fixture('bad-response');
    const first = new CodexAppServerProcess(malformed.options);
    await expect(first.prompt('hi')).rejects.toThrow('malformed protocol');
    expect(first.getStatus().running).toBe(false);
    const exited = fixture('exit');
    const second = new CodexAppServerProcess(exited.options);
    await expect(second.prompt('hi')).rejects.toThrow('exited (17)');
    await second.stop();
    const rpc = fixture('rpc-error');
    const third = new CodexAppServerProcess(rpc.options);
    await expect(third.prompt('hi')).rejects.toThrow('rpc boom');
    expect(third.getStatus()).toMatchObject({ running: false, pendingRequestCount: 0 });
  });

  it('accepts the actual Codex 0.144 wire shape without a jsonrpc member', async () => {
    const item = fixture('no-jsonrpc');
    const runner = new CodexAppServerProcess(item.options);
    await expect(runner.prompt('hi')).resolves.toMatchObject({ response: 'hello' });
    await runner.stop();
  });

  it('accepts a canonical CODEX_HOME returned for an equivalent symlink path', async () => {
    const item = fixture('canonical-home');
    const realHome = join(item.root, 'real-managed-codex');
    const aliasHome = join(item.root, 'alias-managed-codex');
    mkdirSync(realHome);
    symlinkSync(realHome, aliasHome, 'dir');
    const runner = new CodexAppServerProcess({ ...item.options, codexHome: aliasHome });
    await expect(runner.prompt('hi')).resolves.toMatchObject({ response: 'hello' });
    await runner.stop();
  });

  it.each([
    'null-json',
    'bad-jsonrpc',
    'combined-shape',
    'version-only',
    'result-no-id',
    'error-no-id',
    'id-only',
  ])('cleans up automatically for malformed protocol shape %s', async (mode) => {
    const item = fixture(mode);
    const runner = new CodexAppServerProcess(item.options);
    await expect(runner.prompt('hi')).rejects.toThrow(/malformed/);
    expect(() => process.kill(Number(messages(item.capture)[0].pid), 0)).toThrow();
  });

  it('keeps a turn pending through missing, prior, cross, wrong, and inProgress events', async () => {
    const item = fixture('delayed');
    const runner = new CodexAppServerProcess(item.options);
    let settled = false;
    const pending = runner.prompt('hi').finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    writeFileSync(join(item.root, 'release'), '1');
    await expect(pending).resolves.toMatchObject({ response: 'hello', usage: { input_tokens: 3 } });
    await runner.stop();
  });

  it('rejects instruction sources outside managed roots independently on start and resume', async () => {
    const start = fixture();
    writeFileSync(join(start.root, 'bad-source'), '1');
    const first = new CodexAppServerProcess(start.options);
    await expect(first.prompt('hi')).rejects.toThrow('outside managed roots');
    await first.stop();

    const resume = fixture();
    const second = new CodexAppServerProcess(resume.options);
    await second.prompt('hi');
    await second.stop();
    writeFileSync(join(resume.root, 'bad-source'), '1');
    const third = new CodexAppServerProcess(resume.options);
    await expect(third.prompt('again')).rejects.toThrow('outside managed roots');
    await third.stop();
  });

  it('rejects response policy metadata that differs from the requested thread policy', async () => {
    const item = fixture('bad-policy');
    const process = new CodexAppServerProcess(item.options);
    await expect(process.prompt('hi')).rejects.toThrow('response model');
    await process.stop();
  });

  it.each(['bad-thread-schema', 'bad-turn-schema'])(
    'rejects incomplete strict 0.144 %s payloads',
    async (mode) => {
      const item = fixture(mode);
      const runner = new CodexAppServerProcess(item.options);
      await expect(runner.prompt('hi')).rejects.toThrow(/malformed/);
      await runner.stop();
    }
  );

  it('rejects a response id that does not match a pending client request', async () => {
    const item = fixture('unknown-response');
    const runner = new CodexAppServerProcess(item.options);
    await expect(runner.prompt('hi')).rejects.toThrow('did not match');
    expect(runner.getStatus()).toMatchObject({ running: false, pendingRequestCount: 0 });
  });

  it('resumes after a rebuilt system prompt and reuses the shared homes', async () => {
    const item = fixture();
    const first = new CodexAppServerProcess({
      ...item.options,
      policyFingerprint: 'stable-policy',
    });
    await first.prompt('hi');
    await first.stop();
    const changed = new CodexAppServerProcess({
      ...item.options,
      systemPrompt: 'changed',
      policyFingerprint: 'stable-policy',
    });
    await expect(changed.prompt('hi')).resolves.toMatchObject({ response: 'hello' });
    await changed.stop();
    const launches = messages(item.capture).filter((entry) => Array.isArray(entry.argv));
    expect(new Set(launches.map((entry) => entry.home))).toEqual(
      new Set([item.options.isolatedHome])
    );
    expect(new Set(launches.map((entry) => entry.codexHome))).toEqual(
      new Set([item.options.codexHome])
    );
    expect(
      messages(item.capture).some(
        (entry) => entry.method === 'thread/resume' && entry.params?.threadId === 'thread-1'
      )
    ).toBe(true);
  });

  it('rejects a stable policy fingerprint change even when dynamic prompt resume is allowed', async () => {
    const item = fixture();
    const first = new CodexAppServerProcess({ ...item.options, policyFingerprint: 'policy-one' });
    await first.prompt('hi');
    await first.stop();
    const changed = new CodexAppServerProcess({
      ...item.options,
      systemPrompt: 'rebuilt with history',
      policyFingerprint: 'policy-two',
    });

    await expect(changed.prompt('again')).rejects.toThrow('policy mismatch');
    await changed.stop();
  });

  it.each([
    {
      direction: 'narrowing',
      initial: 'code-act:allowed=mama_search,report_publish',
      changed: 'code-act:allowed=mama_search',
    },
    {
      direction: 'widening',
      initial: 'code-act:allowed=mama_search',
      changed: 'code-act:allowed=mama_search,report_publish',
    },
  ])(
    'rejects same-session Code-Act policy $direction with an unchanged outer tool signature',
    async ({ initial, changed }) => {
      const item = fixture();
      const first = new CodexAppServerProcess(item.options);
      await first.prompt('first', undefined, {
        policyFingerprint: initial,
        hostToolBridge: hostBridge(),
      });
      await first.stop();
      const resumed = new CodexAppServerProcess(item.options);

      await expect(
        resumed.prompt('changed', undefined, {
          policyFingerprint: changed,
          hostToolBridge: hostBridge(),
        })
      ).rejects.toThrow('policy mismatch');
      await resumed.stop();
    }
  );

  it('forwards accepted agent message deltas while collecting the final response', async () => {
    const item = fixture();
    const runner = new CodexAppServerProcess(item.options);
    const deltas: string[] = [];
    const result = await (
      runner as unknown as {
        prompt(text: string, callbacks: { onDelta(text: string): void }): Promise<PromptResult>;
      }
    ).prompt('hi', { onDelta: (text) => deltas.push(text) });

    expect(deltas).toEqual(['hello']);
    expect(result.response).toBe('hello');
    await runner.stop();
  });

  it('forwards app-server deltas through the production runtime adapter', async () => {
    const item = fixture();
    const runtime = new CodexRuntimeProcess(item.options);
    const deltas: string[] = [];

    const result = await runtime.prompt('hi', { onDelta: (text) => deltas.push(text) });

    expect(deltas).toEqual(['hello']);
    expect(result.response).toBe('hello');
    await runtime.stop();
  });

  it('forwards a run-local host tool bridge through the production runtime adapter', async () => {
    const item = fixture('tool-success');
    const runtime = new CodexRuntimeProcess(item.options);
    const calls: string[] = [];

    await expect(
      runtime.prompt('hi', undefined, {
        hostToolBridge: hostBridge(async (call) => {
          calls.push(call.name);
          return { content: 'runtime bridge result', isError: false };
        }),
      })
    ).resolves.toMatchObject({ response: 'hello' });

    expect(calls).toEqual(['report_request']);
    expect(messages(item.capture)).toContainEqual({
      jsonrpc: '2.0',
      id: 710,
      result: {
        success: true,
        contentItems: [{ type: 'inputText', text: 'runtime bridge result' }],
      },
    });
    await runtime.stop();
  });

  it.each([
    {
      agentId: 'dashboard-agent',
      source: 'discord',
      channelId: 'dashboard-channel',
      tier: 2 as const,
      allowedTools: ['mama_search', 'report_publish'],
    },
    {
      agentId: 'wiki-agent',
      source: 'slack',
      channelId: 'wiki-channel',
      tier: 2 as const,
      allowedTools: ['mama_search', 'wiki_publish'],
    },
    {
      agentId: 'conductor',
      source: 'telegram',
      channelId: 'multi-agent-channel',
      tier: 1 as const,
      allowedTools: ['mama_search', 'delegate'],
    },
  ])(
    'routes managed Codex Code-Act for $agentId through the boot-shared executor with context',
    async ({ agentId, source, channelId, tier, allowedTools }) => {
      const item = fixture('code-act-tool-success');
      const personaPath = join(item.root, `${agentId}.md`);
      writeFileSync(personaPath, `# ${agentId}\nManaged test persona.\n`, 'utf8');
      const config: MultiAgentConfig = {
        enabled: true,
        agents: {
          [agentId]: {
            name: agentId,
            display_name: agentId,
            trigger_prefix: `!${agentId}`,
            persona_file: personaPath,
            backend: 'codex',
            model: 'gpt-test',
            tier,
            useCodeAct: true,
            gateway_tool_permissions: { allowed: allowedTools, blocked: ['mama_save'] },
          },
        },
        loop_prevention: {
          max_chain_length: 3,
          global_cooldown_ms: 0,
          chain_window_ms: 60_000,
        },
      };
      const mamaApi = {
        beginModelRun: async () => ({ model_run_id: `run-${agentId}`, status: 'running' }),
        commitModelRun: async () => ({ model_run_id: `run-${agentId}`, status: 'committed' }),
        failModelRun: async () => ({ model_run_id: `run-${agentId}`, status: 'failed' }),
        appendToolTrace: async () => ({ success: true }),
      } as unknown as MAMAApiInterface;
      const executor = new GatewayToolExecutor({ mamaApi, envelopeIssuanceMode: 'off' });
      const executeSpy = vi.spyOn(executor, 'execute');
      const manager = new AgentProcessManager(
        config,
        {},
        {
          model: 'gpt-test',
          codexCwd: item.root,
          codexCommand: item.command,
          codexSandbox: 'workspace-write',
          codexHome: item.options.codexHome,
          codexIsolatedHome: item.options.isolatedHome,
          codexRegistryRoot: item.options.registryRoot,
          requestTimeout: 500,
        }
      );
      manager.setGatewayToolExecutor(executor);

      const process = await manager.getProcess(source, channelId, agentId);
      await expect(process.sendMessage('Run the managed task')).resolves.toMatchObject({
        response: 'hello',
      });

      const starts = messages(item.capture).filter((entry) => entry.method === 'thread/start');
      expect(starts).toHaveLength(1);
      expect((starts[0].params as Record<string, unknown>).dynamicTools).toEqual([
        expect.objectContaining({ name: 'code_act' }),
      ]);
      const codeActCall = executeSpy.mock.calls.find(([toolName]) => toolName === 'code_act');
      expect(codeActCall).toBeDefined();
      const expectedRoleAllowedTools = ['code_act', ...allowedTools].sort();
      expect(codeActCall?.[2]).toMatchObject({
        agentId,
        source,
        channelId,
        executionSurface: 'model_tool',
        agentContext: {
          roleName: agentId,
          source,
          tier,
          backend: 'codex',
          role: { allowedTools: expectedRoleAllowedTools, blockedTools: ['mama_save'] },
          session: { channelId },
        },
      });
      await manager.stopAll();
    }
  );

  it('multiplexes concurrent sessions through one initialized app-server process', async () => {
    const item = fixture();
    const runtime = new CodexRuntimeProcess(item.options);

    const [one, two] = await Promise.all([
      runtime.prompt('one', undefined, { sessionKey: 'one' }),
      runtime.prompt('two', undefined, { sessionKey: 'two' }),
    ]);

    const launches = messages(item.capture).filter((entry) => Array.isArray(entry.argv));
    const sent = messages(item.capture);
    expect(launches).toHaveLength(1);
    expect(sent.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
    expect(sent.filter((entry) => entry.method === 'thread/start')).toHaveLength(2);
    expect(new Set([one.session_id, two.session_id]).size).toBe(2);
    expect(() => process.kill(Number(launches[0].pid), 0)).not.toThrow();
    await runtime.stop();
  });

  it('serializes overlapping turns for the same session on the shared app-server', async () => {
    const item = fixture();
    const runtime = new CodexRuntimeProcess(item.options);

    await Promise.all([
      runtime.prompt('first', undefined, { sessionKey: 'same' }),
      runtime.prompt('second', undefined, { sessionKey: 'same' }),
    ]);

    const sent = messages(item.capture);
    expect(sent.filter((entry) => Array.isArray(entry.argv))).toHaveLength(1);
    expect(sent.filter((entry) => entry.method === 'thread/start')).toHaveLength(1);
    expect(sent.filter((entry) => entry.method === 'turn/start')).toHaveLength(2);
    await runtime.stop();
  });

  it('retries the official overloaded response without restarting the app-server', async () => {
    const item = fixture('overloaded-once');
    const runtime = new CodexRuntimeProcess(item.options);

    await expect(runtime.prompt('retry me')).resolves.toMatchObject({ response: 'hello' });

    const sent = messages(item.capture);
    expect(sent.filter((entry) => Array.isArray(entry.argv))).toHaveLength(1);
    expect(sent.filter((entry) => entry.method === 'turn/start')).toHaveLength(2);
    await runtime.stop();
  });

  it('awaits app-server child termination before runtime stop resolves', async () => {
    const item = fixture('ignore-term');
    const runtime = new CodexRuntimeProcess(item.options);
    await runtime.prompt('hi');
    const launch = messages(item.capture).find((entry) => Array.isArray(entry.argv));

    await runtime.stop();

    expect(() => process.kill(Number(launch?.pid), 0)).toThrow();
  });

  it.each(['model', 'cwd', 'mcp'] as const)(
    'rejects a persisted %s policy mismatch',
    async (field) => {
      const item = fixture();
      const first = new CodexAppServerProcess(item.options);
      await first.prompt('hi');
      await first.stop();
      const changed = { ...item.options };
      if (field === 'model') {
        changed.model = 'different-model';
      }
      if (field === 'cwd') {
        changed.cwd = join(item.root, 'different-cwd');
        mkdirSync(changed.cwd);
      }
      if (field === 'mcp') {
        changed.mcpConfigPath = join(item.root, 'changed-mcp.json');
        writeFileSync(
          changed.mcpConfigPath,
          JSON.stringify({ mcpServers: { remote: { command: 'node' } } })
        );
      }
      const second = new CodexAppServerProcess(changed);
      await expect(second.prompt('again')).rejects.toThrow('policy mismatch');
      await second.stop();
    }
  );

  it('keeps MCP secrets out of argv and redacts echoed stderr from errors', async () => {
    const secret = 'super-secret-token';
    const item = fixture('exit', secret);
    const mcpConfigPath = join(item.root, 'mcp.json');
    const previousSecret = globalThis.process.env.TEST_SECRET;
    globalThis.process.env.TEST_SECRET = secret;
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { remote: { command: 'node', env_vars: ['TEST_SECRET'] } } })
    );
    const process = new CodexAppServerProcess({ ...item.options, mcpConfigPath });
    let message = '';
    try {
      await process.prompt('hi');
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      if (previousSecret === undefined) {
        delete globalThis.process.env.TEST_SECRET;
      } else {
        globalThis.process.env.TEST_SECRET = previousSecret;
      }
    }
    await process.stop();
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(secret);
    expect(JSON.stringify(messages(item.capture)[0].argv)).not.toContain(secret);
  });

  it('redacts generated HTTP-header environment values without redacting arbitrary env', async () => {
    const secret = 'generated-header-secret';
    const item = fixture('exit', secret);
    const mcpConfigPath = join(item.root, 'http-mcp.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://mcp.example.test',
            http_headers: { Authorization: secret },
          },
        },
      })
    );
    const runner = new CodexAppServerProcess({ ...item.options, mcpConfigPath });
    let message = '';
    try {
      await runner.prompt('hi');
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    await runner.stop();
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(secret);
    expect(JSON.stringify(messages(item.capture)[0].argv)).not.toContain(secret);
  });

  it('writes stable private shared config and non-empty auth atomically', async () => {
    const item = fixture();
    const sourceHome = join(item.root, 'source-home');
    writeFileSync(join(sourceHome, '.codex', 'auth.json'), '{"token":"abc"}');
    const previousHome = process.env.HOME;
    process.env.HOME = sourceHome;
    try {
      const one = new CodexAppServerProcess({ ...item.options, sessionKey: 'one' });
      const two = new CodexAppServerProcess({ ...item.options, sessionKey: 'two' });
      await Promise.all([one.prompt('a'), two.prompt('b')]);
      await Promise.all([one.stop(), two.stop()]);
      expect(readFileSync(join(item.options.codexHome!, 'auth.json'), 'utf8')).toContain('abc');
      expect(readFileSync(join(item.options.codexHome!, 'config.toml'), 'utf8')).toContain(
        '[features]'
      );
      expect(statSync(item.options.codexHome!).mode & 0o777).toBe(0o700);
      expect(statSync(item.options.isolatedHome!).mode & 0o777).toBe(0o700);
      expect(statSync(join(item.options.codexHome!, 'config.toml')).mode & 0o777).toBe(0o600);
      expect(statSync(join(item.options.codexHome!, 'auth.json')).mode & 0o777).toBe(0o600);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it('force-kills a child that ignores SIGTERM within a bounded grace period', async () => {
    const item = fixture('ignore-term');
    const process = new CodexAppServerProcess(item.options);
    await process.prompt('hi');
    const started = Date.now();
    await process.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(() => globalThis.process.kill(Number(messages(item.capture)[0].pid), 0)).toThrow();
    expect(process.getStatus()).toMatchObject({
      running: false,
      pendingRequestCount: 0,
      hasActiveTurn: false,
      stdoutListenerCount: 0,
      stderrListenerCount: 0,
      shutdownTimerActive: false,
    });
  });

  it('restarts before the next turn when source authentication changes', async () => {
    const item = fixture();
    const sourceHome = join(item.root, 'source-home');
    const authPath = join(sourceHome, '.codex', 'auth.json');
    const previousHome = process.env.HOME;
    process.env.HOME = sourceHome;
    try {
      writeFileSync(authPath, '{"token":"first-auth-token"}');
      const runner = new CodexAppServerProcess(item.options);
      await runner.prompt('first');
      writeFileSync(authPath, '{"token":"second-auth-token"}');
      await runner.prompt('second');
      await runner.stop();
      const launches = messages(item.capture).filter((entry) => Array.isArray(entry.argv));
      expect(launches).toHaveLength(2);
      expect(readFileSync(join(item.options.codexHome!, 'auth.json'), 'utf8')).toContain(
        'second-auth-token'
      );
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it.each(['absent', 'empty'])(
    'restarts when authentication changes from %s to present',
    async (state) => {
      const item = fixture();
      const sourceHome = join(item.root, 'source-home');
      const authPath = join(sourceHome, '.codex', 'auth.json');
      if (state === 'empty') {
        writeFileSync(authPath, '');
      }
      const previousHome = process.env.HOME;
      process.env.HOME = sourceHome;
      try {
        const runner = new CodexAppServerProcess(item.options);
        await runner.prompt('first');
        writeFileSync(authPath, '{"token":"now-present"}');
        await runner.prompt('second');
        await runner.stop();
        expect(messages(item.capture).filter((entry) => Array.isArray(entry.argv))).toHaveLength(2);
      } finally {
        process.env.HOME = previousHome;
      }
    }
  );

  it.each(['exit-after-turn', 'timeout-once'])(
    'resumes the persisted thread after %s before starting the next turn',
    async (mode) => {
      const item = fixture(mode);
      const runner = new CodexAppServerProcess({ ...item.options, requestTimeout: 200 });
      if (mode === 'exit-after-turn') {
        await runner.prompt('first');
        await new Promise((resolve) => setTimeout(resolve, 30));
      } else {
        await expect(runner.prompt('first')).rejects.toThrow('timed out');
      }
      await expect(runner.prompt('second')).resolves.toMatchObject({ response: 'hello' });
      await runner.stop();
      const sent = messages(item.capture);
      const resumeIndex = sent.findIndex((entry) => entry.method === 'thread/resume');
      const secondTurnIndex = sent.findLastIndex((entry) => entry.method === 'turn/start');
      expect(resumeIndex).toBeGreaterThan(-1);
      expect(resumeIndex).toBeLessThan(secondTurnIndex);
    }
  );

  it('does not overwrite managed authentication when the source is missing', async () => {
    const item = fixture();
    mkdirSync(item.options.codexHome!, { recursive: true });
    writeFileSync(join(item.options.codexHome!, 'auth.json'), '{"token":"keep-me"}');
    const emptyHome = join(item.root, 'empty-source-home');
    mkdirSync(emptyHome);
    const previousHome = process.env.HOME;
    process.env.HOME = emptyHome;
    try {
      const runner = new CodexAppServerProcess(item.options);
      await runner.prompt('hi');
      await runner.stop();
      expect(readFileSync(join(item.options.codexHome!, 'auth.json'), 'utf8')).toContain('keep-me');
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
