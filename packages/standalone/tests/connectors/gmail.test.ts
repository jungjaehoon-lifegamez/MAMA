import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GmailConnector } from '../../src/connectors/gmail/index.js';
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
    channels: {},
    auth: {
      type: 'cli',
      cli: 'gws',
      cliAuthCommand: 'gws auth login',
    },
    ...overrides,
  };
}

function makeMessageListJson(messageIds: string[]): string {
  const messages = messageIds.map((id) => ({ id, threadId: `thread-${id}` }));
  return JSON.stringify({ messages });
}

function makeMessageJson(overrides: Record<string, unknown> = {}): string {
  const msg = {
    id: 'msg001',
    threadId: 'thread001',
    snippet: 'This is a brief snippet of the email.',
    internalDate: '1700000001000',
    payload: {
      headers: [
        { name: 'Subject', value: 'Test Subject' },
        { name: 'From', value: 'sender@example.com' },
      ],
    },
    ...overrides,
  };
  return JSON.stringify(msg);
}

describe('GmailConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gws --version succeeds
    mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
  });

  describe('name and type', () => {
    it('has name "gmail"', () => {
      const connector = new GmailConnector(makeConfig());
      expect(connector.name).toBe('gmail');
    });

    it('has type "api"', () => {
      const connector = new GmailConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns cli auth requirement for gws', () => {
      const connector = new GmailConnector(makeConfig());
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
      const connector = new GmailConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when gws CLI is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found: gws');
      });
      const connector = new GmailConnector(makeConfig());
      await expect(connector.init()).rejects.toThrow(/gws/i);
    });
  });

  describe('authenticate', () => {
    it('returns true when gws auth status succeeds', async () => {
      mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when gws auth status throws', async () => {
      // First call (init --version) succeeds, second call (auth status) fails
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockImplementationOnce(() => {
          throw new Error('not authenticated');
        });
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns empty array when no messages', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>) // init
        .mockReturnValueOnce(makeMessageListJson([]) as unknown as ReturnType<typeof execSync>); // list
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('fetches and returns normalized email items', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>) // init
        .mockReturnValueOnce(
          makeMessageListJson(['msg001']) as unknown as ReturnType<typeof execSync>
        ) // list
        .mockReturnValueOnce(makeMessageJson() as unknown as ReturnType<typeof execSync>); // get
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.source).toBe('gmail');
      expect(items[0]?.type).toBe('email');
    });

    it('sets sourceId to message id', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeMessageListJson(['abc123']) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeMessageJson({ id: 'abc123' }) as unknown as ReturnType<typeof execSync>
        );
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('abc123');
    });

    it('formats content as "Subject: {subject}\\n\\n{snippet}"', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeMessageListJson(['msg001']) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeMessageJson({
            snippet: 'Check out this update',
            payload: {
              headers: [
                { name: 'Subject', value: 'Weekly Update' },
                { name: 'From', value: 'boss@company.com' },
              ],
            },
          }) as unknown as ReturnType<typeof execSync>
        );
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe('Subject: Weekly Update\n\nCheck out this update');
    });

    it('sets author from From header', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeMessageListJson(['msg001']) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeMessageJson({
            payload: {
              headers: [
                { name: 'Subject', value: 'Hello' },
                { name: 'From', value: 'alice@example.com' },
              ],
            },
          }) as unknown as ReturnType<typeof execSync>
        );
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('alice@example.com');
    });

    it('skips prefix lines like "Using keyring backend: ..." before JSON', async () => {
      const prefixedOutput =
        'Using keyring backend: SecretService\n' + makeMessageListJson(['msg001']);
      const msgOutput = 'Using keyring backend: SecretService\n' + makeMessageJson();
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(prefixedOutput as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(msgOutput as unknown as ReturnType<typeof execSync>);
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
    });

    it('filters out messages at or before since timestamp', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z'); // 1704067200000 ms
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeMessageListJson(['old001', 'new001']) as unknown as ReturnType<typeof execSync>
        )
        .mockReturnValueOnce(
          makeMessageJson({ id: 'old001', internalDate: '1704067200000' }) as unknown as ReturnType<
            typeof execSync
          >
        ) // exactly at since
        .mockReturnValueOnce(
          makeMessageJson({ id: 'new001', internalDate: '1704067201000' }) as unknown as ReturnType<
            typeof execSync
          >
        ); // after
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(since);
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('new001');
    });

    it('continues polling other messages if one fetch fails', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeMessageListJson(['bad001', 'good001']) as unknown as ReturnType<typeof execSync>
        )
        .mockImplementationOnce(() => {
          throw new Error('not found');
        }) // bad001 fails
        .mockReturnValueOnce(
          makeMessageJson({ id: 'good001' }) as unknown as ReturnType<typeof execSync>
        );
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('good001');
    });
  });

  describe('healthCheck', () => {
    it('reflects lastPollTime and lastPollCount after poll', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeMessageListJson([]) as unknown as ReturnType<typeof execSync>);
      const connector = new GmailConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollCount).toBe(0);
    });
  });
});
