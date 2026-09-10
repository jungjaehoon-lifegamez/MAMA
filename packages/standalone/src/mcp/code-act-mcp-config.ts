/**
 * code-act MCP config maintenance.
 *
 * WHY THIS EXISTS (2026-09-10 incident, twice in one day):
 * A test process rewrote the live ~/.mama/mama-mcp-config.json so its
 * `code-act` entry pointed at a file that does not exist. The Claude backend
 * persona is spawned with `--mcp-config <that file> --strict-mcp-config`, so
 * for the whole life of that process it had NO gateway tools
 * ("No such tool available: mcp__code-act__code_act", task_list, ...). Only a
 * daemon restart repaired it, because the boot path was the only writer.
 *
 * The merge now lives here so both boot AND every persona spawn can repair it,
 * and a persona is never spawned silently tool-less.
 */

import path from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export interface EnsureCodeActMcpConfigLogger {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface EnsureCodeActMcpConfigOptions {
  mcpConfigPath: string;
  /** Installed code-act server path. Defaults to resolveCodeActServerPath(). */
  serverPath?: string;
  apiPort: number | string;
  logger?: EnsureCodeActMcpConfigLogger;
}

export interface EnsureCodeActMcpConfigResult {
  changed: boolean;
  serverPath: string;
}

/**
 * The ONE place the installed code-act server path is resolved:
 * __dirname-relative, i.e. dist/mcp/code-act-server.js next to this module.
 */
export function resolveCodeActServerPath(): string {
  return path.join(__dirname, 'code-act-server.js');
}

interface McpConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Write the `code-act` entry into the MCP config when it is missing or when its
 * args[0] differs from the installed server path. Returns whether it wrote.
 * Throws if the config cannot be written — callers about to spawn a persona
 * must fail loudly rather than run without gateway tools.
 */
export function ensureCodeActMcpConfig(
  options: EnsureCodeActMcpConfigOptions
): EnsureCodeActMcpConfigResult {
  const serverPath = options.serverPath ?? resolveCodeActServerPath();
  const logger = options.logger;

  let existing: McpConfigShape = {};
  if (existsSync(options.mcpConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(options.mcpConfigPath, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as McpConfigShape;
      }
    } catch (parseErr) {
      logger?.warn?.('[mcp] invalid MCP config JSON; recreating code-act entry:', parseErr);
    }
  }
  if (
    !existing.mcpServers ||
    typeof existing.mcpServers !== 'object' ||
    Array.isArray(existing.mcpServers)
  ) {
    existing.mcpServers = {};
  }

  const current = existing.mcpServers['code-act'] as
    | { command?: unknown; args?: unknown; env?: unknown }
    | undefined;
  const currentArg =
    current && typeof current === 'object' && Array.isArray(current.args)
      ? current.args[0]
      : undefined;
  const currentPort =
    current && typeof current === 'object' && current.env && typeof current.env === 'object'
      ? (current.env as Record<string, unknown>).MAMA_SERVER_PORT
      : undefined;
  // The whole managed entry must match: a stale command or port would start the server
  // against the wrong API endpoint even when the script path is right.
  if (
    currentArg === serverPath &&
    current?.command === 'node' &&
    currentPort === String(options.apiPort)
  ) {
    return { changed: false, serverPath };
  }

  existing.mcpServers['code-act'] = {
    command: 'node',
    args: [serverPath],
    env: { MAMA_SERVER_PORT: String(options.apiPort) },
  };
  writeFileSync(options.mcpConfigPath, JSON.stringify(existing, null, 2), 'utf-8');
  logger?.debug?.(`[mcp] code-act entry written into ${options.mcpConfigPath}`);
  return { changed: true, serverPath };
}

/**
 * Pre-spawn guard: if the configured code-act server path is absent from disk,
 * log loudly and rewrite the entry. Throws when repair fails or when the
 * installed server itself is missing — never spawn a tool-less persona.
 */
export function ensureCodeActMcpConfigBeforeSpawn(
  options: EnsureCodeActMcpConfigOptions
): EnsureCodeActMcpConfigResult {
  const serverPath = options.serverPath ?? resolveCodeActServerPath();
  const configuredPath = readConfiguredCodeActServerPath(options.mcpConfigPath);
  if (configuredPath !== undefined && existsSync(configuredPath)) {
    // An entry that points at a real file is respected as-is: per-agent configs and operator
    // overrides may legitimately name a different server. Only a dangling path is repaired.
    return { changed: false, serverPath: configuredPath };
  }
  if (configuredPath !== undefined) {
    options.logger?.error?.(
      `[mcp] code-act server path missing: ${configuredPath} — regenerating`
    );
  }
  try {
    if (!existsSync(serverPath) || !statSync(serverPath).isFile()) {
      throw new Error(`installed code-act server is missing: ${serverPath}`);
    }
    return ensureCodeActMcpConfig({ ...options, serverPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[mcp] failed to repair code-act entry in ${options.mcpConfigPath}: ${message}`
    );
  }
}

function readConfiguredCodeActServerPath(mcpConfigPath: string): string | undefined {
  if (!existsSync(mcpConfigPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as McpConfigShape;
    const entry = parsed?.mcpServers?.['code-act'] as { args?: unknown } | undefined;
    if (entry && typeof entry === 'object' && Array.isArray(entry.args)) {
      const arg = entry.args[0];
      return typeof arg === 'string' ? arg : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
