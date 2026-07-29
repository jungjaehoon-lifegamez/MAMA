/**
 * The two compiled forms of one rule.
 *
 * A rule that must exist as both a boolean and a SQL predicate can drift between its two
 * forms exactly the way three hand-written copies drifted. The difference is that these
 * two live in one file and this differential runs them against the same rows, so a change
 * to one that does not fit the other fails here rather than in production six weeks later.
 *
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  channelGrantClause,
  isChannelGranted,
  type ChannelGrant,
} from '../../src/context-compile/channel-grant.js';

let db: Database.Database;

const ROWS: Array<{ id: string; connector: string; channel: string | null }> = [
  { id: 'r1', connector: 'chat', channel: 'C001' },
  { id: 'r2', connector: 'chat', channel: 'C002' },
  { id: 'r3', connector: 'chat', channel: 'C999' },
  { id: 'r4', connector: 'board', channel: 'b-1' },
  { id: 'r5', connector: 'board', channel: 'b-2' },
  { id: 'r6', connector: 'mail', channel: 'inbox' },
  { id: 'r7', connector: 'chat', channel: '' },
  // The one case the two forms provably disagreed on was unreachable from both sides
  // because no fixture anywhere had a NULL channel.
  { id: 'r8', connector: 'chat', channel: null },
  { id: 'r9', connector: 'mail', channel: null },
];

const GRANTS: Array<{ name: string; grant: ChannelGrant; requested?: string[] }> = [
  { name: 'one channel', grant: { chat: ['C001'] } },
  { name: 'several channels', grant: { chat: ['C001', 'C002'] } },
  { name: 'two connectors', grant: { chat: ['C001'], board: ['b-1'] } },
  { name: 'empty for a connector', grant: { chat: [] } },
  { name: 'connector not in the index', grant: { absent: ['x'] } },
  {
    name: 'granted but not requested',
    grant: { chat: ['C001'], board: ['b-1'] },
    requested: ['chat'],
  },
  { name: 'requested but not granted', grant: { chat: ['C001'] }, requested: ['board'] },
  { name: 'channel that is not in the grant', grant: { chat: ['C404'] } },
  { name: 'duplicate entries', grant: { chat: ['C001', 'C001'] } },
  { name: 'malformed grant value', grant: { chat: 'C001' as never } },
  { name: 'malformed channel entry', grant: { chat: [null as never, 'C001'] } },
];

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE ev (id TEXT PRIMARY KEY, connector TEXT NOT NULL, channel TEXT)');
  const insert = db.prepare('INSERT INTO ev (id, connector, channel) VALUES (?, ?, ?)');
  for (const row of ROWS) insert.run(row.id, row.connector, row.channel);
});

afterEach(() => db.close());

describe('the boolean and SQL forms of the grant agree', () => {
  for (const { name, grant, requested } of GRANTS) {
    it(`agrees for: ${name}`, () => {
      const clause = channelGrantClause(grant, requested, {
        connector: 'connector',
        channel: 'channel',
      });
      const bySql = new Set(
        clause === null
          ? []
          : (
              db.prepare(`SELECT id FROM ev WHERE ${clause.sql}`).all(...clause.params) as Array<{
                id: string;
              }>
            ).map((row) => row.id)
      );
      const byBoolean = new Set(
        ROWS.filter(
          (row) =>
            (requested === undefined || requested.includes(row.connector)) &&
            isChannelGranted(row.connector, row.channel, grant)
        ).map((row) => row.id)
      );

      expect([...bySql].sort()).toEqual([...byBoolean].sort());
    });
  }
});

describe('the rule itself', () => {
  it('denies a connector absent from the grant', () => {
    expect(isChannelGranted('mail', 'inbox', { chat: ['C001'] })).toBe(false);
  });

  // "Granted the connector but no channel of it" is not a useful state, and reading it as
  // "all channels" is how a grant becomes a wildcard.
  it('denies a connector granted with no channels', () => {
    expect(isChannelGranted('chat', 'C001', { chat: [] })).toBe(false);
    expect(
      channelGrantClause({ chat: [] }, undefined, { connector: 'c', channel: 'ch' })
    ).toBeNull();
  });

  it('denies a row with no channel at all', () => {
    expect(isChannelGranted('chat', null, { chat: ['C001'] })).toBe(false);
    expect(isChannelGranted('chat', '', { chat: ['C001'] })).toBe(false);
  });

  it('does not approximate', () => {
    expect(isChannelGranted('chat', 'C00', { chat: ['C001'] })).toBe(false);
    expect(isChannelGranted('chat', 'C001 ', { chat: ['C001'] })).toBe(false);
    expect(isChannelGranted('Chat', 'C001', { chat: ['C001'] })).toBe(false);
  });

  // Returning an empty clause instead of null would be a WHERE that matches everything -
  // a visibility rule turning into a full scan at the moment it should have refused.
  it('returns null rather than an empty clause when nothing is readable', () => {
    expect(channelGrantClause({}, undefined, { connector: 'c', channel: 'ch' })).toBeNull();
    expect(
      channelGrantClause({ chat: ['C001'] }, [], { connector: 'c', channel: 'ch' })
    ).toBeNull();
  });
});
