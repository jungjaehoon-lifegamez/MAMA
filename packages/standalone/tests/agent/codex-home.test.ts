import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

    it('translates the per-agent Code-Act MCP config into Codex config.toml', () => {
      const mcpConfigPath = path.join(os.tmpdir(), `mama-code-act-${Date.now()}.json`);
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            'code-act': {
              command: 'node',
              args: ['code-act-server.js'],
              env: {
                MAMA_SERVER_PORT: '3847',
                MAMA_CODE_ACT_AGENT_ID: 'dashboard',
              },
            },
          },
        })
      );

      try {
        const config = buildMAMACodexConfig(mcpConfigPath);

        expect(config).toContain('[mcp_servers."code-act"]');
        expect(config).toContain('command = "node"');
        expect(config).toContain('args = ["code-act-server.js"]');
        expect(config).toContain('MAMA_CODE_ACT_AGENT_ID = "dashboard"');
      } finally {
        fs.unlinkSync(mcpConfigPath);
      }
    });

    it('skips mama MCP entries when translating external MCP config', () => {
      const mcpConfigPath = path.join(os.tmpdir(), `mama-code-act-${Date.now()}-mixed.json`);
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            mama: {
              command: 'node',
              args: ['packages/mcp-server/src/server.js'],
            },
            'code-act': {
              command: 'node',
              args: ['code-act-server.js'],
            },
          },
        })
      );

      try {
        const config = buildMAMACodexConfig(mcpConfigPath);

        expect(config).toContain('[mcp_servers."code-act"]');
        expect(config).not.toContain('[mcp_servers."mama"]');
        expect(config).not.toContain('packages/mcp-server/src/server.js');
      } finally {
        fs.unlinkSync(mcpConfigPath);
      }
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
