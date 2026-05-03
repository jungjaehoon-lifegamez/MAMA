import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

type McpServerConfig = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlInlineStringTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`);
  return `{ ${entries.join(', ')} }`;
}

function mcpServersToml(mcpConfigPath: string | undefined): string[] {
  if (!mcpConfigPath || !existsSync(mcpConfigPath)) {
    return [];
  }

  const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as {
    mcpServers?: Record<string, McpServerConfig>;
  };
  const servers = parsed.mcpServers ?? {};
  const lines: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (name === 'mama') {
      continue;
    }
    if (typeof server.command !== 'string') {
      continue;
    }
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const env =
      server.env && typeof server.env === 'object' && !Array.isArray(server.env)
        ? Object.fromEntries(
            Object.entries(server.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : {};

    lines.push('', `[mcp_servers.${tomlString(name)}]`, `command = ${tomlString(server.command)}`);
    if (args.length > 0) {
      lines.push(`args = ${tomlStringArray(args)}`);
    }
    if (Object.keys(env).length > 0) {
      lines.push(`env = ${tomlInlineStringTable(env)}`);
    }
  }
  return lines;
}

export function buildMAMACodexConfig(mcpConfigPath?: string): string {
  return [
    'approval_policy = "never"',
    'model_reasoning_effort = "high"',
    'skip_git_repo_check = true',
    '',
    '# MAMA standalone uses GatewayToolExecutor/code_act for mama_* tools.',
    '# Intentionally do not expose a direct mama MCP server here, otherwise Codex',
    '# can bypass the agent loop and call server=mama tools directly.',
    ...mcpServersToml(mcpConfigPath),
  ].join('\n');
}

export function getLocalMCPServerEntry(): string {
  try {
    return require.resolve('@jungjaehoon/mama-server');
  } catch {
    // Fallback to monorepo-relative path for local development
    return join(__dirname, '../../../mcp-server/src/server.js');
  }
}
