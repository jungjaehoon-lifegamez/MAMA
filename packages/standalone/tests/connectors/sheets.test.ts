import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SheetsConnector } from '../../src/connectors/sheets/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
const mockExecSync = vi.mocked(execSync);

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

function makeSheetValues(rows: string[][]): string {
  return JSON.stringify({ values: rows });
}

describe('SheetsConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
  });

  describe('name and type', () => {
    it('has name "sheets"', () => {
      const connector = new SheetsConnector(makeConfig());
      expect(connector.name).toBe('sheets');
    });

    it('has type "api"', () => {
      const connector = new SheetsConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns cli auth requirement for gws', () => {
      const connector = new SheetsConnector(makeConfig());
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
      const connector = new SheetsConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when gws CLI is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found: gws');
      });
      const connector = new SheetsConnector(makeConfig());
      await expect(connector.init()).rejects.toThrow(/gws/i);
    });
  });

  describe('authenticate', () => {
    it('returns true when gws auth status succeeds', async () => {
      mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when gws auth status throws', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>) // init --version
        .mockImplementationOnce(() => {
          throw new Error('not authenticated');
        });
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns empty array when sheet has no data rows', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>) // init
        .mockReturnValueOnce(
          makeSheetValues([['Name', 'Status', 'Owner']]) as unknown as ReturnType<typeof execSync>
        ); // only header row
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('returns empty array when sheet has no values at all', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(JSON.stringify({}) as unknown as ReturnType<typeof execSync>);
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('emits spreadsheet_row items for all rows on first poll', async () => {
      const rows = [
        ['Task', 'Status', 'Owner'],
        ['Fix bug', 'In Progress', 'Alice'],
        ['Write docs', 'Todo', 'Bob'],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = new SheetsConnector(makeConfig());
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
      const connector = new SheetsConnector(makeConfig());
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
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('sheet-abc123:TASK-001');
    });

    it('formats content as "Col1: val1 | Col2: val2 | ..."', async () => {
      const rows = [
        ['Task', 'Status', 'Owner'],
        ['Fix bug', 'In Progress', 'Alice'],
      ];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe('Task: Fix bug | Status: In Progress | Owner: Alice');
    });

    it('sets author to "spreadsheet"', async () => {
      const rows = [['Task'], ['Fix bug']];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('spreadsheet');
    });

    it('sets channel from config name', async () => {
      const rows = [['Task'], ['Fix bug']];
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeSheetValues(rows) as unknown as ReturnType<typeof execSync>);
      const connector = new SheetsConnector(makeConfig());
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
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0)); // first poll — captures snapshot
      const items = await connector.poll(new Date(0)); // second poll
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('sheet-abc123:TASK-001');
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
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('sheet-abc123:TASK-002');
    });

    it('skips channels without spreadsheetId', async () => {
      const config = makeConfig({
        channels: {
          'no-sheet': { role: 'truth', name: 'no-sheet' },
        },
      });
      mockExecSync.mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>);
      const connector = new SheetsConnector(config);
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
      // Should not call gws sheets
      expect(mockExecSync).toHaveBeenCalledTimes(1); // only init
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
      const connector = new SheetsConnector(config);
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
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('handles "Using keyring backend:" prefix before JSON', async () => {
      const rows = [['Task'], ['Fix bug']];
      const prefixed = 'Using keyring backend: SecretService\n' + makeSheetValues(rows);
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(prefixed as unknown as ReturnType<typeof execSync>);
      const connector = new SheetsConnector(makeConfig());
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
      const connector = new SheetsConnector(makeConfig());
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
      const connector = new SheetsConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0)); // captures snapshot
      await connector.dispose();
      const items = await connector.poll(new Date(0)); // snapshot cleared → all rows new
      expect(items).toHaveLength(1);
    });
  });
});
