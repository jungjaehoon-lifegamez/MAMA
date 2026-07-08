/**
 * Task 5 - the decisive real-corpus e2e (RUN_LLM_EVAL-gated).
 *
 * Runs the whole loop against the REAL polled corpus (~/.kagemusha/kagemusha.db, read-only):
 *   author (real agent) -> match/fire -> observe.
 * Proves the agent grows a trigger library from real recurring patterns and that those
 * triggers fire on real messages. This is the e2e proof, not a synthetic harness.
 *
 * PRIVACY: the corpus is opened READ-ONLY (never mutated). Only AGGREGATE counts are printed.
 * The authored triggers (which may contain personal terms) are written to a LOCAL, gitignored
 * file under ~/.mama - never committed, never dumped to stdout in full.
 *
 * Run: RUN_LLM_EVAL=1 npx vitest run tests/operator/trigger-loop-e2e.eval.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { authorTriggers, askAgentCLI } from '../../src/operator/trigger-author.js';
import { matchTriggers } from '../../src/operator/trigger-matcher.js';
import type { OperatorChannelEvent } from '../../src/operator/operator-interfaces.js';

const RUN = process.env.RUN_LLM_EVAL === '1';
const CORPUS = join(homedir(), '.kagemusha', 'kagemusha.db');
const CHANNELS = 4;
const AUTHOR_WINDOW = 30; // recent user messages the agent authors from, per channel
const REPLAY_WINDOW = 300; // user messages replayed through the matcher, per channel

interface Row {
  id: number;
  channel: string;
  channel_id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: number;
}

function toEvent(r: Row): OperatorChannelEvent {
  return {
    id: r.id,
    channel: r.channel,
    channelId: r.channel_id,
    userId: r.user_id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: r.content,
    createdAt: r.created_at,
  };
}

describe.skipIf(!RUN)('trigger loop e2e on the real corpus', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;

  beforeEach(() => {
    db = new Database(':memory:'); // isolated trigger store (NOT the real DB)
    reg = new TriggerRegistry(db);
  });
  afterEach(() => reg.close());

  it(
    'agent authors triggers from real recurring patterns, and they fire on real messages',
    async () => {
      const corpus = new BetterSqlite3(CORPUS, { readonly: true, fileMustExist: true });
      const topChannels = corpus
        .prepare(
          `SELECT channel_id FROM channel_messages WHERE role='user'
           GROUP BY channel_id ORDER BY COUNT(*) DESC LIMIT ?`
        )
        .all(CHANNELS)
        .map((r) => (r as { channel_id: string }).channel_id);

      let authoredTotal = 0;
      let firesTotal = 0;
      let firedOutsideAuthorWindow = 0;
      const perChannel: { authored: number; replayed: number; fires: number }[] = [];
      const reviewDump: { channelIdx: number; authored: unknown[] }[] = [];

      for (let ci = 0; ci < topChannels.length; ci++) {
        const channelId = topChannels[ci];
        const recent = (
          corpus
            .prepare(
              `SELECT * FROM channel_messages WHERE channel_id=? AND role='user'
               ORDER BY created_at DESC LIMIT ?`
            )
            .all(channelId, AUTHOR_WINDOW) as Row[]
        )
          .reverse()
          .map(toEvent);

        const created = await authorTriggers(recent, reg, askAgentCLI, { note: `e2e-ch${ci}` });
        authoredTotal += created.length;
        reviewDump.push({
          channelIdx: ci,
          authored: created.map((t) => ({ kind: t.kind, keywords: t.match.keywords, memoryQuery: t.memoryQuery })),
        });

        const authorIds = new Set(recent.map((e) => e.id));
        const replay = (
          corpus
            .prepare(
              `SELECT * FROM channel_messages WHERE channel_id=? AND role='user'
               ORDER BY created_at DESC LIMIT ?`
            )
            .all(channelId, REPLAY_WINDOW) as Row[]
        ).map(toEvent);

        let fires = 0;
        for (const ev of replay) {
          const signals = matchTriggers(ev, reg);
          if (signals.length > 0) {
            fires += 1;
            if (!authorIds.has(ev.id)) firedOutsideAuthorWindow += 1;
          }
        }
        firesTotal += fires;
        perChannel.push({ authored: created.length, replayed: replay.length, fires });
      }
      corpus.close();

      // Local, gitignored review file (owner-only) - never committed.
      const reviewDir = join(homedir(), '.mama', 'operator');
      mkdirSync(reviewDir, { recursive: true });
      const reviewPath = join(reviewDir, 'trigger-e2e-review.json');
      writeFileSync(reviewPath, JSON.stringify({ perChannel, triggers: reviewDump }, null, 2), 'utf8');

      // AGGREGATE ONLY to stdout.
      // eslint-disable-next-line no-console
      console.log(
        'E2E AGGREGATE:',
        JSON.stringify(
          {
            channels: topChannels.length,
            authoredTotal,
            activeTriggers: reg.listActive().length,
            firesTotal,
            firedOutsideAuthorWindow,
            perChannel,
            reviewFile: reviewPath,
          },
          null,
          2
        )
      );

      // GO: the agent authored >=1 trigger from real data, and triggers fired on real messages.
      expect(authoredTotal).toBeGreaterThanOrEqual(1);
      expect(firesTotal).toBeGreaterThanOrEqual(1);
    },
    600000
  );
});
