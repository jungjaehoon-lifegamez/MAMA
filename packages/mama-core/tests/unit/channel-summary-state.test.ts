import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';

import {
  getChannelSummaryState,
  recordChannelAudit,
} from '../../src/memory/channel-summary-state-store.js';
import { getChannelSummary, upsertChannelSummary } from '../../src/memory/channel-summary-store.js';

const TEST_DB = '/tmp/test-channel-summary-state.db';

describe('channel summary state reducer', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });

    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;

    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('should accumulate active decisions and milestones instead of overwriting the whole summary', async () => {
    await recordChannelAudit({
      channelKey: 'telegram:7026976631',
      turnId: 'turn_1',
      topic: 'database_choice',
      scopeRefs: [{ kind: 'channel', id: 'telegram:7026976631' }],
      ack: {
        status: 'applied',
        action: 'save',
        event_ids: [],
      },
      savedMemories: [
        {
          id: 'decision_db_1',
          topic: '데이터베이스 선택',
          summary: 'SQLite를 기본 DB로 사용한다.',
        },
      ],
    });

    await recordChannelAudit({
      channelKey: 'telegram:7026976631',
      turnId: 'turn_2',
      topic: 'benchmark_direction',
      scopeRefs: [{ kind: 'channel', id: 'telegram:7026976631' }],
      ack: {
        status: 'applied',
        action: 'save',
        event_ids: [],
      },
      savedMemories: [
        {
          id: 'decision_bench_1',
          topic: 'memory_benchmark_research',
          summary: 'LongMemEval-S를 참고하되 MAMA 커스텀 테스트셋을 설계한다.',
        },
      ],
    });

    const state = await getChannelSummaryState('telegram:7026976631');
    const summary = await getChannelSummary('telegram:7026976631');

    expect(state?.active_topic).toBe('memory_benchmark_research');
    expect(state?.active_decisions).toHaveLength(2);
    expect(state?.active_decisions.map((entry) => entry.topic)).toEqual([
      'memory_benchmark_research',
      '데이터베이스 선택',
    ]);
    expect(state?.recent_milestones).toHaveLength(2);
    expect(summary?.summary_markdown).toContain('데이터베이스 선택');
    expect(summary?.summary_markdown).toContain('memory_benchmark_research');
  });

  it('should keep failed and skipped audit outcomes in state without replacing active decisions', async () => {
    await recordChannelAudit({
      channelKey: 'telegram:7026976631',
      turnId: 'turn_3',
      topic: 'memory_audit',
      scopeRefs: [{ kind: 'channel', id: 'telegram:7026976631' }],
      ack: {
        status: 'skipped',
        action: 'no_op',
        event_ids: [],
        reason: 'no durable change in this turn',
      },
    });

    await recordChannelAudit({
      channelKey: 'telegram:7026976631',
      turnId: 'turn_4',
      topic: 'memory_audit',
      scopeRefs: [{ kind: 'channel', id: 'telegram:7026976631' }],
      ack: {
        status: 'failed',
        action: 'save',
        event_ids: [],
        reason: 'mama_save invoked but nothing persisted',
      },
    });

    const state = await getChannelSummaryState('telegram:7026976631');
    const summary = await getChannelSummary('telegram:7026976631');

    expect(state?.active_decisions.map((entry) => entry.topic)).toContain('데이터베이스 선택');
    expect(state?.recent_audit_outcomes[0]?.status).toBe('failed');
    expect(state?.recent_audit_outcomes[1]?.status).toBe('skipped');
    expect(summary?.summary_markdown).toContain('Audit Signals');
    expect(summary?.summary_markdown).toContain('failed');
    expect(summary?.summary_markdown).toContain('skipped');
  });

  it('should preserve legacy channel summary context when state does not exist yet', async () => {
    await upsertChannelSummary({
      channelKey: 'telegram:legacy',
      summaryMarkdown:
        '## Channel Summary\n- Legacy context: we were comparing benchmark directions.',
      deltaHash: 'legacy-seed',
    });

    await recordChannelAudit({
      channelKey: 'telegram:legacy',
      turnId: 'turn_legacy_1',
      topic: 'benchmark_direction',
      scopeRefs: [{ kind: 'channel', id: 'telegram:legacy' }],
      ack: {
        status: 'applied',
        action: 'save',
        event_ids: [],
      },
      savedMemories: [
        {
          id: 'decision_legacy_bench',
          topic: 'memory_benchmark_research',
          summary: '커스텀 테스트셋을 기본 평가 구조로 삼는다.',
        },
      ],
    });

    const summary = await getChannelSummary('telegram:legacy');
    expect(summary?.summary_markdown).toContain('Legacy context');
    expect(summary?.summary_markdown).toContain('memory_benchmark_research');
  });
});
