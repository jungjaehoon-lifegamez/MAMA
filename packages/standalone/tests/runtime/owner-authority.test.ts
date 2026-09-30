import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type {
  ActionContext,
  ActionRegistration,
  DatabaseInstance,
  JudgmentAccess,
} from '@jungjaehoon/mama-core';
import {
  guardOwnerRules,
  isOwnerChatRef,
  ownerRuleIds,
} from '../../src/runtime/owner-authority.js';

const OWNER = 'owner-test';

/** Rules as the daemon stores them: the host writes the turn's message ref into provenance. */
function database(): DatabaseInstance {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE decisions (id TEXT PRIMARY KEY, kind TEXT, provenance_json TEXT)');
  const insert = db.prepare('INSERT INTO decisions (id, kind, provenance_json) VALUES (?, ?, ?)');
  const rows: Array<[string, string, string | null]> = [
    ['owner-telegram', 'lesson', JSON.stringify({ source_message_ref: 'telegram:-100123:7280' })],
    ['owner-slack', 'preference', JSON.stringify({ source_message_ref: 'slack:C1:1790.12' })],
    ['owner-discord', 'constraint', JSON.stringify({ source_message_ref: 'discord:9:42' })],
    ['learned', 'lesson', JSON.stringify({ source_message_ref: 'source_delta:abc' })],
    ['by-subagent', 'lesson', JSON.stringify({ source_message_ref: 'subagent:thread-1' })],
    ['by-hand', 'lesson', null],
    ['owner-fact', 'fact', JSON.stringify({ source_message_ref: 'telegram:-100123:1' })],
  ];
  for (const row of rows) insert.run(...row);
  return db as unknown as DatabaseInstance;
}

/** Stands in for core memory.save / memory.retire and records what reached it. */
function inner(name: 'memory.save' | 'memory.retire') {
  const calls: unknown[] = [];
  const registration: ActionRegistration = {
    contract: { name, summary: name, inputSchema: { type: 'object' } },
    exec: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  };
  return { calls, registration };
}

function turn(sourceMessageRef: string, principalId = OWNER): ActionContext {
  const access: JudgmentAccess = { principalId, agentId: 'agent', scopes: [], actions: [] };
  return { access, session: { sourceMessageRef } };
}

describe('owner rules keep the owner as their only author (owner, 2026-10-01)', () => {
  it('tells owner-chat refs from observation, subagent and missing refs', () => {
    for (const ref of ['telegram:-100123:7280', 'discord:9:42', 'slack:C1:1790.12']) {
      expect(isOwnerChatRef(ref)).toBe(true);
    }
    for (const ref of ['source_delta:abc', 'record:source_delta:abc:1', 'subagent:thread-1', '']) {
      expect(isOwnerChatRef(ref)).toBe(false);
    }
    expect(isOwnerChatRef(undefined)).toBe(false);
    const ids = ownerRuleIds(database(), [
      'owner-telegram',
      'owner-slack',
      'owner-discord',
      'learned',
      'by-subagent',
      'by-hand',
      'owner-fact',
      'missing',
    ]);
    // A fact is not a rule, and nothing is inferred for a rule saved without a turn.
    expect([...ids].sort()).toEqual(['owner-discord', 'owner-slack', 'owner-telegram']);
  });

  it('refuses a source-change turn or a subagent that replaces or retires an owner rule', async () => {
    const db = database();
    const save = inner('memory.save');
    const retire = inner('memory.retire');
    const guardedSave = guardOwnerRules(save.registration, db, OWNER);
    const guardedRetire = guardOwnerRules(retire.registration, db, OWNER);
    for (const ref of ['source_delta:abc', 'subagent:thread-1']) {
      await expect(
        guardedSave.exec(
          { kind: 'lesson', replaces: [{ id: 'owner-telegram', reason: 'x' }] },
          turn(ref)
        )
      ).rejects.toMatchObject({
        name: 'denied',
        message: expect.stringContaining('owner-telegram'),
      });
      await expect(
        guardedRetire.exec({ memory_id: 'owner-slack', status: 'stale', reason: 'x' }, turn(ref))
      ).rejects.toMatchObject({ name: 'denied' });
    }
    expect(save.calls).toEqual([]);
    expect(retire.calls).toEqual([]);
  });

  it('lets any turn save a lesson and change learned rules', async () => {
    const db = database();
    const save = inner('memory.save');
    const retire = inner('memory.retire');
    const observation = turn('source_delta:abc');
    await guardOwnerRules(save.registration, db, OWNER).exec({ kind: 'lesson' }, observation);
    await guardOwnerRules(save.registration, db, OWNER).exec(
      { kind: 'lesson', replaces: [{ id: 'learned', reason: 'sharper' }] },
      observation
    );
    await guardOwnerRules(retire.registration, db, OWNER).exec(
      { memory_id: 'by-subagent', status: 'stale', reason: 'x' },
      observation
    );
    expect(save.calls).toHaveLength(2);
    expect(retire.calls).toHaveLength(1);
  });

  it('lets an owner-chat turn change owner rules, and nobody else', async () => {
    const db = database();
    const retire = inner('memory.retire');
    const guarded = guardOwnerRules(retire.registration, db, OWNER);
    await guarded.exec(
      { memory_id: 'owner-telegram', status: 'stale', reason: 'owner withdrew it' },
      turn('telegram:-100123:9000')
    );
    expect(retire.calls).toHaveLength(1);
    // Another principal's turn, or a replay of source messages, is not the owner speaking.
    await expect(
      guarded.exec(
        { memory_id: 'owner-telegram', status: 'stale', reason: 'x' },
        turn('telegram:-100123:9001', 'member')
      )
    ).rejects.toMatchObject({ name: 'denied' });
    const replay = turn('telegram:-100123:9002');
    replay.session = { ...replay.session, replaySourceEndMs: 1 };
    await expect(
      guarded.exec({ memory_id: 'owner-telegram', status: 'stale', reason: 'x' }, replay)
    ).rejects.toMatchObject({ name: 'denied' });
  });
});
