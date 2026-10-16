import { lstatSync, readFileSync } from 'node:fs';

import type {
  AuthConfig,
  ChannelConfig,
  ConnectorConfig,
  ConnectorsConfig,
} from './framework/types.js';
import { LOADABLE_CONNECTORS } from './index.js';
import { SECRET_NAMES, isIcalSecret } from '../cli/secrets.js';

export type ConnectorConfigLoadErrorCode = 'read_error' | 'parse_error' | 'validation_error';

export interface ConnectorConfigLoadError {
  readonly code: ConnectorConfigLoadErrorCode;
  readonly path: string;
  readonly message: string;
}

export type ConnectorConfigLoadResult =
  | {
      readonly ok: true;
      readonly config: ConnectorsConfig;
      readonly enabledNames: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: ConnectorConfigLoadError;
      readonly config: Record<string, never>;
      readonly enabledNames: readonly string[];
    };

const ROLES = new Set<ChannelConfig['role']>([
  'truth',
  'hub',
  'deliverable',
  'spoke',
  'reference',
  'ignore',
]);

class ConfigValidationError extends Error {}

const CONNECTOR_NAMES = new Set<string>(LOADABLE_CONNECTORS);

interface ValidationState {
  readonly ignored: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigValidationError(`${field} must be an object`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigValidationError(`${field} must be nonblank text`);
  }
  return value;
}

function collectIgnoredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  state: ValidationState
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    // Channel ids and names are data, not key names: report the key once, with the id masked.
    const name = `${field.replace(/\.channels\.[^.]+$/, '.channels.*')}.${key}`;
    if (!state.ignored.includes(name)) state.ignored.push(name);
  }
}

function channel(value: unknown, field: string, state: ValidationState): ChannelConfig {
  const raw = record(value, field);
  collectIgnoredKeys(
    raw,
    [
      'role',
      'name',
      'boardId',
      'folderId',
      'driveId',
      'spreadsheetId',
      'sheetRange',
      'dataRange',
      'vaultPath',
      'calendarId',
      'feedName',
    ],
    field,
    state
  );
  if (typeof raw.role !== 'string' || !ROLES.has(raw.role as ChannelConfig['role'])) {
    throw new ConfigValidationError(`${field}.role must be a valid channel role`);
  }
  const result: ChannelConfig = { role: raw.role as ChannelConfig['role'] };
  if (raw.name !== undefined) result.name = text(raw.name, `${field}.name`);
  if (raw.boardId !== undefined) result.boardId = text(raw.boardId, `${field}.boardId`);
  if (raw.folderId !== undefined) result.folderId = text(raw.folderId, `${field}.folderId`);
  if (raw.driveId !== undefined) result.driveId = text(raw.driveId, `${field}.driveId`);
  if (raw.spreadsheetId !== undefined)
    result.spreadsheetId = text(raw.spreadsheetId, `${field}.spreadsheetId`);
  if (raw.sheetRange !== undefined) result.sheetRange = text(raw.sheetRange, `${field}.sheetRange`);
  if (raw.dataRange !== undefined) result.dataRange = text(raw.dataRange, `${field}.dataRange`);
  if (raw.vaultPath !== undefined) result.vaultPath = text(raw.vaultPath, `${field}.vaultPath`);
  if (raw.calendarId !== undefined) result.calendarId = text(raw.calendarId, `${field}.calendarId`);
  if (raw.feedName !== undefined) result.feedName = text(raw.feedName, `${field}.feedName`);
  return result;
}

function channels(
  value: unknown,
  field: string,
  state: ValidationState
): Record<string, ChannelConfig> {
  const raw = record(value, field);
  const result = Object.create(null) as Record<string, ChannelConfig>;
  for (const [key, value] of Object.entries(raw)) {
    result[key] = channel(value, `${field}.${key}`, state);
  }
  return result;
}

function auth(value: unknown, field: string, state: ValidationState): AuthConfig {
  const raw = record(value, field);
  collectIgnoredKeys(raw, ['type', 'tokenName', 'cli', 'cliAuthCommand'], field, state);
  if (raw.type !== 'token' && raw.type !== 'cli' && raw.type !== 'none') {
    throw new ConfigValidationError(`${field}.type must be token, cli or none`);
  }
  const result: AuthConfig = { type: raw.type };
  if (raw.tokenName !== undefined) {
    const name = text(raw.tokenName, `${field}.tokenName`);
    if (!(SECRET_NAMES as readonly string[]).includes(name) && !isIcalSecret(name)) {
      throw new ConfigValidationError(`${field}.tokenName must name a managed MAMA secret`);
    }
    result.tokenName = name;
  }
  if (raw.cli !== undefined) result.cli = text(raw.cli, `${field}.cli`);
  if (raw.cliAuthCommand !== undefined) {
    result.cliAuthCommand = text(raw.cliAuthCommand, `${field}.cliAuthCommand`);
  }
  return result;
}

