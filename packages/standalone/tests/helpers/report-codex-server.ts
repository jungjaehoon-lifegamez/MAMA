import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function installReportCodexServer(root: string, delayedTurn = 1): string {
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
let finishTool = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 700 && !message.method && finishTool) { finishTool(); return; }
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
    const complete = () => {
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
    send({
      method: 'turn/completed',
      params: { threadId: message.params.threadId, turn: fullTurn(turnId, 'completed') },
    });
    };
    if (${delayedTurn} > 1 && turn === 1) {
      fs.writeFileSync(${JSON.stringify(join(root, 'initial-started'))}, '1');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(join(root, 'initial-release'))})) return;
        clearInterval(timer);
        complete();
      }, 5);
    } else if (turn === ${delayedTurn}) {
      fs.writeFileSync(${JSON.stringify(join(root, 'background-started'))}, '1');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(join(root, 'release-send'))})) return;
        clearInterval(timer);
        finishTool = complete;
        send({id:700,method:'item/tool/call',params:{threadId:message.params.threadId,turnId,callId:'report-send',namespace:null,tool:'code_act',arguments:{code:'telegram_send({chat_id:"7777",message:"background effect"})'}}});
      }, 5);
    } else complete();
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
