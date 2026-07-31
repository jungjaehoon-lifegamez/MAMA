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

async function invokeCodeAct(contextKey?: string): Promise<{
  body: Record<string, unknown>;
  stdout: string;
  stderr: string;
}> {
  let body: Record<string, unknown> | undefined;
  const api = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, value: 2, logs: [] }));
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
  return { body, stdout, stderr };
}

describe('Story S3/TG-03: Code-Act MCP process context transport', () => {
  it('sends the inherited process context key once without exposing it in MCP output or logs', async () => {
    const contextKey = 'A'.repeat(43);

    const observed = await invokeCodeAct(contextKey);

    expect(observed.body).toMatchObject({ code: '1 + 1', context_key: contextKey });
    expect(observed.stdout).not.toContain(contextKey);
    expect(observed.stderr).not.toContain(contextKey);
    expect(JSON.parse(observed.stdout)).toMatchObject({ jsonrpc: '2.0', id: 1 });
  });

  it('keeps the legacy HTTP body unchanged when no process context key exists', async () => {
    const observed = await invokeCodeAct();

    expect(observed.body).toEqual({ code: '1 + 1' });
  });
});
