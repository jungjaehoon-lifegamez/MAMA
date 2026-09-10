import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

    const result = ensureCodeActMcpConfigBeforeSpawn({
      mcpConfigPath,
      serverPath: '/opt/mama/dist/mcp/code-act-server.js',
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
