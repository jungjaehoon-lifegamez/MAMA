/**
 * MAMA OS runtime utility functions, constants, and interfaces.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 */

import { accessSync, constants, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { join } from 'node:path';
import http from 'node:http';

import { loadConfig } from '../config/config-manager.js';

// Port configuration — single source of truth
/** Operational REST API port */
export const API_PORT = 3847;
export const RUNTIME_PORTS = [API_PORT] as const;

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
 * Runtime readiness is independent from the first-report onboarding milestone.
 *
 * Personas were retired: the owner runtime loads no SOUL/IDENTITY/USER file, so
 * their presence says nothing about whether the runtime can start. config.yaml
 * is the only artifact the runtime actually reads.
 */
export function isRuntimeReady(): boolean {
  return existsSync(join(homedir(), '.mama', 'config.yaml'));
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

export function resolveClineCommandForStartup(configuredCommand?: string): string {
  const candidates = [configuredCommand, process.env.MAMA_CLINE_COMMAND, process.env.CLINE_COMMAND];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed && isExecutable(trimmed)) {
      return trimmed;
    }
  }

  const fromPath = findExecutableInPath('cline');
  if (fromPath) {
    return fromPath;
  }

  throw new Error(
    'Cline command not found. Set agent.cline_command, MAMA_CLINE_COMMAND, or CLINE_COMMAND ' +
      'to an executable path, or install cline and ensure PATH includes the binary.'
  );
}

export function hasCodexBackendConfigured(config: Awaited<ReturnType<typeof loadConfig>>): boolean {
  if (config.agent.backend === 'codex') {
    return true;
  }

  const agents = config.multi_agent?.agents;
  if (!agents || typeof agents !== 'object') {
    return false;
  }

  for (const raw of Object.values(agents)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const agentBackend = (raw as { backend?: string }).backend;
      if (agentBackend === 'codex') {
        return true;
      }
    }
  }

  return false;
}

export function hasClineBackendConfigured(config: Awaited<ReturnType<typeof loadConfig>>): boolean {
  if (config.agent.backend === 'cline') {
    return true;
  }

  const agents = config.multi_agent?.agents;
  if (!agents || typeof agents !== 'object') {
    return false;
  }

  return Object.values(agents).some(
    (raw) =>
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as { backend?: string }).backend === 'cline'
  );
}
