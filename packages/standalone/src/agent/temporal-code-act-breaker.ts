import { createHash } from 'node:crypto';

export const TEMPORAL_CODE_ACT_MAX_CALLS = 8;
export const TEMPORAL_DETERMINISTIC_FAILURE_LIMIT = 3;

const DETERMINISTIC_TOOL_FAILURE_CODES = new Set([
  'memory_scope_out_of_scope',
  'connector_out_of_scope',
  'context_compile_input_invalid',
  'invalid_memory_scope',
  'memory_scope_invalid',
  'memory_scope_denied',
  'role_denied',
  'tool_denied',
  'destination_out_of_scope',
  'invalid_tool_input',
  'permission_denied_tier3',
]);

export interface TemporalCodeActBreakerState {
  codeActCalls: number;
  lastDeterministicFingerprint: string | undefined;
  consecutiveDeterministicFailures: number;
}

export type TemporalCodeActBreakerDecision =
  | { terminal: false; state: TemporalCodeActBreakerState }
  | {
      terminal: true;
      reason: 'deterministic_repeat' | 'outer_call_limit';
      fingerprintPrefix?: string;
      state: TemporalCodeActBreakerState;
    };

interface CodeActResultAudit {
  success: boolean;
  hostToolExecutions?: unknown;
}

export function createTemporalCodeActBreakerState(): TemporalCodeActBreakerState {
  return {
    codeActCalls: 0,
    lastDeterministicFingerprint: undefined,
    consecutiveDeterministicFailures: 0,
  };
}

export function beginTemporalCodeActCall(
  state: TemporalCodeActBreakerState
): TemporalCodeActBreakerDecision {
  const nextState = { ...state, codeActCalls: state.codeActCalls + 1 };
  return nextState.codeActCalls > TEMPORAL_CODE_ACT_MAX_CALLS
    ? { terminal: true, reason: 'outer_call_limit', state: nextState }
    : { terminal: false, state: nextState };
}

export function deterministicToolFailureFingerprint(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const failures: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    if (record.success === true) {
      continue;
    }
    if (
      record.success !== false ||
      typeof record.name !== 'string' ||
      typeof record.code !== 'string' ||
      !DETERMINISTIC_TOOL_FAILURE_CODES.has(record.code)
    ) {
      return undefined;
    }
    failures.push(`${record.name}\u0000${record.code}`);
  }
  if (failures.length === 0) {
    return undefined;
  }
  return createHash('sha256').update(failures.join('\u0001')).digest('hex');
}

export function observeTemporalCodeActResult(
  state: TemporalCodeActBreakerState,
  result: CodeActResultAudit
): TemporalCodeActBreakerDecision {
  const fingerprint = result.success
    ? undefined
    : deterministicToolFailureFingerprint(result.hostToolExecutions);
  if (!fingerprint) {
    return {
      terminal: false,
      state: {
        ...state,
        lastDeterministicFingerprint: undefined,
        consecutiveDeterministicFailures: 0,
      },
    };
  }

  const consecutive =
    fingerprint === state.lastDeterministicFingerprint
      ? state.consecutiveDeterministicFailures + 1
      : 1;
  const nextState = {
    ...state,
    lastDeterministicFingerprint: fingerprint,
    consecutiveDeterministicFailures: consecutive,
  };
  return consecutive >= TEMPORAL_DETERMINISTIC_FAILURE_LIMIT
    ? {
        terminal: true,
        reason: 'deterministic_repeat',
        fingerprintPrefix: fingerprint.slice(0, 12),
        state: nextState,
      }
    : { terminal: false, state: nextState };
}
