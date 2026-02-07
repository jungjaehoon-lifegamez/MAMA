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
 */
export function isDelegationAttempt(content: string): boolean {
  return REQUIRED_SECTIONS.some((s) => content.includes(s));
}

/**
 * Validate that a delegation message contains all 6 required sections.
 * Returns { valid: true } if all sections present, or lists missing ones.
 */
export function validateDelegationFormat(content: string): DelegationValidation {
  const missingSections = REQUIRED_SECTIONS.filter((s) => !content.includes(s));
  return { valid: missingSections.length === 0, missingSections };
}
