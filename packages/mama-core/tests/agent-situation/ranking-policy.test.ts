import { describe, expect, it } from 'vitest';

import {
  AGENT_SITUATION_V0_POLICY_VERSION,
  getAgentSituationRankingPolicy,
  scoreAgentSituationCandidate,
} from '../../src/agent-situation/ranking-policy.js';
import type { AgentSituationCandidate } from '../../src/agent-situation/types.js';

function candidate(overrides: Partial<AgentSituationCandidate>): AgentSituationCandidate {
  return {
    ref: { kind: 'memory', id: 'mem-1' },
    kind: 'memory',
    title: 'Architecture note',
    summary: 'Use scoped provenance',
    timestamp_ms: Date.parse('2026-04-29T01:00:00.000Z'),
    confidence: 0.9,
    status: 'active',
    is_open_question: false,
    has_debate_edge: false,
    ...overrides,
  };
}

describe('Story M5: Agent situation ranking policy', () => {
  describe('AC #1: stable v0 registry', () => {
    it('returns the stable agent_situation.v0 policy by default', () => {
      const policy = getAgentSituationRankingPolicy();

      expect(policy.version).toBe(AGENT_SITUATION_V0_POLICY_VERSION);
      expect(policy.weights.pending_human_question).toBeGreaterThan(0);
    });
  });

  describe('AC #2: visible candidate scoring', () => {
    it('ranks open questions above ordinary old facts when other signals are equal', () => {
      const policy = getAgentSituationRankingPolicy();
      const openQuestion = scoreAgentSituationCandidate(
        candidate({
          ref: { kind: 'memory', id: 'question' },
          title: 'Should we expose raw search to workers?',
          summary: 'Need human answer before API work',
          is_open_question: true,
        }),
        policy
      );
      const oldFact = scoreAgentSituationCandidate(
        candidate({
          ref: { kind: 'memory', id: 'fact' },
          title: 'Fact',
          summary: 'Existing system uses SQLite',
          is_open_question: false,
        }),
        policy
      );

      expect(openQuestion.score).toBeGreaterThan(oldFact.score);
      expect(openQuestion.reasons).toContain('pending_open_question');
    });

    it('marks low-confidence or debated visible memory as a confidence gap', () => {
      const score = scoreAgentSituationCandidate(
        candidate({ confidence: 0.35, has_debate_edge: true }),
        getAgentSituationRankingPolicy()
      );

      expect(score.reasons).toContain('low_confidence_memory');
      expect(score.reasons).toContain('debated_visible_memory');
      expect(score.caveats).toContain('low_confidence_visible_memory');
    });

    it('does not emit reason strings that reveal hidden source counts', () => {
      const score = scoreAgentSituationCandidate(
        candidate({
          connector: 'slack',
          title: 'Blocked: deploy review',
          summary: 'Need review before release',
        }),
        getAgentSituationRankingPolicy()
      );

      expect(score.reasons.join(' ')).not.toMatch(/\bhidden\b|\bfiltered\b|\d+ .*outside/i);
    });
  });
});
