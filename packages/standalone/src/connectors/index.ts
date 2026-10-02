import type { ConnectorConfig, IConnector } from './framework/types.js';
import type { TimeZoneSetting } from '../runtime/timezone.js';

export * from './framework/index.js';

export const LOADABLE_CONNECTORS = [
  'chatwork',
  'slack',
  'trello',
  'kagemusha',
  'calendar',
  'ical',
  'gmail',
  'drive',
  'sheets',
  'notion',
  'obsidian',
  'discord',
  'telegram',
  'imessage',
  'claude-code',
] as const;

export type LoadableConnector = (typeof LOADABLE_CONNECTORS)[number];

export interface ConnectorLoadPaths {
  kagemushaDbPath?: string;
  connectorStatePath?: string;
  imessageDbPath?: string;
  claudeCodeProjectsPath?: string;
  timeZone?: TimeZoneSetting;
}

const loaders: Record<
  LoadableConnector,
  (config: ConnectorConfig, paths?: ConnectorLoadPaths) => Promise<IConnector>
> = {
  chatwork: async (config) => new (await import('./chatwork/index.js')).ChatworkConnector(config),
  slack: async (config) => new (await import('./slack/index.js')).SlackConnector(config),
  calendar: async (config, paths) => {
    if (paths?.connectorStatePath === undefined)
      throw new Error('Calendar connector state path is not configured');
    return new (await import('./calendar/index.js')).CalendarConnector(
      config,
      paths.connectorStatePath
    );
  },
  ical: async (config, paths) => {
    if (paths?.connectorStatePath === undefined)
      throw new Error('iCal connector state path is not configured');
    if (paths.timeZone === undefined) throw new Error('iCal timezone setting is not configured');
    return new (await import('./ical/index.js')).ICalConnector(
      config,
      paths.connectorStatePath,
      paths.timeZone
    );
  },
  gmail: async (config) => new (await import('./gmail/index.js')).GmailConnector(config),
  drive: async (config, paths) => {
    if (paths?.connectorStatePath === undefined)
      throw new Error('Drive connector state file path is required');
    return new (await import('./drive/index.js')).DriveConnector(config, paths.connectorStatePath);
  },
  sheets: async (config, paths) => {
    if (paths?.connectorStatePath === undefined)
      throw new Error('Sheets connector state file path is required');
    return new (await import('./sheets/index.js')).SheetsConnector(
      config,
      paths.connectorStatePath
    );
  },
  notion: async (config) => new (await import('./notion/index.js')).NotionConnector(config),
  obsidian: async (config) => new (await import('./obsidian/index.js')).ObsidianConnector(config),
  discord: async (config, paths) => {
    if (paths?.connectorStatePath === undefined)
      throw new Error('Discord connector state file path is required');
    return new (await import('./discord/index.js')).DiscordConnector(
      config,
      paths.connectorStatePath
    );
  },
  telegram: async (config, paths) => {
    if (paths?.connectorStatePath === undefined)
      throw new Error('Telegram connector state file path is required');
    return new (await import('./telegram/index.js')).TelegramConnector(
      config,
      paths.connectorStatePath
    );
  },
  imessage: async (config, paths) =>
    new (await import('./imessage/index.js')).IMessageConnector(config, paths?.imessageDbPath),
  'claude-code': async (config, paths) =>
    new (await import('./claude-code/index.js')).ClaudeCodeConnector(
      config,
      paths?.claudeCodeProjectsPath
    ),
  trello: async (config) => new (await import('./trello/index.js')).TrelloConnector(config),
  kagemusha: async (config, paths) => {
    if (paths?.kagemushaDbPath === undefined)
      throw new Error('Kagemusha source database path is required');
    return new (await import('./kagemusha/index.js')).KagemushaConnector(
      config,
      paths.kagemushaDbPath
    );
  },
};

/**
 * Dynamic connector loader — avoids importing all connector deps at startup.
 * Optionally accepts a ConnectorConfig; if omitted, a minimal disabled config is used
 * (useful for CLI introspection like healthCheck or getAuthRequirements).
 */
export async function loadConnector(
  name: string,
  config?: ConnectorConfig,
  paths?: ConnectorLoadPaths
): Promise<IConnector> {
  if (!(LOADABLE_CONNECTORS as readonly string[]).includes(name)) {
    throw new Error(`Unsupported connector: ${name}`);
  }
  const effectiveConfig: ConnectorConfig = config ?? {
    enabled: false,
    pollIntervalMinutes: 5,
    channels: {},
    auth: { type: 'none' },
  };

  return loaders[name as LoadableConnector](effectiveConfig, paths);
}
