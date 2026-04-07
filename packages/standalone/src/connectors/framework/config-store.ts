/**
 * Shared connectors.json read/write used by both CLI and API handlers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorsConfig } from './types.js';

const CONNECTORS_CONFIG_PATH = join(homedir(), '.mama', 'connectors.json');

export function loadConnectorsConfig(): ConnectorsConfig {
  if (!existsSync(CONNECTORS_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONNECTORS_CONFIG_PATH, 'utf-8')) as ConnectorsConfig;
  } catch {
    return {};
  }
}

export function saveConnectorsConfig(config: ConnectorsConfig): void {
  const dir = join(homedir(), '.mama');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONNECTORS_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
