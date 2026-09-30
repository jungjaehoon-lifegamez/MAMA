/**
 * code_act: the agent runs one piece of JavaScript that calls several actions, instead of
 * one model round trip per action.
 *
 * Mechanism ported from Kagemusha's code-act sandbox and worker. The code runs in its own
 * Node process; every action it calls is relayed over IPC to this process and dispatched
 * with the calling turn's own context, so the grant, session and traces are the caller's.
 * The worker runs under Node's permission model: `vm` gives the code a clean namespace but
 * is not a boundary, and an escaped script must reach no files, processes or network.
 * The process does not outlive the call: what a script leaves on globalThis goes back to the
 * host as data and is handed to the same model run's next script, so a failed step is fixed
 * in place instead of being written again.
 */
import { spawn } from 'node:child_process';
import type {
  ActionContext,
  ActionContract,
  ActionDispatcher,
  ActionRegistration,
} from '@jungjaehoon/mama-core';

const WORKER_SOURCE = `
const vm = require('node:vm');
const pending = new Map();
let nextId = 0;
function callTool(name, params) {
  const id = String(++nextId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ type: 'callTool', id, name, params });
  });
}
function assignNested(root, path, fn) {
  let cursor = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (!cursor[path[i]] || typeof cursor[path[i]] !== 'object') cursor[path[i]] = {};
    cursor = cursor[path[i]];
  }
  cursor[path[path.length - 1]] = fn;
}
process.on('disconnect', () => process.exit(1));
process.on('message', async (msg) => {
  if (msg.type === 'toolResult') {
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) call.reject(new Error(msg.error));
    else call.resolve(msg.result);
    return;
  }
  if (msg.type !== 'execute') return;
  const logs = [];
  const sandbox = {
    console: { log: (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
    callTool,
  };
  for (const name of msg.functionNames) {
    const proxy = (params) => callTool(name, params);
    if (name.includes('.')) assignNested(sandbox, name.split('.'), proxy);
    else sandbox[name] = proxy;
  }
  sandbox.globalThis = sandbox;
  // The names above are the host's; everything else on globalThis is what the run's scripts left.
  const reserved = new Set(Object.keys(sandbox));
  for (const [key, value] of Object.entries(msg.carried || {})) if (!reserved.has(key)) sandbox[key] = value;
  // Plain data left on globalThis goes back for the run's next script, whether this one returned
  // or threw: a step that failed is fixed in place, not written again. Functions do not carry, and
  // a value JSON cannot hold (a cycle) is not carried; the result's kept names show what did.
  const carried = () => {
    const kept = {};
    for (const key of Object.keys(sandbox)) {
      if (reserved.has(key)) continue;
      let json;
      try {
        json = JSON.stringify(sandbox[key]);
      } catch (notJson) {
        continue;
      }
      if (json !== undefined) kept[key] = JSON.parse(json);
    }
    return kept;
  };
  try {
    // Code that parses as one expression is returned, its closing semicolon dropped; anything
    // else is a function body. A line of several statements is a body, so it runs to the end.
    const expression = msg.code.trim().replace(/;$/, '');
    let script;
    try {
      script = new vm.Script('(async () => { return (' + expression + '\\n); })()', { filename: 'code_act.js' });
    } catch (notOneExpression) {
      script = new vm.Script('(async () => { ' + msg.code + '\\n})()', { filename: 'code_act.js' });
    }
    const value = await script.runInContext(vm.createContext(sandbox), { timeout: msg.timeoutMs });
    process.send({ type: 'result', success: true, value, logs, carried: carried() }, () => process.exit(0));
  } catch (error) {
    process.send(
      { type: 'result', success: false, logs, carried: carried(), error: { name: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) } },
      () => process.exit(0)
    );
  }
});
process.send({ type: 'ready' });
`;

export interface CodeActHost {
  /** The action names the code may call, e.g. `work.list`. */
  functions: readonly { name: string }[];
  call(name: string, input: unknown): Promise<unknown>;
}

export interface CodeActResult {
  success: boolean;
  value?: unknown;
  error?: { name: string; message: string };
  logs: string[];
  hostCallCount: number;
  durationMs: number;
  /** The names of the values the code left on globalThis for the run's next code_act. */
  kept?: string[];
}

type CarriedValues = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 300_000;
const CARRIED_RUNS = 4;

/**
 * Run the code in a fresh worker process; host calls are answered by `host.call`. `carried` is
 * what the run's earlier scripts left on globalThis; the result's `carried` is what this one
 * leaves. A worker that dies or times out leaves what it was given.
 */
