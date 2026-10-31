import type { NormalizedItem } from '../../storage/source-archive.js';

export type { NormalizedItem } from '../../storage/source-archive.js';

export interface ChannelConfig {
  role: 'truth' | 'hub' | 'deliverable' | 'spoke' | 'reference' | 'ignore';
  name?: string;
  boardId?: string;
  folderId?: string;
  driveId?: string;
  spreadsheetId?: string;
  sheetRange?: string;
  dataRange?: string;
  vaultPath?: string;
  calendarId?: string;
  feedName?: string;
}

export interface ConnectorPollCursor {
  hasCursor: boolean;
}

export interface AuthConfig {
  type: 'token' | 'cli' | 'none';
  tokenName?: string;
  cli?: string;
  cliAuthCommand?: string;
}

export interface AuthRequirement extends AuthConfig {
  description: string;
  /**
   * For a `type: 'cli'` requirement, what the tool's login must grant this source (gws: the
   * source's service, whose OAuth scope the tool's `loginScope` names).
   */
  scope?: string;
}

/** A command a source runs (its `type: 'cli'` requirement), how a person installs it, its login. */
export interface SourceTool {
  /** The command's name, as `cli` in the requirement and in connectors.json. */
  readonly command: string;
  /** The arguments after the command that sign it in. */
  readonly loginArgs: string;
  /** The login's flag that takes the scopes the sources need, comma-separated. */
  readonly scopeFlag: string;
  /** What `scopeFlag` takes for a requirement's `scope`. */
  readonly loginScope: (scope: string) => string;
  /** What the login needs first, said before it. */
  readonly beforeLogin: string;
  /** The npm package that installs the command. */
  readonly npmPackage: string;
  /** The Homebrew formula that installs the command. */
  readonly brewFormula: string;
}

/** The `type: 'cli'` requirement that names a tool, as connectors.json and the source carry it. */
export function cliAuth(tool: SourceTool): AuthConfig {
  return {
    type: 'cli',
    cli: tool.command,
    cliAuthCommand: `${tool.command} ${tool.loginArgs}`,
  };
}

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
  beginPollHandoff?(): void;
  poll(since: Date, cursor?: ConnectorPollCursor): Promise<NormalizedItem[]>;
  commitPoll?(): void | Promise<void>;
  abortPollHandoff?(): void;
}

export type ConnectorsConfig = Record<string, ConnectorConfig>;
