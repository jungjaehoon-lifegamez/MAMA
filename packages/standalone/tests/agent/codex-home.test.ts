import { describe, expect, it } from 'vitest';

import { buildMAMACodexConfig, getLocalMCPServerEntry } from '../../src/agent/codex-home.js';

describe('buildMAMACodexConfig', () => {
  it('does not expose a direct mama MCP server to Codex', () => {
    const config = buildMAMACodexConfig({
      nodeCommand: '/opt/homebrew/bin/node',
      mcpEntry: '/Users/jeongjaehun/project/MAMA/packages/mcp-server/src/server.js',
      mamaDbPath: '/Users/jeongjaehun/.mama/mama-memory.db',
    });

    expect(config).not.toContain('[mcp_servers.mama]');
    expect(config).not.toContain('packages/mcp-server/src/server.js');
    expect(config).not.toContain('vendor/mama-mcp-node-sqlite');
  });

  it('resolves the local MCP server entry from standalone dist layout', () => {
    expect(getLocalMCPServerEntry()).toContain('packages/mcp-server/src/server.js');
  });
});
