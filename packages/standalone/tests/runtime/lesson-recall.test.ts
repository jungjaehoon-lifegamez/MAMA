import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '@jungjaehoon/mama-core';
import { guidanceInSearchOrder } from '../../src/runtime/owner-runtime.js';

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
});
