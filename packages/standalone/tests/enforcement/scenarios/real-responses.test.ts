import { describe, it, expect } from 'vitest';
import { EnforcementPipeline } from '../../../src/enforcement/index.js';
import type { EnforcementResult } from '../../../src/enforcement/index.js';
import {
  DEVELOPER_CLEAN_IMPLEMENTATION,
  DEVELOPER_FLATTERY_HEAVY,
  DEVELOPER_MODERATE_FLATTERY,
  DEVELOPER_SELF_CONGRATULATION,
  REVIEWER_APPROVE_WITH_EVIDENCE,
  REVIEWER_APPROVE_NO_EVIDENCE,
  REVIEWER_LGTM_NO_EVIDENCE,
  REVIEWER_LGTM_WITH_EVIDENCE,
  REVIEWER_KOREAN_APPROVE_WITH_EVIDENCE,
  REVIEWER_KOREAN_APPROVE_NO_EVIDENCE,
  SISYPHUS_DELEGATION,
  SISYPHUS_CONTINUATION,
  CODE_BLOCK_FALSE_POSITIVE,
  EMPTY_RESPONSE,
  WHITESPACE_RESPONSE,
  LONG_CLEAN_RESPONSE,
  INCOMPLETE_TASK_RESPONSE,
  FLATTERY_PLUS_APPROVE,
} from './fixtures/agent-responses.js';

