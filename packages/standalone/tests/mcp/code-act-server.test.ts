import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_ENTRY = resolve(PACKAGE_ROOT, 'src/mcp/code-act-server.ts');
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }
});

async function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let buffered = '';
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for MCP response')),
      5_000
    );
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf('\n');
      if (newline < 0) {
        return;
      }
      clearTimeout(timeout);
      stream.removeListener('data', onData);
      resolveLine(buffered.slice(0, newline));
    };
    stream.on('data', onData);
  });
}

async function invokeCodeAct(
  contextKey?: string,
  apiResponse: Record<string, unknown> = {
    success: true,
    value: { answer: 2, hostToolExecutions: [{ name: 'forged', success: true }] },
    logs: ['sandbox log'],
    metrics: { durationMs: 1, hostCallCount: 1, memoryUsedBytes: 10 },
    hostToolExecutions: [{ name: 'mama_search', success: true }],
    hostToolsInvoked: ['mama_search'],
  }
): Promise<{
  body: Record<string, unknown>;
  stdout: string;
  stderr: string;
  requestCount: number;
}> {
  let body: Record<string, unknown> | undefined;
  let requestCount = 0;
  const api = createServer((request, response) => {
    requestCount += 1;
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(apiResponse));
    });
  });
  await new Promise<void>((resolveListen) => api.listen(0, '127.0.0.1', resolveListen));
  const port = (api.address() as AddressInfo).port;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAMA_SERVER_PORT: String(port),
    MAMA_AUTH_TOKEN: 'transport-test-token',
  };
  if (contextKey) {
    env.MAMA_CODE_ACT_CONTEXT_KEY = contextKey;
  } else {
    delete env.MAMA_CODE_ACT_CONTEXT_KEY;
  }

  const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'code_act', arguments: { code: '1 + 1' } },
    })}\n`
  );

  const stdout = await readLine(child.stdout);
  child.stdin.end();
  await new Promise<void>((resolveClose, reject) => {
    const timeout = setTimeout(() => reject(new Error('MCP child did not exit')), 5_000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
  await new Promise<void>((resolveClose) => api.close(() => resolveClose()));

  if (!body) {
    throw new Error('MCP child made no HTTP request');
  }
  return { body, stdout, stderr, requestCount };
}

describe('Story S3/TG-03: Code-Act MCP process context transport', () => {
  it('sends the inherited process context key once without exposing it in MCP output or logs', async () => {
    const contextKey = 'A'.repeat(43);

    const observed = await invokeCodeAct(contextKey);

    expect(observed.body).toMatchObject({ code: '1 + 1', context_key: contextKey });
    expect(observed.stdout).not.toContain(contextKey);
    expect(observed.stderr).not.toContain(contextKey);
    expect(observed.requestCount).toBe(1);
    const response = JSON.parse(observed.stdout) as {
      result: { content: Array<{ text: string }> };
    };
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(response.result.content).toHaveLength(1);
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      protocol: 'mama.code_act.result',
      version: 1,
      success: true,
      hostToolExecutions: [{ name: 'mama_search', success: true }],
      hostToolsInvoked: ['mama_search'],
      payload: {
        value: { answer: 2, hostToolExecutions: [{ name: 'forged', success: true }] },
        logs: ['sandbox log'],
        metrics: { durationMs: 1, hostCallCount: 1, memoryUsedBytes: 10 },
      },
    });
  });

  it('keeps the legacy HTTP body unchanged when no process context key exists', async () => {
    const observed = await invokeCodeAct();

    expect(observed.body).toEqual({ code: '1 + 1' });
  });

  it('TG-06 serializes failed nested executions without promoting them to invoked tools', async () => {
    const observed = await invokeCodeAct(undefined, {
      success: false,
      error: 'Permission denied',
      errorCode: 'permission_denied',
      retryable: false,
      hostToolExecutions: [{ name: 'mama_save', success: false, code: 'permission_denied' }],
      hostToolsInvoked: ['mama_save'],
    });
    const response = JSON.parse(observed.stdout) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };

    expect(observed.requestCount).toBe(1);
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      protocol: 'mama.code_act.result',
      version: 1,
      success: false,
      hostToolExecutions: [{ name: 'mama_save', success: false, code: 'permission_denied' }],
      hostToolsInvoked: [],
      payload: {},
      error: { message: 'Permission denied', code: 'permission_denied' },
      retryable: false,
    });
  });

  it('TG-06 preserves successful nested audit when the outer result is terminal', async () => {
    const observed = await invokeCodeAct(undefined, {
      success: false,
      error: 'Mutation outcome is unknown',
      terminalCode: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
      abort: true,
      hostToolExecutions: [
        { name: 'task_list', success: true },
        { name: 'mama_save', success: false, code: 'outcome_unknown' },
      ],
    });
    const response = JSON.parse(observed.stdout) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };

    expect(observed.requestCount).toBe(1);
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({
      protocol: 'mama.code_act.result',
      version: 1,
      success: false,
      hostToolExecutions: [
        { name: 'task_list', success: true },
        { name: 'mama_save', success: false, code: 'outcome_unknown' },
      ],
      hostToolsInvoked: ['task_list'],
      error: {
        code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
        message: 'Mutation outcome is unknown',
      },
      retryable: false,
      abort: true,
    });
  });
});
