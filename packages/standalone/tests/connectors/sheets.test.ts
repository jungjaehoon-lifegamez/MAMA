import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SheetsConnector } from '../../src/connectors/sheets/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

import { execFile, execSync } from 'node:child_process';
const mockExecSync = vi.mocked(execSync);
const mockExecFile = vi.mocked(execFile);
const roots: string[] = [];
let snapshotPath = '';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 10,
    channels: {
      tasks: {
        role: 'truth',
        name: 'tasks',
        spreadsheetId: 'sheet-abc123',
        sheetRange: 'A1:D100',
      },
    },
    auth: {
      type: 'cli',
      cli: 'gws',
      cliAuthCommand: 'gws auth login',
    },
    ...overrides,
  };
}

function makeConnector(config: ConnectorConfig = makeConfig()): SheetsConnector {
  return new SheetsConnector(config, snapshotPath);
}

function makeSheetValues(rows: string[][]): string {
  return JSON.stringify({ values: rows });
}

describe('SheetsConnector', () => {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'sheets-connector-test-'));
    roots.push(root);
    snapshotPath = join(root, 'snapshot.json');
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
    mockExecFile.mockImplementation(((_file, args, _options, callback) => {
      try {
        callback(null, String(mockExecSync(`gws ${args.join(' ')}`)), '');
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), '', '');
      }
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  describe('name and type', () => {
    it('has name "sheets"', () => {
      const connector = makeConnector(makeConfig());
      expect(connector.name).toBe('sheets');
    });

    it('has type "api"', () => {
      const connector = makeConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns cli auth requirement for gws', () => {
      const connector = makeConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('cli');
      expect(reqs[0]?.cli).toBe('gws');
      expect(reqs[0]?.cliAuthCommand).toBe('gws auth login');
    });
  });

  describe('init', () => {
    it('initializes when gws CLI is available', async () => {
      mockExecSync.mockReturnValue('gws version 1.0.0' as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when gws CLI is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found: gws');
      });
      const connector = makeConnector(makeConfig());
      await expect(connector.init()).rejects.toThrow(/gws/i);
    });
  });

  describe('authenticate', () => {
    // `gws auth status` exits 0 signed in or not, and a sign-in granted for other services
    // refreshes fine: only a read with this source's own scope says it can read.
    it('reads with its own scope', async () => {
      const connector = makeConnector(makeConfig());
      await connector.init();
      mockExecSync.mockReturnValue('{}' as unknown as ReturnType<typeof execSync>);
      expect(await connector.authenticate()).toBe(true);
      expect(mockExecSync).toHaveBeenLastCalledWith(
        'gws sheets spreadsheets get --params {"spreadsheetId":"sheet-abc123","fields":"spreadsheetId"}'
      );
    });

    it('is refused when the read is, and says why', async () => {
      const connector = makeConnector(makeConfig());
      await connector.init();
      mockExecSync.mockImplementation(() => {
        throw new Error('403 Request had insufficient authentication scopes.');
      });
      expect(await connector.authenticate()).toBe(false);
      expect((await connector.healthCheck()).error).toBe(
        'Sheets: gws cannot read spreadsheet sheet-abc123 with its sign-in (403 Request had insufficient authentication scopes.). Sign in with its access (mama doctor names the gws auth login command for this install), then retry.'
      );
    });
  });

  describe('poll', () => {
    it('returns empty array when sheet has no data rows', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>) // init
        .mockReturnValueOnce(
          makeSheetValues([['Name', 'Status', 'Owner']]) as unknown as ReturnType<typeof execSync>
        ); // only header row
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('returns empty array when sheet has no values at all', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(JSON.stringify({}) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('emits spreadsheet_row items for all rows on first poll', async () => {
      const rows = [
        ['Task', 'Status', 'Owner'],
        ['Fixture task one', 'In Progress', 'fixture-person-1'],
        ['Fixture task two', 'Todo', 'fixture-person-2'],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(2);
      expect(items[0]?.type).toBe('spreadsheet_row');
      expect(items[1]?.type).toBe('spreadsheet_row');
    });

    it('sets source to "sheets"', async () => {
      const rows = [
        ['Task', 'Status'],
        ['Fix bug', 'Done'],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('sheets');
    });

    it('sets sourceId as "spreadsheetId:rowKey"', async () => {
      const rows = [
        ['Task', 'Status'],
        ['TASK-001', 'Done'],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('sheet-abc123:tasks:TASK-001');
    });

    it('formats content as "Col1: val1 | Col2: val2 | ..."', async () => {
      const rows = [
        ['Task', 'Status', 'Owner'],
        ['Fixture task one', 'In Progress', 'fixture-person-1'],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe(
        'Task: Fixture task one | Status: In Progress | Owner: fixture-person-1'
      );
    });

    it('sets author to "spreadsheet"', async () => {
      const rows = [['Task'], ['Fix bug']];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('spreadsheet');
    });

    it('sets channel from config name', async () => {
      const rows = [['Task'], ['Fix bug']];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.channel).toBe('tasks');
    });

    it('emits only changed rows on subsequent polls', async () => {
      const initialRows = [
        ['Task', 'Status'],
        ['TASK-001', 'Todo'],
        ['TASK-002', 'Done'],
      ];
      const updatedRows = [
        ['Task', 'Status'],
        ['TASK-001', 'In Progress'], // changed
        ['TASK-002', 'Done'], // unchanged
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>) // init
        .mockReturnValueOnce(makeSheetValues(initialRows) as unknown as ReturnType<typeof execSync>) // first poll
        .mockReturnValueOnce(
          makeSheetValues(updatedRows) as unknown as ReturnType<typeof execSync>
        ); // second poll
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0)); // first poll — captures snapshot
      const items = await connector.poll(new Date(0)); // second poll
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('sheet-abc123:tasks:TASK-001');
      expect(items[0]?.content).toBe('Task: TASK-001 | Status: In Progress');
    });

    it('emits new rows added between polls', async () => {
      const initialRows = [
        ['Task', 'Status'],
        ['TASK-001', 'Todo'],
      ];
      const updatedRows = [
        ['Task', 'Status'],
        ['TASK-001', 'Todo'],
        ['TASK-002', 'New'],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(initialRows) as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeSheetValues(updatedRows) as unknown as ReturnType<typeof execSync>
        );
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('sheet-abc123:tasks:TASK-002');
    });

    it('fails visibly when a configured channel omits spreadsheetId or sheetRange', async () => {
      const config = makeConfig({
        channels: {
          'no-sheet': { role: 'truth', name: 'no-sheet' },
        },
      });
      mockExecSync.mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(config);
      await connector.init();
      await expect(connector.poll(new Date(0))).rejects.toThrow(
        /Sheets poll failed for 1 of 1 configured sheets; last error: channel no-sheet requires spreadsheetId and sheetRange/
      );
    });

    it('skips channels with role "ignore"', async () => {
      const config = makeConfig({
        channels: {
          ignored: {
            role: 'ignore',
            name: 'ignored',
            spreadsheetId: 'sheet-xyz',
            sheetRange: 'A1:Z100',
          },
        },
      });
      mockExecSync.mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(config);
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
      expect(mockExecSync).toHaveBeenCalledTimes(1); // only init
    });

    it('skips rows with all columns empty', async () => {
      const rows = [
        ['Task', 'Status'],
        ['', ''],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('reads separate header and data ranges through argv calls', async () => {
      const config = makeConfig({
        channels: {
          sheet: {
            role: 'reference',
            spreadsheetId: 'spreadsheet-fixture',
            sheetRange: 'Records!A1:B1',
            dataRange: 'Records!A2:B',
          },
        },
      });
      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeSheetValues([['Key', 'State']]) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeSheetValues([['ROW-001', 'Open']]) as unknown as ReturnType<typeof execSync>
        );
      const connector = makeConnector(config);
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items[0]?.sourceId).toBe('spreadsheet-fixture:sheet:ROW-001');
      expect(mockExecFile.mock.calls.every(([, args]) => Array.isArray(args))).toBe(true);
      expect(mockExecFile.mock.calls.some(([, args]) => args.includes('sheets'))).toBe(true);
    });

    it('fails instead of collapsing duplicate first nonempty row keys', async () => {
      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeSheetValues([
            ['Key', 'State'],
            ['ROW-001', 'Open'],
            ['', 'ROW-001'],
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = makeConnector();
      await connector.init();

      await expect(connector.poll(new Date(0))).rejects.toThrow(/duplicate row identity ROW-001/);
    });

    it('keeps equal row keys from two configured channels as separate entities', async () => {
      const values = makeSheetValues([
        ['Key', 'State'],
        ['ROW-001', 'Open'],
      ]);
      const config = makeConfig({
        channels: {
          first: { role: 'truth', spreadsheetId: 'shared-sheet-fixture', sheetRange: 'First!A:B' },
          second: {
            role: 'reference',
            spreadsheetId: 'shared-sheet-fixture',
            sheetRange: 'Second!A:B',
          },
        },
      });
      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(values as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(values as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(config);
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items.map((item) => item.sourceId)).toEqual([
        'shared-sheet-fixture:first:ROW-001',
        'shared-sheet-fixture:second:ROW-001',
      ]);
    });

    it('emits a deletion revision when a row disappears', async () => {
      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeSheetValues([
            ['Key', 'State'],
            ['ROW-001', 'Open'],
          ]) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeSheetValues([['Key', 'State']]) as unknown as ReturnType<typeof execSync>
        );
      const connector = makeConnector();
      await connector.init();
      await connector.poll(new Date(0));
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('sheet-abc123:tasks:ROW-001');
      expect(items[0]?.metadata?.deleted).toBe(true);
      expect(items[0]?.content).toContain('Deleted row ROW-001');
    });

    it('keeps deletion evidence when the provider omits values for an empty sheet', async () => {
      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeSheetValues([
            ['Key', 'State'],
            ['ROW-001', 'Open'],
          ]) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(JSON.stringify({}) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector();
      await connector.init();
      await connector.poll(new Date(0));
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(1);
      expect(items[0]?.metadata?.deleted).toBe(true);
      expect(items[0]?.content).toContain('Deleted row ROW-001');
    });

    it('leaves the row snapshot unchanged when the handoff is aborted', async () => {
      const values = makeSheetValues([
        ['Key', 'State'],
        ['ROW-001', 'Open'],
      ]);
      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(values as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(values as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector();
      await connector.init();
      connector.beginPollHandoff();
      expect(await connector.poll(new Date(0))).toHaveLength(1);
      connector.abortPollHandoff();
      expect(await connector.poll(new Date(0))).toHaveLength(1);
    });

    it('restores the committed snapshot after connector restart', async () => {
      const values = makeSheetValues([
        ['Key', 'State'],
        ['ROW-001', 'Open'],
      ]);
      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(values as unknown as ReturnType<typeof execSync>);
      const first = makeConnector();
      await first.init();
      await first.poll(new Date(0));
      await first.dispose();

      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(values as unknown as ReturnType<typeof execSync>);
      const second = makeConnector();
      await second.init();
      expect(await second.poll(new Date(0))).toEqual([]);
    });

    it('uses poll time as the source timestamp', async () => {
      const before = Date.now();
      mockExecSync
        .mockReturnValueOnce('gws version 1.0.0' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeSheetValues([
            ['Key', 'State'],
            ['ROW-001', 'Open'],
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));
      const after = Date.now();

      expect(items[0]!.timestamp.getTime()).toBeGreaterThanOrEqual(before);
      expect(items[0]!.timestamp.getTime()).toBeLessThanOrEqual(after);
    });

    it('handles "Using keyring backend:" prefix before JSON', async () => {
      const rows = [['Task'], ['Fix bug']];
      const prefixed = 'Using keyring backend: SecretService\n' + makeSheetValues(rows);
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(prefixed as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
    });
  });

  describe('healthCheck', () => {
    it('reflects lastPollTime and lastPollCount after poll', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues([['Task']]) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollCount).toBe(0);
    });
  });

  describe('dispose', () => {
    it('clears the snapshot so next poll emits all rows again', async () => {
      const rows = [
        ['Task', 'Status'],
        ['TASK-001', 'Todo'],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0)); // captures snapshot
      await connector.dispose();
      const items = await connector.poll(new Date(0)); // snapshot cleared → all rows new
      expect(items).toHaveLength(1);
    });
  });
});
