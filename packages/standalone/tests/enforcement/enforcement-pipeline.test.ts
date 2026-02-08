import { describe, it, expect } from 'vitest';
import { EnforcementPipeline } from '../../src/enforcement/index.js';
import type { EnforcementResult } from '../../src/enforcement/index.js';

describe('Story M3.3: EnforcementPipeline — Integration', () => {
  describe('AC #1: Pipeline disabled → all responses pass through', () => {
    it('EP-001: should pass any response when pipeline is disabled', () => {
      const pipeline = new EnforcementPipeline({ enabled: false });

      const flattery = '완벽합니다! 훌륭합니다! 마스터피스! Legendary! Enterprise-grade!';
      const result = pipeline.enforce(flattery, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
      expect(result.todoResult).toBeDefined();
      expect(result.todoResult.allComplete).toBe(true);
    });

    it('EP-002: should pass APPROVE without evidence when disabled', () => {
      const pipeline = new EnforcementPipeline({ enabled: false });

      const result = pipeline.enforce('LGTM, APPROVED!', { isAgentToAgent: true });

      expect(result.passed).toBe(true);
    });
  });

  describe('AC #2: Pipeline enabled, clean response → passes all stages', () => {
    it('EP-003: should pass a technical response with no flattery and no approval', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = [
        'Fixed the auth bug. Changed line 42 in auth-service.ts.',
        'Before: direct string comparison.',
        'After: bcrypt.compare() with proper error handling.',
        'Tests pass (628/628). TypeScript compiles. No lint errors.',
      ].join('\n');

      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
      expect(result.reviewResult.approved).toBe(true);
      expect(result.todoResult).toBeDefined();
    });
  });

  describe('AC #3: Pipeline enabled, flattery response → rejected by ResponseValidator', () => {
    it('EP-004: should reject pure flattery (ResponseValidator stage)', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = [
        '완벽합니다! 훌륭합니다! 엔터프라이즈급 품질이네요.',
        '세계 최고 수준의 코드입니다. 역사에 기록될 만한 작업이에요.',
        '프로덕션 레디 상태입니다. 마스터피스!',
      ].join('\n');

      const result: EnforcementResult = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
      expect(result.validationResult.valid).toBe(false);
    });
  });

  describe('AC #4: APPROVE without evidence → rejected by ReviewGate', () => {
    it('EP-005: should reject approval with no evidence (ReviewGate stage)', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = 'LGTM, looks good! APPROVED!';

      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ReviewGate');
      expect(result.reviewResult.approved).toBe(false);
      expect(result.reviewResult.hasEvidence).toBe(false);
    });
  });

  describe('AC #5: APPROVE with evidence → passes', () => {
    it('EP-006: should pass approval with test evidence', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = [
        'APPROVED. Tests pass (42/42). Build succeeded.',
        'Typecheck clean. Reviewed code in auth-service.ts and middleware.ts.',
        'No issues found. git diff shows only intended changes.',
      ].join('\n');

      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.reviewResult.approved).toBe(true);
      expect(result.reviewResult.hasEvidence).toBe(true);
      expect(result.reviewResult.evidenceFound.length).toBeGreaterThan(0);
    });
  });

  describe('AC #6: Mixed flattery + APPROVE → rejected by ResponseValidator (first in chain)', () => {
    it('EP-007: should short-circuit at ResponseValidator before reaching ReviewGate', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = [
        '완벽합니다! 훌륭합니다! 엔터프라이즈급! 마스터피스!',
        '세계 최고 수준! 역사에 기록될! 프로덕션 레디!',
        'APPROVED. Tests pass. Build succeeded.',
      ].join('\n');

      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
      expect(result.validationResult.valid).toBe(false);
    });
  });

  describe('AC #7: Non-agent-to-agent (human-facing) → lenient validation', () => {
    it('EP-008: should apply lenient threshold for human-facing responses', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = [
        'Great question! Here is how the authentication flow works:',
        '',
        '1. User submits email and password',
        '2. Server validates credentials via bcrypt',
        '3. JWT token is generated with 1h expiry',
        '4. Refresh token is stored in httpOnly cookie',
        '',
        'The endpoint is POST /api/auth/login and returns { userId, token, email }.',
      ].join('\n');

      const result = pipeline.enforce(response, { isAgentToAgent: false });

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
    });
  });

  describe('AC #8: Config override — custom threshold', () => {
    it('EP-009: should respect custom flattery threshold', () => {
      const pipeline = new EnforcementPipeline({
        enabled: true,
        responseValidator: { flatteryThreshold: 0.5 },
      });

      const response = [
        'This is a perfect and excellent implementation.',
        'Here is the technical detail of the change:',
        'Updated auth-service.ts to use bcrypt.compare.',
        'Changed error handling to use proper HTTP status codes.',
      ].join('\n');

      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
    });

    it('EP-010: should respect custom reviewGate config (evidence not required)', () => {
      const pipeline = new EnforcementPipeline({
        enabled: true,
        reviewGate: { requireEvidence: false },
      });

      const response = 'LGTM, APPROVED! No issues.';

      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.reviewResult.approved).toBe(true);
    });

    it('EP-011: should allow disabling individual stages via config', () => {
      const pipeline = new EnforcementPipeline({
        enabled: true,
        responseValidator: { enabled: false },
        reviewGate: { enabled: false },
        todoTracker: { enabled: false },
      });

      const response = '완벽합니다! APPROVED without evidence! Enterprise-grade!';

      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
    });
  });

  describe('AC #9: Edge cases', () => {
    it('EP-012: should pass empty response', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const result = pipeline.enforce('', { isAgentToAgent: true });

      expect(result.passed).toBe(true);
    });

    it('EP-013: should pass whitespace-only response', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const result = pipeline.enforce('   \n\t  ', { isAgentToAgent: true });

      expect(result.passed).toBe(true);
    });

    it('EP-014: default constructor (no config) creates enabled pipeline', () => {
      const pipeline = new EnforcementPipeline();

      const technical = 'Fixed bug in auth module. Tests pass (12/12).';
      const result = pipeline.enforce(technical, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
    });

    it('EP-015: partial config merges with defaults', () => {
      const pipeline = new EnforcementPipeline({
        responseValidator: { flatteryThreshold: 0.1 },
      });

      const response = 'This is a perfect fix for the auth issue. Tests pass (5/5).';
      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
    });
  });

  describe('AC #10: Result structure integrity', () => {
    it('EP-016: passed result has all stage results without rejectionReason', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const result = pipeline.enforce('Technical response with no issues.', {
        isAgentToAgent: true,
      });

      expect(result.passed).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
      expect(result.validationResult).toBeDefined();
      expect(result.reviewResult).toBeDefined();
      expect(result.todoResult).toBeDefined();
    });

    it('EP-017: failed result has rejectionReason and all stage results', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const result = pipeline.enforce('LGTM, APPROVED! No tests needed.', {
        isAgentToAgent: true,
      });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason!.length).toBeGreaterThan(0);
      expect(result.validationResult).toBeDefined();
      expect(result.reviewResult).toBeDefined();
      expect(result.todoResult).toBeDefined();
    });
  });

  describe('AC #11: TodoTracker in pipeline — completion detection', () => {
    it('EP-018: should detect completion markers in response', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = 'Fixed the auth bug. All tests passing. DONE.';
      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.todoResult.allComplete).toBe(true);
      expect(result.todoResult.completionMarkers.length).toBeGreaterThan(0);
    });

    it('EP-019: should flag incomplete tasks when expected outcome provided', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const expectedOutcome = [
        'EXPECTED OUTCOME:',
        '- Fix authentication bug',
        '- Add unit tests',
        '- Update documentation',
      ].join('\n');

      const response = 'Fixed the authentication bug in auth-service.ts.';
      const result = pipeline.enforce(response, {
        isAgentToAgent: true,
        expectedOutcome,
      });

      expect(result.passed).toBe(true);
      expect(result.todoResult.pendingItems.length).toBeGreaterThan(0);
      expect(result.todoResult.reminder).toContain('Incomplete tasks');
    });

    it('EP-020: should pass with no pending items when no expected outcome', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = 'Implemented the feature. 완료.';
      const result = pipeline.enforce(response, { isAgentToAgent: true });

      expect(result.passed).toBe(true);
      expect(result.todoResult.pendingItems).toHaveLength(0);
    });

    it('EP-021: todoTracker disabled via config', () => {
      const pipeline = new EnforcementPipeline({
        enabled: true,
        todoTracker: { enabled: false },
      });

      const result = pipeline.enforce('Some response', {
        isAgentToAgent: true,
        expectedOutcome: 'EXPECTED OUTCOME:\n- Item 1\n- Item 2',
      });

      expect(result.passed).toBe(true);
      expect(result.todoResult.allComplete).toBe(true);
      expect(result.todoResult.pendingItems).toHaveLength(0);
    });
  });

  describe('AC #12: Full 3-stage chain with all components', () => {
    it('EP-022: clean response + completed tasks → full pass', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const expectedOutcome = ['EXPECTED OUTCOME:', '- Fix the auth bug', '- Run tests'].join('\n');

      const response = [
        'Fixed the auth bug in auth-service.ts by switching to bcrypt.compare.',
        'Tests pass (42/42). Build succeeded. Typecheck clean.',
        'DONE.',
      ].join('\n');

      const result = pipeline.enforce(response, {
        isAgentToAgent: true,
        expectedOutcome,
      });

      expect(result.passed).toBe(true);
      expect(result.validationResult.valid).toBe(true);
      expect(result.reviewResult.approved).toBe(true);
      expect(result.todoResult.completionMarkers.length).toBeGreaterThan(0);
    });

    it('EP-023: flattery blocks pipeline before TodoTracker runs', () => {
      const pipeline = new EnforcementPipeline({ enabled: true });

      const response = [
        '완벽합니다! 훌륭합니다! 엔터프라이즈급! 마스터피스!',
        '세계 최고 수준! 역사에 기록될! 프로덕션 레디!',
        'DONE. All tasks complete.',
      ].join('\n');

      const result = pipeline.enforce(response, {
        isAgentToAgent: true,
        expectedOutcome: 'EXPECTED OUTCOME:\n- Fix bug',
      });

      expect(result.passed).toBe(false);
      expect(result.rejectionReason).toContain('ResponseValidator');
      expect(result.todoResult.allComplete).toBe(true);
      expect(result.todoResult.completionMarkers).toHaveLength(0);
    });
  });
});
