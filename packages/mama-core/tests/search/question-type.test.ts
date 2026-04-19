import { describe, expect, it } from 'vitest';

import { classifyQuestionType } from '../../src/search/question-type.js';

describe('Phase 3 Task 10: question type classifier', () => {
  it('classifies correction questions', () => {
    expect(classifyQuestionType('fix the stale case status')).toBe('correction');
  });

  it('classifies artifact questions', () => {
    expect(classifyQuestionType('find the Obsidian doc for this case')).toBe('artifact');
  });

  it('classifies timeline questions', () => {
    expect(classifyQuestionType('when did this happen before 2026-04-18')).toBe('timeline');
  });

  it('classifies status questions', () => {
    expect(classifyQuestionType('what is the current progress now')).toBe('status');
  });

  it('classifies decision-reason questions', () => {
    expect(classifyQuestionType('why did we choose this because the reason matters')).toBe(
      'decision_reason'
    );
  });

  it('classifies how-to questions', () => {
    expect(classifyQuestionType('how to configure the ranker')).toBe('how_to');
  });

  it('falls back to unknown', () => {
    expect(classifyQuestionType('banana window silver')).toBe('unknown');
  });

  it('prioritizes correction over how-to', () => {
    expect(classifyQuestionType('how to fix the wrong case merge')).toBe('correction');
  });
});
