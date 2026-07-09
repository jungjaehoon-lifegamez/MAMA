/**
 * Unit tests for matchTriggers (Task 1 - registry-driven matcher).
 * Ports Kagemusha workflowMatchesMessage (keyword any/every + scope), WITHOUT the
 * approvedBy gate (G4) and WITHOUT any per-kind special-case branch (G1/PII).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { matchTriggers } from '../../src/operator/trigger-matcher.js';
import type { CreateTriggerInput } from '../../src/operator/trigger-types.js';
import type { OperatorChannelEvent } from '../../src/operator/operator-interfaces.js';

function trigger(over: Partial<CreateTriggerInput> = {}): CreateTriggerInput {
  return {
    id: over.id ?? 't1',
    kind: over.kind ?? 'some_agent_authored_kind',
    memoryQuery: over.memoryQuery ?? 'the recalled memory query',
    match: over.match ?? { keywords: ['report'], keywordMode: 'any', minConfidence: 0.7 },
    procedure: over.procedure ?? [],
    requiredEvidence: over.requiredEvidence ?? ['current_message'],
    authoredBy: 'agent',
    provenance: { createdFrom: 'agent-authored', note: '' },
  };
}

function event(over: Partial<OperatorChannelEvent> = {}): OperatorChannelEvent {
  return {
    id: over.id ?? 1,
    channel: over.channel ?? 'discord',
    channelId: over.channelId ?? 'c1',
    userId: over.userId ?? 'u1',
    role: over.role ?? 'user',
    content: over.content ?? 'please send the weekly report',
    createdAt: over.createdAt ?? 1000,
  };
}

describe('matchTriggers', () => {
  let db: SQLiteDatabase;
  let reg: TriggerRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    reg = new TriggerRegistry(db);
  });
  afterEach(() => reg.close());

  it('matches on keyword and carries the trigger memoryQuery/kind/evidence', () => {
    reg.create(trigger({ id: 't1', kind: 'k', memoryQuery: 'Q', match: { keywords: ['report'], keywordMode: 'any', minConfidence: 0.7 }, requiredEvidence: ['current_message'] }));
    const signals = matchTriggers(event({ content: 'the report is late' }), reg);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: 'k', memoryQuery: 'Q', requiredEvidence: ['current_message'], channelId: 'c1', occurredAt: 1000 });
  });

  it('no keyword match yields no signal', () => {
    reg.create(trigger({ match: { keywords: ['report'], keywordMode: 'any', minConfidence: 0.7 } }));
    expect(matchTriggers(event({ content: 'what time is lunch' }), reg)).toEqual([]);
  });

  it("keywordMode 'every' requires all keywords present", () => {
    reg.create(trigger({ id: 'te', match: { keywords: ['deploy', 'canary'], keywordMode: 'every', minConfidence: 0.7 } }));
    expect(matchTriggers(event({ content: 'deploy now' }), reg)).toEqual([]);
    expect(matchTriggers(event({ content: 'deploy the canary build' }), reg)).toHaveLength(1);
  });

  it('scope filter limits to configured channels', () => {
    reg.create(trigger({ id: 'ts', match: { keywords: ['report'], keywordMode: 'any', minConfidence: 0.7, scopeChannelIds: ['c1'] } }));
    expect(matchTriggers(event({ channelId: 'c2', content: 'report' }), reg)).toEqual([]);
    expect(matchTriggers(event({ channelId: 'c1', content: 'report' }), reg)).toHaveLength(1);
  });

  it('only fires on incoming (user) messages, not the operator own output', () => {
    reg.create(trigger());
    expect(matchTriggers(event({ role: 'assistant', content: 'report' }), reg)).toEqual([]);
  });

  it('matches purely on keywords/scope regardless of kind (no per-kind branch - G1)', () => {
    // an arbitrary kind with no special-casing must match on its keywords alone
    reg.create(trigger({ id: 'tk', kind: 'feedback_artifact_followup', match: { keywords: ['zzz'], keywordMode: 'any', minConfidence: 0.7 } }));
    expect(matchTriggers(event({ content: 'contains zzz token' }), reg)).toHaveLength(1);
  });
});
