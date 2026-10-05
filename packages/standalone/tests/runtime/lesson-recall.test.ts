import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '@jungjaehoon/mama-core';
import { guidanceInSearchOrder, ownerRuleLines } from '../../src/runtime/owner-runtime.js';

function record(id: string, kind: MemoryRecord['kind'], status: MemoryRecord['status'] = 'active') {
  return { id, kind, status, topic: id, summary: `${id} summary` } as MemoryRecord;
}

describe('lesson recall', () => {
  it('keeps active guidance in the search order and never promotes a kind', () => {
    const records = [
      record('lesson-relevant', 'lesson'),
      record('lesson-second', 'lesson'),
      record('workflow-unrelated', 'workflow'),
      record('lesson-retired', 'lesson', 'superseded'),
      record('work-item', 'commitment' as MemoryRecord['kind']),
    ];
    // The search ranked two relevant lessons first; the lone workflow came last.
    const picked = guidanceInSearchOrder(
      ['work-item', 'lesson-relevant', 'lesson-retired', 'lesson-second', 'workflow-unrelated'],
      records,
      2,
      new Set(['lesson-second'])
    );
    expect(picked.map((lesson) => [lesson.id, lesson.ownerRule])).toEqual([
      ['lesson-relevant', false],
      ['lesson-second', true],
    ]);
  });

  it("indexes the owner's rules only, by when they apply", () => {
    const rules = [
      { ...record('rule-close', 'workflow'), applies_when: 'when an item is fixed' },
      record('rule-plain', 'preference'),
      { ...record('lesson-learned', 'lesson'), applies_when: 'when a card moves' },
    ];
    expect(ownerRuleLines(rules, new Set(['rule-close', 'rule-plain']))).toEqual([
      { topic: 'rule-close', when: 'when an item is fixed' },
      // A rule saved without an applies-when line shows its own words.
      { topic: 'rule-plain', when: 'rule-plain summary' },
    ]);
  });
});
