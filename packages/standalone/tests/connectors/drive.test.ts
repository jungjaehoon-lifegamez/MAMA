import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DriveConnector } from '../../src/connectors/drive/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

// Mock fs to prevent state file I/O from interfering with tests
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { execFile, execSync } from 'child_process';
const mockExecSync = vi.mocked(execSync);
const mockExecFile = vi.mocked(execFile);

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {
      docs: {
        role: 'deliverable',
        name: 'project-docs',
        folderId: 'folder-abc123',
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

function makeStartPageToken(token: string): string {
  return JSON.stringify({ startPageToken: token });
}

function makeChangeList(
  changes: Array<{
    fileId: string;
    time: string;
    fileName?: string;
    mimeType?: string;
    modifiedTime?: string;
    displayName?: string;
    parents?: string[];
    removed?: boolean;
  }>,
  newStartPageToken: string | null = 'next-token-456',
  nextPageToken?: string
): string {
  const changeObjects = changes.map((c) => ({
    fileId: c.fileId,
    time: c.time,
    removed: c.removed ?? false,
    file: c.removed
      ? undefined
      : {
          name: c.fileName ?? 'test-file.docx',
          mimeType: c.mimeType ?? 'application/vnd.google-apps.document',
          modifiedTime: c.modifiedTime ?? c.time,
          lastModifyingUser: { displayName: c.displayName ?? 'Alice' },
          parents: c.parents ?? ['folder-abc123'],
        },
  }));
  return JSON.stringify({
    changes: changeObjects,
    ...(newStartPageToken === null ? {} : { newStartPageToken }),
    ...(nextPageToken ? { nextPageToken } : {}),
  });
}

describe('DriveConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
    mockExecFile.mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      try {
        const stdout = String(mockExecSync(`gws ${args.join(' ')}`));
        callback(null, stdout, '');
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), '', '');
      }
      return {} as ReturnType<typeof execFile>;
    }) as typeof execFile);
  });

  describe('name and type', () => {
    it('has name "drive"', () => {
      const connector = new DriveConnector(makeConfig());
      expect(connector.name).toBe('drive');
    });

    it('has type "api"', () => {
      const connector = new DriveConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns cli auth requirement for gws', () => {
      const connector = new DriveConnector(makeConfig());
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
      const connector = new DriveConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when gws CLI is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found: gws');
      });
      const connector = new DriveConnector(makeConfig());
      await expect(connector.init()).rejects.toThrow(/gws/i);
    });
  });

  describe('authenticate', () => {
    it('returns true when gws auth status succeeds', async () => {
      mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when gws auth status throws', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockImplementationOnce(() => {
          throw new Error('not authenticated');
        });
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('fetches start page token on first poll', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>) // init
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        ) // getStartPageToken
        .mockReturnValueOnce(makeChangeList([]) as unknown as ReturnType<typeof execSync>); // changes list
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      // Verify getStartPageToken was called
      const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes('getStartPageToken'))).toBe(true);
    });

    it('reuses stored page token on subsequent polls', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>) // init
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        ) // getStartPageToken (first poll)
        .mockReturnValueOnce(
          makeChangeList([], 'token-002') as unknown as ReturnType<typeof execSync>
        ) // changes list (first poll)
        .mockReturnValueOnce(makeChangeList([]) as unknown as ReturnType<typeof execSync>); // changes list (second poll — no getStartPageToken)
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      await connector.poll(new Date(0));
      const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
      // getStartPageToken should only be called once
      expect(calls.filter((c) => c.includes('getStartPageToken'))).toHaveLength(1);
    });

    it('returns empty array when no changes', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(makeChangeList([]) as unknown as ReturnType<typeof execSync>);
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('emits file_change items for files in configured folder', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([
            {
              fileId: 'file-111',
              time: '2024-06-15T10:00:00.000Z',
              fileName: 'Report.docx',
              parents: ['folder-abc123'],
            },
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe('file_change');
    });

    it('sets source to "drive"', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([
            { fileId: 'file-111', time: '2024-01-01T00:00:00.000Z' },
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('drive');
    });

    it('sets sourceId as "fileId:changeTime"', async () => {
      const time = '2024-06-15T10:00:00.000Z';
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([{ fileId: 'file-xyz', time }]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe(`file-xyz:${time}`);
    });

    it('formats content as "modified: {fileName} ({mimeType})"', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([
            {
              fileId: 'file-111',
              time: '2024-01-01T00:00:00.000Z',
              fileName: 'Budget.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe(
        'modified: Budget.xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)'
      );
    });

    it('sets author from lastModifyingUser.displayName', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([
            { fileId: 'file-111', time: '2024-01-01T00:00:00.000Z', displayName: 'Bob Smith' },
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('Bob Smith');
    });

    it('sets channel from matched folder config name', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([
            { fileId: 'file-111', time: '2024-01-01T00:00:00.000Z' },
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.channel).toBe('project-docs');
    });

    it('filters out changes not in any configured folder', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([
            {
              fileId: 'file-other',
              time: '2024-01-01T00:00:00.000Z',
              parents: ['some-other-folder'],
            },
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('matches file to correct channel when multiple folders configured', async () => {
      const config = makeConfig({
        channels: {
          docs: { role: 'deliverable', name: 'project-docs', folderId: 'folder-abc123' },
          assets: { role: 'deliverable', name: 'project-assets', folderId: 'folder-def456' },
        },
      });
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([
            { fileId: 'file-1', time: '2024-01-01T00:00:00.000Z', parents: ['folder-def456'] },
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(config);
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.channel).toBe('project-assets');
    });

    it('updates page token after each poll', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([], 'token-002') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([], 'token-003') as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      await connector.poll(new Date(0));
      // Check second poll used token-002 (set from first poll's newStartPageToken)
      const secondPollParams = String(mockExecSync.mock.calls[3]?.[0]);
      expect(secondPollParams).toContain('token-002');
    });

    it('consumes every changes page before committing the new start token', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList(
            [{ fileId: 'file-1', time: '2024-01-01T00:00:00.000Z' }],
            null,
            'page-002'
          ) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList(
            [{ fileId: 'file-2', time: '2024-01-01T00:01:00.000Z' }],
            'token-003'
          ) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([], 'token-004') as unknown as ReturnType<typeof execSync>
        );

      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const firstPoll = await connector.poll(new Date(0));
      await connector.poll(new Date(0));

      expect(firstPoll.map((item) => item.metadata?.fileId)).toEqual(['file-1', 'file-2']);
      expect(String(mockExecSync.mock.calls[3]?.[0])).toContain('page-002');
      expect(String(mockExecSync.mock.calls[4]?.[0])).toContain('token-003');
    });

    it('continues a large changes backlog across bounded polls', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList(
            [{ fileId: 'file-1', time: '2024-01-01T00:00:00.000Z' }],
            null,
            'page-002'
          ) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList(
            [{ fileId: 'file-2', time: '2024-01-01T00:01:00.000Z' }],
            null,
            'page-003'
          ) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList(
            [{ fileId: 'file-3', time: '2024-01-01T00:02:00.000Z' }],
            'token-004'
          ) as unknown as ReturnType<typeof execSync>
        );

      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const firstPoll = await connector.poll(new Date(0));
      const secondPoll = await connector.poll(new Date(0));

      expect(firstPoll.map((item) => item.metadata?.fileId)).toEqual(['file-1', 'file-2']);
      expect(secondPoll.map((item) => item.metadata?.fileId)).toEqual(['file-3']);
      expect(String(mockExecSync.mock.calls[4]?.[0])).toContain('page-003');
    });

    it('fails loudly when the changes API repeats a pagination token', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([], null, 'page-loop') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([], null, 'page-loop') as unknown as ReturnType<typeof execSync>
        );

      const connector = new DriveConnector(makeConfig());
      await connector.init();

      await expect(connector.poll(new Date(0))).rejects.toThrow(/repeated a page token/i);
    });

    it('fails loudly when the terminal changes page omits newStartPageToken', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(makeChangeList([], null) as unknown as ReturnType<typeof execSync>);

      const connector = new DriveConnector(makeConfig());
      await connector.init();

      await expect(connector.poll(new Date(0))).rejects.toThrow(/new start page token/i);
    });

    it('marks health unhealthy when a shared Drive poll fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockImplementationOnce(() => {
          throw new Error('shared drive unavailable');
        });
      const connector = new DriveConnector(
        makeConfig({
          channels: {
            shared: { role: 'deliverable', name: 'shared', driveId: 'drive-1' },
          },
        })
      );
      await connector.init();

      await expect(connector.poll(new Date(0))).resolves.toEqual([]);
      await expect(connector.healthCheck()).resolves.toMatchObject({
        healthy: false,
        error: expect.stringContaining('shared drive unavailable'),
      });
      errorSpy.mockRestore();
    });

    it('skips changes with no file object', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeChangeList([
            { fileId: 'file-removed', time: '2024-01-01T00:00:00.000Z', removed: true },
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('handles "Using keyring backend:" prefix before JSON', async () => {
      const prefix = 'Using keyring backend: SecretService\n';
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          (prefix + makeStartPageToken('token-001')) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          (prefix +
            makeChangeList([
              { fileId: 'file-111', time: '2024-01-01T00:00:00.000Z' },
            ])) as unknown as ReturnType<typeof execSync>
        );
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
    });
  });

  describe('healthCheck', () => {
    it('reflects lastPollTime and lastPollCount after poll', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(makeChangeList([]) as unknown as ReturnType<typeof execSync>);
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollCount).toBe(0);
    });
  });

  describe('dispose', () => {
    it('clears page token so next poll fetches a fresh start token', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeStartPageToken('token-001') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(makeChangeList([]) as unknown as ReturnType<typeof execSync>)
        // After dispose: init again + getStartPageToken again
        .mockReturnValueOnce(
          makeStartPageToken('token-fresh') as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(makeChangeList([]) as unknown as ReturnType<typeof execSync>);
      const connector = new DriveConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      await connector.dispose();
      await connector.poll(new Date(0));
      const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
      expect(calls.filter((c) => c.includes('getStartPageToken'))).toHaveLength(2);
    });
  });
});
