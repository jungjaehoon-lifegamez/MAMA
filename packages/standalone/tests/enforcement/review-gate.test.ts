import { describe, it, expect } from 'vitest';
import { ReviewGate } from '../../src/enforcement/review-gate.js';

import type { ReviewResult } from '../../src/enforcement/review-gate.js';

describe('Story M3.2: ReviewGate - Evidence-based APPROVE Enforcement', () => {
  const gate = new ReviewGate();

  describe('AC #1: APPROVE without evidence → REJECT', () => {
    it('should reject APPROVE with only flattery (RG-001)', () => {
      const response = `APPROVE - 모든 것이 완벽합니다! 훌륭한 구현이에요.
엔터프라이즈급 품질로 작성되었습니다.
프로덕션 레디 상태입니다.`;

      const result: ReviewResult = gate.checkApproval(response);

      expect(result.approved).toBe(false);
      expect(result.hasEvidence).toBe(false);
      expect(result.evidenceFound).toEqual([]);
      expect(result.reason).toContain('evidence');
    });
  });

  describe('AC #2: APPROVE with test evidence → PASS', () => {
    it('should approve APPROVE with test results', () => {
      const response = `APPROVE

Tests pass (12/12). All acceptance criteria met.`;

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound).toContain('test pass');
      expect(result.evidenceFound).toContain('test count');
    });
  });

  describe('AC #3: APPROVE with build evidence → PASS', () => {
    it('should approve APPROVE with build success', () => {
      const response = 'APPROVED. Build success. Deployed to staging.';

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound).toContain('build success');
    });
  });

  describe('AC #4: APPROVE with multiple evidence → PASS', () => {
    it('should approve with full evidence set (RG-002)', () => {
      const response = `APPROVE

Files reviewed:
- packages/standalone/src/agent/response-validator.ts (142 lines)
- packages/standalone/src/agent/review-gate.ts (89 lines)

Verification:
- Tests pass: 628/628 (pnpm vitest run)
- TypeScript compiles: 0 errors (pnpm typecheck)
- Lint: 0 errors (pnpm lint)`;

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound.length).toBeGreaterThanOrEqual(3);
      expect(result.evidenceFound).toContain('test pass');
      expect(result.evidenceFound).toContain('0 errors');
      expect(result.evidenceFound).toContain('reviewed code');
    });
  });

  describe('AC #5: Korean 승인 without evidence → REJECT', () => {
    it('should reject Korean approval without evidence', () => {
      const response = '승인합니다. 완벽한 구현이에요! 엔터프라이즈급 품질입니다.';

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(false);
      expect(result.hasEvidence).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  describe('AC #6: Korean approval + evidence → PASS', () => {
    it('should approve Korean 통과 with English evidence', () => {
      const response = '통과. 테스트 628/628 passed. TypeScript compiles. 0 errors.';

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound).toContain('test count');
    });

    it('should approve Korean 승인 with Korean-only evidence (GAP-2)', () => {
      const response = [
        '승인',
        '',
        '테스트 통과 (45개 테스트 통과)',
        '에러 0건, 경고 0건',
        '빌드 성공',
        '타입체크 통과',
        '린트 통과',
      ].join('\n');

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound).toContain('테스트 통과');
      expect(result.evidenceFound).toContain('에러 0건');
      expect(result.evidenceFound).toContain('빌드 성공');
      expect(result.evidenceFound).toContain('타입체크 통과');
      expect(result.evidenceFound).toContain('린트 통과');
      expect(result.evidenceFound).toContain('경고 0건');
    });

    it('should detect 검토 완료 and 코드 리뷰 완료 as evidence', () => {
      const response = '승인. 코드 리뷰 완료. 검토 완료.';

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound).toContain('검토 완료');
      expect(result.evidenceFound).toContain('코드 리뷰 완료');
    });

    it('should detect Korean test count patterns', () => {
      const evidence1 = gate.extractEvidence('45개 테스트 통과');
      expect(evidence1).toContain('test count (KR)');

      const evidence2 = gate.extractEvidence('23/25 통과');
      expect(evidence2).toContain('test count (KR)');
    });
  });

  describe('AC #7: LGTM without evidence → REJECT', () => {
    it('should reject LGTM with no evidence', () => {
      const response = 'LGTM! Great work, this is fantastic.';

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(false);
      expect(result.hasEvidence).toBe(false);
    });
  });

  describe('AC #8: LGTM with evidence → PASS', () => {
    it('should approve LGTM with evidence', () => {
      const response = 'LGTM. Reviewed code changes. Tests pass. Lint pass.';

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound).toContain('reviewed code');
      expect(result.evidenceFound).toContain('test pass');
      expect(result.evidenceFound).toContain('lint pass');
    });
  });

  describe('AC #9: Non-approval response → PASS (passthrough)', () => {
    it('should pass through non-approval responses without checking evidence', () => {
      const response = `Fixed the auth bug. Changed line 42 in auth-service.ts.

Before: if (password === user.passwordHash)
After: const isValid = await bcrypt.compare(password, user.passwordHash);`;

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(false);
      expect(result.evidenceFound).toEqual([]);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('AC #10: APPROVE with flattery only → REJECT', () => {
    it('should reject APPROVE surrounded by only flattery, no evidence', () => {
      const response = `APPROVE

This is a masterpiece of software engineering!
World-class implementation. Enterprise-grade quality.
Beautiful code with stunning architecture. Legendary work!`;

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(false);
      expect(result.hasEvidence).toBe(false);
      expect(result.reason).toContain('Flattery does not substitute for evidence');
    });
  });

  describe('AC #11: Partial evidence → PASS', () => {
    it('should approve when at least one evidence pattern matches', () => {
      const response = 'APPROVE - Verified the implementation works correctly.';

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound).toContain('verified');
    });
  });

  describe('AC #12: Mixed language approval + evidence → PASS', () => {
    it('should approve mixed Korean/English with evidence', () => {
      const response = `승인

Reviewed code changes in auth-service.ts.
628 tests passed. Build success.
Git diff checked. 0 errors confirmed.`;

      const result = gate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(true);
      expect(result.evidenceFound.length).toBeGreaterThanOrEqual(3);
      expect(result.evidenceFound).toContain('reviewed code');
      expect(result.evidenceFound).toContain('build success');
      expect(result.evidenceFound).toContain('0 errors');
    });
  });

  describe('Configuration', () => {
    it('should pass all responses when gate is disabled', () => {
      const disabledGate = new ReviewGate({ enabled: false });
      const response = 'APPROVE - no evidence at all';

      const result = disabledGate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.reason).toBe('Gate disabled');
    });

    it('should allow evidence-less APPROVE when requireEvidence is false', () => {
      const lenientGate = new ReviewGate({ requireEvidence: false });
      const response = 'APPROVE - looks fine to me';

      const result = lenientGate.checkApproval(response);

      expect(result.approved).toBe(true);
      expect(result.hasEvidence).toBe(false);
    });
  });

  describe('containsApproval', () => {
    it('should detect case-insensitive approval keywords', () => {
      expect(gate.containsApproval('approve')).toBe(true);
      expect(gate.containsApproval('APPROVE')).toBe(true);
      expect(gate.containsApproval('Approved')).toBe(true);
      expect(gate.containsApproval('lgtm')).toBe(true);
      expect(gate.containsApproval('Looks Good')).toBe(true);
    });

    it('should detect Korean approval keywords', () => {
      expect(gate.containsApproval('승인합니다')).toBe(true);
      expect(gate.containsApproval('통과')).toBe(true);
      expect(gate.containsApproval('합격')).toBe(true);
    });

    it('should not detect approval in non-approval text', () => {
      expect(gate.containsApproval('Fixed the bug.')).toBe(false);
      expect(gate.containsApproval('Here is the implementation.')).toBe(false);
    });
  });

  describe('extractEvidence', () => {
    it('should extract multiple evidence types from rich response', () => {
      const response = `Tests pass (628/628). Build success. TypeScript compiles.
Lint: 0 errors. Reviewed code changes. git diff clean.`;

      const evidence = gate.extractEvidence(response);

      expect(evidence).toContain('test pass');
      expect(evidence).toContain('test count');
      expect(evidence).toContain('build success');
      expect(evidence).toContain('typecheck pass');
      expect(evidence).toContain('0 errors');
      expect(evidence).toContain('reviewed code');
      expect(evidence).toContain('git diff');
    });

    it('should return empty array when no evidence found', () => {
      const evidence = gate.extractEvidence('Great work! Masterpiece!');
      expect(evidence).toEqual([]);
    });

    it('should deduplicate evidence labels', () => {
      const response = 'Tests pass. 12 tests passed. All tests passing.';
      const evidence = gate.extractEvidence(response);

      const testPassCount = evidence.filter((e) => e === 'test pass').length;
      expect(testPassCount).toBeLessThanOrEqual(1);
    });
  });
});
