import { describe, it, expect } from 'vitest';
import { MEMORY_KINDS } from '../../src/memory/types.js';
import type { MemoryKind } from '../../src/memory/types.js';

describe('MEMORY_KINDS', () => {
  it('includes task and schedule kinds for v0.17 connector extraction', () => {
    expect(MEMORY_KINDS).toContain('task');
    expect(MEMORY_KINDS).toContain('schedule');
  });

  it('task and schedule are valid MemoryKind values', () => {
    const task: MemoryKind = 'task';
    const schedule: MemoryKind = 'schedule';
    expect(task).toBe('task');
    expect(schedule).toBe('schedule');
  });

  it('preserves all existing kinds', () => {
    expect(MEMORY_KINDS).toContain('decision');
    expect(MEMORY_KINDS).toContain('preference');
    expect(MEMORY_KINDS).toContain('constraint');
    expect(MEMORY_KINDS).toContain('lesson');
    expect(MEMORY_KINDS).toContain('fact');
  });
});
