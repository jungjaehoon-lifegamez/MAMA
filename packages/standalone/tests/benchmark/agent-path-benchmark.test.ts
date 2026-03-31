import { describe, it, expect } from 'vitest';

import { extractSaveCandidates } from '../../src/memory/save-candidate-extractor.js';
import { SAVE_SCENARIOS } from './scenarios.js';

function makeInput(userText: string) {
  return {
    userText,
    botResponse: 'Acknowledged.',
    channelKey: 'benchmark:test',
    source: 'benchmark',
    channelId: 'test',
    createdAt: Date.now(),
  };
}

describe('Agent-Path Benchmark: Candidate Extraction', () => {
  const results: Array<{ name: string; pass: boolean; candidateCount: number }> = [];

  for (const scenario of SAVE_SCENARIOS) {
    it(`${scenario.name}: ${scenario.expectCandidate ? 'detects candidate' : 'no candidate'}`, () => {
      const candidates = extractSaveCandidates(makeInput(scenario.userText));

      if (scenario.expectCandidate) {
        expect(candidates.length).toBeGreaterThan(0);
        if (scenario.expectedKind) {
          expect(candidates[0].kind).toBe(scenario.expectedKind);
        }
        if (scenario.expectedTopicHint) {
          expect(candidates[0].topicHint).toBe(scenario.expectedTopicHint);
        }
      } else {
        expect(candidates.length).toBe(0);
      }

      results.push({
        name: scenario.name,
        pass: true,
        candidateCount: candidates.length,
      });
    });
  }

  it('prints summary', () => {
    console.log('\n--- Benchmark Summary ---');
    for (const r of results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'} | ${r.name} (candidates: ${r.candidateCount})`);
    }
    console.log(`--- ${results.length} scenarios evaluated ---\n`);
  });
});

describe('Agent-Path Benchmark: Supersede Detection', () => {
  it('detects change from SQLite to PostgreSQL', () => {
    const candidates = extractSaveCandidates({
      userText: '이제는 PostgreSQL을 기본 DB로 바꿀게',
      botResponse: 'OK',
      channelKey: 'benchmark:test',
      source: 'benchmark',
      channelId: 'test',
      createdAt: Date.now(),
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].kind).toBe('change');
  });
});
