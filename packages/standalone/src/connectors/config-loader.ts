import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AuthConfig,
  ChannelConfig,
  ConnectorConfig,
  ConnectorsConfig,
} from './framework/types.js';

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

const CHANNEL_STRING_FIELDS = [
  'name',
  'spreadsheetId',
  'sheetRange',
  'dataRange',
  'boardId',
  'folderId',
  'driveId',
  'vaultPath',
] as const satisfies readonly (keyof ChannelConfig)[];
const CHANNEL_STRING_ARRAY_FIELDS = [
  'keywords',
  'watchPatterns',
] as const satisfies readonly (keyof ChannelConfig)[];
const CHANNEL_ROLES = new Set<ChannelConfig['role']>([
  'truth',
  'hub',
  'deliverable',
  'spoke',
  'reference',
  'ignore',
]);
const AUTH_STRING_FIELDS = [
  'cli',
  'cliAuthCommand',
  'tokenName',
  'token',
] as const satisfies readonly (keyof AuthConfig)[];
const AUTH_TYPES = new Set<AuthConfig['type']>(['cli', 'token', 'none']);

class ConfigValidationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(
  value: unknown,
  field: string
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ConfigValidationError(`${field} must be a plain object`);
  }
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigValidationError(`${field} must be an array of strings`);
  }
  return [...value];
}

function validateChannel(value: unknown, field: string): ChannelConfig {
  assertPlainObject(value, field);

  if (typeof value.role !== 'string' || !CHANNEL_ROLES.has(value.role as ChannelConfig['role'])) {
    throw new ConfigValidationError(`${field}.role must be a valid channel role`);
  }

  const channel: ChannelConfig = { role: value.role as ChannelConfig['role'] };
  if (value.project_entity_id !== undefined) {
    if (value.project_entity_id !== null && typeof value.project_entity_id !== 'string') {
      throw new ConfigValidationError(`${field}.project_entity_id must be a string or null`);
    }
    channel.project_entity_id = value.project_entity_id;
  }
  for (const optionalField of CHANNEL_STRING_FIELDS) {
    const optionalValue = value[optionalField];
    if (optionalValue === undefined) {
      continue;
    }
    if (typeof optionalValue !== 'string') {
      throw new ConfigValidationError(`${field}.${optionalField} must be a string`);
    }
    channel[optionalField] = optionalValue;
  }
  for (const optionalField of CHANNEL_STRING_ARRAY_FIELDS) {
    const optionalValue = value[optionalField];
    if (optionalValue !== undefined) {
      channel[optionalField] = validateStringArray(optionalValue, `${field}.${optionalField}`);
    }
  }
  return channel;
}

function validateChannels(value: unknown, field: string): Record<string, ChannelConfig> {
  assertPlainObject(value, field);
  const channels = Object.create(null) as Record<string, ChannelConfig>;
  let channelIndex = 0;
  for (const [channelName, channelValue] of Object.entries(value)) {
    channels[channelName] = validateChannel(channelValue, `${field}[${channelIndex}]`);
    channelIndex += 1;
  }
  return channels;
}

function validateAuth(value: unknown, field: string): AuthConfig {
  assertPlainObject(value, field);

  if (typeof value.type !== 'string' || !AUTH_TYPES.has(value.type as AuthConfig['type'])) {
    throw new ConfigValidationError(`${field}.type must be one of cli, token, or none`);
  }

  const auth: AuthConfig = { type: value.type as AuthConfig['type'] };
  for (const optionalField of AUTH_STRING_FIELDS) {
    const optionalValue = value[optionalField];
    if (optionalValue === undefined) {
      continue;
    }
    if (typeof optionalValue !== 'string') {
      throw new ConfigValidationError(`${field}.${optionalField} must be a string`);
    }
    auth[optionalField] = optionalValue;
  }
  return auth;
}

function validateConnector(value: unknown, field: string): ConnectorConfig {
  assertPlainObject(value, field);

  if (typeof value.enabled !== 'boolean') {
    throw new ConfigValidationError(`${field}.enabled must be a boolean`);
  }
  if (
    typeof value.pollIntervalMinutes !== 'number' ||
    !Number.isFinite(value.pollIntervalMinutes) ||
    value.pollIntervalMinutes <= 0
  ) {
    throw new ConfigValidationError(
      `${field}.pollIntervalMinutes must be a finite number greater than zero`
    );
  }

  return {
    enabled: value.enabled,
    pollIntervalMinutes: value.pollIntervalMinutes,
    channels: validateChannels(value.channels, `${field}.channels`),
    auth: validateAuth(value.auth, `${field}.auth`),
  };
}

function validateConfig(value: unknown): ConnectorsConfig {
  assertPlainObject(value, 'connectors');
  const config = Object.create(null) as ConnectorsConfig;
  const sourceNameByNormalizedName = new Map<string, string>();

  let connectorIndex = 0;
  for (const [sourceName, connectorValue] of Object.entries(value)) {
    const normalizedName = sourceName.toLowerCase();
    const collidingName = sourceNameByNormalizedName.get(normalizedName);
    if (collidingName !== undefined) {
      throw new ConfigValidationError(
        `connectors contain a key normalization collision at entry ${connectorIndex}`
      );
    }
    sourceNameByNormalizedName.set(normalizedName, sourceName);
    config[normalizedName] = validateConnector(connectorValue, `connectors[${connectorIndex}]`);
    connectorIndex += 1;
  }

  return config;
}

function failure(
  code: ConnectorConfigLoadErrorCode,
  path: string,
  message: string
): ConnectorConfigLoadResult {
  return {
    ok: false,
    error: Object.freeze({ code, path, message }),
    config: frozenEmptyConfig(),
    enabledNames: Object.freeze([]),
  };
}

function frozenEmptyConfig(): Record<string, never> {
  return Object.freeze(Object.create(null) as Record<string, never>);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

/**
 * Read and strictly validate the connector configuration used by all runtime bootstraps.
 * Missing configuration is an expected empty state; every other failure is explicit and
 * fail-closed. Error details intentionally never include configuration values.
 */
export function loadConnectorConfig(
  path = join(homedir(), '.mama', 'connectors.json')
): ConnectorConfigLoadResult {
  try {
    lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { ok: true, config: frozenEmptyConfig(), enabledNames: Object.freeze([]) };
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
    const config = validateConfig(parsed);
    const enabledNames = Object.freeze(
      Object.entries(config)
        .filter(([, connector]) => connector.enabled)
        .map(([name]) => name)
    );
    return { ok: true, config, enabledNames };
  } catch (error) {
    const message =
      error instanceof ConfigValidationError
        ? error.message
        : 'Connector configuration failed structural validation';
    return failure('validation_error', path, message);
  }
}
