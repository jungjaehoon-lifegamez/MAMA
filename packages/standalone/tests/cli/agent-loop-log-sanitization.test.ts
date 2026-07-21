import { describe, expect, it } from 'vitest';
import {
  appendToolResultReasoning,
  summarizeToolResult,
} from '../../src/cli/runtime/agent-loop-init.js';

describe('Agent loop tool-result diagnostic logging', () => {
  it('emits only bounded failure metadata for model-controlled results', () => {
    const privateSentinel = 'private-tool-result-secret-44';
    const result = {
      success: false,
      code: 'SYNTHETIC_FAILURE',
      error: privateSentinel,
      results: [privateSentinel],
    };
    const reasoningLog: string[] = [];

    appendToolResultReasoning(reasoningLog, result);

    expect(summarizeToolResult(result)).toBe('failed code=SYNTHETIC_FAILURE');
    expect(reasoningLog).toEqual(['  ❌ failed (SYNTHETIC_FAILURE)']);
    expect(`${summarizeToolResult(result)} ${reasoningLog.join(' ')}`).not.toContain(
      privateSentinel
    );
  });

  it('summarizes successful result arrays by count without exposing their contents', () => {
    const privateSentinel = 'private-success-result-secret-45';
    const result = { success: true, results: [privateSentinel, privateSentinel] };
    const reasoningLog: string[] = [];

    appendToolResultReasoning(reasoningLog, result);

    expect(summarizeToolResult(result)).toBe('success items=2');
    expect(reasoningLog).toEqual(['  ✓ 2 items']);
    expect(`${summarizeToolResult(result)} ${reasoningLog.join(' ')}`).not.toContain(
      privateSentinel
    );
  });
});
