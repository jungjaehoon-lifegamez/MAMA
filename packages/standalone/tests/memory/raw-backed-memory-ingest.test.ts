import { describe, expect, it } from 'vitest';

import {
  buildRawBackedMemoryCandidates,
  ingestRawBackedMemoryCandidates,
} from '../../src/memory/raw-backed-memory-ingest.js';
import type { ChannelConfig, NormalizedItem } from '../../src/connectors/framework/types.js';
import type { RawBackedMemorySaveInput } from '../../src/memory/raw-backed-memory-ingest.js';

function makeItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    source: 'slack',
    sourceId: 'CTESTCHAN01:1710000000.000100',
    channel: 'slack:CTESTCHAN01',
    author: 'reviewer',
    content: 'Tinklestar next week feedback fixes are approved. Please proceed by Friday.',
    timestamp: new Date('2026-04-27T03:24:00Z'),
    type: 'message',
    metadata: {
      rawConnector: 'kagemusha',
      channelId: 'slack:CTESTCHAN01',
      channelName: 'project-review',
    },
    ...overrides,
  };
}

describe('Story M1R: Raw-backed connector memory ingest', () => {
  describe('AC #1: Connector evidence becomes scoped memory without LLM extraction', () => {
    it('builds project-scoped memory candidates with source observation links', () => {
      const channelConfig = {
        role: 'hub',
        project_entity_id: 'project_tinklestar',
        project_name: 'Tinklestar',
      } as ChannelConfig & Record<string, unknown>;

      const candidates = buildRawBackedMemoryCandidates([makeItem()], {
        channelConfig,
        entityObservationIdsBySourceId: new Map([
          ['CTESTCHAN01:1710000000.000100', ['obs_message_author', 'obs_message_channel']],
        ]),
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        topic: 'raw/project_tinklestar/slack_ctestchan01/ctestchan01_1710000000_000100',
        kind: 'decision',
        confidence: 0.72,
        scopes: [{ kind: 'project', id: 'project_tinklestar' }],
        source: {
          package: 'standalone',
          source_type: 'connector-raw-evidence',
          channel_id: 'slack:CTESTCHAN01',
          project_id: 'project_tinklestar',
        },
        eventDate: '2026-04-27',
        eventDateTime: Date.parse('2026-04-27T03:24:00Z'),
        entityObservationIds: ['obs_message_author', 'obs_message_channel'],
      });
      expect(candidates[0]?.summary).toContain('reviewer @ slack:CTESTCHAN01');
      expect(candidates[0]?.details).toContain('Deterministic raw-backed memory candidate');
    });

    it('drops chatter that has no work, decision, status, or schedule signal', () => {
      const candidates = buildRawBackedMemoryCandidates([
        makeItem({
          sourceId: 'noise:1',
          content: '감사합니다 확인했습니다', // Korean: chatter fixture
        }),
      ]);

      expect(candidates).toEqual([]);
    });

    it('does not promote unbound connector evidence to global memory', () => {
      const candidates = buildRawBackedMemoryCandidates([
        makeItem({
          sourceId: 'unbound:1',
          content: 'BC-77 feedback fix was delivered today.',
        }),
      ]);

      expect(candidates).toEqual([]);
    });

    it('does not classify Japanese confirmation boilerplate as a decision', () => {
      const channelConfig = {
        role: 'hub',
        project_entity_id: 'project_tinklestar',
      } as ChannelConfig & Record<string, unknown>;

      const candidates = buildRawBackedMemoryCandidates(
        [
          makeItem({
            sourceId: 'jp-confirm:1',
            content:
              '調整データありがとうございます。こちら確認いたします。ご確認のほどよろしくお願いいたします。',
          }),
        ],
        { channelConfig }
      );

      expect(candidates).toEqual([]);
    });

    it('drops Japanese checked/please-confirm boilerplate before memory save', () => {
      const channelConfig = {
        role: 'hub',
        project_entity_id: 'project_tinklestar',
      } as ChannelConfig & Record<string, unknown>;

      const candidates = buildRawBackedMemoryCandidates(
        [
          makeItem({
            sourceId: 'jp-confirm:2',
            content: '資料ありがとうございます。確認しました。ご確認お願いします。',
          }),
        ],
        { channelConfig }
      );

      expect(candidates).toEqual([]);
    });

    it('keeps strong Japanese decision wording as a decision', () => {
      const channelConfig = {
        role: 'hub',
        project_entity_id: 'project_tinklestar',
      } as ChannelConfig & Record<string, unknown>;

      const candidates = buildRawBackedMemoryCandidates(
        [
          makeItem({
            sourceId: 'jp-decision:1',
            content: 'Tinklestarの次回修正方針はA案を採用で決定しました。',
          }),
        ],
        { channelConfig }
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.kind).toBe('decision');
    });

    it('skips already-indexed topics and saves new candidates through the memory API boundary', async () => {
      const saved: RawBackedMemorySaveInput[] = [];

      const result = await ingestRawBackedMemoryCandidates(
        [
          makeItem({
            sourceId: 'existing:1',
            content: 'EX-123 작업은 내일까지 완료 예정입니다.', // Korean: work-token fixture
            memoryScopeKind: 'project',
            memoryScopeId: 'project_tinklestar',
          }),
          makeItem({
            sourceId: 'new:1',
            content: 'BC-77 feedback fix was delivered today.',
            memoryScopeKind: 'project',
            memoryScopeId: 'project_tinklestar',
          }),
        ],
        {
          memoryExists: (topic) => topic.includes('existing_1'),
          saveMemory: async (input) => {
            saved.push(input);
            return { success: true, id: `saved-${saved.length}` };
          },
        }
      );

      expect(result).toEqual({ candidatesBuilt: 2, saved: 1, skippedExisting: 1 });
      expect(saved).toHaveLength(1);
      expect(saved[0]?.topic).toContain('new_1');
      expect(saved[0]?.scopes).toEqual([{ kind: 'project', id: 'project_tinklestar' }]);
    });
  });
});
