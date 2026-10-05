import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as yaml from 'js-yaml';

export type RuntimeBackend = 'claude' | 'codex';
export type RuntimeEffort = 'low' | 'medium' | 'high' | 'max' | 'xhigh';
export type RuntimeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface W1AgentConfig {
  backend: RuntimeBackend;
  model: string;
  effort: RuntimeEffort;
  max_turns: number;
  /** How long a turn may go without progress, in ms; progress restarts it. */
  timeout: number;
  /** The longest one turn may run in all, in ms. */
  max_turn_ms: number;
  run_token_budget: number;
  codex_home?: string;
  codex_cwd?: string;
  codex_sandbox?: RuntimeSandbox;
  tools?: { mcp_config?: string };
}

export interface W1TelegramConfig {
  enabled: boolean;
  owner_chat_id?: string;
  allowed_chats: string[];
  owner_user_ids: string[];
  polling: boolean;
  /** Whether the owner agent may send files through Telegram; on unless turned off. */
  file_delivery: boolean;
}

export interface W1MessengerConfig {
  enabled: boolean;
  owner_channel_id?: string;
  allowed_channels: string[];
  owner_user_ids: string[];
  /** Whether the owner agent may send files through this messenger; on unless turned off. */
  file_delivery: boolean;
}
export type MessengerName = 'telegram' | 'discord' | 'slack';
/** Who may read a file delivered to Drive: a Workspace domain, a Google group or one account. */
export type DriveReader = { domain: string } | { group: string } | { user: string };

/** Large files go to a Drive folder the owner names, readable by the readers the owner names. */
export interface W1DriveDeliveryConfig {
  folder: string;
  readers: DriveReader[];
}

export interface W1DeliveryConfig {
  reports: MessengerName;
  notifications: MessengerName;
  security_alerts: MessengerName;
  drive?: W1DriveDeliveryConfig;
  /** What the owner is told when a turn on their message was cut off, in the owner's words. */
  interrupted_notice?: string;
}

export interface W1WikiConfig {
  enabled: boolean;
  vaultPath?: string;
  wikiDir?: string;
}

export interface W1JevConfig {
  /** The owner's choice to let the agent call judge; everything works without it. */
  enabled: boolean;
  keyFile: string;
  vocabFile: string;
}

export interface W1ReportsConfig {
  full_report_hours: number[];
  reminder_start_hour: number;
  reminder_end_hour: number;
  /** The hour the day's daily wiki page is written; used only with the wiki enabled. */
  daily_hour: number;
}

export interface W1Config {
  version: 1;
  timezone: string;
  agent: W1AgentConfig;
  database: { path: string };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; file: string };
  telegram: W1TelegramConfig;
  discord?: W1MessengerConfig;
  slack?: W1MessengerConfig;
  delivery?: W1DeliveryConfig;
  jev: W1JevConfig;
  reports: W1ReportsConfig;
  wiki?: W1WikiConfig;
}

export interface LoadConfigOptions {
  path?: string;
  configPath?: string;
  home?: string;
}

export interface ParseConfigOptions {
  home?: string;
}

interface ParseState {
  readonly ignored: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CONFIG_KEYS = [
  'version',
  'timezone',
  'agent',
  'database',
  'logging',
  'telegram',
  'discord',
  'slack',
  'delivery',
  'jev',
  'wiki',
  'reports',
] as const;
const AGENT_KEYS = [
  'backend',
  'model',
  'effort',
  'max_turns',
  'timeout',
  'max_turn_ms',
  'run_token_budget',
  'codex_home',
  'codex_cwd',
  'codex_sandbox',
  'tools',
] as const;

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function collectIgnoredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  state: ParseState
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) state.ignored.push(path === '' ? key : `${path}.${key}`);
  }
}

