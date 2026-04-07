/**
 * SheetsConnector — polls Google Sheets via the gws CLI tool.
 * Uses child_process.execSync to call gws CLI commands.
 * Emits spreadsheet_row NormalizedItems for changed/new rows.
 */

import { execSync } from 'child_process';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { execGws } from '../framework/gws-utils.js';

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

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    try {
      execSync('gws --version', { stdio: 'pipe' });
    } catch {
      throw new Error('gws CLI not found. Install it and run: gws auth login');
    }
  }

  async dispose(): Promise<void> {
    this.lastSnapshot.clear();
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

  async poll(_since: Date): Promise<NormalizedItem[]> {
    const items: NormalizedItem[] = [];
    let hadError = false;

    for (const [channelKey, channelCfg] of Object.entries(this.config.channels)) {
      if (channelCfg.role === 'ignore') continue;
      if (!channelCfg.spreadsheetId) continue;
      const headerRange = channelCfg.sheetRange;
      const dataRange = channelCfg.dataRange;
      if (!headerRange) continue;

      const channelName = channelCfg.name ?? channelKey;

      try {
        let headers: string[];
        let effectiveRows: string[][];

        if (dataRange) {
          // Separate header and data ranges (for large sheets)
          const headerParams = JSON.stringify({
            spreadsheetId: channelCfg.spreadsheetId,
            range: headerRange,
          });
          const headerResult = execGws(
            `sheets spreadsheets values get --params '${headerParams}'`,
            { maxBuffer: 50 * 1024 * 1024 }
          ) as SheetValues;
          headers = (headerResult.values ?? [])[0] ?? [];
          if (headers.length === 0) continue;

          const dataParams = JSON.stringify({
            spreadsheetId: channelCfg.spreadsheetId,
            range: dataRange,
          });
          const dataResult = execGws(`sheets spreadsheets values get --params '${dataParams}'`, {
            maxBuffer: 50 * 1024 * 1024,
          }) as SheetValues;
          effectiveRows = dataResult.values ?? [];
        } else {
          // Single range: first row is header, rest is data
          const params = JSON.stringify({
            spreadsheetId: channelCfg.spreadsheetId,
            range: headerRange,
          });
          const result = execGws(`sheets spreadsheets values get --params '${params}'`, {
            maxBuffer: 50 * 1024 * 1024,
          }) as SheetValues;
          const allRows = result.values ?? [];
          if (allRows.length === 0) continue;
          headers = allRows[0] ?? [];
          if (headers.length === 0) continue;
          effectiveRows = allRows.slice(1);
        }

        const isFirstPoll = !this.lastSnapshot.has(channelName);
        const previousRows = this.lastSnapshot.get(channelName) ?? [];

        // Build a map from row key (first column) to row data for the previous snapshot
        const prevMap = new Map<string, string[]>();
        for (const row of previousRows) {
          const rowKey = row.find((c) => c && c.trim()) ?? '';
          if (rowKey) prevMap.set(rowKey, row);
        }

        // For truth sources: first poll returns ALL populated rows as current state
        // Subsequent polls return only changed rows
        const activeRows = isFirstPoll
          ? effectiveRows.filter((row) => {
              // Only include rows with at least one non-empty column
              const nonEmpty = row.filter((c) => c && c.trim()).length;
              return nonEmpty >= 1;
            })
          : effectiveRows;

        for (const row of activeRows) {
          // Find row key: first non-empty column (A column may be empty in some sheets)
          const rowKey = row.find((c) => c && c.trim()) ?? '';
          if (!rowKey) continue;

          if (isFirstPoll) {
            // First poll: emit all populated rows as truth snapshot
            const content = headers.map((header, i) => `${header}: ${row[i] ?? ''}`).join(' | ');
            items.push({
              source: 'sheets',
              sourceId: `${channelCfg.spreadsheetId}:${rowKey}`,
              channel: channelName,
              author: 'spreadsheet',
              content,
              timestamp: new Date(),
              type: 'spreadsheet_row',
              metadata: {
                spreadsheetId: channelCfg.spreadsheetId,
                sheetRange: channelCfg.sheetRange,
                rowKey,
                headers,
                values: row,
              },
            });
          } else {
            // Subsequent polls: only emit changed rows
            const prevRow = prevMap.get(rowKey);
            const rowChanged =
              prevRow === undefined ||
              headers.some((_, i) => (row[i] ?? '') !== (prevRow[i] ?? ''));

            if (rowChanged) {
              const content = headers.map((header, i) => `${header}: ${row[i] ?? ''}`).join(' | ');
              items.push({
                source: 'sheets',
                sourceId: `${channelCfg.spreadsheetId}:${rowKey}`,
                channel: channelName,
                author: 'spreadsheet',
                content,
                timestamp: new Date(),
                type: 'spreadsheet_row',
                metadata: {
                  spreadsheetId: channelCfg.spreadsheetId,
                  sheetRange: channelCfg.sheetRange,
                  rowKey,
                  headers,
                  values: row,
                },
              });
            }
          }
        }

        // Update snapshot with current data rows
        this.lastSnapshot.set(channelName, effectiveRows);
      } catch (err) {
        hadError = true;
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}
