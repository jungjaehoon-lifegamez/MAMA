import { join } from 'path';

export function buildMAMACodexConfig(): string {
  return [
    'approval_policy = "never"',
    'model_reasoning_effort = "high"',
    'skip_git_repo_check = true',
    '',
    '# MAMA standalone uses GatewayToolExecutor/code_act for mama_* tools.',
    '# Intentionally do not expose a direct mama MCP server here, otherwise Codex',
    '# can bypass the agent loop and call server=mama tools directly.',
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
