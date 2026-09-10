import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

// Under vitest the module resolves the installed server next to src/mcp, where only the .ts
// exists; production resolves next to dist/mcp. Point the repair at a real temp file.
const fakeServer = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const p = require('node:path') as typeof import('node:path');
  const file = p.join(fs.mkdtempSync(p.join(os.tmpdir(), 'mama-fake-server-')), 'code-act-server.js');
  fs.writeFileSync(file, '// fake installed server', 'utf-8');
  return file;
});

vi.mock('../../src/mcp/code-act-mcp-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/code-act-mcp-config.js')>();
  return {
    ...actual,
    ensureCodeActMcpConfigBeforeSpawn: (o: Parameters<typeof actual.ensureCodeActMcpConfigBeforeSpawn>[0]) =>
      actual.ensureCodeActMcpConfigBeforeSpawn({ ...o, serverPath: o.serverPath ?? fakeServer }),
  };
});

import { PersistentClaudeProcess } from '../../src/agent/persistent-cli-process.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.pid = 4242;
  child.kill = vi.fn();
  return child;
}

describe('persistent Claude process repairs the code-act MCP entry before spawn', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeChild());
  });

  it('logs the missing server path and rewrites the config before spawning', async () => {
    const mcpConfigPath = join(
      mkdtempSync(join(tmpdir(), 'mama-persona-mcp-')),
      'mama-mcp-config.json'
    );
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: { 'code-act': { command: 'node', args: ['/gone/code-act-server.js'] } },
      }),
      'utf-8'
    );
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });

    const proc = new PersistentClaudeProcess({ sessionId: 'mcp-repair', mcpConfigPath });
    await proc.start();
    spy.mockRestore();

    const written = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    expect(written.mcpServers['code-act'].args[0]).not.toBe('/gone/code-act-server.js');
    expect(written.mcpServers['code-act'].args[0]).toMatch(/code-act-server\.js$/);
    const flat = errors.map((a) => a.map(String).join(' ')).join('\n');
    expect(flat).toContain('[mcp] code-act server path missing: /gone/code-act-server.js');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // repair happens before the spawn, so the CLI gets a config with a real entry
    expect(spawnMock.mock.calls[0]?.[1]).toContain(mcpConfigPath);
  });

  it('throws instead of spawning a tool-less persona when repair fails', async () => {
    const unwritable = join(tmpdir(), 'mama-no-dir-' + Date.now(), 'mama-mcp-config.json');
    const proc = new PersistentClaudeProcess({
      sessionId: 'mcp-repair-fail',
      mcpConfigPath: unwritable,
    });

    await expect(proc.start()).rejects.toThrow(/failed to repair code-act entry/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
