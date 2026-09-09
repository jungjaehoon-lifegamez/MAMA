import { describe, expect, it } from 'vitest';
import { ThreadBriefMemory, briefContentHash } from '../../src/operator/thread-brief-memory.js';

describe('ThreadBriefMemory: standing brief goes on a thread once', () => {
  it('admits the first send and omits the unchanged brief afterwards', () => {
    const memory = new ThreadBriefMemory();
    expect(memory.admit('owner:runtime', 'brief v1')).toBe(true);
    expect(memory.admit('owner:runtime', 'brief v1')).toBe(false);
    expect(memory.admit('owner:runtime', 'brief v1')).toBe(false);
  });

  it('admits again once the owner corrects the brief, then falls silent', () => {
    const memory = new ThreadBriefMemory();
    memory.admit('owner:runtime', 'brief v1');
    expect(memory.admit('owner:runtime', 'brief v2')).toBe(true);
    expect(memory.admit('owner:runtime', 'brief v2')).toBe(false);
    // Reverting to the earlier text is a change too - the thread last saw v2.
    expect(memory.admit('owner:runtime', 'brief v1')).toBe(true);
  });

  it('keeps threads independent', () => {
    const memory = new ThreadBriefMemory();
    expect(memory.admit('thread-a', 'brief')).toBe(true);
    expect(memory.admit('thread-b', 'brief')).toBe(true);
    expect(memory.admit('thread-a', 'brief')).toBe(false);
  });

  it('never reports empty text as sent, and does not displace what is remembered', () => {
    const memory = new ThreadBriefMemory();
    memory.admit('owner:runtime', 'brief');
    expect(memory.admit('owner:runtime', '   ')).toBe(false);
    expect(memory.admit('owner:runtime', null)).toBe(false);
    expect(memory.admit('owner:runtime', 'brief')).toBe(false);
  });

  it('bounds itself: the oldest thread is evicted and re-sends once', () => {
    const memory = new ThreadBriefMemory(2);
    memory.admit('t1', 'brief');
    memory.admit('t2', 'brief');
    memory.admit('t3', 'brief');
    expect(memory.admit('t1', 'brief')).toBe(true);
    expect(memory.admit('t3', 'brief')).toBe(false);
  });

  it('rejects a nonsense bound instead of silently choosing one', () => {
    expect(() => new ThreadBriefMemory(0)).toThrow(/positive integer/);
  });

  it('hashes content, not identity', () => {
    expect(briefContentHash('a')).toBe(briefContentHash('a'));
    expect(briefContentHash('a')).not.toBe(briefContentHash('b'));
  });
});
