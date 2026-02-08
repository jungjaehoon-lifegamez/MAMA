/**
 * Enforcement Pipeline — Middleware chain for agent response quality enforcement.
 *
 * Chain order: ResponseValidator → ReviewGate → TodoTracker
 * ScopeGuard runs separately (requires git diff input).
 * EnforcementMetrics tracks all pipeline events.
 *
 * @module enforcement
 * @see docs/adr/ADR-001-enforcement-layer.md
 */

// ---------------------------------------------------------------------------
// Barrel exports — all enforcement components
// ---------------------------------------------------------------------------

export { ResponseValidator } from './response-validator.js';
export type { ValidationResult, ResponseValidatorConfig } from './response-validator.js';

export { ReviewGate } from './review-gate.js';
export type { ReviewResult, ReviewGateConfig } from './review-gate.js';

export { ScopeGuard } from './scope-guard.js';
export type { ScopeCheckResult, ScopeGuardConfig } from './scope-guard.js';

export { TodoTracker } from './todo-tracker.js';
export type { TodoTrackerResult, TodoTrackerConfig } from './todo-tracker.js';

export { EnforcementMetrics } from './metrics.js';
export type { AgentMetrics, MetricsSummary, EnforcementMetricsConfig } from './metrics.js';

// ---------------------------------------------------------------------------
// Pipeline Configuration
// ---------------------------------------------------------------------------

import {
  ResponseValidator,
  type ResponseValidatorConfig,
  type ValidationResult,
} from './response-validator.js';
import { ReviewGate, type ReviewGateConfig, type ReviewResult } from './review-gate.js';
import { TodoTracker, type TodoTrackerConfig, type TodoTrackerResult } from './todo-tracker.js';

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
  /** TodoTracker overrides */
  todoTracker: Partial<TodoTrackerConfig>;
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
  /** Result from the TodoTracker stage */
  todoResult: TodoTrackerResult;
}

// ---------------------------------------------------------------------------
// Pipeline Implementation
// ---------------------------------------------------------------------------

const DEFAULT_ENFORCEMENT_CONFIG: EnforcementConfig = {
  enabled: true,
  responseValidator: {},
  reviewGate: {},
  todoTracker: {},
};

/**
 * Chains ResponseValidator → ReviewGate → TodoTracker.
 * Short-circuits on first failure (ResponseValidator, ReviewGate).
 * TodoTracker adds warnings but does not reject.
 */
export class EnforcementPipeline {
  private readonly responseValidator: ResponseValidator;
  private readonly reviewGate: ReviewGate;
  private readonly todoTracker: TodoTracker;
  private readonly enabled: boolean;

  constructor(config?: Partial<EnforcementConfig>) {
    const merged = { ...DEFAULT_ENFORCEMENT_CONFIG, ...config };
    this.enabled = merged.enabled;
    this.responseValidator = new ResponseValidator(merged.responseValidator);
    this.reviewGate = new ReviewGate(merged.reviewGate);
    this.todoTracker = new TodoTracker(merged.todoTracker);
  }

  /**
   * Run the full enforcement pipeline on an agent response.
   *
   * Chain: ResponseValidator → ReviewGate → TodoTracker
   * Short-circuits on ResponseValidator/ReviewGate failure.
   * TodoTracker runs last and adds warnings (non-blocking).
   *
   * @param response - The raw agent response text
   * @param options.isAgentToAgent - Whether this is agent-to-agent communication (strict mode)
   * @param options.expectedOutcome - Optional expected outcome text for TodoTracker
   * @returns EnforcementResult with pass/fail, reason, and per-stage results
   */
  enforce(
    response: string,
    options: { isAgentToAgent: boolean; expectedOutcome?: string }
  ): EnforcementResult {
    const passthroughValidation: ValidationResult = { valid: true };
    const passthroughReview: ReviewResult = {
      approved: true,
      hasEvidence: false,
      evidenceFound: [],
      reason: 'Pipeline disabled',
    };
    const passthroughTodo: TodoTrackerResult = {
      allComplete: true,
      completionMarkers: [],
      pendingItems: [],
      reminder: '',
    };

    if (!this.enabled) {
      return {
        passed: true,
        validationResult: passthroughValidation,
        reviewResult: passthroughReview,
        todoResult: passthroughTodo,
      };
    }

    // Stage 1: ResponseValidator — reject flattery
    const validationResult = this.responseValidator.validate(response, options.isAgentToAgent);

    if (!validationResult.valid) {
      return {
        passed: false,
        rejectionReason: `ResponseValidator: ${validationResult.reason}`,
        validationResult,
        reviewResult: passthroughReview,
        todoResult: passthroughTodo,
      };
    }

    // Stage 2: ReviewGate — require evidence for APPROVE
    const reviewResult = this.reviewGate.checkApproval(response);

    if (!reviewResult.approved) {
      return {
        passed: false,
        rejectionReason: `ReviewGate: ${reviewResult.reason}`,
        validationResult,
        reviewResult,
        todoResult: passthroughTodo,
      };
    }

    // Stage 3: TodoTracker — warn about incomplete tasks (non-blocking)
    const todoResult = this.todoTracker.checkCompletion(response, options.expectedOutcome);

    return {
      passed: true,
      validationResult,
      reviewResult,
      todoResult,
    };
  }
}
