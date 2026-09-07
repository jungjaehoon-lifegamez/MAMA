import { describe, expect, it } from 'vitest';

import {
  evaluateJudgment,
  parseModelJudgment,
  type JudgmentFixture,
  type ModelJudgment,
} from '../../evals/report-judgment/evaluator.js';

const fixture: JudgmentFixture = {
  id: 'adversarial',
  asOf: '2026-09-07T14:30:00+09:00',
  evidence: [
    {
      ref: 'sep-pending',
      observedAt: '2026-09-07T09:00:00+09:00',
      period: '2026-09',
      text: 'September is pending; payment status is absent.',
    },
    {
      ref: 'oct-upcoming',
      observedAt: '2026-09-07T09:00:00+09:00',
      period: '2026-10',
      text: 'A separate October occurrence is upcoming.',
    },
    {
      ref: 'future-receipt',
      observedAt: '2026-09-07T15:29:00+09:00',
      period: '2026-09',
      text: 'Receipt issued after the as-of.',
    },
    {
      ref: 'retries',
      observedAt: '2026-09-07T14:00:00+09:00',
      period: '2026-09',
      text: 'Six retries occurred on three distinct dates.',
    },
  ],
  expected: [
    {
      label: 'september-payment-state',
      disposition: 'unconfirmed',
      period: '2026-09',
      requiredRefs: ['sep-pending'],
    },
    {
      label: 'october-work-is-separate',
      disposition: 'confirmed',
      period: '2026-10',
      requiredRefs: ['oct-upcoming'],
    },
    {
      label: 'consecutive-day-claim',
      disposition: 'unsupported',
      period: '2026-09',
      requiredRefs: ['retries'],
    },
  ],
};

function validJudgment(): ModelJudgment {
  return {
    fixtureId: fixture.id,
    conclusions: fixture.expected.map((item) => ({
      label: item.label,
      disposition: item.disposition,
      period: item.period,
      evidenceRefs: item.requiredRefs,
      explanation: 'Structured fixture judgment.',
    })),
    coverageGaps: [],
    report: 'Synthetic report.',
  };
}

describe('TG-03/TG-04/TG-06 report judgment evaluator', () => {
  it('accepts exact hand-labelled conclusions with as-of-valid evidence', () => {
    expect(evaluateJudgment(fixture, validJudgment())).toMatchObject({
      passed: true,
      matchedConclusions: 3,
      expectedConclusions: 3,
    });
  });

  it('rejects unsupported completion and evidence observed after the as-of', () => {
    const judgment = validJudgment();
    judgment.conclusions[0] = {
      ...judgment.conclusions[0],
      disposition: 'completed',
      evidenceRefs: ['sep-pending', 'future-receipt'],
    };
    expect(evaluateJudgment(fixture, judgment).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'wrong_disposition', label: 'september-payment-state' }),
        expect.objectContaining({ code: 'future_evidence_ref', label: 'september-payment-state' }),
      ])
    );
  });

  it('rejects month conflation and naive retry-to-date counting', () => {
    const judgment = validJudgment();
    judgment.conclusions[0] = { ...judgment.conclusions[0], period: '2026-10' };
    judgment.conclusions[2] = { ...judgment.conclusions[2], disposition: 'confirmed' };
    expect(evaluateJudgment(fixture, judgment).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'wrong_period', label: 'september-payment-state' }),
        expect.objectContaining({ code: 'wrong_disposition', label: 'consecutive-day-claim' }),
      ])
    );
  });

  it('parses a fenced structured response without scoring prose keywords', () => {
    const parsed = parseModelJudgment(`\`\`\`json\n${JSON.stringify(validJudgment())}\n\`\`\``);
    expect(parsed.fixtureId).toBe('adversarial');
    expect(parsed.report).toBe('Synthetic report.');
  });
});
