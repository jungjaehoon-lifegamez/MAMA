/**
 * Unit tests for trigger authoring (Task 3 - G1+G3: the agent writes its own triggers).
 * The agent is INJECTED (askAgent stub) so this is deterministic; the real claude-CLI
 * agent is exercised by the LLM eval (RUN_LLM_EVAL). Validation is STRUCTURAL only -
 * unknown kind/action VALUES are accepted (never narrowed to a catalog), or G3 re-freezes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { authorTriggers, parseTriggerSpecs, validateTriggerSpec } from '../../src/operator/trigger-author.js';
import type { OperatorChannelEvent } from '../../src/operator/operator-interfaces.js';

const cannedSpec = JSON.stringify([
  {
    kind: 'weird_new_kind_the_agent_invented',
    memoryQuery: 'recall the deploy rollback preference',
    match: { keywords: ['rollback'], keywordMode: 'any', minConfidence: 0.7 },
    procedure: [{ action: 'novel_action', description: 'do the thing' }],
    requiredEvidence: ['current_message'],
  },
]);

function ev(content: string, id = 1): OperatorChannelEvent {
  return { id, channel: 'discord', channelId: 'c1', userId: 'u1', role: 'user', content, createdAt: id * 100 };
}

describe('authorTriggers', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    reg = new TriggerRegistry(db);
  });
  afterEach(() => reg.close());

  it('persists an agent-authored trigger with open kind/action (G3)', async () => {
    const created = await authorTriggers([ev('rollback again'), ev('another rollback', 2)], reg, async () => cannedSpec);
    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe('weird_new_kind_the_agent_invented'); // arbitrary value accepted, not an enum
    expect(created[0].procedure[0].action).toBe('novel_action');
    expect(created[0].authoredBy).toBe('agent');
    expect(reg.listActive().map((t) => t.id)).toContain(created[0].id);
  });

  it('throws on unparseable agent output (no-fallback)', async () => {
    await expect(
      authorTriggers([ev('x')], reg, async () => 'maybe a trigger about rollbacks would be nice')
    ).rejects.toThrow();
  });

  it('dedups against an existing active trigger with the same keyword set', async () => {
    reg.create({
      id: 'existing',
      kind: 'k',
      memoryQuery: 'q',
      match: { keywords: ['rollback'], keywordMode: 'any', minConfidence: 0.7 },
      procedure: [],
      requiredEvidence: [],
      authoredBy: 'agent',
      provenance: { createdFrom: 'seed', note: '' },
    });
    const created = await authorTriggers([ev('rollback')], reg, async () => cannedSpec);
    expect(created).toHaveLength(0);
  });

  it('parseTriggerSpecs extracts the JSON array even with surrounding prose', () => {
    const specs = parseTriggerSpecs(`Sure, here you go:\n${cannedSpec}\nHope that helps.`);
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe('weird_new_kind_the_agent_invented');
  });

  it('validateTriggerSpec accepts unknown kind/action VALUES, rejects malformed SHAPE', () => {
    expect(() =>
      validateTriggerSpec({
        kind: 'anything_at_all',
        memoryQuery: 'q',
        match: { keywords: ['x'], keywordMode: 'any', minConfidence: 0.5 },
        procedure: [{ action: 'whatever_action', description: 'd' }],
        requiredEvidence: [],
      })
    ).not.toThrow();
    expect(() => validateTriggerSpec({ kind: 'k' })).toThrow(); // missing required fields
    expect(() =>
      validateTriggerSpec({ kind: '', memoryQuery: 'q', match: { keywords: [], keywordMode: 'any', minConfidence: 0.5 }, procedure: [], requiredEvidence: [] })
    ).toThrow(); // empty kind + empty keywords = malformed shape
  });
});
