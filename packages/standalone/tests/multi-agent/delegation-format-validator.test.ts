/**
 * Tests for DelegationFormatValidator
 */

import { describe, it, expect } from 'vitest';
import {
  validateDelegationFormat,
  isDelegationAttempt,
} from '../../src/multi-agent/delegation-format-validator.js';

describe('validateDelegationFormat', () => {
  it('should pass valid 6-section delegation', () => {
    const content = `@DevBot
TASK: Fix race condition in persistent-cli-process.ts:165
EXPECTED OUTCOME: start() method checks process survival after 500ms wait
MUST DO: Add this.process && !this.process.killed check
MUST NOT DO: Modify other files, unrelated refactoring
REQUIRED TOOLS: Read, Edit
CONTEXT: packages/standalone/src/agent/persistent-cli-process.ts, start() method`;

    const result = validateDelegationFormat(content);
    expect(result.valid).toBe(true);
    expect(result.missingSections).toEqual([]);
  });

  it('should detect missing sections', () => {
    const content = `@DevBot
TASK: Fix race condition
EXPECTED OUTCOME: Process should not crash`;

    const result = validateDelegationFormat(content);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toContain('MUST DO:');
    expect(result.missingSections).toContain('MUST NOT DO:');
    expect(result.missingSections).toContain('REQUIRED TOOLS:');
    expect(result.missingSections).toContain('CONTEXT:');
  });

  it('should detect all sections missing for empty content', () => {
    const result = validateDelegationFormat('');
    expect(result.valid).toBe(false);
    expect(result.missingSections).toHaveLength(6);
  });

  it('should detect all sections missing for non-delegation message', () => {
    const result = validateDelegationFormat('Hey team, great work on the PR!');
    expect(result.valid).toBe(false);
    expect(result.missingSections).toHaveLength(6);
  });

  it('should pass when sections are in any order', () => {
    const content = `CONTEXT: some/file.ts
MUST NOT DO: break things
REQUIRED TOOLS: Read, Edit
TASK: Add feature
MUST DO: implement it
EXPECTED OUTCOME: feature works`;

    const result = validateDelegationFormat(content);
    expect(result.valid).toBe(true);
    expect(result.missingSections).toEqual([]);
  });

  it('should detect single missing section', () => {
    const content = `TASK: Fix bug
EXPECTED OUTCOME: Bug is fixed
MUST DO: Apply patch
MUST NOT DO: Touch other files
REQUIRED TOOLS: Edit`;
    // Missing CONTEXT:

    const result = validateDelegationFormat(content);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toEqual(['CONTEXT:']);
  });
});

describe('isDelegationAttempt', () => {
  it('should return true when message contains TASK: header', () => {
    expect(isDelegationAttempt('@DevBot\nTASK: Fix the bug')).toBe(true);
  });

  it('should return true when message contains any section header', () => {
    expect(isDelegationAttempt('CONTEXT: some/file.ts')).toBe(true);
    expect(isDelegationAttempt('MUST DO: implement it')).toBe(true);
    expect(isDelegationAttempt('EXPECTED OUTCOME: tests pass')).toBe(true);
  });

  it('should return false for casual chat without section headers', () => {
    expect(isDelegationAttempt('Great work @DevBot!')).toBe(false);
    expect(isDelegationAttempt('I agree with the approach')).toBe(false);
    expect(isDelegationAttempt('')).toBe(false);
  });

  it('should return false for messages mentioning section words without colon format', () => {
    // "TASK" without colon is not a section header
    expect(isDelegationAttempt('The TASK is done')).toBe(false);
    expect(isDelegationAttempt('Check the CONTEXT')).toBe(false);
  });

  it('should return true for partial delegation (some sections present)', () => {
    const partial = `TASK: Fix something
MUST DO: Apply patch`;
    expect(isDelegationAttempt(partial)).toBe(true);
  });
});
