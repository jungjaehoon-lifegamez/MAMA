/**
 * DriveConnector — polls Google Drive changes via the gws CLI tool.
 * Uses child_process.execSync to call gws CLI commands.
 * Emits file_change NormalizedItems for files modified in configured folders.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { execGws } from '../framework/gws-utils.js';

interface DriveFile {
  name: string;
  mimeType: string;
  modifiedTime: string;
  lastModifyingUser?: {
    displayName: string;
  };
  parents?: string[];
}

interface DriveChange {
  fileId: string;
  time: string;
  removed?: boolean;
  file?: DriveFile;
}

interface DriveChangeList {
  changes: DriveChange[];
  newStartPageToken?: string;
}

interface StartPageTokenResult {
  startPageToken: string;
}

export class DriveConnector implements IConnector {
  readonly name = 'drive';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  /** Stored page tokens per poll session (single global token for Drive changes API) */
  private pageTokens: Map<string, string> = new Map();

  private readonly stateFilePath = join(homedir(), '.mama', 'connectors', 'drive', 'drive-state.json');

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    try {
      execSync('gws --version', { stdio: 'pipe' });
    } catch {
      throw new Error('gws CLI not found. Install it and run: gws auth login');
    }
    this.loadState();
  }

  private loadState(): void {
    if (existsSync(this.stateFilePath)) {
      try {
        const data = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'));
        for (const [k, v] of Object.entries(data.pageTokens ?? {})) {
          this.pageTokens.set(k, v as string);
        }
      } catch { /* ignore corrupt state */ }
    }
  }

  private saveState(): void {
    const dir = join(homedir(), '.mama', 'connectors', 'drive');
    mkdirSync(dir, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of this.pageTokens) obj[k] = v;
    writeFileSync(this.stateFilePath, JSON.stringify({ pageTokens: obj }));
  }

  async dispose(): Promise<void> {
    this.pageTokens.clear();
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'cli',
        cli: 'gws',
        cliAuthCommand: 'gws auth login',
        description: 'Google Workspace CLI authentication. Run: gws auth login',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      execSync('gws auth status', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find which channel config matches based on a file's parent folder IDs.
   * Returns [channelKey, channelName] or null if no match.
   */
  private findChannelByParent(parents: string[]): [string, string] | null {
    for (const [channelKey, channelCfg] of Object.entries(this.config.channels)) {
      if (channelCfg.role === 'ignore') continue;
      if (!channelCfg.folderId) continue;
      if (parents.includes(channelCfg.folderId)) {
        return [channelKey, channelCfg.name ?? channelKey];
      }
    }
    return null;
  }

  /**
   * Get shared drive IDs from channel configs.
   * Channels with a driveId property are treated as shared drive sources.
   */
  private getSharedDriveIds(): Array<{ driveId: string; channelKey: string }> {
    const drives: Array<{ driveId: string; channelKey: string }> = [];
    for (const [key, cfg] of Object.entries(this.config.channels)) {
      const driveId = cfg.driveId as string | undefined;
      if (driveId) {
        drives.push({ driveId, channelKey: key });
      }
    }
    return drives;
  }

  /**
   * Poll changes from a single drive (personal or shared).
   * Returns items and updates the page token.
   */
  private pollDrive(
    tokenKey: string,
    driveId?: string
  ): NormalizedItem[] {
    // Get or initialize page token
    let pageToken = this.pageTokens.get(tokenKey);
    if (!pageToken) {
      const tokenParams: Record<string, unknown> = {};
      if (driveId) {
        tokenParams.driveId = driveId;
        tokenParams.supportsAllDrives = true;
      }
      const tokenResult = execGws(
        `drive changes getStartPageToken --params '${JSON.stringify(tokenParams)}'`
      ) as StartPageTokenResult;
      pageToken = tokenResult.startPageToken;
      this.pageTokens.set(tokenKey, pageToken);
    }

    const params: Record<string, unknown> = {
      pageToken,
      pageSize: 100,
      fields:
        'changes(fileId,time,removed,file(name,mimeType,modifiedTime,lastModifyingUser,parents,driveId)),newStartPageToken',
      includeRemoved: false,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    };
    if (driveId) {
      params.driveId = driveId;
    }

    const changeList = execGws(
      `drive changes list --params '${JSON.stringify(params)}'`
    ) as DriveChangeList;

    const items: NormalizedItem[] = [];
    for (const change of changeList.changes) {
      if (!change.file) continue;

      const file = change.file;
      const parents = file.parents ?? [];

      // Match by parent folder or by shared drive ID
      let channelName: string | null = null;
      const folderMatch = this.findChannelByParent(parents);
      if (folderMatch) {
        channelName = folderMatch[1];
      } else if (driveId) {
        // For shared drives: use the channel key as channel name
        for (const [key, cfg] of Object.entries(this.config.channels)) {
          if (cfg.driveId === driveId) {
            channelName = cfg.name ?? key;
            break;
          }
        }
      }

      if (!channelName) continue;

      const author = file.lastModifyingUser?.displayName ?? 'unknown';
      items.push({
        source: 'drive',
        sourceId: `${change.fileId}:${change.time}`,
        channel: channelName,
        author,
        content: `modified: ${file.name} (${file.mimeType})`,
        timestamp: new Date(change.time),
        type: 'file_change',
        metadata: {
          fileId: change.fileId,
          fileName: file.name,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          parents,
          driveId: driveId || undefined,
        },
      });
    }

    if (changeList.newStartPageToken) {
      this.pageTokens.set(tokenKey, changeList.newStartPageToken);
    }

    return items;
  }

  async poll(_since: Date): Promise<NormalizedItem[]> {
    const allItems: NormalizedItem[] = [];
    let hadError = false;

    try {
      // 1. Poll personal drive (for folder-based channels)
      const hasFolderChannels = Object.values(this.config.channels).some(
        (c) => c.folderId && !c.driveId
      );
      if (hasFolderChannels) {
        allItems.push(...this.pollDrive('drive'));
      }

      // 2. Poll each shared drive
      for (const { driveId, channelKey } of this.getSharedDriveIds()) {
        try {
          allItems.push(...this.pollDrive(`shared:${driveId}`, driveId));
        } catch (err) {
          console.error(`[drive] Shared drive ${channelKey} poll error:`, err);
        }
      }

      this.saveState();
    } catch (err) {
      hadError = true;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }

    this.lastPollTime = new Date();
    this.lastPollCount = allItems.length;
    if (!hadError) this.lastError = undefined;

    return allItems;
  }
}
