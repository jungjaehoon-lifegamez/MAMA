/**
 * Live observation for the onboarding contract.
 *
 * This module observes the current installation. Judgment and wording remain
 * in agent-contract.ts. Completion markers cache observed history; they never
 * gate runtime behavior.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigPath, getMAMAHome, loadConfig } from '../cli/config/config-manager.js';
import { isDaemonRunning } from '../cli/utils/pid-manager.js';
import { loadConnectorConfig } from '../connectors/config-loader.js';
import type { AssessDeps } from './agent-contract.js';

interface CompletionMarker {
  completed_at?: string;
}

interface FirstReportMarker {
  at?: string;
}

function parseJsonFile<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse onboarding state file ${path}: ${message}`);
  }
}

function parseJsonObjectFile(path: string): Record<string, unknown> {
  const value = parseJsonFile<unknown>(path);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid onboarding state file ${path}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function countEnabledConnectors(mamaHome: string): number {
  const path = join(mamaHome, 'connectors.json');
  const result = loadConnectorConfig(path);
  if (!result.ok) {
    throw new Error(
      `Failed to load onboarding connector state ${result.error.path}: ${result.error.message}`
    );
  }
  return result.enabledNames.length;
}

function readFirstReportAt(mamaHome: string): string | null {
  const path = join(mamaHome, 'state', 'first-report.json');
  if (!existsSync(path)) {
    return null;
  }
  const raw = parseJsonObjectFile(path) as FirstReportMarker;
  if (typeof raw.at !== 'string' || raw.at.length === 0) {
    throw new Error(`Invalid onboarding state file ${path}: expected a non-empty string "at"`);
  }
  return raw.at;
}

export async function collectAssessDeps(): Promise<AssessDeps> {
  const mamaHome = getMAMAHome();
  const configPath = getConfigPath();
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;

  if (existsSync(configPath)) {
    try {
      config = await loadConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load onboarding config ${configPath}: ${message}`);
    }
  }

  const running = await isDaemonRunning();
  return {
    configLoadable: config !== null,
    daemonRunning: Boolean(running),
    telegramConfigured:
      config?.telegram?.enabled === true && Boolean(config.telegram.token?.trim()),
    allowedChats:
      Array.isArray(config?.telegram?.allowed_chats) && config.telegram.allowed_chats.length > 0,
    enabledConnectors: countEnabledConnectors(mamaHome),
    firstReportAt: readFirstReportAt(mamaHome),
  };
}

/** Idempotent: the first completed_at is preserved forever. */
export async function writeCompletionMarker(mamaHome: string): Promise<void> {
  const path = join(mamaHome, 'setup-complete.json');
  if (existsSync(path)) {
    return;
  }
  mkdirSync(mamaHome, { recursive: true });
  writeFileSync(path, JSON.stringify({ completed_at: new Date().toISOString() }, null, 2));
}

/**
 * Backfill observed completion evidence for an existing working installation.
 * The markers describe history only; assessment still recomputes live state.
 */
export async function migrateLegacyInstall(mamaHome: string): Promise<boolean> {
  const completionPath = join(mamaHome, 'setup-complete.json');
  const reportPath = join(mamaHome, 'state', 'first-report.json');
  if (existsSync(completionPath) && existsSync(reportPath)) {
    return false;
  }

  const hasPersonas =
    existsSync(join(mamaHome, 'SOUL.md')) && existsSync(join(mamaHome, 'USER.md'));
  if (!hasPersonas || !existsSync(getConfigPath())) {
    return false;
  }

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load onboarding config ${getConfigPath()}: ${message}`);
  }
  const telegramConfigured =
    config.telegram?.enabled === true &&
    Boolean(config.telegram.token?.trim()) &&
    Array.isArray(config.telegram.allowed_chats) &&
    config.telegram.allowed_chats.length > 0;
  if (!telegramConfigured) {
    return false;
  }

  let completedAt = new Date().toISOString();
  let changed = false;

  if (existsSync(completionPath)) {
    const marker = parseJsonObjectFile(completionPath) as CompletionMarker;
    if (typeof marker.completed_at !== 'string' || marker.completed_at.length === 0) {
      throw new Error(
        `Invalid onboarding state file ${completionPath}: expected a non-empty string "completed_at"`
      );
    }
    completedAt = marker.completed_at;
  } else {
    mkdirSync(mamaHome, { recursive: true });
    writeFileSync(completionPath, JSON.stringify({ completed_at: completedAt }, null, 2));
    changed = true;
  }

  if (!existsSync(reportPath)) {
    mkdirSync(join(mamaHome, 'state'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ at: completedAt }, null, 2));
    changed = true;
  }

  return changed;
}