function warnIgnored(names: readonly string[]): void {
  if (names.length > 0) console.warn(`ignored in W1: ${names.join(', ')}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${path} must be nonblank text`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ConfigError(`${path} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function reportHour(value: unknown, path: string): number {
  const hour = integer(value, path);
  if (hour > 23) throw new ConfigError(`${path} must be an hour from 0 to 23`);
  return hour;
}

function parseReports(value: unknown, state: ParseState): W1ReportsConfig {
  const raw = value === undefined ? {} : object(value, 'reports');
  collectIgnoredKeys(
    raw,
    ['full_report_hours', 'reminder_start_hour', 'reminder_end_hour', 'daily_hour'],
    'reports',
    state
  );
  const hours = raw.full_report_hours === undefined ? [8, 13, 18] : raw.full_report_hours;
  if (!Array.isArray(hours)) throw new ConfigError('reports.full_report_hours must be an array');
  const reports = {
    full_report_hours: hours.map((hour, index) =>
      reportHour(hour, `reports.full_report_hours[${index}]`)
    ),
    reminder_start_hour: reportHour(
      raw.reminder_start_hour === undefined ? 9 : raw.reminder_start_hour,
      'reports.reminder_start_hour'
    ),
    reminder_end_hour: reportHour(
      raw.reminder_end_hour === undefined ? 21 : raw.reminder_end_hour,
      'reports.reminder_end_hour'
    ),
    daily_hour: reportHour(
      raw.daily_hour === undefined ? 23 : raw.daily_hour,
      'reports.daily_hour'
    ),
  };
  if (reports.reminder_start_hour > reports.reminder_end_hour) {
    throw new ConfigError('reports.reminder_start_hour must be <= reports.reminder_end_hour');
  }
  return reports;
}

function stringList(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array of strings`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function wikiPath(value: string, home: string): string {
  const expanded =
    value === '~'
      ? home
      : value.startsWith('~/')
        ? join(home, value.slice(2))
        : value.replace(/^\$\{HOME\}(?=\/|$)/, home);
  return isAbsolute(expanded) ? expanded : value;
}

function configPath(value: string, home: string): string {
  const expanded =
    value === '~'
      ? home
      : value.startsWith('~/')
        ? join(home, value.slice(2))
        : value.replace(/^\$\{HOME\}(?=\/|$)/, home);
  return isAbsolute(expanded) ? expanded : resolve(home, expanded);
}

function parseAgent(value: unknown, home: string, state: ParseState): W1AgentConfig {
  const raw = object(value, 'agent');
  collectIgnoredKeys(raw, AGENT_KEYS, 'agent', state);
  const backend = text(raw.backend, 'agent.backend');
  if (backend !== 'claude' && backend !== 'codex') {
    throw new ConfigError('agent.backend must be claude or codex');
  }
  const effort = (raw.effort ?? 'medium') as string;
  if (!['low', 'medium', 'high', 'max', 'xhigh'].includes(effort)) {
    throw new ConfigError('agent.effort is not a supported effort level');
  }
  const sandbox = raw.codex_sandbox;
  if (
    sandbox !== undefined &&
    !['read-only', 'workspace-write', 'danger-full-access'].includes(String(sandbox))
  ) {
    throw new ConfigError('agent.codex_sandbox is not a supported sandbox');
  }
  let tools: W1AgentConfig['tools'];
  if (raw.tools !== undefined) {
    const toolConfig = object(raw.tools, 'agent.tools');
    collectIgnoredKeys(toolConfig, ['mcp_config'], 'agent.tools', state);
    tools = {
      ...(toolConfig.mcp_config === undefined
        ? {}
        : { mcp_config: configPath(text(toolConfig.mcp_config, 'agent.tools.mcp_config'), home) }),
    };
  }
  const codexHome = optionalText(raw.codex_home, 'agent.codex_home');
  const codexCwd = optionalText(raw.codex_cwd, 'agent.codex_cwd');
  return {
    backend: backend as RuntimeBackend,
    model: text(raw.model, 'agent.model'),
    effort: effort as RuntimeEffort,
    max_turns: integer(raw.max_turns, 'agent.max_turns', 1),
    timeout: integer(raw.timeout, 'agent.timeout', 1),
    // A turn that keeps working runs on; this caps its cost while run_token_budget is off
    // (owner, 2026-10-03: the longest owner turn so far took 645 s).
    max_turn_ms: integer(raw.max_turn_ms ?? 3_600_000, 'agent.max_turn_ms', 1),
    run_token_budget: integer(raw.run_token_budget ?? 0, 'agent.run_token_budget'),
    ...(codexHome === undefined ? {} : { codex_home: configPath(codexHome, home) }),
    ...(codexCwd === undefined ? {} : { codex_cwd: configPath(codexCwd, home) }),
    ...(sandbox === undefined ? {} : { codex_sandbox: sandbox as RuntimeSandbox }),
    ...(tools === undefined ? {} : { tools }),
  };
}

function deriveTelegramOwnerIds(
  telegramRaw: Record<string, unknown>,
  allowedChats: readonly string[]
): string[] {
  if (telegramRaw.owner_user_ids !== undefined) {
    return Array.from(
      new Set(
        stringList(telegramRaw.owner_user_ids, 'telegram.owner_user_ids').map((id) => id.trim())
      )
    );
  }

  const normalizedAllowedChatIds = Array.from(new Set(allowedChats.map((chatId) => chatId.trim())));
  const positiveAllowedChatIds = normalizedAllowedChatIds.filter((chatId) =>
    /^[1-9]\d*$/.test(chatId)
  );
  const [onlyOwnerId] = positiveAllowedChatIds;
  return onlyOwnerId === undefined ? [] : positiveAllowedChatIds.length === 1 ? [onlyOwnerId] : [];
}

function parseMessenger(
  value: unknown,
  name: 'discord' | 'slack',
  state: ParseState
): W1MessengerConfig {
  const raw = value === undefined ? {} : object(value, name);
  collectIgnoredKeys(
    raw,
    ['enabled', 'owner_channel_id', 'allowed_channels', 'owner_user_ids', 'file_delivery'],
    name,
    state
  );
  if (typeof (raw.enabled ?? false) !== 'boolean')
    throw new ConfigError(`${name}.enabled must be boolean`);
  const enabled = (raw.enabled ?? false) as boolean;
  const allowedChannels = stringList(raw.allowed_channels, `${name}.allowed_channels`);
  const ownerChannelId = optionalText(raw.owner_channel_id, `${name}.owner_channel_id`);
  const ownerUserIds = stringList(raw.owner_user_ids, `${name}.owner_user_ids`);
  if (enabled && ownerChannelId === undefined)
    throw new ConfigError(`${name}.owner_channel_id is required when ${name}.enabled is true`);
  if (enabled && allowedChannels.length === 0)
    throw new ConfigError(`${name}.allowed_channels is required when ${name}.enabled is true`);
  if (ownerChannelId !== undefined && !allowedChannels.includes(ownerChannelId)) {
    throw new ConfigError(`${name}.owner_channel_id must be listed in ${name}.allowed_channels`);
  }
  if (enabled && ownerUserIds.length === 0)
    throw new ConfigError(`${name}.owner_user_ids is required when ${name}.enabled is true`);
  return {
    enabled,
    ...(ownerChannelId === undefined ? {} : { owner_channel_id: ownerChannelId }),
    allowed_channels: allowedChannels,
    owner_user_ids: Array.from(new Set(ownerUserIds.map((id) => id.trim()))),
    file_delivery: fileDelivery(raw, name),
  };
}

function fileDelivery(raw: Record<string, unknown>, name: MessengerName): boolean {
  const value = raw.file_delivery ?? true;
  if (typeof value !== 'boolean') throw new ConfigError(`${name}.file_delivery must be boolean`);
  return value;
}

/** Messengers the owner agent may send files through: enabled, with file delivery on. */
export function fileDeliveryMessengers(
  config: Pick<W1Config, 'telegram' | 'discord' | 'slack'>
): MessengerName[] {
  return (['telegram', 'discord', 'slack'] as const).filter((name) => {
    const messenger = config[name];
    return messenger !== undefined && messenger.enabled && messenger.file_delivery;
  });
}

function parseDelivery(value: unknown, state: ParseState): W1DeliveryConfig {
  const raw = value === undefined ? {} : object(value, 'delivery');
  collectIgnoredKeys(
    raw,
    ['reports', 'notifications', 'security_alerts', 'interrupted_notice', 'drive'],
    'delivery',
    state
  );
  const route = (key: 'reports' | 'notifications' | 'security_alerts'): MessengerName => {
    const selected = raw[key] ?? 'telegram';
    if (selected !== 'telegram' && selected !== 'discord' && selected !== 'slack') {
      throw new ConfigError(`delivery.${key} must be telegram, discord, or slack`);
    }
    return selected;
  };
  const notice = raw.interrupted_notice;
  if (notice !== undefined && (typeof notice !== 'string' || notice.trim() === '')) {
    throw new ConfigError('delivery.interrupted_notice must be nonblank text');
  }
  return {
    reports: route('reports'),
    notifications: route('notifications'),
    security_alerts: route('security_alerts'),
    ...(notice === undefined ? {} : { interrupted_notice: notice }),
    ...(raw.drive === undefined ? {} : { drive: parseDriveDelivery(raw.drive, state) }),
  };
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
const DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseDriveDelivery(value: unknown, state: ParseState): W1DriveDeliveryConfig {
  const raw = object(value, 'delivery.drive');
  collectIgnoredKeys(raw, ['folder', 'readers'], 'delivery.drive', state);
  const folder = text(raw.folder, 'delivery.drive.folder');
  if (!DRIVE_ID.test(folder))
    throw new ConfigError('delivery.drive.folder must be a Drive folder id');
  if (!Array.isArray(raw.readers) || raw.readers.length === 0) {
    throw new ConfigError('delivery.drive.readers must list at least one reader');
  }
  const readers = raw.readers.map((entry, index): DriveReader => {
    const field = `delivery.drive.readers[${index}]`;
    const reader = object(entry, field);
    const keys = Object.keys(reader);
    if (keys.length !== 1 || !['domain', 'group', 'user'].includes(keys[0]!)) {
      throw new ConfigError(`${field} must have exactly one of domain, group or user`);
    }
    const kind = keys[0] as 'domain' | 'group' | 'user';
    const target = text(reader[kind], `${field}.${kind}`);
    if (kind === 'domain' ? !DOMAIN.test(target) : !EMAIL.test(target)) {
      throw new ConfigError(
        `${field}.${kind} must be ${kind === 'domain' ? 'a domain name' : 'an email address'}`
      );
    }
    return { [kind]: target } as DriveReader;
  });
  return { folder, readers };
}

function parseConfigValue(
  value: unknown,
  options: ParseConfigOptions = {}
): { config: W1Config; ignored: readonly string[] } {
  const home = options.home ?? homedir();
  const state: ParseState = { ignored: [] };
  const raw = object(value, 'config');
  collectIgnoredKeys(raw, CONFIG_KEYS, '', state);
  if (raw.version !== 1) throw new ConfigError('version must be 1');
  const timezone = text(
    raw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    'timezone'
  );
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new ConfigError(`timezone "${timezone}" is not a valid IANA time zone`);
  }
  const database = object(raw.database, 'database');
  collectIgnoredKeys(database, ['path'], 'database', state);
  const logging = object(raw.logging, 'logging');
  collectIgnoredKeys(logging, ['level', 'file'], 'logging', state);
  const level = text(logging.level, 'logging.level');
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new ConfigError('logging.level is not supported');
  }
  const telegramRaw = raw.telegram === undefined ? {} : object(raw.telegram, 'telegram');
  if (Object.hasOwn(telegramRaw, 'token')) {
    throw new ConfigError('run mama secret set MAMA_TELEGRAM_TOKEN and remove telegram.token');
  }
  collectIgnoredKeys(
    telegramRaw,
    ['enabled', 'owner_chat_id', 'allowed_chats', 'owner_user_ids', 'polling', 'file_delivery'],
    'telegram',
    state
  );
  if (typeof (telegramRaw.enabled ?? false) !== 'boolean') {
    throw new ConfigError('telegram.enabled must be boolean');
  }
  const telegramEnabled = (telegramRaw.enabled ?? false) as boolean;
  if (telegramRaw.polling !== undefined && typeof telegramRaw.polling !== 'boolean') {
    throw new ConfigError('telegram.polling must be boolean');
  }
  const allowedChats = stringList(telegramRaw.allowed_chats, 'telegram.allowed_chats');
  const ownerChatId = optionalText(telegramRaw.owner_chat_id, 'telegram.owner_chat_id');
  if (telegramEnabled && ownerChatId === undefined) {
    throw new ConfigError('telegram.owner_chat_id is required when telegram.enabled is true');
  }
  if (ownerChatId !== undefined && !allowedChats.includes(ownerChatId)) {
    throw new ConfigError('telegram.owner_chat_id must be listed in telegram.allowed_chats');
  }
  const jevRaw = raw.jev === undefined ? {} : object(raw.jev, 'jev');
  collectIgnoredKeys(jevRaw, ['enabled', 'keyFile', 'vocabFile'], 'jev', state);
  if (typeof (jevRaw.enabled ?? false) !== 'boolean') {
    throw new ConfigError('jev.enabled must be boolean');
  }
  const jev: W1JevConfig = {
    enabled: (jevRaw.enabled ?? false) as boolean,
    keyFile: configPath(
      text(jevRaw.keyFile ?? join(home, '.mama', 'jev-key'), 'jev.keyFile'),
      home
    ),
    vocabFile: configPath(
      text(jevRaw.vocabFile ?? join(home, '.mama', 'backfill', 'vocab.json'), 'jev.vocabFile'),
      home
    ),
  };
  const wikiRaw = raw.wiki === undefined ? undefined : object(raw.wiki, 'wiki');
  if (wikiRaw !== undefined)
    collectIgnoredKeys(wikiRaw, ['enabled', 'vaultPath', 'wikiDir'], 'wiki', state);
  let wiki: W1WikiConfig | undefined;
  if (wikiRaw !== undefined) {
    if (typeof (wikiRaw.enabled ?? false) !== 'boolean') {
      throw new ConfigError('wiki.enabled must be boolean');
    }
    const enabled = (wikiRaw.enabled ?? false) as boolean;
    const vaultPath = optionalText(wikiRaw.vaultPath, 'wiki.vaultPath');
    const rawWikiDir = optionalText(wikiRaw.wikiDir, 'wiki.wikiDir');
    if (enabled && (vaultPath === undefined || rawWikiDir === undefined)) {
      throw new ConfigError('enabled wiki requires wiki.vaultPath and wiki.wikiDir');
    }
    wiki = {
      enabled,
      ...(vaultPath === undefined ? {} : { vaultPath: configPath(vaultPath, home) }),
      ...(rawWikiDir === undefined ? {} : { wikiDir: wikiPath(rawWikiDir, home) }),
    };
  }
  return {
    config: {
      version: 1,
      timezone,
      agent: parseAgent(raw.agent, home, state),
      database: { path: configPath(text(database.path, 'database.path'), home) },
      logging: {
        level: level as W1Config['logging']['level'],
        file: configPath(text(logging.file, 'logging.file'), home),
      },
      telegram: {
        enabled: telegramEnabled,
        ...(ownerChatId === undefined ? {} : { owner_chat_id: ownerChatId }),
        allowed_chats: allowedChats,
        owner_user_ids: deriveTelegramOwnerIds(telegramRaw, allowedChats),
        // Absent means the daemon polls, as in the archive gateway (`polling !== false`);
        // only an explicit `false` hands inbound polling to another instance.
        polling: (telegramRaw.polling ?? true) as boolean,
        file_delivery: fileDelivery(telegramRaw, 'telegram'),
      },
      discord: parseMessenger(raw.discord, 'discord', state),
      slack: parseMessenger(raw.slack, 'slack', state),
      delivery: parseDelivery(raw.delivery, state),
      jev,
      reports: parseReports(raw.reports, state),
      ...(wiki === undefined ? {} : { wiki }),
    },
    ignored: Object.freeze(state.ignored),
  };
}

export function parseConfig(value: unknown, options: ParseConfigOptions = {}): W1Config {
  return parseConfigValue(value, options).config;
}

export function defaultConfigPath(home = homedir()): string {
  return join(home, '.mama', 'config.yaml');
}

export function loadConfig(options: LoadConfigOptions = {}): W1Config {
  const path = options.path ?? options.configPath ?? defaultConfigPath(options.home);
  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(path, 'utf8'));
  } catch {
    // YAML parser messages contain source snippets, which can include obsolete inline secrets.
    throw new ConfigError(`Cannot load config ${path}: check file access and YAML syntax`);
  }
  const loaded = parseConfigValue(parsed, { home: options.home });
  warnIgnored(loaded.ignored);
  return loaded.config;
}
