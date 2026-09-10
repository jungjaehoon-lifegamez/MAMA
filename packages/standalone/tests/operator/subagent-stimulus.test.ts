import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  attachSubagentWake,
  buildSubagentStimulus,
  buildSubagentStimulusBlock,
  shouldWakeOwner,
  subagentStimulusSourceRef,
  type SubagentEvent,
} from '../../src/operator/subagent-stimulus.js';
import { OWNER_RUNTIME_SESSION_KEY } from '../../src/operator/owner-runtime.js';

function completed(overrides: Partial<SubagentEvent> = {}): SubagentEvent {
  return {
    kind: 'completed',
    sessionKey: OWNER_RUNTIME_SESSION_KEY,
    parentThreadId: 'parent-1',
    agentThreadId: 'child-1',
    agentPath: '/root/board',
    status: 'completed',
    finalText: 'Reconciled 3 cards; two need owner input.',
    ...overrides,
  };
}

describe('buildSubagentStimulus', () => {
  it('wraps the child result as untrusted data inside the completed block', () => {
    const text = buildSubagentStimulus(completed());

    expect(text).toContain('<subagent_completed path="/root/board"');
    expect(text).toContain('thread="child-1"');
    expect(text).toContain('status="completed"');
    expect(text).toContain('</subagent_completed>');
    expect(text).toContain('<<<UNTRUSTED-CONTENT source=subagent:child-1>>>');
    expect(text).toContain('<<<END-UNTRUSTED-CONTENT>>>');
    expect(text).toContain('Reconciled 3 cards; two need owner input.');
    // the untrusted block closes before the host sentence
    expect(text.indexOf('<<<END-UNTRUSTED-CONTENT>>>')).toBeLessThan(
      text.indexOf('A subagent you started has finished.')
    );
  });

  it('adds exactly one host sentence group and no tool ordering', () => {
    const text = buildSubagentStimulus(completed());
    const tail = text.slice(text.indexOf('</subagent_completed>'));

    expect(tail).toContain(
      "A subagent you started has finished. Read its result below (your runtime's own " +
        'agent-result tools if you need more), verify what matters against the sources, and carry ' +
        'the outcome to the owner or the board as the original objective requires. Do not restate ' +
        'the result as your own work without checking it, and do not start another subagent for ' +
        'the same objective.'
    );
    expect(tail).not.toMatch(/first|then|step \d/i);
  });

  it('bounds a long child result', () => {
    const text = buildSubagentStimulus(completed({ finalText: 'x'.repeat(9000) }));

    expect(text.length).toBeLessThan(5000);
    expect(text).toContain('[truncated]');
  });

  it('reports a missing result instead of an empty untrusted block', () => {
    const text = buildSubagentStimulus(
      completed({ status: 'failed', finalText: undefined, error: 'child crashed' })
    );

    expect(text).toContain('status="failed"');
    expect(text).toContain('child crashed');
  });

  it('names a non-completed status in the host sentence instead of the success one', () => {
    const text = buildSubagentStimulus(completed({ status: 'unknown', finalText: undefined }));

    expect(text).toContain('status="unknown"');
    expect(text).toContain('A subagent you started ended with status unknown.');
    expect(text).not.toContain('A subagent you started has finished.');
    expect(text).toContain('(no result text returned)');
  });

  it('reports the error alongside partial text rather than instead of it', () => {
    const text = buildSubagentStimulus(
      completed({ status: 'interrupted', finalText: 'read 2 of 5 cards', error: 'daemon stopped' })
    );

    expect(text).toContain('A subagent you started ended with status interrupted.');
    expect(text).toContain('read 2 of 5 cards');
    expect(text).toContain('error: daemon stopped');
    expect(text.indexOf('read 2 of 5 cards')).toBeLessThan(text.indexOf('error: daemon stopped'));
  });

  it('neutralizes quotes and angle brackets in block attributes', () => {
    const text = buildSubagentStimulus(
      completed({ agentPath: '/root/"><script>', agentThreadId: 'a"b' })
    );

    const header = text.slice(0, text.indexOf('>\n') + 1);
    expect(header).not.toContain('"><script>');
    expect(header.match(/"/g)?.length).toBe(6);
  });

  it('journal block carries the evidence without the host sentence', () => {
    const block = buildSubagentStimulusBlock(completed());

    expect(block).toContain('</subagent_completed>');
    expect(block).not.toContain('A subagent you started has finished.');
    expect(buildSubagentStimulus(completed()).startsWith(block)).toBe(true);
  });
});

describe('shouldWakeOwner', () => {
  it('is true for a completed event on the owner runtime session', () => {
    expect(shouldWakeOwner(completed())).toBe(true);
  });

  it('is false for started events', () => {
    expect(shouldWakeOwner(completed({ kind: 'started', status: undefined }))).toBe(false);
  });

  it('is false for another session key', () => {
    expect(shouldWakeOwner(completed({ sessionKey: 'discord:c1:u1' }))).toBe(false);
  });
});

describe('subagentStimulusSourceRef', () => {
  it('is the child thread id namespaced for dedupe', () => {
    expect(subagentStimulusSourceRef(completed())).toBe('subagent:child-1');
  });
});

describe('attachSubagentWake', () => {
  it('wakes once per completed owner event and ignores the rest', async () => {
    const runner = new EventEmitter();
    const wake = vi.fn().mockResolvedValue(undefined);
    const lines: string[] = [];

    const detach = attachSubagentWake(runner, wake, (line) => lines.push(line));

    runner.emit('subagent', completed({ kind: 'started', status: undefined }));
    runner.emit('subagent', completed());
    runner.emit('subagent', completed());
    runner.emit('subagent', completed({ sessionKey: 'telegram:1', agentThreadId: 'child-2' }));
    await Promise.resolve();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].agentThreadId).toBe('child-1');
    expect(lines).toEqual([
      '[subagent] wake owner path=/root/board thread=child-1 status=completed',
    ]);

    detach();
    runner.emit('subagent', completed({ agentThreadId: 'child-3' }));
    await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('catches and logs a wake rejection', async () => {
    const runner = new EventEmitter();
    const wake = vi.fn().mockRejectedValue(new Error('lane closed'));
    const lines: string[] = [];

    attachSubagentWake(runner, wake, (line) => lines.push(line));
    runner.emit('subagent', completed());
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines.some((line) => line.includes('wake failed') && line.includes('lane closed'))).toBe(
      true
    );
  });

  it('lets a rejected wake be retried for the same child', async () => {
    const runner = new EventEmitter();
    const wake = vi
      .fn()
      .mockRejectedValueOnce(new Error('lane closed'))
      .mockResolvedValueOnce(undefined);
    const lines: string[] = [];

    attachSubagentWake(runner, wake, (line) => lines.push(line));
    runner.emit('subagent', completed());
    await new Promise((resolve) => setImmediate(resolve));
    // The first attempt failed loudly; the same completion must still be deliverable.
    runner.emit('subagent', completed());
    await new Promise((resolve) => setImmediate(resolve));

    expect(wake).toHaveBeenCalledTimes(2);
    expect(lines.some((line) => line.includes('wake failed'))).toBe(true);
  });

  it('is a no-op detach when the runner emits nothing', () => {
    const wake = vi.fn();
    const detach = attachSubagentWake({ prompt: () => undefined }, wake);

    expect(typeof detach).toBe('function');
    expect(() => detach()).not.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });
});
