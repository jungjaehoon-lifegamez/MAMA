/**
 * Enforcement Pipeline — Middleware chain for agent response quality enforcement.
 *
 * Chain order: ResponseValidator → ReviewGate
 * Week 4 will add: ScopeGuard → TodoTracker
 *
 * @module enforcement
 * @see docs/spike-results-enforcement-layer-2026-02-08.md
 */

export { ResponseValidator } from './response-validator.js';
export type { ValidationResult, ResponseValidatorConfig } from './response-validator.js';

export { ReviewGate } from './review-gate.js';
export type { ReviewResult, ReviewGateConfig } from './review-gate.js';

/**
 * Configuration for the full enforcement pipeline
 */
export interface EnforcementConfig {
  /** Master switch — disables all enforcement when false */
  enabled: boolean;
  /** ResponseValidator overrides */
  responseValidator: Partial<ResponseValidatorConfig>;
  /** ReviewGate overrides */
  reviewGate: Partial<ReviewGateConfig>;
}

/**
 * Result of running the full enforcement pipeline
 */
export interface EnforcementResult {
  /** Whether the response passed all enforcement checks */
  passed: boolean;
  /** Human-readable rejection reason (set when passed=false) */
  rejectionReason?: string;
  /** Result from the ResponseValidator stage */
  validationResult: ValidationResult;
  /** Result from the ReviewGate stage */
  reviewResult: ReviewResult;
}

import {
  ResponseValidator,
  type ResponseValidatorConfig,
  type ValidationResult,
} from './response-validator.js';
import { ReviewGate, type ReviewGateConfig, type ReviewResult } from './review-gate.js';

const DEFAULT_ENFORCEMENT_CONFIG: EnforcementConfig = {
  enabled: true,
  responseValidator: {},
  reviewGate: {},
};

/** Chains ResponseValidator → ReviewGate. Short-circuits on first failure. */
export class EnforcementPipeline {
  private readonly responseValidator: ResponseValidator;
  private readonly reviewGate: ReviewGate;
  private readonly enabled: boolean;

  constructor(config?: Partial<EnforcementConfig>) {
    const merged = { ...DEFAULT_ENFORCEMENT_CONFIG, ...config };
    this.enabled = merged.enabled;
    this.responseValidator = new ResponseValidator(merged.responseValidator);
    this.reviewGate = new ReviewGate(merged.reviewGate);
  }

  /**
   * Run the full enforcement pipeline on an agent response.
   *
   * Chain: ResponseValidator → ReviewGate
   * Short-circuits on first failure.
   *
   * @param response - The raw agent response text
   * @param options.isAgentToAgent - Whether this is agent-to-agent communication (strict mode)
   * @returns EnforcementResult with pass/fail, reason, and per-stage results
   */
  enforce(response: string, options: { isAgentToAgent: boolean }): EnforcementResult {
    const passthroughValidation: ValidationResult = { valid: true };
    const passthroughReview: ReviewResult = {
      approved: true,
      hasEvidence: false,
      evidenceFound: [],
      reason: 'Pipeline disabled',
    };

    if (!this.enabled) {
      return {
        passed: true,
        validationResult: passthroughValidation,
        reviewResult: passthroughReview,
      };
    }

    const validationResult = this.responseValidator.validate(response, options.isAgentToAgent);

    if (!validationResult.valid) {
      return {
        passed: false,
        rejectionReason: `ResponseValidator: ${validationResult.reason}`,
        validationResult,
        reviewResult: passthroughReview,
      };
    }

    const reviewResult = this.reviewGate.checkApproval(response);

    if (!reviewResult.approved) {
      return {
        passed: false,
        rejectionReason: `ReviewGate: ${reviewResult.reason}`,
        validationResult,
        reviewResult,
      };
    }

    return {
      passed: true,
      validationResult,
      reviewResult,
    };
  }
}
