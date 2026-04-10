/**
 * MAMA OS runtime utility functions, constants, and interfaces.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 */

import { exec } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path, { join } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import http from 'node:http';

import { loadConfig } from '../config/config-manager.js';
import { getEmbeddingDim, getModelName } from '@jungjaehoon/mama-core/config-loader';

// Port configuration — single source of truth
/** Public-facing API server port (REST API, Viewer UI, Setup Wizard) */
export const API_PORT = 3847;
/** Internal embedding server port (model inference, mobile chat, graph) */
export const EMBEDDING_PORT = 3849;

export interface SecurityAlertTarget {
  gateway: 'discord' | 'slack' | 'telegram';
  channelId: string;
}

export function parseSecurityAlertTargets(config: {
  discord?: { default_channel_id?: string };
  slack?: unknown;
}): SecurityAlertTarget[] {
  const rawTargets = process.env.MAMA_SECURITY_ALERT_CHANNELS;
  if (rawTargets && rawTargets.trim()) {
    return rawTargets
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [gateway, channelId] = entry.split(':', 2);
        if ((gateway === 'discord' || gateway === 'slack' || gateway === 'telegram') && channelId) {
          return { gateway, channelId } as SecurityAlertTarget;
        }
        return null;
      })
      .filter((target): target is SecurityAlertTarget => target !== null);
  }

  if (config.discord?.default_channel_id) {
    return [{ gateway: 'discord', channelId: config.discord.default_channel_id }];
  }

  const slackConfig = config.slack as
    | { default_channel?: string; default_channel_id?: string }
    | undefined;
  const slackDefaultChannel = slackConfig?.default_channel || slackConfig?.default_channel_id;
  if (slackDefaultChannel) {
    return [{ gateway: 'slack', channelId: slackDefaultChannel }];
  }

  return [];
}

// MAMA embedding server (keeps model in memory)
let embeddingServer: HttpServer | null = null;
let embeddingShutdownToken: string | null = null;

export function getEmbeddingServer(): HttpServer | null {
  return embeddingServer;
}

export function setEmbeddingServer(server: HttpServer | null): void {
  embeddingServer = server;
}

export function getEmbeddingShutdownToken(): string | null {
  return embeddingShutdownToken;
}

export function setEmbeddingShutdownToken(token: string | null): void {
  embeddingShutdownToken = token;
}

/**
 * Normalize Discord guild config before passing to gateway.
 * Guards against null, unexpected types, and non-string keys.
 */
export interface NormalizedDiscordGuildConfig {
  requireMention?: boolean;
  channels?: Record<string, { requireMention?: boolean }>;
}

export function normalizeDiscordGuilds(
  raw: unknown
): Record<string, NormalizedDiscordGuildConfig> | undefined {
  // Reject arrays - they pass typeof 'object' check but get coerced to numeric keys
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const source = raw instanceof Map ? Object.fromEntries(raw) : raw;
  const normalized: Record<string, NormalizedDiscordGuildConfig> = {};

  for (const [guildId, guildConfig] of Object.entries(source as Record<string, unknown>)) {
    if (!guildId) {
      continue;
    }
    if (!guildConfig || typeof guildConfig !== 'object' || Array.isArray(guildConfig)) {
      continue;
    }

    const normalizedGuildConfig: NormalizedDiscordGuildConfig = {};
    if (typeof (guildConfig as Record<string, unknown>).requireMention === 'boolean') {
      normalizedGuildConfig.requireMention = (guildConfig as Record<string, unknown>)
        .requireMention as boolean;
    }

    const rawChannels = (guildConfig as Record<string, unknown>).channels;
    // Reject arrays for channels as well
    if (rawChannels && typeof rawChannels === 'object' && !Array.isArray(rawChannels)) {
      const normalizedChannels: Record<string, { requireMention?: boolean }> = {};
      for (const [channelId, channelConfig] of Object.entries(
        rawChannels as Record<string, unknown>
      )) {
        if (!channelId) {
          continue;
        }
        if (!channelConfig || typeof channelConfig !== 'object' || Array.isArray(channelConfig)) {
          continue;
        }
        const rawChannelRequireMention = (channelConfig as Record<string, unknown>).requireMention;
        if (typeof rawChannelRequireMention === 'boolean') {
          normalizedChannels[String(channelId)] = {
            requireMention: rawChannelRequireMention,
          };
        }
      }
      if (Object.keys(normalizedChannels).length > 0) {
        normalizedGuildConfig.channels = normalizedChannels;
      }
    }

    normalized[String(guildId)] = normalizedGuildConfig;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * SECURITY P1: Wait for port to become available after shutdown
 * Polls port availability instead of using fixed setTimeout
 */
export async function waitForPortAvailable(
  port: number,
  maxWaitMs: number = 5000
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < maxWaitMs) {
    const isAvailable = await new Promise<boolean>((resolve) => {
      const testServer = http.createServer();
      testServer.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(true);
        }
      });
      testServer.once('listening', () => {
        testServer.close(() => resolve(true));
      });
      testServer.listen(port, '127.0.0.1');
    });

    if (isAvailable) return true;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return false;
}