export function runCodeAct(
  code: string,
  host: CodeActHost,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  carried: CarriedValues = {}
): Promise<CodeActResult & { carried: CarriedValues }> {
  const startedAt = Date.now();
  let hostCallCount = 0;
  return new Promise((resolve) => {
    // An empty environment: --permission does not guard process.env, and the daemon's holds
    // MAMA's own credentials (auth.env), which an escaped script must not read.
    const child = spawn(process.execPath, ['--permission', '-e', WORKER_SOURCE], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {},
    });
    let stderr = '';
    let settled = false;
    const settle = (
      result: Omit<CodeActResult, 'hostCallCount' | 'durationMs' | 'kept'>,
      left: CarriedValues = carried
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      const kept = Object.keys(left);
      resolve({
        ...result,
        hostCallCount,
        durationMs: Date.now() - startedAt,
        ...(kept.length > 0 ? { kept } : {}),
        carried: left,
      });
    };
    const timer = setTimeout(
      () =>
        settle({
          success: false,
          error: { name: 'TimeoutError', message: `code_act timed out after ${timeoutMs}ms` },
          logs: [],
        }),
      timeoutMs
    );
    child.stderr!.on('data', (chunk: Buffer) => {
      // Keep the tail only: an escaped script could write to stderr for the whole timeout.
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on(
      'message',
      async (msg: {
        type: string;
        id?: string;
        name?: string;
        params?: unknown;
        success?: boolean;
        value?: unknown;
        error?: { name: string; message: string };
        logs?: string[];
        carried?: CarriedValues;
      }) => {
        if (msg.type === 'ready') {
          child.send({
            type: 'execute',
            code,
            functionNames: host.functions.map((fn) => fn.name),
            timeoutMs,
            carried,
          });
          return;
        }
        if (msg.type === 'callTool') {
          // A call that arrives after a timeout must not start an action nobody will see.
          if (settled) return;
          hostCallCount += 1;
          try {
            const result = await host.call(msg.name!, msg.params);
            if (child.connected) child.send({ type: 'toolResult', id: msg.id, result });
          } catch (error) {
            if (child.connected)
              child.send({
                type: 'toolResult',
                id: msg.id,
                error: error instanceof Error ? error.message : String(error),
              });
          }
          return;
        }
        if (msg.type === 'result') {
          settle(
            msg.success
              ? { success: true, value: msg.value, logs: msg.logs ?? [] }
              : { success: false, error: msg.error, logs: msg.logs ?? [] },
            msg.carried ?? {}
          );
        }
      }
    );
    child.on('error', (error) =>
      settle({ success: false, error: { name: 'WorkerError', message: error.message }, logs: [] })
    );
    child.on('exit', (exitCode, signal) => {
      // A clean exit follows the result message; anything else lost the result.
      if (exitCode === 0 && signal === null) return;
      settle({
        success: false,
        error: {
          name: 'WorkerError',
          message: `code_act worker exited (code=${exitCode}, signal=${signal})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
        },
        logs: [],
      });
    });
  });
}

export const CODE_ACT_CONTRACT: ActionContract = {
  name: 'code_act',
  summary:
    'Run JavaScript that calls MAMA actions and returns only what the turn needs. Every action is an async function by its name, e.g. `return (await work.list({ view: "items", text: "asset" })).tasks.map((task) => [task.title, task.status])`; a failed action throws with its error; independent calls go together with `Promise.all`; `help({ actions: ["work.revise"] })` returns an action\'s argument types and examples; a name with a colon is called as `memory["read:provenance"]({...})`. The code runs in a separate process with no file or process access and an empty environment; its return value, console.log lines and any error come back. Plain data you assign to globalThis (strings, numbers, arrays, objects; not functions) is there again in your next code_act of this turn, even when the script threw, and the result lists it in kept: when a script fails, fix the part that failed instead of sending the whole script again.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: {
      code: {
        type: 'string',
        minLength: 1,
        description:
          'The body of an async function, e.g. const [recent, days] = await Promise.all([source.recent({ since: "24h ago" }), schedule.upcoming({ days: 14 })]); return { channels: recent.channels.length, events: days.events.length };',
      },
    },
  },
};

/**
 * The code_act action over a dispatcher built after it: the functions are the actions the
 * caller is granted, and each call is dispatched with the caller's own context.
 */
export function codeActRegistration(dispatcher: () => ActionDispatcher): ActionRegistration {
  // What each run's scripts left on globalThis. Runs are serial in one owner runtime, so the
  // latest run is the one that continues; the daemon is long-lived and a script can hold a whole
  // ledger, so only the latest few runs keep theirs.
  const carriedByRun = new Map<string, CarriedValues>();
  return {
    contract: CODE_ACT_CONTRACT,
    exec: async (input, context: ActionContext) => {
      const dispatch = dispatcher();
      const granted = new Set(context.access.actions ?? []);
      const functions = dispatch.contracts
        .filter(
          (contract) => contract.name !== CODE_ACT_CONTRACT.name && granted.has(contract.name)
        )
        .map((contract) => ({ name: contract.name }));
      // Inner writes take their command ids from this one; without it two calls would collide.
      const operationId = context.operationId;
      if (!operationId) throw new Error('code_act requires an operation id');
      const callable = new Set(functions.map((fn) => fn.name));
      let calls = 0;
      const runId = context.session?.modelRunId;
      const before = runId === undefined ? {} : (carriedByRun.get(runId) ?? {});
      const { carried: after, ...result } = await runCodeAct(
        (input as { code: string }).code,
        {
          functions,
          call: async (name, params) => {
            // callTool() takes any name; code_act itself would start a worker inside a worker.
            if (!callable.has(name)) throw new Error(`action_not_granted: ${name}`);
            calls += 1;
            const result = await dispatch(
              {
                action: name,
                input: params ?? {},
                operationId: `${operationId}#${calls}`,
              },
              context
            );
            if (result.status === 'completed') return result.data;
            throw new Error(`${result.error.code}: ${result.error.message}`);
          },
        },
        DEFAULT_TIMEOUT_MS,
        before
      );
      if (runId === undefined) return result;
      // One model message can carry several code_act calls, each started from the same values:
      // apply only what this call changed, so it does not replace what the others left.
      const current = { ...(carriedByRun.get(runId) ?? {}) };
      for (const key of Object.keys(before)) if (!(key in after)) delete current[key];
      for (const [key, value] of Object.entries(after))
        if (JSON.stringify(value) !== JSON.stringify(before[key])) current[key] = value;
      carriedByRun.delete(runId);
      carriedByRun.set(runId, current);
      for (const oldest of carriedByRun.keys()) {
        if (carriedByRun.size <= CARRIED_RUNS) break;
        carriedByRun.delete(oldest);
      }
      const { kept: _ownView, ...rest } = result;
      const kept = Object.keys(current);
      return kept.length > 0 ? { ...rest, kept } : rest;
    },
  };
}
