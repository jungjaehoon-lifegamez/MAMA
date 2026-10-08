import { untrustedToolData } from '../utils/untrusted-content.js';
/**
 * The owner agent's door into the daemon's action catalog, spoken as stdio MCP
 * because that is how the CLI backends take tools.
 *
 * tools/list is the catalog's own describe over the runtime socket; tools/call
 * is one client.call on the same socket. No database, no second execution path.
 * The session credential is re-read per request, so rotation takes effect on
 * the next call instead of pinning a stale one; it never appears in tool output.
 *
 * MCP servers log to stderr (stdout is JSON-RPC).
 */
import { join } from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ActionContract, ActionResult } from '@jungjaehoon/mama-core';
import { createClient, type Client } from '@jungjaehoon/mama-core/client/client';
import { readCredentialFile, readSessionCredential } from './session-credential.js';
import { CLAUDE_CALLER_FIELD } from './claude-caller-hook.js';
import type { NativeToolCaller } from '@jungjaehoon/mama-core/action-contracts';
import { actionCatalogLine } from '../api/help-actions.js';
import { CODE_ACT_CONTRACT } from '../api/code-act-actions.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'mama', version: '0.1.0' };

function log(message: string): void {
  process.stderr.write(`[mama-action-mcp] ${message}\n`);
}

function mamaHome(): string {
  const home = process.env.MAMA_HOME?.trim();
  if (!home) {
    throw new Error('MAMA_HOME is not set — the action server cannot locate the runtime socket');
  }
  return home;
}

function runtimeClient(home: string): Client {
  return createClient({
    socketPath: process.env.MAMA_SOCKET_PATH ?? join(home, 'runtime.sock'),
    journalPath:
      process.env.MAMA_CLIENT_JOURNAL_PATH ?? join(home, 'runtime', 'client-journal.jsonl'),
    credential:
      process.env.MAMA_SESSION_CREDENTIAL_PATH === undefined
        ? readSessionCredential(home)
        : readCredentialFile(process.env.MAMA_SESSION_CREDENTIAL_PATH),
  });
}

/**
 * Claude gets one tool, code_act, as Kagemusha's Claude CLI did: its description lists every other
 * action by name, arguments and first sentence, and the script calls them by name. Claude CLI has
 * no code mode of its own, and its Bash sandbox cannot reach the action socket.
 */
function codeActTool(contracts: readonly ActionContract[]) {
  const codeAct = contracts.find((contract) => contract.name === CODE_ACT_CONTRACT.name);
  if (!codeAct) throw new Error('code_act is not granted to this session');
  return {
    name: codeAct.name,
    description: [
      codeAct.summary,
      '',
      'Actions:',
      ...contracts.filter((contract) => contract !== codeAct).map(actionCatalogLine),
    ].join('\n'),
    // Without additionalProperties: the PreToolUse hook adds __mama_caller to the input, which
    // callTool strips before the dispatcher checks the strict schema.
    inputSchema: {
      type: 'object',
      required: ['code'],
      properties: (codeAct.inputSchema as { properties: Record<string, unknown> }).properties,
    },
  };
}

function textResult(value: unknown, isError: boolean): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function resultContent(name: string, result: ActionResult): ToolResult {
  if (result.status === 'completed') {
    // A code_act script that threw completes as an action but failed as a call.
    const failed =
      name === CODE_ACT_CONTRACT.name &&
      (result.data as { success?: unknown } | null)?.success === false;
    return textResult(
      { success: !failed, data: untrustedToolData(name, result.data ?? null) },
      failed
    );
  }
  return textResult(
    {
      success: false,
      status: result.status,
      error: untrustedToolData(name, result.error ?? null),
      ...(result.operationId !== undefined ? { operationId: result.operationId } : {}),
    },
    true
  );
}

async function callTool(client: Client, params: Record<string, unknown>): Promise<ToolResult> {
  const name = params.name;
  if (typeof name !== 'string' || name.length === 0) {
    return textResult({ success: false, error: 'missing tool name' }, true);
  }
  try {
    const input = params.arguments ?? {};
    if (
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.hasOwn(input, CLAUDE_CALLER_FIELD)
    ) {
      const { [CLAUDE_CALLER_FIELD]: caller, ...argumentsWithoutCaller } = input as Record<
        string,
        unknown
      >;
      return resultContent(
        name,
        await client.call({
          action: name,
          input: argumentsWithoutCaller,
          session: { nativeCaller: caller as NativeToolCaller },
        })
      );
    }
    throw new Error('Claude MCP call is missing hook caller metadata');
  } catch (error) {
    return textResult(
      {
        success: false,
        error: untrustedToolData(name, error instanceof Error ? error.message : String(error)),
      },
      true
    );
  }
}

/**
 * One JSON-RPC request → one MCP response (null for notifications). The client
 * dependency is the only socket handle; the handler never opens its own.
 */
export async function handleRequest(
  request: JsonRpcRequest,
  deps: { client: Client; allowedActions?: readonly string[] }
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? 0;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: [
          codeActTool(
            (await deps.client.describe()).filter(
              (contract) =>
                deps.allowedActions === undefined || deps.allowedActions.includes(contract.name)
            )
          ),
        ],
      });
    case 'tools/call':
      return reply(await callTool(deps.client, request.params ?? {}));
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (request.id === undefined) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }
}

export function runStdioMcpServer(
  streams: { input?: Readable; output?: Writable } = {}
): readline.Interface {
  const home = mamaHome();
  const output = streams.output ?? process.stdout;
  const write = (response: JsonRpcResponse): void => {
    output.write(`${JSON.stringify(response)}\n`);
  };
  log(`starting — MAMA_HOME=${home}`);
  const lines = readline.createInterface({ input: streams.input ?? process.stdin });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: '2.0', id: 0, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    void handleRequest(request, {
      client: runtimeClient(home),
      allowedActions:
        process.env.MAMA_ALLOWED_ACTIONS === undefined
          ? undefined
          : JSON.parse(process.env.MAMA_ALLOWED_ACTIONS),
    })
      .then((response) => {
        if (response !== null) write(response);
      })
      .catch((error: unknown) => {
        write({
          jsonrpc: '2.0',
          id: request.id ?? 0,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      });
  });
  return lines;
}

if (require.main === module) {
  try {
    runStdioMcpServer();
  } catch (error) {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
