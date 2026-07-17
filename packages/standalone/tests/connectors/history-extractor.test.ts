import { describe, expect, it } from 'vitest';

import {
  classifyItemsByRole,
  buildProjectTruth,
  buildEntityObservations,
  groupByChannel,
} from '../../src/memory/history-extractor.js';
import type { NormalizedItem, ChannelConfig } from '../../src/connectors/framework/types.js';

function makeItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    source: 'chatwork',
    sourceId: 'cw:001',
    channel: 'general',
    author: 'Alice',
    content: 'Hello world',
    timestamp: new Date('2025-01-15T09:30:00Z'),
    type: 'message',
    ...overrides,
  };
}

describe('History Extractor', () => {
  describe('classifyItemsByRole', () => {
    it('classifies items into truth, activity, and spoke groups', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'chatwork', channel: 'general' }),
        makeItem({ source: 'chatwork', channel: 'dev', content: 'PR merged' }),
        makeItem({ source: 'slack', channel: 'announcements', content: 'Release done' }),
        makeItem({
          source: 'trello',
          channel: 'board',
          content: 'Card moved',
          type: 'kanban_card',
        }),
        makeItem({
          source: 'sheets',
          channel: 'tasks',
          content: 'Row updated',
          type: 'spreadsheet_row',
        }),
      ];

      const channelConfigs: Record<string, Record<string, ChannelConfig>> = {
        chatwork: {
          general: { role: 'hub' },
          dev: { role: 'spoke' },
        },
        slack: {
          announcements: { role: 'hub' },
        },
        trello: {
          board: { role: 'truth' },
        },
        sheets: {
          tasks: { role: 'truth' },
        },
      };

      const result = classifyItemsByRole(items, channelConfigs);

      expect(result.truth).toHaveLength(2);
      expect(result.activity).toHaveLength(2);
      expect(result.spoke).toHaveLength(1);
      expect(result.truth.map((i) => i.channel)).toContain('board');
      expect(result.truth.map((i) => i.channel)).toContain('tasks');
      expect(result.activity.map((i) => i.channel)).toContain('general');
      expect(result.activity.map((i) => i.channel)).toContain('announcements');
      expect(result.spoke[0]?.channel).toBe('dev');
    });

    it('places hub items into activity', () => {
      const items: NormalizedItem[] = [makeItem({ source: 'chatwork', channel: 'hub-channel' })];
      const channelConfigs: Record<string, Record<string, ChannelConfig>> = {
        chatwork: { 'hub-channel': { role: 'hub' } },
      };
      const result = classifyItemsByRole(items, channelConfigs);
      expect(result.activity).toHaveLength(1);
      expect(result.truth).toHaveLength(0);
      expect(result.spoke).toHaveLength(0);
    });

    it('places deliverable items into activity', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'drive', channel: 'deliverables', type: 'file_change' }),
      ];
      const channelConfigs: Record<string, Record<string, ChannelConfig>> = {
        drive: { deliverables: { role: 'deliverable' } },
      };
      const result = classifyItemsByRole(items, channelConfigs);
      expect(result.activity).toHaveLength(1);
    });

    it('places reference items into activity', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'notion', channel: 'wiki', type: 'document' }),
      ];
      const channelConfigs: Record<string, Record<string, ChannelConfig>> = {
        notion: { wiki: { role: 'reference' } },
      };
      const result = classifyItemsByRole(items, channelConfigs);
      expect(result.activity).toHaveLength(1);
    });

    it('sorts activity items by timestamp ascending', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'chatwork',
          channel: 'general',
          timestamp: new Date('2025-01-15T12:00:00Z'),
          content: 'later',
        }),
        makeItem({
          source: 'chatwork',
          channel: 'general',
          timestamp: new Date('2025-01-15T09:00:00Z'),
          content: 'earlier',
        }),
        makeItem({
          source: 'chatwork',
          channel: 'general',
          timestamp: new Date('2025-01-15T10:30:00Z'),
          content: 'middle',
        }),
      ];
      const channelConfigs: Record<string, Record<string, ChannelConfig>> = {
        chatwork: { general: { role: 'hub' } },
      };
      const result = classifyItemsByRole(items, channelConfigs);
      expect(result.activity[0]?.content).toBe('earlier');
      expect(result.activity[1]?.content).toBe('middle');
      expect(result.activity[2]?.content).toBe('later');
    });

    it('drops items with ignore role or no config', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'chatwork', channel: 'noise' }), // ignore role
        makeItem({ source: 'chatwork', channel: 'unknown-channel' }), // no config
        makeItem({ source: 'unknown-source', channel: 'anything' }), // no source config
        makeItem({ source: 'chatwork', channel: 'hub-channel' }), // should be kept
      ];

      const channelConfigs: Record<string, Record<string, ChannelConfig>> = {
        chatwork: {
          noise: { role: 'ignore' },
          'hub-channel': { role: 'hub' },
        },
      };

      const result = classifyItemsByRole(items, channelConfigs);

      expect(result.activity).toHaveLength(1);
      expect(result.spoke).toHaveLength(0);
      expect(result.truth).toHaveLength(0);
      expect(result.activity[0]?.channel).toBe('hub-channel');
    });

    it('returns empty arrays when all items are dropped', () => {
      const items: NormalizedItem[] = [makeItem({ source: 'chatwork', channel: 'noise' })];
      const channelConfigs: Record<string, Record<string, ChannelConfig>> = {
        chatwork: { noise: { role: 'ignore' } },
      };

      const result = classifyItemsByRole(items, channelConfigs);
      expect(result.truth).toHaveLength(0);
      expect(result.activity).toHaveLength(0);
      expect(result.spoke).toHaveLength(0);
    });

    it('handles empty items array', () => {
      const result = classifyItemsByRole([], { chatwork: { general: { role: 'hub' } } });
      expect(result.truth).toHaveLength(0);
      expect(result.activity).toHaveLength(0);
      expect(result.spoke).toHaveLength(0);
    });
  });

  describe('buildProjectTruth', () => {
    it('builds project truth from kanban_card items', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'trello',
          channel: 'MyProject',
          sourceId: 'card-1',
          type: 'kanban_card',
          metadata: {
            cardName: 'Login Feature',
            listName: 'In Progress',
            members: 'Alice',
          },
        }),
        makeItem({
          source: 'trello',
          channel: 'MyProject',
          sourceId: 'card-2',
          type: 'kanban_card',
          metadata: {
            cardName: 'Sign Up Page',
            listName: 'Done',
            members: 'Bob',
          },
        }),
      ];

      const truth = buildProjectTruth(items);

      expect(truth.projects['MyProject']).toBeDefined();
      const wu = truth.projects['MyProject']!.workUnits;
      expect(wu['Login Feature']?.status).toBe('In Progress');
      expect(wu['Login Feature']?.column).toBe('In Progress');
      expect(wu['Login Feature']?.assigned).toBe('Alice');
      expect(wu['Sign Up Page']?.status).toBe('Done');
      expect(wu['Sign Up Page']?.assigned).toBe('Bob');
    });

    it('uses sourceId as fallback for kanban_card when cardName is missing', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'trello',
          channel: 'Project',
          sourceId: 'card-99',
          type: 'kanban_card',
          metadata: { listName: 'Backlog' },
        }),
      ];

      const truth = buildProjectTruth(items);
      expect(truth.projects['Project']!.workUnits['card-99']).toBeDefined();
    });

    it('builds project truth from spreadsheet_row items', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'sheets',
          channel: 'TaskSheet',
          sourceId: 'row-1',
          type: 'spreadsheet_row',
          metadata: {
            headers: ['DB_NO', '클라이언트', '프로젝트', '명칭', '제출기한', '담당'],
            values: ['101', 'ClientA', 'ProjectX', 'TaskAlpha', '2026-04-20', 'Carol'],
          },
        }),
      ];

      const truth = buildProjectTruth(items);

      expect(truth.projects['ClientA/ProjectX']).toBeDefined();
      const wu = truth.projects['ClientA/ProjectX']!.workUnits['TaskAlpha'];
      expect(wu?.status).toBe('deadline:2026-04-20');
      expect(wu?.assigned).toBe('Carol');
      expect(wu?.metadata?.['클라이언트']).toBe('ClientA');
    });

    it('handles Korean column names for spreadsheet_row', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'sheets',
          channel: 'KoreanSheet',
          sourceId: 'row-1',
          type: 'spreadsheet_row',
          metadata: {
            headers: ['DB_NO', '클라이언트', '프로젝트', '명칭', '제출기한', '담당자'],
            values: ['202', 'ClientA', 'project_beta', 'feature_dev', '2026-05-01', 'Lee'],
          },
        }),
      ];

      const truth = buildProjectTruth(items);
      const wu = truth.projects['ClientA/project_beta']!.workUnits['feature_dev'];
      expect(wu?.status).toBe('deadline:2026-05-01');
      expect(wu?.assigned).toBe('Lee');
    });

    it('uses sourceId as fallback for spreadsheet_row when values is empty', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'sheets',
          channel: 'Sheet',
          sourceId: 'row-42',
          type: 'spreadsheet_row',
          metadata: { headers: [], values: [] },
        }),
      ];

      const truth = buildProjectTruth(items);
      expect(truth.projects['Sheet']!.workUnits['row-42']).toBeDefined();
      expect(truth.projects['Sheet']!.workUnits['row-42']?.status).toBe('active');
    });

    it('groups work units by channel', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'trello',
          channel: 'ProjectA',
          sourceId: 'card-1',
          type: 'kanban_card',
          metadata: { cardName: 'Task A', listName: 'Todo' },
        }),
        makeItem({
          source: 'trello',
          channel: 'ProjectB',
          sourceId: 'card-2',
          type: 'kanban_card',
          metadata: { cardName: 'Task B', listName: 'Done' },
        }),
      ];

      const truth = buildProjectTruth(items);
      expect(Object.keys(truth.projects)).toHaveLength(2);
      expect(truth.projects['ProjectA']!.workUnits['Task A']).toBeDefined();
      expect(truth.projects['ProjectB']!.workUnits['Task B']).toBeDefined();
    });

    it('returns empty projects for empty input', () => {
      const truth = buildProjectTruth([]);
      expect(truth.projects).toEqual({});
    });

    it('skips non-truth item types (message, email, etc.)', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'chatwork', channel: 'general', type: 'message' }),
        makeItem({ source: 'chatwork', channel: 'general', type: 'email' }),
      ];
      const truth = buildProjectTruth(items);
      // Projects are still created by channel, but no workUnits are added
      expect(truth.projects['general']?.workUnits).toEqual({});
    });
  });

  describe('buildEntityObservations', () => {
    it('builds person and project observations while preserving Slack raw provenance', () => {
      const koreanProjectAlpha = '\uD504\uB85C\uC81D\uD2B8 \uC54C\uD30C';
      const items: NormalizedItem[] = [
        makeItem({
          source: 'slack',
          sourceId: 'C123:1710000000.000100',
          channel: koreanProjectAlpha,
          author: 'Alice Kim',
          content: 'Alpha launch status updated',
          metadata: {
            channelId: 'C123',
            channelName: koreanProjectAlpha,
          },
        }),
      ];

      const observations = buildEntityObservations(items, {
        extractorVersion: 'history-extractor@v1',
        embeddingModelVersion: 'multilingual-e5-large',
        rawDbRefForSource: (source) => `/tmp/${source}/raw.db`,
      });

      expect(observations).toHaveLength(2);
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            observation_type: 'author',
            entity_kind_hint: 'person',
            surface_form: 'Alice Kim',
            source_connector: 'slack',
            source_raw_record_id: 'C123:1710000000.000100',
            source_raw_db_ref: '/tmp/slack/raw.db',
            scope_kind: 'channel',
            scope_id: 'C123',
          }),
          expect.objectContaining({
            observation_type: 'channel',
            entity_kind_hint: 'project',
            surface_form: koreanProjectAlpha,
            normalized_form: koreanProjectAlpha,
            source_connector: 'slack',
            source_raw_record_id: 'C123:1710000000.000100',
            source_raw_db_ref: '/tmp/slack/raw.db',
            scope_kind: 'channel',
            scope_id: 'C123',
          }),
        ])
      );
    });
  });

  describe('groupByChannel', () => {
    it('uses Slack channelId as the stable grouping key across channel renames', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'slack',
          sourceId: 'C123:1',
          channel: 'alpha-launch',
          metadata: {
            channelId: 'C123',
            channelName: 'alpha-launch',
          },
        }),
        makeItem({
          source: 'slack',
          sourceId: 'C123:2',
          channel: 'alpha-renamed',
          metadata: {
            channelId: 'C123',
            channelName: 'alpha-renamed',
          },
        }),
      ];

      const groups = groupByChannel(items);

      expect(groups.size).toBe(1);
      expect(Array.from(groups.keys())).toEqual(['slack:C123']);
      expect(groups.get('slack:C123')).toHaveLength(2);
    });
  });
});
