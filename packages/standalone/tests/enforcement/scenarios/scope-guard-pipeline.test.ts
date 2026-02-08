import { describe, it, expect } from 'vitest';
import {
  EnforcementPipeline,
  EnforcementMetrics,
  ScopeGuard,
} from '../../../src/enforcement/index.js';
import {
  FLOW_DEVELOPER_COMPLETE,
  DEVELOPER_FLATTERY_HEAVY,
  GIT_DIFF_IN_SCOPE,
  GIT_DIFF_SCOPE_CREEP,
  GIT_DIFF_ONLY_ALLOWED,
  TASK_DESCRIPTION_AUTH,
} from './fixtures/agent-responses.js';

describe('Scenario: ScopeGuard + Pipeline + Metrics Integration', () => {
  describe('AC #1: Full enforcement — Pipeline + ScopeGuard both pass', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });
    const scopeGuard = new ScopeGuard({ mode: 'block' });
    const metrics = new EnforcementMetrics();

    it('SGP-001: developer response passes pipeline', () => {
      const pipelineResult = pipeline.enforce(FLOW_DEVELOPER_COMPLETE, {
        isAgentToAgent: true,
      });

      expect(pipelineResult.passed).toBe(true);
    });

    it('SGP-002: all modified files are within expected scope', () => {
      const modifiedFiles = scopeGuard.parseGitDiff(GIT_DIFF_IN_SCOPE);
      const expectedFiles = scopeGuard.extractExpectedFiles(TASK_DESCRIPTION_AUTH);
      const scopeResult = scopeGuard.checkScope(expectedFiles, modifiedFiles);

      expect(scopeResult.inScope).toBe(true);
      expect(scopeResult.unexpectedFiles).toHaveLength(0);
    });

    it('SGP-003: metrics record pass when both pipeline and scope pass', () => {
      const pipelineResult = pipeline.enforce(FLOW_DEVELOPER_COMPLETE, {
        isAgentToAgent: true,
      });

      const modifiedFiles = scopeGuard.parseGitDiff(GIT_DIFF_IN_SCOPE);
      const expectedFiles = scopeGuard.extractExpectedFiles(TASK_DESCRIPTION_AUTH);
      const scopeResult = scopeGuard.checkScope(expectedFiles, modifiedFiles);

      if (pipelineResult.passed && scopeResult.inScope) {
        metrics.recordPass('developer');
      }

      expect(metrics.getPassRate('developer')).toBe(1.0);
    });
  });

  describe('AC #2: Pipeline passes but ScopeGuard detects creep', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });
    const scopeGuard = new ScopeGuard({ mode: 'block' });
    const metrics = new EnforcementMetrics();

    it('SGP-004: developer response passes pipeline checks', () => {
      const pipelineResult = pipeline.enforce(FLOW_DEVELOPER_COMPLETE, {
        isAgentToAgent: true,
      });

      expect(pipelineResult.passed).toBe(true);
    });

    it('SGP-005: scope creep detected — db/ files modified outside task scope', () => {
      const modifiedFiles = scopeGuard.parseGitDiff(GIT_DIFF_SCOPE_CREEP);
      const expectedFiles = scopeGuard.extractExpectedFiles(TASK_DESCRIPTION_AUTH);
      const scopeResult = scopeGuard.checkScope(expectedFiles, modifiedFiles);

      expect(scopeResult.inScope).toBe(false);
      expect(scopeResult.unexpectedFiles).toContain('src/db/migrations/003-add-token-blacklist.ts');
      expect(scopeResult.unexpectedFiles).toContain('src/db/models/user.ts');
      expect(scopeResult.reason).toContain('block');
    });

    it('SGP-006: metrics record scopeGuard rejection on creep', () => {
      const modifiedFiles = scopeGuard.parseGitDiff(GIT_DIFF_SCOPE_CREEP);
      const expectedFiles = scopeGuard.extractExpectedFiles(TASK_DESCRIPTION_AUTH);
      const scopeResult = scopeGuard.checkScope(expectedFiles, modifiedFiles);

      if (!scopeResult.inScope) {
        metrics.recordRejection('developer', 'scopeGuard');
      }

      const devMetrics = metrics.getAgentMetrics('developer');
      expect(devMetrics!.rejectedByScopeGuard).toBe(1);
    });
  });

  describe('AC #3: Pipeline rejects flattery — ScopeGuard never runs', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });
    const scopeGuard = new ScopeGuard({ mode: 'block' });
    const metrics = new EnforcementMetrics();

    it('SGP-007: flattery blocked by pipeline before scope check', () => {
      const pipelineResult = pipeline.enforce(DEVELOPER_FLATTERY_HEAVY, {
        isAgentToAgent: true,
      });

      expect(pipelineResult.passed).toBe(false);

      metrics.recordRejection('developer', 'validator');

      // ScopeGuard should not be invoked — simulate the Discord integration logic
      let scopeGuardInvoked = false;
      if (pipelineResult.passed) {
        scopeGuard.checkScope([], []);
        scopeGuardInvoked = true;
      }

      expect(scopeGuardInvoked).toBe(false);

      const devMetrics = metrics.getAgentMetrics('developer');
      expect(devMetrics!.rejectedByValidator).toBe(1);
      expect(devMetrics!.rejectedByScopeGuard).toBe(0);
    });
  });

  describe('AC #4: ScopeGuard warn mode — passes but logs', () => {
    const scopeGuard = new ScopeGuard({ mode: 'warn' });

    it('SGP-008: warn mode detects scope creep but reason says "warn"', () => {
      const modifiedFiles = scopeGuard.parseGitDiff(GIT_DIFF_SCOPE_CREEP);
      const expectedFiles = scopeGuard.extractExpectedFiles(TASK_DESCRIPTION_AUTH);
      const scopeResult = scopeGuard.checkScope(expectedFiles, modifiedFiles);

      expect(scopeResult.inScope).toBe(false);
      expect(scopeResult.reason).toContain('warn');
      expect(scopeResult.unexpectedFiles.length).toBe(2);
    });
  });

  describe('AC #5: Only test/config files modified — always allowed', () => {
    const scopeGuard = new ScopeGuard({ mode: 'block' });

    it('SGP-009: test and config files pass even with empty expected list', () => {
      const modifiedFiles = scopeGuard.parseGitDiff(GIT_DIFF_ONLY_ALLOWED);
      const scopeResult = scopeGuard.checkScope([], modifiedFiles);

      expect(scopeResult.inScope).toBe(true);
      expect(scopeResult.unexpectedFiles).toHaveLength(0);
    });
  });

  describe('AC #6: Full pipeline + scope + metrics — 5-agent simulation', () => {
    const pipeline = new EnforcementPipeline({ enabled: true });
    const scopeGuard = new ScopeGuard({ mode: 'block' });
    const metrics = new EnforcementMetrics();

    function processResponse(
      agentId: string,
      response: string,
      isAgentToAgent: boolean,
      gitDiff?: string
    ): boolean {
      const pipelineResult = pipeline.enforce(response, { isAgentToAgent });

      if (!pipelineResult.passed) {
        metrics.recordRejection(
          agentId,
          pipelineResult.rejectionReason!.includes('ResponseValidator') ? 'validator' : 'reviewGate'
        );
        return false;
      }

      if (gitDiff) {
        const modifiedFiles = scopeGuard.parseGitDiff(gitDiff);
        const expectedFiles = scopeGuard.extractExpectedFiles(TASK_DESCRIPTION_AUTH);
        const scopeResult = scopeGuard.checkScope(expectedFiles, modifiedFiles);

        if (!scopeResult.inScope) {
          metrics.recordRejection(agentId, 'scopeGuard');
          return false;
        }
      }

      metrics.recordPass(agentId);
      return true;
    }

    it('SGP-010: process 5 responses from 3 agents and verify metrics', () => {
      // Sisyphus: delegation (passes)
      const r1 = processResponse(
        'sisyphus',
        'Analyzing request. DELEGATE::developer::Implement auth.',
        false
      );
      expect(r1).toBe(true);

      // Developer: clean response + in-scope diff (passes)
      const r2 = processResponse('developer', FLOW_DEVELOPER_COMPLETE, true, GIT_DIFF_IN_SCOPE);
      expect(r2).toBe(true);

      // Developer: flattery response (rejected by validator)
      const r3 = processResponse('developer', DEVELOPER_FLATTERY_HEAVY, true);
      expect(r3).toBe(false);

      // Reviewer: APPROVE with evidence (passes)
      const r4 = processResponse(
        'reviewer',
        '승인. 12/12 tests passing, build succeeded, typecheck 0 errors.',
        true
      );
      expect(r4).toBe(true);

      // Developer: clean but scope creep (rejected by scope guard)
      const r5 = processResponse('developer', FLOW_DEVELOPER_COMPLETE, true, GIT_DIFF_SCOPE_CREEP);
      expect(r5).toBe(false);

      const summary = metrics.getSummary();

      expect(summary.global.totalResponses).toBe(5);
      expect(summary.global.passed).toBe(3);
      expect(summary.global.rejectedByValidator).toBe(1);
      expect(summary.global.rejectedByScopeGuard).toBe(1);
      expect(metrics.getPassRate()).toBe(0.6);

      expect(metrics.getPassRate('sisyphus')).toBe(1.0);
      expect(metrics.getPassRate('reviewer')).toBe(1.0);
      expect(metrics.getPassRate('developer')).toBeCloseTo(1 / 3, 2);
    });
  });
});
