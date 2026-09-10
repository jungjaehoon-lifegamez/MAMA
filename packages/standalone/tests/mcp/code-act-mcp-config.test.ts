import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  ensureCodeActMcpConfig,
  ensureCodeActMcpConfigBeforeSpawn,
  resolveCodeActServerPath,
} from '../../src/mcp/code-act-mcp-config.js';

function tempConfigPath() {
  return join(mkdtempSync(join(tmpdir(), 'mama-mcp-config-')), 'mama-mcp-config.json');
}

describe('ensureCodeActMcpConfig', () => {
  it('creates the entry when the config file is missing', () => {
    const mcpConfigPath = tempConfigPath();
    const result = ensureCodeActMcpConfig({
      mcpConfigPath,
      serverPath: '/opt/mama/dist/mcp/code-act-server.js',
      apiPort: 3847,
    });

    expect(result).toEqual({ changed: true, serverPath: '/opt/mama/dist/mcp/code-act-server.js' });
    const written = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    expect(written.mcpServers['code-act']).toEqual({
      command: 'node',
      args: ['/opt/mama/dist/mcp/code-act-server.js'],
      env: { MAMA_SERVER_PORT: '3847' },
    });
  });

  it('does not write when args[0] already matches the installed path', () => {
    const mcpConfigPath = tempConfigPath();
    const serverPath = '/opt/mama/dist/mcp/code-act-server.js';
    ensureCodeActMcpConfig({ mcpConfigPath, serverPath, apiPort: 3847 });
    const before = statSync(mcpConfigPath).mtimeMs;

    const result = ensureCodeActMcpConfig({ mcpConfigPath, serverPath, apiPort: 3847 });

    expect(result.changed).toBe(false);
    expect(statSync(mcpConfigPath).mtimeMs).toBe(before);
  });

  it('rewrites a stale server path and preserves other servers', () => {
    const mcpConfigPath = tempConfigPath();
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          'code-act': { command: 'node', args: ['/gone/code-act-server.js'] },
          other: { command: 'node', args: ['/keep/me.js'] },
        },
      }),
      'utf-8'
    );

    const result = ensureCodeActMcpConfig({
      mcpConfigPath,
      serverPath: '/opt/mama/dist/mcp/code-act-server.js',
      apiPort: 4000,
    });

    expect(result.changed).toBe(true);
    const written = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    expect(written.mcpServers['code-act'].args).toEqual([
      '/opt/mama/dist/mcp/code-act-server.js',
    ]);
    expect(written.mcpServers.other.args).toEqual(['/keep/me.js']);
  });

  it('recreates the entry when the config JSON is corrupt', () => {
    const mcpConfigPath = tempConfigPath();
    writeFileSync(mcpConfigPath, '{ not json', 'utf-8');
    const warn = vi.fn();

    const result = ensureCodeActMcpConfig({
      mcpConfigPath,
      serverPath: '/opt/s.js',
      apiPort: 1,
      logger: { warn },
    });

    expect(result.changed).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('resolves the installed server path in one place', () => {
    expect(resolveCodeActServerPath().endsWith('/mcp/code-act-server.js')).toBe(true);
  });
});

describe('ensureCodeActMcpConfigBeforeSpawn', () => {
  it('logs an error and regenerates when the configured server path is gone', () => {
    const mcpConfigPath = tempConfigPath();
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: { 'code-act': { command: 'node', args: ['/gone/code-act-server.js'] } },
      }),
      'utf-8'
    );
    const error = vi.fn();
    const serverPath = join(dirname(mcpConfigPath), 'code-act-server.js');
    writeFileSync(serverPath, '// installed server', 'utf-8');

    const result = ensureCodeActMcpConfigBeforeSpawn({
      mcpConfigPath,
      serverPath,
      apiPort: 3847,
      logger: { error },
    });

    expect(result.changed).toBe(true);
    expect(error).toHaveBeenCalledWith(
      '[mcp] code-act server path missing: /gone/code-act-server.js — regenerating'
    );
  });

  it('throws instead of returning when the config cannot be repaired', () => {
    const missingDir = join(tmpdir(), 'mama-no-such-dir-' + Date.now(), 'mama-mcp-config.json');
    expect(() =>
      ensureCodeActMcpConfigBeforeSpawn({
        mcpConfigPath: missingDir,
        serverPath: '/opt/s.js',
        apiPort: 1,
      })
    ).toThrow(/failed to repair code-act entry/);
  });
});

import { mkdtempSync, writeFileSync as writeFs, readFileSync as readFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { describe as describe2, expect as expect2, it as it2 } from 'vitest';
import {
  ensureCodeActMcpConfig as ensure2,
  ensureCodeActMcpConfigBeforeSpawn as ensureBeforeSpawn2,
} from '../../src/mcp/code-act-mcp-config.js';

describe2('code-act MCP entry: whole managed entry and server verification (review follow-up)', () => {
  it2('rewrites when the port or command is stale even if the path matches', () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'mama-mcp-'));
    const server = joinPath(dir, 'code-act-server.js');
    writeFs(server, '// server');
    const cfg = joinPath(dir, 'mcp.json');
    writeFs(
      cfg,
      JSON.stringify({ mcpServers: { 'code-act': { command: 'node', args: [server], env: { MAMA_SERVER_PORT: '1' } } } })
    );
    const r = ensure2({ mcpConfigPath: cfg, serverPath: server, apiPort: 3847 });
    expect2(r.changed).toBe(true);
    const written = JSON.parse(readFs(cfg, 'utf-8')) as { mcpServers: Record<string, { env: { MAMA_SERVER_PORT: string } }> };
    expect2(written.mcpServers['code-act'].env.MAMA_SERVER_PORT).toBe('3847');
  });

  it2('refuses to write a replacement server that does not exist', () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'mama-mcp-'));
    const cfg = joinPath(dir, 'mcp.json');
    writeFs(cfg, JSON.stringify({ mcpServers: { 'code-act': { command: 'node', args: [joinPath(dir, 'gone.js')], env: { MAMA_SERVER_PORT: '3847' } } } }));
    expect2(() =>
      ensureBeforeSpawn2({ mcpConfigPath: cfg, serverPath: joinPath(dir, 'also-missing.js'), apiPort: 3847 })
    ).toThrow(/installed code-act server is missing/);
  });
});
