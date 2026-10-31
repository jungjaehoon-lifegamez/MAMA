/**
 * DriveConnector — polls Google Drive changes via the gws CLI tool.
 * Uses argv-based asynchronous gws CLI calls.
 * Emits file_change NormalizedItems for files modified in configured folders.
 */

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { cliAuth } from '../framework/types.js';
import {
  execGwsAsync,
  execGwsTextAsync,
  gwsReadRefusal,
  gwsLogin,
  gwsTool,
  gwsUnavailable,
} from '../framework/gws-utils.js';
import { readConnectorState, writeConnectorState } from '../framework/connector-state.js';

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
  nextPageToken?: string;
}

interface StartPageTokenResult {
  startPageToken: string;
}

interface DriveState {
  pageTokens: Record<string, string>;
  fileChannels: Record<string, string>;
}

export class DriveConnector implements IConnector {
  readonly name = 'drive';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  private pageTokens = new Map<string, string>();
  private fileChannels = new Map<string, string>();
  private pendingPageTokens: Map<string, string> | null = null;
  private pendingFileChannels: Map<string, string> | null = null;
  private pollCommitDeferred = false;
  private stateFilePath: string;

  constructor(config: ConnectorConfig, stateFilePath: string) {
    this.config = config;
    if (!stateFilePath.trim()) throw new Error('Drive state file path is required');
    this.stateFilePath = stateFilePath;
  }

  async init(): Promise<void> {
    try {
      await execGwsTextAsync(['--version']);
    } catch (error) {
      throw new Error(gwsUnavailable(error), { cause: error });
    }
    this.loadState();
  }

