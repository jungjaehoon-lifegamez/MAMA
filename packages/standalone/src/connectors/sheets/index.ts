/**
 * SheetsConnector — polls Google Sheets via the gws CLI tool.
 * Uses argv-based asynchronous gws CLI calls.
 * Emits spreadsheet_row NormalizedItems for changed/new rows.
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

interface SheetValues {
  values?: string[][];
}

export class SheetsConnector implements IConnector {
  readonly name = 'sheets';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  /** Snapshot of previous rows per channel: channelName → rows (excluding header) */
  private lastSnapshot: Map<string, string[][]> = new Map();
  private pendingSnapshot: Map<string, string[][]> | null = null;
  private pollCommitDeferred = false;
  private readonly snapshotPath: string;

  constructor(config: ConnectorConfig, snapshotPath: string) {
    this.config = config;
    if (!snapshotPath.trim()) throw new Error('Sheets snapshot file path is required');
    this.snapshotPath = snapshotPath;
  }

  async init(): Promise<void> {
    try {
      await execGwsTextAsync(['--version']);
    } catch (error) {
      throw new Error(gwsUnavailable(error), { cause: error });
    }
    this.loadSnapshot();
  }

  async dispose(): Promise<void> {
    this.lastSnapshot.clear();
    this.pendingSnapshot = null;
    this.pollCommitDeferred = false;
  }

  private loadSnapshot(): void {
    const state = readConnectorState(this.snapshotPath, (value): Record<string, string[][]> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Sheets snapshot state must contain an object');
      }
      for (const [channel, rows] of Object.entries(value)) {
        if (
          !Array.isArray(rows) ||
          rows.some((row) => !Array.isArray(row) || row.some((cell) => typeof cell !== 'string'))
        ) {
          throw new Error(`Sheets snapshot for ${channel} must contain rows of text cells`);
        }
      }
      return value as Record<string, string[][]>;
    });
    if (state !== undefined) this.lastSnapshot = new Map(Object.entries(state));
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
        scope: 'sheets',
        description: `Google Workspace CLI sign-in with ${gwsTool.loginScope('sheets')}; ${gwsLogin}`,
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    // The first spreadsheet this source reads; with none configured it reads nothing.
    const spreadsheetId = Object.values(this.config.channels).find(
      (channel) => channel.role !== 'ignore' && channel.spreadsheetId
    )?.spreadsheetId;
    if (spreadsheetId === undefined) return true;
    this.lastError = await gwsReadRefusal('Sheets', `spreadsheet ${spreadsheetId}`, [
      'sheets',
      'spreadsheets',
      'get',
      '--params',
      JSON.stringify({ spreadsheetId, fields: 'spreadsheetId' }),
    ]);
    return this.lastError === undefined;
  }

  async poll(_since: Date): Promise<NormalizedItem[]> {
    if (this.pendingSnapshot !== null) throw new Error('Sheets poll handoff is already active');
    this.pendingSnapshot = new Map(
      [...this.lastSnapshot].map(([channel, rows]) => [channel, rows.map((row) => [...row])])
    );
    const items: NormalizedItem[] = [];
    const channels = Object.entries(this.config.channels).filter(
      ([, channel]) => channel.role !== 'ignore'
    );
    let failedSheets = 0;
    let lastSheetError: string | undefined;

    try {
      for (const [channelKey, channelCfg] of channels) {
        try {
          if (!channelCfg.spreadsheetId || !channelCfg.sheetRange) {
            throw new Error(`channel ${channelKey} requires spreadsheetId and sheetRange`);
          }
          const headerRange = channelCfg.sheetRange;
          const dataRange = channelCfg.dataRange;
          let headers: string[];
          let effectiveRows: string[][];
          if (dataRange) {
            const headerResult = (await execGwsAsync(
              [
                'sheets',
                'spreadsheets',
                'values',
                'get',
                '--params',
                JSON.stringify({ spreadsheetId: channelCfg.spreadsheetId, range: headerRange }),
              ],
              { maxBuffer: 50 * 1024 * 1024 }
            )) as SheetValues;
            headers = (headerResult.values ?? [])[0] ?? [];
            if (headers.length === 0)
              throw new Error('configured header range returned no headers');
            const dataResult = (await execGwsAsync(
              [
                'sheets',
                'spreadsheets',
                'values',
                'get',
                '--params',
                JSON.stringify({ spreadsheetId: channelCfg.spreadsheetId, range: dataRange }),
              ],
              { maxBuffer: 50 * 1024 * 1024 }
            )) as SheetValues;
            effectiveRows = dataResult.values ?? [];
          } else {
            const result = (await execGwsAsync(
              [
                'sheets',
                'spreadsheets',
                'values',
                'get',
                '--params',
                JSON.stringify({ spreadsheetId: channelCfg.spreadsheetId, range: headerRange }),
              ],
              { maxBuffer: 50 * 1024 * 1024 }
            )) as SheetValues;
            const allRows = result.values ?? [];
            headers = allRows[0] ?? [];
            if (allRows.length > 0 && headers.length === 0) {
              throw new Error('configured range returned an empty header row');
            }
            effectiveRows = allRows.slice(1);
          }

          const currentRows = new Map<string, string[]>();
          for (const row of effectiveRows) {
            const rowKey = row.find((cell) => cell && cell.trim()) ?? '';
            if (!rowKey) continue;
            if (currentRows.has(rowKey)) throw new Error(`duplicate row identity ${rowKey}`);
            currentRows.set(rowKey, row);
          }
          const previousRows = this.pendingSnapshot!.get(channelKey) ?? [];
          const previousByKey = new Map(
            previousRows
              .map((row) => [row.find((cell) => cell && cell.trim()) ?? '', row] as const)
              .filter(([key]) => key !== '')
          );
          const isFirstPoll = !this.lastSnapshot.has(channelKey);
          const sourceTime = new Date();
          const emitRow = (rowKey: string, row: string[], deleted = false): void => {
            const content = deleted
              ? `Deleted row ${rowKey}: ${headers.length > 0 ? headers.map((header, i) => `${header}: ${row[i] ?? ''}`).join(' | ') : row.join(' | ')}`
              : headers.map((header, i) => `${header}: ${row[i] ?? ''}`).join(' | ');
            items.push({
              source: 'sheets',
              sourceId: `${channelCfg.spreadsheetId}:${channelKey}:${rowKey}`,
              sourceEntityId: `${channelCfg.spreadsheetId}:${channelKey}:${rowKey}`,
              channel: channelKey,
              author: 'spreadsheet',
              content,
              timestamp: sourceTime,
              type: 'spreadsheet_row',
              metadata: {
                spreadsheetId: channelCfg.spreadsheetId,
                sheetRange: channelCfg.sheetRange,
                rowKey,
                headers,
                values: row,
                ...(deleted ? { deleted: true } : {}),
              },
            });
          };

          for (const [rowKey, row] of currentRows) {
            const previous = previousByKey.get(rowKey);
            const changed =
              isFirstPoll ||
              previous === undefined ||
              headers.some((_, index) => (row[index] ?? '') !== (previous[index] ?? ''));
            if (changed) emitRow(rowKey, row);
          }
          if (!isFirstPoll) {
            for (const [rowKey, previous] of previousByKey) {
              if (!currentRows.has(rowKey)) emitRow(rowKey, previous, true);
            }
          }
          this.pendingSnapshot!.set(
            channelKey,
            effectiveRows.map((row) => [...row])
          );
        } catch (error) {
          failedSheets += 1;
          lastSheetError = error instanceof Error ? error.message : String(error);
        }
      }
      if (failedSheets > 0) {
        throw new Error(
          `Sheets poll failed for ${failedSheets} of ${channels.length} configured sheets; last error: ${lastSheetError}`
        );
      }
      this.lastError = undefined;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      if (!this.pollCommitDeferred) this.commitPoll();
      return items;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      if (!this.pollCommitDeferred) this.abortPollHandoff();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  commitPoll(): void {
    if (this.pendingSnapshot === null)
      throw new Error('Sheets poll state is unavailable to commit');
    writeConnectorState(this.snapshotPath, Object.fromEntries(this.pendingSnapshot));
    this.lastSnapshot = this.pendingSnapshot;
    this.pendingSnapshot = null;
    this.pollCommitDeferred = false;
  }

  beginPollHandoff(): void {
    if (this.pollCommitDeferred || this.pendingSnapshot !== null) {
      throw new Error('Sheets poll handoff is already active');
    }
    this.pollCommitDeferred = true;
  }

  abortPollHandoff(): void {
    this.pendingSnapshot = null;
    this.pollCommitDeferred = false;
  }
}
