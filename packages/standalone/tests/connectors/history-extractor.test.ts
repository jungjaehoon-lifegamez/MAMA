import { describe, expect, it } from 'vitest';

import {
  classifyItemsByRole,
  buildSpokeExtractionPrompt,
  buildProjectTruth,
  buildActivityExtractionPrompt,
} from '../../src/memory/history-extractor.js';
import type { NormalizedItem, ChannelConfig } from '../../src/connectors/framework/types.js';
import type { HubContextEntry, ProjectTruth } from '../../src/memory/history-extractor.js';

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

  describe('buildActivityExtractionPrompt', () => {
    it('builds activity extraction prompt with truth context header', () => {
      const activity: NormalizedItem[] = [
        makeItem({
          source: 'chatwork',
          channel: 'general',
          author: 'Alice',
          content: 'Login feature is now submitted for review',
          timestamp: new Date('2025-01-15T09:30:00Z'),
        }),
      ];

      const truth: ProjectTruth = {
        projects: {
          MyProject: {
            workUnits: {
              'Login Feature': { status: 'In Progress', column: 'In Progress', assigned: 'Alice' },
            },
          },
        },
      };

      const prompt = buildActivityExtractionPrompt(activity, truth);

      expect(prompt).toContain('You are a project historian');
      expect(prompt).toContain('Current project state');
      expect(prompt).toContain('MyProject/Login Feature: In Progress');
      expect(prompt).toContain('assigned: Alice');
      expect(prompt).toContain('chatwork:general');
      expect(prompt).toContain('Alice');
      expect(prompt).toContain('Login feature is now submitted for review');
      expect(prompt).toContain('JSON');
      expect(prompt).toContain('project');
      expect(prompt).toContain('confidence');
    });

    it('shows (none) when truth has no projects', () => {
      const activity: NormalizedItem[] = [makeItem({ source: 'chatwork', channel: 'general' })];
      const truth: ProjectTruth = { projects: {} };
      const prompt = buildActivityExtractionPrompt(activity, truth);
      expect(prompt).toContain('(none)');
    });

    it('includes activity items grouped by source:channel', () => {
      const activity: NormalizedItem[] = [
        makeItem({ source: 'chatwork', channel: 'general', content: 'msg1' }),
        makeItem({ source: 'slack', channel: 'general', content: 'msg2' }),
        makeItem({ source: 'chatwork', channel: 'general', content: 'msg3' }),
      ];
      const truth: ProjectTruth = { projects: {} };

      const prompt = buildActivityExtractionPrompt(activity, truth);

      expect(prompt).toContain('chatwork:general');
      expect(prompt).toContain('slack:general');
      expect(prompt).toContain('msg1');
      expect(prompt).toContain('msg2');
      expect(prompt).toContain('msg3');
    });

    it('returns a prompt even for empty activity', () => {
      const truth: ProjectTruth = { projects: {} };
      const prompt = buildActivityExtractionPrompt([], truth);
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('You are a project historian');
    });
  });

  describe('buildSpokeExtractionPrompt', () => {
    it('builds spoke extraction prompt with hub context', () => {
      const items: NormalizedItem[] = [
        makeItem({
          source: 'telegram',
          channel: 'team-chat',
          author: 'Carol',
          content: 'PostgreSQL migration is on track',
          timestamp: new Date('2025-01-15T11:00:00Z'),
        }),
      ];

      const hubContext: HubContextEntry[] = [
        {
          project: 'DataPlatform',
          workUnit: 'DB Migration',
          assignedTo: 'Alice',
          status: 'in-progress',
        },
      ];

      const prompt = buildSpokeExtractionPrompt(items, hubContext);

      expect(prompt).toContain('You are a historian');
      expect(prompt).toContain('Current active project context:');
      expect(prompt).toContain('DataPlatform');
      expect(prompt).toContain('DB Migration');
      expect(prompt).toContain('Alice');
      expect(prompt).toContain('in-progress');
      expect(prompt).toContain('telegram:team-chat');
      expect(prompt).toContain('Carol');
      expect(prompt).toContain('PostgreSQL migration is on track');
      // Should include HH:MM format
      expect(prompt).toMatch(/Carol\(\d{2}:\d{2}\)/);
      // Should request JSON output with same schema
      expect(prompt).toContain('JSON');
      expect(prompt).toContain('confidence');
    });

    it('handles empty hub context gracefully', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'telegram', channel: 'dm', content: 'quick update' }),
      ];

      const prompt = buildSpokeExtractionPrompt(items, []);

      expect(prompt).toContain('Current active project context:');
      expect(prompt).toContain('(none)');
      expect(prompt).toContain('quick update');
    });

    it('includes hub context entries without optional fields', () => {
      const hubContext: HubContextEntry[] = [{ project: 'SimpleProject' }];
      const prompt = buildSpokeExtractionPrompt([], hubContext);
      expect(prompt).toContain('SimpleProject');
    });

    it('includes truth context in prompt when provided', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'telegram', channel: 'team', content: 'task done' }),
      ];
      const hubContext: HubContextEntry[] = [{ project: 'MyProject' }];
      const truth: ProjectTruth = {
        projects: {
          MyProject: {
            workUnits: {
              'Feature X': { status: 'In Review', column: 'In Review', assigned: 'Dave' },
            },
          },
        },
      };

      const prompt = buildSpokeExtractionPrompt(items, hubContext, truth);

      expect(prompt).toContain('Project truth state');
      expect(prompt).toContain('MyProject/Feature X: In Review');
      expect(prompt).toContain('assigned: Dave');
    });

    it('omits truth context section when truth is undefined', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'telegram', channel: 'team', content: 'msg' }),
      ];
      const hubContext: HubContextEntry[] = [{ project: 'P' }];

      const prompt = buildSpokeExtractionPrompt(items, hubContext, undefined);

      expect(prompt).not.toContain('Project truth state');
    });

    it('omits truth context section when truth has no projects', () => {
      const items: NormalizedItem[] = [
        makeItem({ source: 'telegram', channel: 'team', content: 'msg' }),
      ];
      const hubContext: HubContextEntry[] = [{ project: 'P' }];
      const truth: ProjectTruth = { projects: {} };

      const prompt = buildSpokeExtractionPrompt(items, hubContext, truth);

      expect(prompt).not.toContain('Project truth state');
    });
  });
});