/**
 * Check existing embedding server and request takeover if needed
 * Returns true if existing server has chat capability (no takeover needed)
 *
 * SECURITY P1: Uses authenticated shutdown with token
 * SECURITY P1: Validates health response before reuse
 * SECURITY P1: Uses port polling instead of fixed timeout
 */
export async function checkAndTakeoverExistingServer(
  port: number,
  shutdownToken: string | null
): Promise<boolean> {
  const targetModel = getModelName();
  const targetDim = getEmbeddingDim();
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          try {
            const health = JSON.parse(data);
            const healthModel = typeof health.model === 'string' ? health.model : null;
            const healthDim = typeof health.dim === 'number' ? health.dim : null;
            const metadataMismatch =
              healthModel !== targetModel || (healthDim !== null && healthDim !== targetDim);
            const metadataMissing = healthModel === null || healthDim === null;
            // SECURITY P1: Validate health response before reuse
            if (
              health.chatEnabled &&
              health.status === 'ok' &&
              health.modelLoaded &&
              !metadataMismatch &&
              !metadataMissing
            ) {
              // Fully functional server, reuse it
              console.log('✓ Fully functional embedding server (reusing)');
              resolve(true);
              return;
            }

            if (health.status === 'ok') {
              // Server healthy but incomplete features
              if (!health.modelLoaded) {
                console.warn('[EmbeddingServer] Warning: Model not loaded');
              }
              if (metadataMismatch || metadataMissing) {
                console.warn(
                  `[EmbeddingServer] Metadata mismatch -> replacing. ` +
                    `Expected ${targetModel}/${targetDim}, got ${healthModel ?? 'unknown'}/${healthDim ?? 'unknown'}`
                );
              }
              // MCP server running without chat, request shutdown
              console.log('[EmbeddingServer] MCP server detected, requesting takeover...');
              const shutdownReq = http.request(
                {
                  hostname: '127.0.0.1',
                  port,
                  path: '/shutdown',
                  method: 'POST',
                  timeout: 2000,
                  // SECURITY P1: Pass shutdown token
                  headers: {
                    'X-Shutdown-Token': shutdownToken || process.env.MAMA_SHUTDOWN_TOKEN || '',
                  },
                },
                async (shutdownRes) => {
                  if ((shutdownRes.statusCode ?? 0) < 200 || (shutdownRes.statusCode ?? 0) >= 300) {
                    console.warn(
                      `[EmbeddingServer] Takeover shutdown rejected with HTTP ${shutdownRes.statusCode ?? 0}`
                    );
                    resolve(false);
                    return;
                  }

                  console.log('[EmbeddingServer] MCP server shutdown requested');
                  // SECURITY P1: Use port polling instead of fixed timeout
                  const portAvailable = await waitForPortAvailable(port, 10000);
                  if (portAvailable) {
                    console.log('[EmbeddingServer] Port available, proceeding');
                  } else {
                    console.warn(
                      `[EmbeddingServer] Warning: Port ${port} still in use after 10s. ` +
                        'Proceeding anyway — Watchdog will retry if needed.'
                    );
                  }
                  resolve(false);
                }
              );
              shutdownReq.on('error', () => resolve(false));
              shutdownReq.end();
            } else {
              // Server unhealthy
              console.warn('[EmbeddingServer] Server unhealthy, starting fresh');
              resolve(false);
            }
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function startEmbeddingServerIfAvailable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messageRouter?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionStore?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphHandler?: any
): Promise<void> {
  const port = EMBEDDING_PORT;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const embeddingServerModule = require('@jungjaehoon/mama-core/embedding-server');
    embeddingShutdownToken =
      typeof embeddingServerModule.SHUTDOWN_TOKEN === 'string'
        ? embeddingServerModule.SHUTDOWN_TOKEN
        : null;

    // Check if server already running
    const existingHasChat = await checkAndTakeoverExistingServer(port, embeddingShutdownToken);
    if (existingHasChat) {
      // Another Standalone is running with chat, no need to start
      return;
    }

    embeddingServer = await embeddingServerModule.startEmbeddingServer(port, {
      messageRouter,
      sessionStore,
      graphHandler,
    });
    if (embeddingServer) {
      console.log(`✓ Embedding server started (port ${EMBEDDING_PORT})`);
      if (messageRouter && sessionStore) {
        console.log('✓ Mobile Chat integrated with MessageRouter');
      }
      await embeddingServerModule.warmModel();
      console.log('✓ Embedding model preloaded');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[EmbeddingServer] Failed to start: ${message}\n` +
        `  ⚠️  Semantic search (decision recall) UNAVAILABLE this session`
    );
  }
}

/**
 * Open URL in default browser (cross-platform)
 */
export function openBrowser(url: string): void {
  const os = platform();
  let command: string;

  switch (os) {
    case 'darwin':
      command = `open "${url}"`;
      break;
    case 'win32':
      command = `start "" "${url}"`;
      break;
    default:
      command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.warn(`[Browser] Failed to open: ${error.message}`);
      console.log(`\n🌐 Open MAMA OS manually: ${url}\n`);
    }
  });
}

/**
 * Check if onboarding is complete (persona files exist)
 */
export function isOnboardingComplete(): boolean {
  const mamaHome = join(homedir(), '.mama');
  return existsSync(join(mamaHome, 'USER.md')) && existsSync(join(mamaHome, 'SOUL.md'));
}

/**
 * Sync built-in skills from templates to user's skills directory.
 * Only copies files that don't already exist (never overwrites user modifications).
 */
export function syncBuiltinSkills(): void {
  const skillsDir = join(homedir(), '.mama', 'skills');
  const templatesDir = join(__dirname, '..', '..', '..', 'templates', 'skills');

  if (!existsSync(templatesDir)) {
    return;
  }

  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch (err) {
    console.warn('[syncBuiltinSkills] Failed to create skills directory (non-fatal):', err);
    return;
  }

  try {
    const entries = readdirSync(templatesDir);
    let synced = 0;
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const dest = join(skillsDir, file);
      if (existsSync(dest)) continue;
      copyFileSync(join(templatesDir, file), dest);
      synced++;
    }
    if (synced > 0) {
      console.log(`✓ Synced ${synced} built-in skill(s)`);
    }
  } catch (err) {
    // Non-blocking: skills are optional, but surface failures for observability
    console.warn('[syncBuiltinSkills] Skill sync failed (non-fatal):', err);
  }
}

export function shouldAutoOpenBrowser(): boolean {
  return process.env.MAMA_NO_AUTO_OPEN_BROWSER !== '1';
}

export function isExecutable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutableInPath(commandName: string): string | null {
  const pathValue = process.env.PATH || '';
  if (!pathValue) {
    return null;
  }

  const pathEntries = pathValue
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = join(dir, commandName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveCodexCommandForStartup(): string {
  const candidates = [process.env.MAMA_CODEX_COMMAND, process.env.CODEX_COMMAND];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed && isExecutable(trimmed)) {
      return trimmed;
    }
  }

  const fromPath = findExecutableInPath('codex');
  if (fromPath) {
    return fromPath;
  }

  throw new Error(
    'Codex command not found. Set MAMA_CODEX_COMMAND or CODEX_COMMAND to an executable path, ' +
      'or install codex and ensure PATH includes the binary.'
  );
}

export function hasCodexBackendConfigured(config: Awaited<ReturnType<typeof loadConfig>>): boolean {
  if (config.agent.backend === 'codex-mcp') {
    return true;
  }

  const agents = config.multi_agent?.agents;
  if (!agents || typeof agents !== 'object') {
    return false;
  }

  for (const raw of Object.values(agents)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const agentBackend = (raw as { backend?: string }).backend;
      if (agentBackend === 'codex-mcp') {
        return true;
      }
    }
  }

  return false;
}