  private loadState(): void {
    const state = readConnectorState(this.stateFilePath, (value): DriveState => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Drive connector state must contain an object');
      }
      const raw = value as Record<string, unknown>;
      const readMap = (field: string): Record<string, string> => {
        const candidate = raw[field];
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          throw new Error(`Drive connector state ${field} must contain an object`);
        }
        const entries = Object.entries(candidate);
        if (entries.some(([, item]) => typeof item !== 'string' || item === '')) {
          throw new Error(`Drive connector state ${field} must contain nonblank text values`);
        }
        return Object.fromEntries(entries) as Record<string, string>;
      };
      return { pageTokens: readMap('pageTokens'), fileChannels: readMap('fileChannels') };
    });
    if (state === undefined) return;
    this.pageTokens = new Map(Object.entries(state.pageTokens));
    this.fileChannels = new Map(Object.entries(state.fileChannels));
  }

  async dispose(): Promise<void> {
    this.pageTokens.clear();
    this.fileChannels.clear();
    this.abortPollHandoff();
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
        ...cliAuth(gwsTool),
        scope: 'drive',
        description: `Google Workspace CLI sign-in with ${gwsTool.loginScope('drive')}; ${gwsLogin}`,
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    // Drive requires `fields` on about.get.
    this.lastError = await gwsReadRefusal('Drive', 'Drive', [
      'drive',
      'about',
      'get',
      '--params',
      JSON.stringify({ fields: 'user' }),
    ]);
    return this.lastError === undefined;
  }

  /**
   * Find which channel config matches based on a file's parent folder IDs.
   * Returns [channelKey, channelName] or null if no match.
   */
  private findChannelByParent(parents: string[]): string | null {
    for (const [channelKey, channelCfg] of Object.entries(this.config.channels)) {
      if (channelCfg.role === 'ignore') continue;
      if (!channelCfg.folderId) continue;
      if (parents.includes(channelCfg.folderId)) {
        return channelKey;
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
      if (driveId && cfg.role !== 'ignore') {
        drives.push({ driveId, channelKey: key });
      }
    }
    return drives;
  }

  /**
   * Poll changes from a single drive (personal or shared).
   * Returns items and updates the page token.
   */
  private async pollDrive(tokenKey: string, driveId?: string): Promise<NormalizedItem[]> {
    const pageTokens = this.pendingPageTokens;
    const fileChannels = this.pendingFileChannels;
    if (pageTokens === null || fileChannels === null) {
      throw new Error('Drive poll handoff has not been prepared');
    }
    // Get or initialize page token
    let pageToken = pageTokens.get(tokenKey);
    if (!pageToken) {
      const tokenParams: Record<string, unknown> = {};
      if (driveId) {
        tokenParams.driveId = driveId;
        tokenParams.supportsAllDrives = true;
      }
      const tokenResult = (await execGwsAsync([
        'drive',
        'changes',
        'getStartPageToken',
        '--params',
        JSON.stringify(tokenParams),
      ])) as StartPageTokenResult;
      if (typeof tokenResult.startPageToken !== 'string' || tokenResult.startPageToken === '') {
        throw new Error(`Drive ${tokenKey} start page token was empty`);
      }
      pageToken = tokenResult.startPageToken;
      pageTokens.set(tokenKey, pageToken);
    }

    const items: NormalizedItem[] = [];
    const visitedPageTokens = new Set<string>();
    let requestPageToken = pageToken;
    let terminalStartPageToken: string | undefined;
    let reachedTerminalPage = false;

    while (!reachedTerminalPage) {
      if (visitedPageTokens.has(requestPageToken)) {
        throw new Error(`Drive changes pagination repeated a page token for ${tokenKey}`);
      }
      visitedPageTokens.add(requestPageToken);

      const params: Record<string, unknown> = {
        pageToken: requestPageToken,
        pageSize: 100,
        fields:
          'changes(fileId,time,removed,file(name,mimeType,modifiedTime,lastModifyingUser,parents,driveId)),nextPageToken,newStartPageToken',
        includeRemoved: true,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      };
      if (driveId) {
        params.driveId = driveId;
      }

      const changeList = (await execGwsAsync([
        'drive',
        'changes',
        'list',
        '--params',
        JSON.stringify(params),
      ])) as DriveChangeList;

      for (const change of changeList.changes) {
        const file = change.file;
        const parents = file?.parents ?? [];
        let channelKey = fileChannels.get(change.fileId) ?? null;
        if (file) {
          let fileChannelKey = this.findChannelByParent(parents);
          if (fileChannelKey === null && driveId) {
            fileChannelKey =
              Object.entries(this.config.channels).find(
                ([, cfg]) => cfg.role !== 'ignore' && cfg.driveId === driveId
              )?.[0] ?? null;
          }
          if (!change.removed) {
            channelKey = fileChannelKey;
            if (channelKey !== null) fileChannels.set(change.fileId, channelKey);
          } else if (channelKey === null) {
            channelKey = fileChannelKey;
          }
        }
        if (!channelKey) continue;
        if (change.removed) fileChannels.delete(change.fileId);
        if (!file && !change.removed) continue;

        const author = file?.lastModifyingUser?.displayName ?? 'unknown';
        items.push({
          source: 'drive',
          sourceId: `${change.fileId}:${change.time}`,
          sourceEntityId: change.fileId,
          channel: channelKey,
          author,
          content: change.removed
            ? `removed: ${file?.name ?? 'file'}`
            : `modified: ${file!.name} (${file!.mimeType})`,
          timestamp: new Date(change.time),
          type: 'file_change',
          metadata: {
            fileId: change.fileId,
            ...(file ? { fileName: file.name, mimeType: file.mimeType } : {}),
            ...(file?.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
            ...(parents.length > 0 ? { parents } : {}),
            ...(driveId ? { driveId } : {}),
            ...(change.removed ? { removed: true } : {}),
          },
        });
      }

      if (!changeList.nextPageToken) {
        terminalStartPageToken = changeList.newStartPageToken;
        reachedTerminalPage = true;
        break;
      }
      if (visitedPageTokens.has(changeList.nextPageToken)) {
        throw new Error(`Drive changes pagination repeated a page token for ${tokenKey}`);
      }
      requestPageToken = changeList.nextPageToken;
    }

    if (typeof terminalStartPageToken !== 'string' || terminalStartPageToken.length === 0) {
      throw new Error(
        `Drive changes terminal page omitted the new start page token for ${tokenKey}`
      );
    }
    pageTokens.set(tokenKey, terminalStartPageToken);

    return items;
  }

  async poll(_since: Date): Promise<NormalizedItem[]> {
    if (this.pendingPageTokens !== null || this.pendingFileChannels !== null) {
      throw new Error('Drive poll handoff is already active');
    }
    this.pendingPageTokens = new Map(this.pageTokens);
    this.pendingFileChannels = new Map(this.fileChannels);
    const allItems: NormalizedItem[] = [];
    const hasFolderChannels = Object.values(this.config.channels).some(
      (channel) => channel.role !== 'ignore' && channel.folderId && !channel.driveId
    );
    const sharedDrives = this.getSharedDriveIds();
    const targets = (hasFolderChannels ? 1 : 0) + sharedDrives.length;
    let failedTargets = 0;
    let lastTargetError: string | undefined;
    try {
      if (hasFolderChannels) {
        try {
          allItems.push(...(await this.pollDrive('drive')));
        } catch (error) {
          failedTargets += 1;
          lastTargetError = error instanceof Error ? error.message : String(error);
        }
      }
      for (const { driveId, channelKey } of sharedDrives) {
        try {
          allItems.push(...(await this.pollDrive(`shared:${driveId}`, driveId)));
        } catch (error) {
          failedTargets += 1;
          lastTargetError = `${channelKey}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (failedTargets > 0) {
        throw new Error(
          `Drive poll failed for ${failedTargets} of ${targets} configured drives; last error: ${lastTargetError}`
        );
      }
      this.lastError = undefined;
      this.lastPollTime = new Date();
      this.lastPollCount = allItems.length;
      if (!this.pollCommitDeferred) this.commitPoll();
      return allItems;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastPollTime = new Date();
      this.lastPollCount = allItems.length;
      if (!this.pollCommitDeferred) this.abortPollHandoff();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  commitPoll(): void {
    if (this.pendingPageTokens === null || this.pendingFileChannels === null) {
      throw new Error('Drive poll state is unavailable to commit');
    }
    writeConnectorState(this.stateFilePath, {
      pageTokens: Object.fromEntries(this.pendingPageTokens),
      fileChannels: Object.fromEntries(this.pendingFileChannels),
    } satisfies DriveState);
    this.pageTokens = this.pendingPageTokens;
    this.fileChannels = this.pendingFileChannels;
    this.pendingPageTokens = null;
    this.pendingFileChannels = null;
    this.pollCommitDeferred = false;
  }

  beginPollHandoff(): void {
    if (
      this.pollCommitDeferred ||
      this.pendingPageTokens !== null ||
      this.pendingFileChannels !== null
    ) {
      throw new Error('Drive poll handoff is already active');
    }
    this.pollCommitDeferred = true;
  }

  abortPollHandoff(): void {
    this.pendingPageTokens = null;
    this.pendingFileChannels = null;
    this.pollCommitDeferred = false;
  }
}
