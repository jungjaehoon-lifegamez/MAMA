/**
 * Delegation Format Validator
 *
 * Validates that orchestrator delegations follow the 6-section format.
 * Hard gate: blocks malformed delegations and posts warning to channel.
 */

export interface DelegationValidation {
  valid: boolean;
  missingSections: string[];
}

const REQUIRED_SECTIONS = [
  'TASK:',
  'EXPECTED OUTCOME:',
  'MUST DO:',
  'MUST NOT DO:',
  'REQUIRED TOOLS:',
  'CONTEXT:',
];

/**
 * Check if a message is a delegation attempt (contains at least one section header).
 * Messages without any section headers are regular chat, not delegation attempts.
 * Uses stricter pattern matching to reduce false positives.
 */
export function isDelegationAttempt(content: string): boolean {
  // Look for section headers at start of line (optionally preceded by whitespace/bullets)
  const sectionPattern =
    /^\s*[-*•]?\s*(TASK:|EXPECTED OUTCOME:|MUST DO:|MUST NOT DO:|REQUIRED TOOLS:|CONTEXT:)/m;
  return sectionPattern.test(content);
}

/**
 * Validate that a delegation message contains all 6 required sections.
 * Returns { valid: true } if all sections present, or lists missing ones.
 */
export function validateDelegationFormat(content: string): DelegationValidation {
  const missingSections = REQUIRED_SECTIONS.filter((s) => !content.includes(s));
  return { valid: missingSections.length === 0, missingSections };
}