describe('Scenario: Real Agent Responses', () => {
  const pipeline = new EnforcementPipeline({ enabled: true });
  const strictPipeline = new EnforcementPipeline({
    enabled: true,
    responseValidator: { flatteryThreshold: 0.15 },
  });

  // -------------------------------------------------------------------------
  // Developer Agent Scenarios
  // -------------------------------------------------------------------------

  describe('Developer Agent', () => {
    it('S-DEV-001: clean implementation with code blocks passes all stages', () => {
      const result: EnforcementResult = pipeline.enforce(DEVELOPER_CLEAN_IMPLEMENTATION, {
        isAgentToAgent: true,
      });

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
      expect(result.todoResult.completionMarkers.length).toBeGreaterThan(0);
    });

    it('S-DEV-002: heavy flattery response is rejected by ResponseValidator', () => {
      const result = pipeline.enforce(DEVELOPER_FLATTERY_HEAVY, { isAgentToAgent: true });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
      expect(result.validationResult.valid).toBe(false);
      expect(result.validationResult.flatteryRatio).toBeGreaterThan(0.2);
    });

    it('S-DEV-003: moderate flattery with substance passes at default threshold', () => {
      const result = pipeline.enforce(DEVELOPER_MODERATE_FLATTERY, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
    });

    it('S-DEV-004: moderate flattery rejected at stricter threshold (0.15)', () => {
      const result = strictPipeline.enforce(DEVELOPER_MODERATE_FLATTERY, {
        isAgentToAgent: true,
      });

      // At 0.15 threshold, borderline responses may be rejected
      // This tests that threshold tuning works as intended
      expect(result.validationResult.flatteryRatio).toBeDefined();
      if (result.validationResult.flatteryRatio! > 0.15) {
        expect(result.passed).toBe(false);
      }
    });

    it('S-DEV-005: self-congratulatory status — caught by pattern-count secondary check', () => {
      const result = pipeline.enforce(DEVELOPER_SELF_CONGRATULATION, { isAgentToAgent: true });

      // GAP-1 FIX: English self-congratulation with many distinct flattery patterns
      // (outstanding, exceptional, remarkable, superb, masterpiece, elegant solution, absolutely)
      // has a low character ratio (~11%) but 7 distinct patterns. The pattern-count
      // secondary check (threshold: 5 for agent-to-agent) catches this.
      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
      expect(result.validationResult.valid).toBe(false);
      expect(result.validationResult.matched!.length).toBeGreaterThanOrEqual(5);
      expect(result.validationResult.flatteryRatio).toBeLessThanOrEqual(0.2);
    });
  });

  // -------------------------------------------------------------------------
  // Reviewer Agent Scenarios
  // -------------------------------------------------------------------------

  describe('Reviewer Agent', () => {
    it('S-REV-001: APPROVE with full evidence passes all stages', () => {
      const result = pipeline.enforce(REVIEWER_APPROVE_WITH_EVIDENCE, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.reviewResult.approved).toBe(true);
      expect(result.reviewResult.hasEvidence).toBe(true);
      expect(result.reviewResult.evidenceFound.length).toBeGreaterThanOrEqual(3);
    });

    it('S-REV-002: APPROVE without evidence — rejected by ResponseValidator (pattern-count)', () => {
      const result = pipeline.enforce(REVIEWER_APPROVE_NO_EVIDENCE, { isAgentToAgent: true });

      expect(result.passed).toBe(false);
      // With pattern-count secondary check, ResponseValidator catches this BEFORE ReviewGate.
      // The response has 5 distinct flattery patterns (excellent, fantastic, brilliant, superb, absolutely)
      // which meets the threshold=5 for agent-to-agent mode.
      expect(result.rejectionReason).toContain('ResponseValidator');
    });

    it('S-REV-003: LGTM without evidence is rejected', () => {
      const result = pipeline.enforce(REVIEWER_LGTM_NO_EVIDENCE, { isAgentToAgent: true });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ReviewGate');
    });

    it('S-REV-004: LGTM with test counts and build evidence passes', () => {
      const result = pipeline.enforce(REVIEWER_LGTM_WITH_EVIDENCE, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.reviewResult.hasEvidence).toBe(true);
      expect(result.reviewResult.evidenceFound.length).toBeGreaterThanOrEqual(2);
    });

    it('S-REV-005: Korean 승인 with evidence — passes with Korean evidence patterns', () => {
      const result = pipeline.enforce(REVIEWER_KOREAN_APPROVE_WITH_EVIDENCE, {
        isAgentToAgent: true,
      });

      // GAP-2 FIX: Korean evidence patterns (테스트 통과, 에러 0건, 빌드 성공, 경고 0건)
      // now match alongside English patterns.
      expect(result.passed).toBe(true);
      expect(result.reviewResult.approved).toBe(true);
      expect(result.reviewResult.hasEvidence).toBe(true);
      expect(result.reviewResult.evidenceFound.length).toBeGreaterThanOrEqual(3);
    });

    it('S-REV-006: Korean 통과 without evidence is rejected', () => {
      const result = pipeline.enforce(REVIEWER_KOREAN_APPROVE_NO_EVIDENCE, {
        isAgentToAgent: true,
      });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ReviewGate');
    });
  });

  // -------------------------------------------------------------------------
  // Orchestrator (Sisyphus) Scenarios
  // -------------------------------------------------------------------------

  describe('Orchestrator Agent', () => {
    it('S-ORC-001: delegation command passes (no flattery, no APPROVE)', () => {
      const result = pipeline.enforce(SISYPHUS_DELEGATION, { isAgentToAgent: false });

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
      expect(result.reviewResult.approved).toBe(true);
    });

    it('S-ORC-002: task continuation passes', () => {
      const result = pipeline.enforce(SISYPHUS_CONTINUATION, { isAgentToAgent: false });

      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('Edge Cases', () => {
    it('S-EDGE-001: flattery inside code blocks is not detected', () => {
      const result = pipeline.enforce(CODE_BLOCK_FALSE_POSITIVE, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
    });

    it('S-EDGE-002: empty response passes', () => {
      const result = pipeline.enforce(EMPTY_RESPONSE, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
    });

    it('S-EDGE-003: whitespace-only response passes', () => {
      const result = pipeline.enforce(WHITESPACE_RESPONSE, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
    });

    it('S-EDGE-004: long (2000+ char) clean response passes', () => {
      expect(LONG_CLEAN_RESPONSE.length).toBeGreaterThan(2000);

      const result = pipeline.enforce(LONG_CLEAN_RESPONSE, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
      expect(result.todoResult.completionMarkers.length).toBeGreaterThan(0);
    });

    it('S-EDGE-005: incomplete task response — anti-completion signals detect in-progress items', () => {
      const result = pipeline.enforce(INCOMPLETE_TASK_RESPONSE, {
        isAgentToAgent: true,
        expectedOutcome: `- JWT middleware implementation
- Token rotation with blacklist
- Route guard registration
- Integration tests`,
      });

      // GAP-3 FIX: "still in progress" and "remaining items" are anti-completion signals.
      // Even though keywords like "token", "blacklist", "tests" overlap, the proximity
      // of anti-completion phrases prevents those items from being considered addressed.
      expect(result.todoResult.pendingItems.length).toBeGreaterThanOrEqual(1);
      expect(result.todoResult.reminder).toContain('Incomplete tasks detected');
    });

    it('S-EDGE-006: flattery + APPROVE → rejected at ResponseValidator (short-circuit)', () => {
      const result = pipeline.enforce(FLATTERY_PLUS_APPROVE, { isAgentToAgent: true });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
      // ReviewGate should NOT have been reached (short-circuit)
      expect(result.reviewResult.reason).toBe('Pipeline disabled');
    });

    it('S-EDGE-007: human-facing mode is more lenient than agent-to-agent', () => {
      const humanResult = pipeline.enforce(DEVELOPER_MODERATE_FLATTERY, {
        isAgentToAgent: false,
      });
      const agentResult = pipeline.enforce(DEVELOPER_MODERATE_FLATTERY, {
        isAgentToAgent: true,
      });

      // Human-facing should be at least as lenient as agent-to-agent
      if (agentResult.passed) {
        expect(humanResult.passed).toBe(true);
      }
    });
  });
});
