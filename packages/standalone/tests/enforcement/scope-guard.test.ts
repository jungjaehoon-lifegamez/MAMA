import { describe, it, expect } from 'vitest';
import { ScopeGuard } from '../../src/enforcement/scope-guard.js';
import type { ScopeCheckResult } from '../../src/enforcement/scope-guard.js';

describe('Story M3.3: ScopeGuard — Scope Creep Detection', () => {
  const guard = new ScopeGuard();

  describe('AC #1: All modified files in expected scope', () => {
    it('SG-001: should return inScope=true when all modified files are expected', () => {
      const expected = ['src/enforcement/scope-guard.ts', 'src/enforcement/review-gate.ts'];
      const modified = ['src/enforcement/scope-guard.ts', 'src/enforcement/review-gate.ts'];

      const result: ScopeCheckResult = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(true);
      expect(result.unexpectedFiles).toEqual([]);
      expect(result.modifiedFiles).toEqual(modified);
    });
  });

  describe('AC #2: One unexpected file detected', () => {
    it('SG-002: should return inScope=false with one unexpected file', () => {
      const expected = ['src/enforcement/scope-guard.ts'];
      const modified = ['src/enforcement/scope-guard.ts', 'src/agent/agent-loop.ts'];

      const result = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(false);
      expect(result.unexpectedFiles).toEqual(['src/agent/agent-loop.ts']);
      expect(result.reason).toContain('src/agent/agent-loop.ts');
    });
  });

  describe('AC #3: Multiple unexpected files detected', () => {
    it('SG-003: should list all unexpected files', () => {
      const expected = ['src/enforcement/scope-guard.ts'];
      const modified = [
        'src/enforcement/scope-guard.ts',
        'src/agent/agent-loop.ts',
        'src/gateways/discord.ts',
        'src/config/loader.ts',
      ];

      const result = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(false);
      expect(result.unexpectedFiles).toHaveLength(3);
      expect(result.unexpectedFiles).toContain('src/agent/agent-loop.ts');
      expect(result.unexpectedFiles).toContain('src/gateways/discord.ts');
      expect(result.unexpectedFiles).toContain('src/config/loader.ts');
    });
  });

  describe('AC #4: Test files are always allowed', () => {
    it('SG-004: should allow test files even when not in expected list', () => {
      const expected = ['src/enforcement/scope-guard.ts'];
      const modified = ['src/enforcement/scope-guard.ts', 'tests/enforcement/scope-guard.test.ts'];

      const result = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(true);
      expect(result.unexpectedFiles).toEqual([]);
    });

    it('SG-004b: should allow .spec.ts and .test.js files', () => {
      const expected = ['src/foo.ts'];
      const modified = [
        'src/foo.ts',
        'tests/foo.spec.ts',
        'tests/bar.test.js',
        'tests/baz.spec.js',
      ];

      const result = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(true);
      expect(result.unexpectedFiles).toEqual([]);
    });
  });

  describe('AC #5: Config files are always allowed', () => {
    it('SG-005: should allow config file changes', () => {
      const expected = ['src/enforcement/scope-guard.ts'];
      const modified = ['src/enforcement/scope-guard.ts', 'package.json', 'tsconfig.json'];

      const result = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(true);
      expect(result.unexpectedFiles).toEqual([]);
    });
  });

  describe('AC #6: Empty diff is always in scope', () => {
    it('SG-006: should return inScope=true for empty diff', () => {
      const result = guard.checkScope(['src/foo.ts'], []);

      expect(result.inScope).toBe(true);
      expect(result.modifiedFiles).toEqual([]);
      expect(result.unexpectedFiles).toEqual([]);
    });
  });

  describe('AC #7: Empty expected files → all non-allowed are unexpected', () => {
    it('SG-007: should flag all non-allowed files as unexpected when no files expected', () => {
      const modified = [
        'src/agent/agent-loop.ts',
        'tests/agent/agent-loop.test.ts',
        'package.json',
      ];

      const result = guard.checkScope([], modified);

      expect(result.inScope).toBe(false);
      expect(result.unexpectedFiles).toEqual(['src/agent/agent-loop.ts']);
    });
  });

  describe('AC #8: parseGitDiff extracts correct file list', () => {
    it('SG-008: should parse standard git diff --name-only output', () => {
      const diffOutput = [
        'src/enforcement/scope-guard.ts',
        'src/enforcement/review-gate.ts',
        'package.json',
        '',
      ].join('\n');

      const files = guard.parseGitDiff(diffOutput);

      expect(files).toEqual([
        'src/enforcement/scope-guard.ts',
        'src/enforcement/review-gate.ts',
        'package.json',
      ]);
    });

    it('SG-008b: should handle whitespace and empty lines', () => {
      const diffOutput = '\n  src/foo.ts  \n\n  src/bar.ts\n\n';

      const files = guard.parseGitDiff(diffOutput);

      expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('SG-008c: should return empty array for empty input', () => {
      expect(guard.parseGitDiff('')).toEqual([]);
      expect(guard.parseGitDiff('  \n  \n  ')).toEqual([]);
    });
  });

  describe('AC #9: extractExpectedFiles finds paths in markdown text', () => {
    it('SG-009: should extract file paths from task description', () => {
      const task = [
        'Implement the ScopeGuard in `packages/standalone/src/enforcement/scope-guard.ts`',
        'and tests in `packages/standalone/tests/enforcement/scope-guard.test.ts`.',
      ].join('\n');

      const files = guard.extractExpectedFiles(task);

      expect(files).toContain('packages/standalone/src/enforcement/scope-guard.ts');
      expect(files).toContain('packages/standalone/tests/enforcement/scope-guard.test.ts');
    });

    it('SG-009b: should deduplicate repeated file paths', () => {
      const task = 'Edit src/foo.ts and then update src/foo.ts again.';

      const files = guard.extractExpectedFiles(task);

      expect(files.filter((f) => f === 'src/foo.ts')).toHaveLength(1);
    });

    it('SG-009c: should return empty array when no paths found', () => {
      const task = 'Fix the authentication bug in the login module.';

      expect(guard.extractExpectedFiles(task)).toEqual([]);
    });
  });

  describe('AC #10: Disabled guard always passes', () => {
    it('SG-010: should return inScope=true when disabled', () => {
      const disabledGuard = new ScopeGuard({ enabled: false });
      const modified = ['src/agent/agent-loop.ts', 'src/gateways/discord.ts'];

      const result = disabledGuard.checkScope([], modified);

      expect(result.inScope).toBe(true);
      expect(result.unexpectedFiles).toEqual([]);
    });
  });

  describe('AC #11: Warn mode vs block mode', () => {
    it('SG-011a: block mode includes "block" in reason', () => {
      const blockGuard = new ScopeGuard({ mode: 'block' });
      const result = blockGuard.checkScope(['src/foo.ts'], ['src/foo.ts', 'src/bar.ts']);

      expect(result.inScope).toBe(false);
      expect(result.reason).toContain('block');
    });

    it('SG-011b: warn mode includes "warn" in reason', () => {
      const warnGuard = new ScopeGuard({ mode: 'warn' });
      const result = warnGuard.checkScope(['src/foo.ts'], ['src/foo.ts', 'src/bar.ts']);

      expect(result.inScope).toBe(false);
      expect(result.reason).toContain('warn');
    });

    it('SG-011c: both modes detect the same unexpected files', () => {
      const blockGuard = new ScopeGuard({ mode: 'block' });
      const warnGuard = new ScopeGuard({ mode: 'warn' });
      const expected = ['src/foo.ts'];
      const modified = ['src/foo.ts', 'src/bar.ts'];

      const blockResult = blockGuard.checkScope(expected, modified);
      const warnResult = warnGuard.checkScope(expected, modified);

      expect(blockResult.unexpectedFiles).toEqual(warnResult.unexpectedFiles);
      expect(blockResult.inScope).toBe(warnResult.inScope);
    });
  });

  describe('AC #12: Nested path matching (directory prefix)', () => {
    it('SG-012a: trailing-slash directory expected → files under it are in scope', () => {
      const expected = ['src/enforcement/'];
      const modified = ['src/enforcement/scope-guard.ts', 'src/enforcement/review-gate.ts'];

      const result = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(true);
      expect(result.unexpectedFiles).toEqual([]);
    });

    it('SG-012b: directory without trailing slash → files under it are in scope', () => {
      const expected = ['src/enforcement'];
      const modified = ['src/enforcement/scope-guard.ts', 'src/enforcement/index.ts'];

      const result = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(true);
      expect(result.unexpectedFiles).toEqual([]);
    });

    it('SG-012c: partial directory name should NOT match different directory', () => {
      const expected = ['src/enforce'];
      const modified = ['src/enforcement/scope-guard.ts'];

      const result = guard.checkScope(expected, modified);

      expect(result.inScope).toBe(false);
      expect(result.unexpectedFiles).toEqual(['src/enforcement/scope-guard.ts']);
    });
  });

  describe('AC #13: Custom allowed patterns', () => {
    it('SG-013: should respect custom allowedPatterns', () => {
      const customGuard = new ScopeGuard({
        allowedPatterns: ['*.md', '*.yaml'],
      });

      const result = customGuard.checkScope(
        ['src/foo.ts'],
        ['src/foo.ts', 'README.md', 'config.yaml', 'package.json']
      );

      expect(result.inScope).toBe(false);
      expect(result.unexpectedFiles).toEqual(['package.json']);
    });
  });

  describe('AC #14: Default config values', () => {
    it('SG-014: should use sensible defaults', () => {
      const defaultGuard = new ScopeGuard();
      const result = defaultGuard.checkScope(
        ['src/foo.ts'],
        [
          'src/foo.ts',
          'tests/foo.test.ts',
          'tests/bar.spec.ts',
          'tests/baz.test.js',
          'tests/qux.spec.js',
          'package.json',
          'tsconfig.json',
        ]
      );

      expect(result.inScope).toBe(true);
      expect(result.unexpectedFiles).toEqual([]);
    });
  });
});
