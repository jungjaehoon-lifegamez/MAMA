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
import { loadConnector } from '../connectors/index.js';
import { loadConnectorConfig } from '../connectors/config-loader.js';
import type { ConnectorConfig } from '../connectors/framework/types.js';
import type { AssessDeps } from './agent-contract.js';
import { DEFAULT_PERSONA_MARKER } from './bootstrap-template.js';

interface CompletionMarker {
  completed_at?: string;
}

interface FirstReportMarker {
  at?: string;
}

export interface CollectAssessOptions {
  connectorProbe?: (name: string, config: ConnectorConfig) => Promise<boolean>;
  connectorProbeTimeoutMs?: number;
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

function loadOnboardingConnectors(mamaHome: string): {
  config: Record<string, ConnectorConfig>;
  enabledNames: readonly string[];
} {
  const path = join(mamaHome, 'connectors.json');
  const result = loadConnectorConfig(path);
  if (!result.ok) {
    throw new Error(
      `Failed to load onboarding connector state ${result.error.path}: ${result.error.message}`
    );
  }
  return { config: result.config, enabledNames: result.enabledNames };
}

async function defaultConnectorProbe(name: string, config: ConnectorConfig): Promise<boolean> {
  const connector = await loadConnector(name, config);
  try {
    await connector.init();
    return await connector.authenticate();
  } finally {
    await connector.dispose();
  }
}

async function probeWithTimeout(
  probe: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void probe().then(
      (ready) => {
        clearTimeout(timer);
        resolve(ready);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      }
    );
  });
}

async function countReadyConnectors(
  config: Record<string, ConnectorConfig>,
  enabledNames: readonly string[],
  options: CollectAssessOptions
): Promise<number> {
  const probe = options.connectorProbe ?? defaultConnectorProbe;
  const timeoutMs = options.connectorProbeTimeoutMs ?? 3_000;
  const results = await Promise.all(
    enabledNames.map(async (name) => {
      const connectorConfig = config[name];
      if (!connectorConfig) {
        return false;
      }
      return await probeWithTimeout(() => probe(name, connectorConfig), timeoutMs);
    })
  );
  return results.filter(Boolean).length;
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

export async function collectAssessDeps(options: CollectAssessOptions = {}): Promise<AssessDeps> {
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
  const connectors = loadOnboardingConnectors(mamaHome);
  return {
    configLoadable: config !== null,
    daemonRunning: Boolean(running),
    telegramConfigured:
      config?.telegram?.enabled === true && Boolean(config.telegram.token?.trim()),
    allowedChats:
      Array.isArray(config?.telegram?.allowed_chats) && config.telegram.allowed_chats.length > 0,
    enabledConnectors: connectors.enabledNames.length,
    readyConnectors: await countReadyConnectors(
      connectors.config,
      connectors.enabledNames,
      options
    ),
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
  const generatedDefaults = ['SOUL.md', 'USER.md'].some((name) =>
    readFileSync(join(mamaHome, name), 'utf8').includes(DEFAULT_PERSONA_MARKER)
  );
  if (generatedDefaults) {
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
