import { describe, it, expect } from 'vitest';
import { EnforcementPipeline, EnforcementMetrics } from '../../../src/enforcement/index.js';
import type { EnforcementResult } from '../../../src/enforcement/index.js';
import {
  FLOW_SISYPHUS_INITIAL,
  FLOW_DEVELOPER_COMPLETE,
  FLOW_REVIEWER_APPROVE,
  FLOW_REVIEWER_REJECT,
  DEVELOPER_FLATTERY_HEAVY,
  REVIEWER_APPROVE_NO_EVIDENCE,
} from './fixtures/agent-responses.js';

describe('Scenario: Multi-Agent Delegation Flow', () => {
  describe('AC #1: Happy path — Sisyphus → Developer → Reviewer (APPROVE)', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });
    const metrics = new EnforcementMetrics();

    it('FLOW-001: Sisyphus delegation command passes (human-facing)', () => {
      const result = pipeline.enforce(FLOW_SISYPHUS_INITIAL, { isAgentToAgent: false });

      if (result.passed) {
        metrics.recordPass('sisyphus');
      }

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
    });

    it('FLOW-002: Developer completes task and passes (agent-to-agent)', () => {
      const result = pipeline.enforce(FLOW_DEVELOPER_COMPLETE, { isAgentToAgent: true });

      if (result.passed) {
        metrics.recordPass('developer');
      }

      expect(result.passed).toBe(true);
      expect(result.todoResult.completionMarkers).toContain('DONE');
    });

    it('FLOW-003: Reviewer APPROVE with evidence passes (agent-to-agent)', () => {
      const result = pipeline.enforce(FLOW_REVIEWER_APPROVE, { isAgentToAgent: true });

      if (result.passed) {
        metrics.recordPass('reviewer');
      }

      expect(result.passed).toBe(true);
      expect(result.reviewResult.hasEvidence).toBe(true);
      expect(result.reviewResult.evidenceFound.length).toBeGreaterThanOrEqual(2);
    });

    it('FLOW-004: metrics show 100% pass rate across all agents', () => {
      const summary = metrics.getSummary();

      expect(summary.global.totalResponses).toBe(3);
      expect(summary.global.passed).toBe(3);
      expect(metrics.getPassRate()).toBe(1.0);

      expect(summary.agents['sisyphus']?.passed).toBe(1);
      expect(summary.agents['developer']?.passed).toBe(1);
      expect(summary.agents['reviewer']?.passed).toBe(1);
    });
  });

  describe('AC #2: Unhappy path — Reviewer APPROVE without evidence gets rejected', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });
    const metrics = new EnforcementMetrics();

    it('FLOW-005: Sisyphus and Developer pass as before', () => {
      const r1 = pipeline.enforce(FLOW_SISYPHUS_INITIAL, { isAgentToAgent: false });
      const r2 = pipeline.enforce(FLOW_DEVELOPER_COMPLETE, { isAgentToAgent: true });

      metrics.recordPass('sisyphus');
      metrics.recordPass('developer');

      expect(r1.passed).toBe(true);
      expect(r2.passed).toBe(true);
    });

    it('FLOW-006: Reviewer APPROVE (flattery only) is rejected by ReviewGate', () => {
      const result = pipeline.enforce(FLOW_REVIEWER_REJECT, { isAgentToAgent: true });

      metrics.recordRejection('reviewer', 'reviewGate');

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ReviewGate');
      expect(result.reviewResult.hasEvidence).toBe(false);
    });

    it('FLOW-007: metrics show reviewer has 0% pass rate', () => {
      expect(metrics.getPassRate('reviewer')).toBe(0);
      expect(metrics.getPassRate('sisyphus')).toBe(1.0);
      expect(metrics.getPassRate('developer')).toBe(1.0);

      const summary = metrics.getSummary();
      expect(summary.global.totalResponses).toBe(3);
      expect(summary.global.passed).toBe(2);
      expect(summary.global.rejectedByReviewGate).toBe(1);
    });
  });

  describe('AC #3: Mixed rejection — Developer flattery + Reviewer no evidence', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });
    const metrics = new EnforcementMetrics();

    it('FLOW-008: Sisyphus passes', () => {
      const result = pipeline.enforce(FLOW_SISYPHUS_INITIAL, { isAgentToAgent: false });
      metrics.recordPass('sisyphus');
      expect(result.passed).toBe(true);
    });

    it('FLOW-009: Developer flattery response rejected by ResponseValidator', () => {
      const result = pipeline.enforce(DEVELOPER_FLATTERY_HEAVY, { isAgentToAgent: true });
      metrics.recordRejection('developer', 'validator');

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
    });

    it('FLOW-010: Reviewer no-evidence APPROVE rejected by ResponseValidator (pattern-count)', () => {
      const result = pipeline.enforce(REVIEWER_APPROVE_NO_EVIDENCE, { isAgentToAgent: true });
      metrics.recordRejection('reviewer', 'validator');

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
    });

    it('FLOW-011: metrics reflect rejection stages per agent', () => {
      const summary = metrics.getSummary();

      expect(summary.global.totalResponses).toBe(3);
      expect(summary.global.passed).toBe(1);
      expect(summary.global.rejectedByValidator).toBe(2);

      expect(summary.agents['developer']?.rejectedByValidator).toBe(1);
      expect(summary.agents['reviewer']?.rejectedByValidator).toBe(1);
    });
  });

  describe('AC #4: Retry simulation — rejected then corrected', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });
    const metrics = new EnforcementMetrics();

    it('FLOW-012: first attempt rejected (flattery)', () => {
      const result = pipeline.enforce(DEVELOPER_FLATTERY_HEAVY, { isAgentToAgent: true });
      metrics.recordRejection('developer', 'validator');
      metrics.recordRetry('developer');

      expect(result.passed).toBe(false);
    });

    it('FLOW-013: retry with clean response passes', () => {
      const result = pipeline.enforce(FLOW_DEVELOPER_COMPLETE, { isAgentToAgent: true });
      metrics.recordPass('developer');

      expect(result.passed).toBe(true);
    });

    it('FLOW-014: metrics show 1 retry and 50% pass rate for developer', () => {
      const devMetrics = metrics.getAgentMetrics('developer');

      expect(devMetrics).toBeDefined();
      expect(devMetrics!.totalResponses).toBe(2);
      expect(devMetrics!.passed).toBe(1);
      expect(devMetrics!.rejectedByValidator).toBe(1);
      expect(devMetrics!.retries).toBe(1);
      expect(metrics.getPassRate('developer')).toBe(0.5);
    });
  });

  describe('AC #5: TodoTracker across delegation chain', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });

    it('FLOW-015: Developer response detected as complete (DONE marker)', () => {
      const result = pipeline.enforce(FLOW_DEVELOPER_COMPLETE, {
        isAgentToAgent: true,
        expectedOutcome: '- JWT middleware implementation\n- Tests for JWT middleware',
      });

      expect(result.passed).toBe(true);
      expect(result.todoResult.completionMarkers).toContain('DONE');
    });

    it('FLOW-016: Reviewer APPROVE detected as complete', () => {
      const result = pipeline.enforce(FLOW_REVIEWER_APPROVE, {
        isAgentToAgent: true,
        expectedOutcome: '- Code review completed\n- Evidence-based approval',
      });

      expect(result.passed).toBe(true);
      expect(result.reviewResult.hasEvidence).toBe(true);
    });
  });
});
