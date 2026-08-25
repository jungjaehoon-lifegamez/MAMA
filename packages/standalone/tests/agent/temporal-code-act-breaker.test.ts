import { describe, expect, it } from 'vitest';
import {
  beginTemporalCodeActCall,
  createTemporalCodeActBreakerState,
  deterministicToolFailureFingerprint,
  observeTemporalCodeActResult,
} from '../../src/agent/temporal-code-act-breaker.js';

const deniedCompile = [{ name: 'context_compile', success: false, code: 'connector_out_of_scope' }];

describe('TG-03/TG-04/TG-05: Temporal deterministic Code-Act breaker', () => {
  it('fingerprints only an ordered, fully deterministic trusted failure audit', () => {
    const first = deterministicToolFailureFingerprint([
      { name: 'context_compile', success: false, code: 'connector_out_of_scope' },
      { name: 'mama_search', success: false, code: 'memory_scope_out_of_scope' },
    ]);
    const same = deterministicToolFailureFingerprint([
      { name: 'context_compile', success: false, code: 'connector_out_of_scope' },
      { name: 'mama_search', success: false, code: 'memory_scope_out_of_scope' },
    ]);
    const reordered = deterministicToolFailureFingerprint([
      { name: 'mama_search', success: false, code: 'memory_scope_out_of_scope' },
      { name: 'context_compile', success: false, code: 'connector_out_of_scope' },
    ]);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(first);
    expect(reordered).not.toBe(first);
  });

  it.each([
    [],
    [{ name: 'context_compile', success: true }],
    [{ name: 'context_compile', success: false }],
    [{ name: 'context_compile', success: false, code: 'rate_limit' }],
    [
      { name: 'context_compile', success: false, code: 'connector_out_of_scope' },
      { name: 'provider', success: false, code: 'transport_disconnect' },
    ],
  ])('does not fingerprint successful, missing-code, or transient audit %#', (audit) => {
    expect(deterministicToolFailureFingerprint(audit)).toBeUndefined();
  });

  it('terminates only on the third consecutive equal deterministic fingerprint', () => {
    let state = createTemporalCodeActBreakerState();

    const first = observeTemporalCodeActResult(state, {
      success: false,
      hostToolExecutions: deniedCompile,
    });
    state = first.state;
    const second = observeTemporalCodeActResult(state, {
      success: false,
      hostToolExecutions: deniedCompile,
    });
    state = second.state;
    const third = observeTemporalCodeActResult(state, {
      success: false,
      hostToolExecutions: deniedCompile,
    });

    expect(first.terminal).toBe(false);
    expect(second.terminal).toBe(false);
    expect(third).toMatchObject({
      terminal: true,
      reason: 'deterministic_repeat',
      fingerprintPrefix: expect.stringMatching(/^[a-f0-9]{12}$/),
      state: { consecutiveDeterministicFailures: 3 },
    });
  });

  it('resets the streak after success, no fingerprint, or a different fingerprint', () => {
    let state = createTemporalCodeActBreakerState();
    state = observeTemporalCodeActResult(state, {
      success: false,
      hostToolExecutions: deniedCompile,
    }).state;
    state = observeTemporalCodeActResult(state, {
      success: true,
      hostToolExecutions: deniedCompile,
    }).state;
    expect(state.consecutiveDeterministicFailures).toBe(0);

    state = observeTemporalCodeActResult(state, {
      success: false,
      hostToolExecutions: deniedCompile,
    }).state;
    state = observeTemporalCodeActResult(state, {
      success: false,
      hostToolExecutions: [{ name: 'context_compile', success: false }],
    }).state;
    expect(state.consecutiveDeterministicFailures).toBe(0);

    state = observeTemporalCodeActResult(state, {
      success: false,
      hostToolExecutions: deniedCompile,
    }).state;
    state = observeTemporalCodeActResult(state, {
      success: false,
      hostToolExecutions: [
        { name: 'context_compile', success: false, code: 'context_compile_input_invalid' },
      ],
    }).state;
    expect(state.consecutiveDeterministicFailures).toBe(1);
  });

  it('blocks the ninth Temporal outer call before execution', () => {
    let state = createTemporalCodeActBreakerState();
    for (let call = 1; call <= 8; call += 1) {
      const decision = beginTemporalCodeActCall(state);
      expect(decision.terminal).toBe(false);
      state = decision.state;
    }

    const ninth = beginTemporalCodeActCall(state);
    expect(ninth).toMatchObject({
      terminal: true,
      reason: 'outer_call_limit',
      state: { codeActCalls: 9 },
    });
  });

  it('keeps concurrent and subsequent run state independent', () => {
    const runA = observeTemporalCodeActResult(createTemporalCodeActBreakerState(), {
      success: false,
      hostToolExecutions: deniedCompile,
    }).state;
    const runB = createTemporalCodeActBreakerState();

    expect(runA.consecutiveDeterministicFailures).toBe(1);
    expect(runB).toEqual({
      codeActCalls: 0,
      lastDeterministicFingerprint: undefined,
      consecutiveDeterministicFailures: 0,
    });
  });
});
