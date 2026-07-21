/**
 * Core types for the Connector Framework.
 * All connectors implement IConnector and produce NormalizedItem records.
 */

export interface NormalizedItem {
  source: string;
  sourceId: string;
  channel: string;
  author: string;
  content: string;
  timestamp: Date;
  contentHash?: string;
  sourceCursor?: string;
  tenantId?: string;
  projectId?: string;
  memoryScopeKind?: string;
  memoryScopeId?: string;
  type:
    | 'message'
    | 'email'
    | 'event'
    | 'document'
    | 'note'
    | 'spreadsheet_row'
    | 'kanban_card'
    | 'file_change';
  metadata?: Record<string, unknown>;
}

export interface ChannelConfig {
  role: 'truth' | 'hub' | 'deliverable' | 'spoke' | 'reference' | 'ignore';
  /** Authoritative project scope binding for connector evidence; null means unbound. */
  project_entity_id?: string | null;
  name?: string;
  keywords?: string[];
  /** Truth: spreadsheet ID for Sheets connector */
  spreadsheetId?: string;
  /** Truth: header range (e.g., "Sheet!A1:Z1") */
  sheetRange?: string;
  /** Truth: data range separate from header (e.g., "Sheet!A100:Z200") */
  dataRange?: string;
  /** Truth: Trello board ID */
  boardId?: string;
  /** Deliverable: Drive folder ID */
  folderId?: string;
  /** Deliverable: Shared Drive (Team Drive) ID */
  driveId?: string;
  /** Spoke: Obsidian vault path */
  vaultPath?: string;
  /** Spoke: file watch patterns */
  watchPatterns?: string[];
}

export interface AuthConfig {
  type: 'cli' | 'token' | 'none';
  cli?: string;
  cliAuthCommand?: string;
  tokenName?: string;
  token?: string;
}

export interface AuthRequirement {
  type: 'cli' | 'token' | 'none';
  cli?: string;
  cliAuthCommand?: string;
  tokenName?: string;
  description: string;
}

/**
 * Connector auth resolution (the ONLY implemented path):
 *   config.auth.token ?? process.env[config.auth.tokenName ?? '<CONNECTOR>_TOKEN']
 * Fields like `envFile` or `apiKeyName` found in older configs are NOT read by
 * any connector -- put credentials in the daemon environment (e.g. sourced
 * from ~/.mama/auth.env by start.sh) and point tokenName at them. Trello wants
 * one variable in "apiKey:token" format.
 */
export interface ConnectorConfig {
  enabled: boolean;
  pollIntervalMinutes: number;
  channels: Record<string, ChannelConfig>;
  auth: AuthConfig;
}

export interface ConnectorHealth {
  healthy: boolean;
  lastPollTime: Date | null;
  lastPollCount: number;
  error?: string;
}

export interface IConnector {
  name: string;
  type: 'api' | 'local';
  init(): Promise<void>;
  dispose(): Promise<void>;
  healthCheck(): Promise<ConnectorHealth>;
  getAuthRequirements(): AuthRequirement[];
  authenticate(): Promise<boolean>;
  poll(since: Date): Promise<NormalizedItem[]>;
}

export type ConnectorsConfig = Record<string, ConnectorConfig>;
