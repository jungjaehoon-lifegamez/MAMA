/**
 * LLM eval for Task 3 (real claude CLI) - the mechanism check: does the agent, given a
 * window with a RECURRING situation + one-offs, author a trigger capturing the recurring one?
 * Gated behind RUN_LLM_EVAL=1 so normal CI stays deterministic and offline.
 * Run: RUN_LLM_EVAL=1 npx vitest run tests/operator/trigger-author.eval.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { authorTriggers, askAgentCLI } from '../../src/operator/trigger-author.js';
import type { OperatorChannelEvent } from '../../src/operator/operator-interfaces.js';

const RUN = process.env.RUN_LLM_EVAL === '1';

function ev(content: string, id: number): OperatorChannelEvent {
  return { id, channel: 'discord', channelId: 'c1', userId: 'u1', role: 'user', content, createdAt: id * 100 };
}

describe.skipIf(!RUN)('trigger-author LLM eval (real claude CLI)', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    reg = new TriggerRegistry(db);
  });
  afterEach(() => reg.close());

  it(
    'authors >=1 trigger for a recurring situation using the real agent',
    async () => {
      const events = [
        ev('can you update the weekly status report?', 1),
        ev('the weekly report needs refreshing before the sync', 2),
        ev("pls refresh this week's status report", 3),
        ev('what time is lunch tomorrow', 4),
        ev('the wifi password changed', 5),
      ];
      const created = await authorTriggers(events, reg, askAgentCLI);
      // eslint-disable-next-line no-console
      console.log(
        'EVAL authored triggers:',
        JSON.stringify(
          created.map((t) => ({ kind: t.kind, keywords: t.match.keywords, memoryQuery: t.memoryQuery })),
          null,
          2
        )
      );
      expect(created.length).toBeGreaterThanOrEqual(1);
      const joined = created
        .map((t) => `${t.kind} ${t.match.keywords.join(' ')} ${t.memoryQuery}`.toLocaleLowerCase())
        .join(' ');
      expect(joined).toContain('report');
    },
    120000
  );
});