function connector(value: unknown, field: string, state: ValidationState): ConnectorConfig {
  const raw = record(value, field);
  collectIgnoredKeys(raw, ['enabled', 'pollIntervalMinutes', 'channels', 'auth'], field, state);
  if (typeof raw.enabled !== 'boolean') {
    throw new ConfigValidationError(`${field}.enabled must be boolean`);
  }
  if (
    typeof raw.pollIntervalMinutes !== 'number' ||
    !Number.isFinite(raw.pollIntervalMinutes) ||
    raw.pollIntervalMinutes <= 0
  ) {
    throw new ConfigValidationError(
      `${field}.pollIntervalMinutes must be a finite number greater than zero`
    );
  }
  const configuredChannels = channels(raw.channels, `${field}.channels`, state);
  if (field.toLowerCase().endsWith('.ical')) {
    const names = new Map<string, string>();
    for (const key of Object.keys(configuredChannels)) {
      const envName = `MAMA_ICAL_URL_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      if (!isIcalSecret(envName)) {
        throw new ConfigValidationError(`${field}.channels.${key} cannot form an iCal secret name`);
      }
      const previous = names.get(envName);
      if (previous !== undefined) {
        throw new ConfigValidationError(
          `${field}.channels.${key} and ${previous} map to the same iCal secret name`
        );
      }
      names.set(envName, key);
    }
  }
  return {
    enabled: raw.enabled,
    pollIntervalMinutes: raw.pollIntervalMinutes,
    channels: configuredChannels,
    auth: auth(raw.auth, `${field}.auth`, state),
  };
}

function validate(value: unknown): { config: ConnectorsConfig; ignored: readonly string[] } {
  const raw = record(value, 'connectors');
  const result = Object.create(null) as ConnectorsConfig;
  const ignored: string[] = [];
  const state: ValidationState = { ignored };
  const normalized = new Set<string>();
  let index = 0;
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (!CONNECTOR_NAMES.has(key)) {
      ignored.push(name);
      continue;
    }
    if (normalized.has(key)) {
      throw new ConfigValidationError(`connectors contain a case collision at entry ${index}`);
    }
    normalized.add(key);
    result[key] = connector(value, `connectors.${name}`, state);
    index += 1;
  }
  return { config: result, ignored: Object.freeze(ignored) };
}

function warnIgnored(names: readonly string[]): void {
  if (names.length > 0) console.warn(`ignored in W1: ${names.join(', ')}`);
}

function failure(
  code: ConnectorConfigLoadErrorCode,
  path: string,
  message: string
): ConnectorConfigLoadResult {
  return {
    ok: false,
    error: Object.freeze({ code, path, message }),
    config: Object.freeze(Object.create(null) as Record<string, never>),
    enabledNames: Object.freeze([]),
  };
}

/** `onIgnored` receives the setting names MAMA ignores; the default prints them on stderr. */
export function loadConnectorConfig(
  path: string,
  onIgnored: (names: readonly string[]) => void = warnIgnored
): ConnectorConfigLoadResult {
  if (typeof path !== 'string' || path.trim() === '') {
    return failure(
      'read_error',
      typeof path === 'string' ? path : '',
      'Connector configuration path is required'
    );
  }
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { ok: true, config: Object.create(null), enabledNames: Object.freeze([]) };
    }
    return failure('read_error', path, `Unable to inspect connector configuration at ${path}`);
  }

  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return failure('read_error', path, `Unable to read connector configuration at ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return failure(
      'parse_error',
      path,
      `Connector configuration at ${path} contains malformed JSON`
    );
  }

  try {
    const validated = validate(parsed);
    const config = validated.config;
    onIgnored(validated.ignored);
    return {
      ok: true,
      config,
      enabledNames: Object.freeze(
        Object.entries(config)
          .filter(([, value]) => value.enabled)
          .map(([name]) => name)
      ),
    };
  } catch (error) {
    const message =
      error instanceof ConfigValidationError
        ? error.message
        : 'Connector configuration failed structural validation';
    return failure('validation_error', path, message);
  }
}
