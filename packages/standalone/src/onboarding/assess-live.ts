/**
 * Live observation for the onboarding contract.
 *
 * This module only OBSERVES - config file, marker files, the pid file, the
 * connectors registry. Judgment and wording live in agent-contract.ts. The
 * completion marker is a cache of an observed state, never an authority:
 * status recomputes from observation every time and the marker exists so a
 * completed install can say so without re-deriving history.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { getMAMAHome } from '../cli/config/config-manager.js';
import { isDaemonRunning } from '../cli/utils/pid-manager.js';
import type { AssessDeps } from './agent-contract.js';

interface RawConfigShape {
  telegram?: { token?: string; allowed_chats?: string[] };
  owner?: { name?: string; language?: string; timezone?: string };
}

interface RawConnectorsShape {
  connectors?: Record<string, { enabled?: boolean } | undefined>;
}

function readYamlConfig(home: string): RawConfigShape | null {
  const p = join(home, 'config.yaml');
  if (!existsSync(p)) return null;
  try {
    return (yaml.load(readFileSync(p, 'utf-8')) as RawConfigShape) ?? null;
  } catch {
    // A corrupt config is observed as absent; init/start fail loudly on it at
    // the real boundary - status must not crash while reporting.
    return null;
  }
}

function countEnabledConnectors(home: string): number {
  const p = join(home, 'connectors.json');
  if (!existsSync(p)) return 0;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as RawConnectorsShape;
    const entries = raw.connectors ?? (raw as Record<string, { enabled?: boolean }>);
    return Object.values(entries).filter(
      (c) => c && typeof c === 'object' && c.enabled === true
    ).length;
  } catch {
    return 0;
  }
}

function readFirstReportAt(home: string): string | null {
  const p = join(home, 'state', 'first-report.json');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { at?: string };
    return typeof raw.at === 'string' ? raw.at : null;
  } catch {
    return null;
  }
}

export async function collectAssessDeps(mamaHome?: string): Promise<AssessDeps> {
  const home = mamaHome ?? getMAMAHome();
  const config = readYamlConfig(home);
  const running = mamaHome === undefined ? await isDaemonRunning() : null;
  return {
    mamaHome: home,
    configExists: config !== null || existsSync(join(home, 'config.yaml')),
    daemonRunning: running !== null && running !== undefined && Boolean(running),
    telegramToken: Boolean(config?.telegram?.token?.trim()),
    allowedChats: Array.isArray(config?.telegram?.allowed_chats)
      ? config.telegram.allowed_chats.length > 0
      : false,
    ownerFacts: Boolean(config?.owner?.name?.trim()),
    enabledConnectors: countEnabledConnectors(home),
    firstReportAt: readFirstReportAt(home),
  };
}

/** Idempotent: the first completed_at is preserved forever. */
export async function writeCompletionMarker(mamaHome: string): Promise<void> {
  const p = join(mamaHome, 'setup-complete.json');
  if (existsSync(p)) return;
  mkdirSync(mamaHome, { recursive: true });
  writeFileSync(p, JSON.stringify({ completed_at: new Date().toISOString() }, null, 2));
}

/**
 * A legacy install (persona files present + telegram configured) predates the
 * marker; backfill it so status never tells a working install to onboard.
 */
export function migrateLegacyInstall(mamaHome: string): boolean {
  const markerPath = join(mamaHome, 'setup-complete.json');
  if (existsSync(markerPath)) return false;
  const hasPersonas =
    existsSync(join(mamaHome, 'SOUL.md')) && existsSync(join(mamaHome, 'USER.md'));
  if (!hasPersonas) return false;
  const config = readYamlConfig(mamaHome);
  const telegramConfigured =
    Boolean(config?.telegram?.token?.trim()) &&
    Array.isArray(config?.telegram?.allowed_chats) &&
    (config?.telegram?.allowed_chats?.length ?? 0) > 0;
  if (!telegramConfigured) return false;
  writeFileSync(markerPath, JSON.stringify({ completed_at: new Date().toISOString() }, null, 2));
  return true;
}
