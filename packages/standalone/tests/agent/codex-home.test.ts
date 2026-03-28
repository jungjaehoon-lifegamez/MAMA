import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildMAMACodexConfig, getLocalMCPServerEntry } from '../../src/agent/codex-home.js';

describe('Story: Codex home config generation', () => {
  describe('AC #1: build MAMA-specific Codex config', () => {
    it('does not expose a direct mama MCP server to Codex', () => {
      const config = buildMAMACodexConfig();

      expect(config).not.toContain('[mcp_servers.mama]');
      expect(config).not.toContain('packages/mcp-server/src/server.js');
      expect(config).not.toContain('vendor/mama-mcp-node-sqlite');
    });
  });

  describe('AC #2: resolve local MCP entry path', () => {
    it('resolves the local MCP server entry from standalone dist layout', () => {
      const actual = path.normalize(getLocalMCPServerEntry()).replace(/\\/g, '/');
      const expected = path.normalize('packages/mcp-server/src/server.js').replace(/\\/g, '/');

      expect(actual).toContain(expected);
    });
  });
});
