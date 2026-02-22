#!/usr/bin/env node
/**
 * Code-Act MCP Server (stdio, no SDK dependency)
 *
 * Lightweight JSON-RPC stdio server that exposes `code_act` as a real tool_use level MCP tool.
 * Proxies execution to MAMA OS HTTP API (POST /api/code-act on localhost:3847).
 *
 * WHY THIS EXISTS:
 * - LLM strongly prefers real tool_use (MCP tools) over text-based tool_call blocks
 * - By registering code_act as MCP tool, it competes equally with other MCP tools
 * - The actual sandbox execution happens in MAMA OS process (shared GatewayToolExecutor)
 */

import http from 'http';
import readline from 'readline';

// MCP servers must use stderr for logging (stdout = JSON-RPC)
const log = (msg: string) => process.stderr.write(`[code-act-mcp] ${msg}\n`);

log(`Starting... PID=${process.pid} NODE=${process.execPath}`);

const MAMA_API_PORT = parseInt(process.env.MAMA_SERVER_PORT || '3847', 10);
log(`API port: ${MAMA_API_PORT}`);

function callCodeActAPI(code: string): Promise<{
  success: boolean;
  value?: unknown;
  logs?: string[];
  error?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: MAMA_API_PORT,
        path: '/api/code-act',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(
              new Error(`Invalid JSON response (HTTP ${res.statusCode}): ${data.substring(0, 200)}`)
            );
          }
        });
      }
    );
    req.on('error', (err) => reject(new Error(`Code-Act API connection failed: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Code-Act API timeout'));
    });
    req.write(body);
    req.end();
  });
}

function send(msg: Record<string, unknown>): void {
  const json = JSON.stringify(msg);
  process.stdout.write(json + '\n');
}

function reply(id: string | number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const CODE_ACT_TOOL = {
  name: 'code_act',
  description:
    'Execute JavaScript code in a sandboxed environment with all MAMA gateway tools. ' +
    'Available: mama_search, mama_save, mama_update, mama_load_checkpoint, Read, Write, Grep, Glob, Bash, etc. ' +
    'Use var for variables. Last expression is the return value. No async/await.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'JavaScript code to execute. Gateway tools available as global functions ' +
          '(e.g., mama_search({query:"auth"}), mama_save({topic:"x",decision:"y",reasoning:"z"}), Read({path:"/tmp/test.txt"})). ' +
          'Use var for variables. Last expression = return value.',
      },
    },
    required: ['code'],
  },
};

async function handleRequest(
  id: string | number,
  method: string,
  params?: Record<string, unknown>
): Promise<void> {
  log(`Request: ${method} (id=${id})`);
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'code-act', version: '1.0.0' },
      });
      log('Initialized OK');
      break;

    case 'tools/list':
      reply(id, { tools: [CODE_ACT_TOOL] });
      log('Tools listed');
      break;

    case 'tools/call': {
      const toolName = (params as { name?: string })?.name;
      const args = (params as { arguments?: Record<string, unknown> })?.arguments;

      if (toolName !== 'code_act') {
        reply(id, {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        });
        break;
      }

      const code = (args as { code?: string })?.code;
      if (!code) {
        reply(id, {
          content: [{ type: 'text', text: 'Missing required parameter: code' }],
          isError: true,
        });
        break;
      }

      try {
        const result = await callCodeActAPI(code);
        if (result.success) {
          const output: string[] = [];
          // Show tool calls executed during code-act
          if (result.toolCalls && result.toolCalls.length > 0) {
            output.push(
              `[tools] ${result.toolCalls.map((t: { name: string }) => t.name).join(', ')}`
            );
          }
          if (result.logs && result.logs.length > 0) {
            output.push(`[logs] ${result.logs.join('\n')}`);
          }
          output.push(
            typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2)
          );
          reply(id, { content: [{ type: 'text', text: output.join('\n') }] });
        } else {
          reply(id, {
            content: [{ type: 'text', text: `Code-Act error: ${result.error || 'Unknown error'}` }],
            isError: true,
          });
        }
      } catch (err) {
        reply(id, {
          content: [
            {
              type: 'text',
              text: `Code-Act server error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        });
      }
      break;
    }

    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

// Handle notifications (no id) - just acknowledge
function handleNotification(method: string): void {
  if (method === 'notifications/initialized') {
    // Client acknowledged initialization - nothing to do
  }
}

// Track pending async requests to avoid premature exit
let pendingRequests = 0;
let stdinClosed = false;

function checkExit(): void {
  if (stdinClosed && pendingRequests === 0) {
    process.exit(0);
  }
}

// Read JSON-RPC messages from stdin (newline-delimited JSON — Claude CLI protocol)
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  try {
    const msg = JSON.parse(trimmed);
    if (msg.id !== undefined) {
      pendingRequests++;
      handleRequest(msg.id, msg.method, msg.params)
        .catch((err) => {
          replyError(msg.id, -32603, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          pendingRequests--;
          checkExit();
        });
    } else {
      handleNotification(msg.method);
    }
  } catch {
    // Invalid JSON - skip
  }
});

rl.on('close', () => {
  stdinClosed = true;
  checkExit();
});
