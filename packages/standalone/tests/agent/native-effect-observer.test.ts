import { describe, expect, it } from 'vitest';
import { NativeEffectReplayBoundary } from '../../src/agent/native-effect-observer.js';
import { AgentError } from '../../src/agent/types.js';

describe('TG-03/04/05/06 native effect replay boundary', () => {
  it.each([false, true])(
    'blocks failure replay after started native effect (settled=%s)',
    (settled) => {
      const events: string[] = [];
      const boundary = new NativeEffectReplayBoundary({
        started: () => {
          events.push('started');
        },
        settled: () => {
          events.push('settled');
        },
        interrupted: () => {
          events.push('interrupted');
        },
      });
      boundary.started('Bash', { command: 'some non-idempotent command' });
      if (settled) boundary.settled('Bash', 'call-1', false);
      const failure = boundary.failure(new Error('context window exceeded'));
      expect(failure).toBeInstanceOf(AgentError);
      expect(failure).toMatchObject({
        code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
        retryable: false,
      });
      expect(events).toEqual(
        settled ? ['started', 'settled', 'interrupted'] : ['started', 'interrupted']
      );
    }
  );
  it('preserves read-only retry and separately receipted MCP bridge', () => {
    const boundary = new NativeEffectReplayBoundary();
    boundary.started('Read', { path: 'README.md' });
    boundary.started('mcp__mama__code_act', {});
    const error = new Error('transport failure');
    expect(boundary.failure(error)).toBe(error);
  });
  it('fails closed when observation persistence throws', () => {
    const boundary = new NativeEffectReplayBoundary({
      started: () => {
        throw new Error('disk full');
      },
      settled: () => {
        throw new Error('disk full');
      },
      interrupted: () => {
        throw new Error('disk full');
      },
    });
    expect(() => boundary.started('fileChange', {})).toThrow('disk full');
    expect(boundary.failure(new Error('disk full'))).toMatchObject({ retryable: false });
  });
});

describe('TG-05/06 durable native admission marker', () => {
  function trackedBoundary() {
    const events: string[] = [];
    const boundary = new NativeEffectReplayBoundary({
      started: () => {
        events.push('started');
      },
      settled: () => {
        events.push('settled');
      },
      interrupted: () => {
        events.push('unknown');
      },
      finished: () => {
        events.push('finished');
      },
    });
    return { events, boundary };
  }

  it('marks a terminal transport failure unknown before any item notification', () => {
    const { events, boundary } = trackedBoundary();
    expect(boundary.failure(new Error('socket closed'), true)).toMatchObject({
      code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(events).toEqual(['unknown']);
  });

  it('allows conclusive missing-session recovery then confirms a clean run', () => {
    const { events, boundary } = trackedBoundary();
    const missing = new Error('No conversation found with session ID missing');
    expect(boundary.failure(missing, true)).toBe(missing);
    expect(events).toEqual([]);
    boundary.finished();
    expect(events).toEqual(['finished']);
  });

  it('marks missing-session terminal failure unknown when recovery has ended', () => {
    const { events, boundary } = trackedBoundary();
    const missing = new Error('No conversation found with session ID missing');
    expect(boundary.failure(missing)).toMatchObject({ retryable: false });
    expect(events).toEqual(['unknown']);
  });

  it('does not allow missing-session recovery after a native effect', () => {
    const { events, boundary } = trackedBoundary();
    boundary.started('commandExecution', {});
    expect(
      boundary.failure(new Error('No conversation found with session ID missing'), true)
    ).toMatchObject({ code: 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN', retryable: false });
    expect(events).toEqual(['started', 'unknown']);
  });
});
