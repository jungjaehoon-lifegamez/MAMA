import { describe, expect, it } from 'vitest';

import type {
  AuthConfig,
  AuthRequirement,
  ChannelConfig,
  ConnectorConfig,
  ConnectorHealth,
  ConnectorsConfig,
  IConnector,
  NormalizedItem,
} from '../../../src/connectors/framework/types.js';

describe('Connector Framework — Types', () => {
  describe('NormalizedItem', () => {
    it('accepts a minimal valid item', () => {
      const item: NormalizedItem = {
        source: 'slack',
        sourceId: 'msg-001',
        channel: 'general',
        author: 'alice',
        content: 'hello world',
        timestamp: new Date('2026-04-07T10:00:00Z'),
        type: 'message',
      };
      expect(item.source).toBe('slack');
      expect(item.type).toBe('message');
      expect(item.metadata).toBeUndefined();
    });

    it('accepts all supported item types', () => {
      const types: NormalizedItem['type'][] = [
        'message',
        'email',
        'event',
        'document',
        'note',
        'spreadsheet_row',
        'kanban_card',
        'file_change',
      ];
      for (const type of types) {
        const item: NormalizedItem = {
          source: 'test',
          sourceId: `id-${type}`,
          channel: 'ch',
          author: 'bot',
          content: 'content',
          timestamp: new Date(),
          type,
        };
        expect(item.type).toBe(type);
      }
    });

    it('accepts optional metadata', () => {
      const item: NormalizedItem = {
        source: 'notion',
        sourceId: 'page-1',
        channel: 'docs',
        author: 'system',
        content: 'doc content',
        timestamp: new Date(),
        type: 'document',
        metadata: { pageId: 'abc123', tags: ['api', 'v2'] },
      };
      expect(item.metadata).toEqual({ pageId: 'abc123', tags: ['api', 'v2'] });
    });
  });

  describe('ChannelConfig', () => {
    it('accepts hub role', () => {
      const cfg: ChannelConfig = { role: 'hub', name: 'main' };
      expect(cfg.role).toBe('hub');
    });

    it('accepts spoke role with keywords', () => {
      const cfg: ChannelConfig = {
        role: 'spoke',
        keywords: ['bug', 'fix'],
        watchPatterns: ['**/*.ts'],
      };
      expect(cfg.keywords).toHaveLength(2);
    });

    it('accepts ignore role', () => {
      const cfg: ChannelConfig = { role: 'ignore' };
      expect(cfg.role).toBe('ignore');
    });

    it('accepts truth role with spreadsheet/board config', () => {
      const sheet: ChannelConfig = {
        role: 'truth',
        spreadsheetId: 'abc123',
        sheetRange: 'A1:Z500',
      };
      const board: ChannelConfig = { role: 'truth', boardId: 'board456' };
      expect(sheet.spreadsheetId).toBe('abc123');
      expect(board.boardId).toBe('board456');
    });

    it('accepts deliverable role with folderId', () => {
      const cfg: ChannelConfig = { role: 'deliverable', folderId: 'folder789' };
      expect(cfg.folderId).toBe('folder789');
    });

    it('accepts reference role', () => {
      const cfg: ChannelConfig = { role: 'reference' };
      expect(cfg.role).toBe('reference');
    });
  });

  describe('AuthConfig', () => {
    it('accepts none type', () => {
      const cfg: AuthConfig = { type: 'none' };
      expect(cfg.type).toBe('none');
    });

    it('accepts cli type with cli fields', () => {
      const cfg: AuthConfig = {
        type: 'cli',
        cli: 'gh',
        cliAuthCommand: 'gh auth login',
      };
      expect(cfg.cli).toBe('gh');
    });

    it('accepts token type', () => {
      const cfg: AuthConfig = {
        type: 'token',
        tokenName: 'SLACK_TOKEN',
        token: 'xoxb-secret',
      };
      expect(cfg.tokenName).toBe('SLACK_TOKEN');
    });
  });

  describe('AuthRequirement', () => {
    it('requires description field', () => {
      const req: AuthRequirement = {
        type: 'token',
        tokenName: 'NOTION_TOKEN',
        description: 'Create an integration token at notion.so/my-integrations',
      };
      expect(req.description).toBeTruthy();
    });
  });

  describe('ConnectorConfig', () => {
    it('accepts a full config', () => {
      const cfg: ConnectorConfig = {
        enabled: true,
        pollIntervalMinutes: 15,
        channels: {
          general: { role: 'hub' },
          random: { role: 'ignore' },
        },
        auth: { type: 'none' },
      };
      expect(cfg.enabled).toBe(true);
      expect(Object.keys(cfg.channels)).toHaveLength(2);
    });
  });

  describe('ConnectorHealth', () => {
    it('represents a healthy state', () => {
      const h: ConnectorHealth = {
        healthy: true,
        lastPollTime: new Date(),
        lastPollCount: 42,
      };
      expect(h.healthy).toBe(true);
      expect(h.error).toBeUndefined();
    });

    it('represents an unhealthy state with error', () => {
      const h: ConnectorHealth = {
        healthy: false,
        lastPollTime: null,
        lastPollCount: 0,
        error: 'connection refused',
      };
      expect(h.healthy).toBe(false);
      expect(h.error).toBe('connection refused');
    });
  });

  describe('ConnectorsConfig', () => {
    it('is a record of ConnectorConfig keyed by connector name', () => {
      const cfg: ConnectorsConfig = {
        slack: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { general: { role: 'hub' } },
          auth: { type: 'token', tokenName: 'SLACK_TOKEN' },
        },
        notion: {
          enabled: false,
          pollIntervalMinutes: 60,
          channels: {},
          auth: { type: 'token', tokenName: 'NOTION_TOKEN' },
        },
      };
      expect(Object.keys(cfg)).toHaveLength(2);
      expect(cfg['slack']?.enabled).toBe(true);
    });
  });

  describe('IConnector shape', () => {
    it('can be implemented as a mock object satisfying the interface', () => {
      const mock: IConnector = {
        name: 'test',
        type: 'api',
        init: async () => undefined,
        dispose: async () => undefined,
        healthCheck: async () => ({
          healthy: true,
          lastPollTime: null,
          lastPollCount: 0,
        }),
        getAuthRequirements: () => [],
        authenticate: async () => true,
        poll: async (_since: Date) => [],
      };
      expect(mock.name).toBe('test');
      expect(mock.type).toBe('api');
    });
  });
});
