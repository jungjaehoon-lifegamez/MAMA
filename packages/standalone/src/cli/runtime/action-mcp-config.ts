import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface EnsureMamaMcpConfigOptions {
  mcpConfigPath: string;
  serverPath?: string;
  mamaHome: string;
  socketPath?: string;
  credentialPath?: string;
  journalPath?: string;
  allowedActions?: readonly string[];
}

export interface EnsureMamaMcpConfigResult {
  changed: boolean;
  serverPath: string;
}

export const MAMA_MCP_SERVER_NAME = 'mama';

/** The built action MCP server beside this module (dist/runtime/action-mcp-server.js). */
export function resolveActionServerPath(): string {
  return join(__dirname, '..', '..', 'runtime', 'action-mcp-server.js');
}

function validEntry(
  value: unknown,
  serverPath: string,
  expectedEnv: Record<string, string>
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as { command?: unknown; args?: unknown; env?: unknown };
  const env = entry.env as Record<string, unknown> | undefined;
  return (
    entry.command === process.execPath &&
    Array.isArray(entry.args) &&
    entry.args.length === 1 &&
    entry.args[0] === serverPath &&
    Object.entries(expectedEnv).every(([key, value]) => env?.[key] === value)
  );
}

/** Keep Claude's one MCP registration pointed at the shared action socket. */
export function ensureMamaMcpConfig(
  options: EnsureMamaMcpConfigOptions
): EnsureMamaMcpConfigResult {
  const serverPath = options.serverPath ?? resolveActionServerPath();
  const env = {
    MAMA_HOME: options.mamaHome,
    ...(options.socketPath === undefined ? {} : { MAMA_SOCKET_PATH: options.socketPath }),
    ...(options.credentialPath === undefined
      ? {}
      : { MAMA_SESSION_CREDENTIAL_PATH: options.credentialPath }),
    ...(options.journalPath === undefined ? {} : { MAMA_CLIENT_JOURNAL_PATH: options.journalPath }),
    ...(options.allowedActions === undefined
      ? {}
      : { MAMA_ALLOWED_ACTIONS: JSON.stringify(options.allowedActions) }),
  };
  let parsed: Record<string, unknown> = {};
  if (existsSync(options.mcpConfigPath)) {
    const value: unknown = JSON.parse(readFileSync(options.mcpConfigPath, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  }
  const servers = parsed.mcpServers;
  if (
    servers &&
    typeof servers === 'object' &&
    !Array.isArray(servers) &&
    validEntry((servers as Record<string, unknown>)[MAMA_MCP_SERVER_NAME], serverPath, env) &&
    !Object.hasOwn(servers, 'code-act')
  ) {
    return { changed: false, serverPath };
  }
  const nextServers: Record<string, unknown> =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? { ...(servers as Record<string, unknown>) }
      : {};
  delete nextServers['code-act'];
  nextServers[MAMA_MCP_SERVER_NAME] = {
    command: process.execPath,
    args: [serverPath],
    env,
  };
  parsed.mcpServers = nextServers;
  mkdirSync(dirname(options.mcpConfigPath), { recursive: true });
  writeFileSync(options.mcpConfigPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { changed: true, serverPath };
}
