/**
 * ScopeGuard - Scope Creep Detection via Git Diff Analysis
 *
 * Detects when an agent modifies files outside the expected scope of a task.
 * Compares expected files (extracted from task description) against actually
 * modified files (from git diff output). Files matching allowed patterns
 * (tests, configs) are always considered in-scope.
 *
 * @module enforcement/scope-guard
 */

/**
 * Result of a scope check
 */
export interface ScopeCheckResult {
  inScope: boolean;
  modifiedFiles: string[];
  unexpectedFiles: string[];
  reason?: string;
}

/**
 * Configuration for the ScopeGuard
 */
export interface ScopeGuardConfig {
  /** Whether scope checking is enabled */
  enabled: boolean;
  /** File patterns that are always allowed (e.g., test files, config) */
  allowedPatterns: string[];
  /** Mode: 'warn' logs but passes, 'block' rejects */
  mode: 'warn' | 'block';
}

// ---------------------------------------------------------------------------
// Pattern Matching (simple glob-like, no external deps)
// ---------------------------------------------------------------------------

/**
 * Match a file path against a simple glob pattern.
 * Supports `*` (any segment chars) and `**` (any path segments).
 *
 * @param pattern - Glob-like pattern (e.g., `*.test.ts`, `src/**`)
 * @param filePath - File path to test
 * @returns true if the file matches the pattern
 */
function matchPattern(pattern: string, filePath: string): boolean {
  // Direct equality
  if (pattern === filePath) {
    return true;
  }

  // Basename-only pattern (no `/`): match against the filename portion
  if (!pattern.includes('/')) {
    const basename = filePath.split('/').pop() ?? filePath;
    return globToRegex(pattern).test(basename);
  }

  // Path pattern: match against the full path
  return globToRegex(pattern).test(filePath);
}

/**
 * Convert a simple glob pattern to a RegExp.
 * `**` → match any path segments; `*` → match any non-`/` chars.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (except * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}') // placeholder for **
    .replace(/\*/g, '[^/]*') // * → any non-slash chars
    .replace(/\?/g, '[^/]') // ? → single non-slash char
    .replace(/\{\{GLOBSTAR\}\}/g, '.*'); // ** → anything

  return new RegExp(`^${escaped}$`);
}

// ---------------------------------------------------------------------------
// File Path Extraction
// ---------------------------------------------------------------------------

/**
 * Regex to find file paths in free-form text.
 * Matches strings like `packages/foo/bar.ts`, `src/index.js`, `README.md`.
 */
const FILE_PATH_REGEX = /[\w\-./]+\.[a-z]{1,4}/g;

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_PATTERNS: string[] = [
  // Test files
  '*.test.ts',
  '*.test.js',
  '*.spec.ts',
  '*.spec.js',
  // Config files
  'package.json',
  'tsconfig.json',
  '.eslintrc*',
  'vitest.config.*',
  'pnpm-lock.yaml',
];

const DEFAULT_CONFIG: ScopeGuardConfig = {
  enabled: true,
  allowedPatterns: DEFAULT_ALLOWED_PATTERNS,
  mode: 'block',
};

// ---------------------------------------------------------------------------
// ScopeGuard
// ---------------------------------------------------------------------------

/**
 * Detects scope creep by comparing expected file modifications (from task
 * descriptions) against actual modifications (from git diff output).
 *
 * Files that match `allowedPatterns` (tests, configs) are always in-scope.
 * Partial directory matching is supported: if an expected path is a prefix
 * of a modified file, the modified file is considered in-scope.
 *
 * @example
 * ```typescript
 * const guard = new ScopeGuard({ mode: 'block' });
 * const modified = guard.parseGitDiff(diffOutput);
 * const expected = guard.extractExpectedFiles(taskDescription);
 * const result = guard.checkScope(expected, modified);
 * if (!result.inScope) {
 *   // scope creep detected
 * }
 * ```
 */
export class ScopeGuard {
  private readonly config: ScopeGuardConfig;

  constructor(config?: Partial<ScopeGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Parse `git diff --name-only` output to extract modified file paths.
   * Filters out blank lines and leading/trailing whitespace.
   *
   * @param diffOutput - Raw output from `git diff --name-only`
   * @returns Array of modified file paths
   */
  parseGitDiff(diffOutput: string): string[] {
    return diffOutput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Extract expected file paths from a task description.
   * Parses file paths from markdown text (backtick-wrapped or bare).
   *
   * @param taskDescription - Free-form task text (may contain markdown)
   * @returns Array of extracted file paths (deduplicated)
   */
  extractExpectedFiles(taskDescription: string): string[] {
    const matches = taskDescription.match(FILE_PATH_REGEX);
    if (!matches) {
      return [];
    }
    return [...new Set(matches)];
  }

  /**
   * Check if modified files match the expected scope from a task description.
   *
   * A modified file is "in scope" when ANY of these conditions hold:
   * 1. It exactly matches an expected file.
   * 2. An expected path is a directory prefix of the modified file.
   * 3. It matches one of the `allowedPatterns`.
   *
   * @param expectedFiles - Files mentioned in the delegation task
   * @param modifiedFiles - Files actually changed (from git diff)
   * @returns ScopeCheckResult with in-scope verdict and details
   */
  checkScope(expectedFiles: string[], modifiedFiles: string[]): ScopeCheckResult {
    if (!this.config.enabled) {
      return { inScope: true, modifiedFiles, unexpectedFiles: [] };
    }

    if (modifiedFiles.length === 0) {
      return { inScope: true, modifiedFiles: [], unexpectedFiles: [] };
    }

    const unexpectedFiles: string[] = [];

    for (const modified of modifiedFiles) {
      if (this.isExpected(modified, expectedFiles)) {
        continue;
      }
      if (this.isAllowed(modified)) {
        continue;
      }
      unexpectedFiles.push(modified);
    }

    const inScope = unexpectedFiles.length === 0;
    const result: ScopeCheckResult = { inScope, modifiedFiles, unexpectedFiles };

    if (!inScope) {
      const fileList = unexpectedFiles.join(', ');
      result.reason =
        this.config.mode === 'block'
          ? `Scope creep detected (block): unexpected files modified: ${fileList}`
          : `Scope creep detected (warn): unexpected files modified: ${fileList}`;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Check if a modified file is expected via exact match or directory prefix.
   */
  private isExpected(modifiedFile: string, expectedFiles: string[]): boolean {
    for (const expected of expectedFiles) {
      // Exact match
      if (modifiedFile === expected) {
        return true;
      }
      // Directory prefix: `src/enforcement/` expected → `src/enforcement/index.ts` is in scope
      if (expected.endsWith('/') && modifiedFile.startsWith(expected)) {
        return true;
      }
      // Non-trailing-slash directory prefix (e.g., `src/enforcement` → `src/enforcement/index.ts`)
      if (!expected.includes('.') && modifiedFile.startsWith(expected + '/')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a modified file matches any of the allowed patterns.
   */
  private isAllowed(filePath: string): boolean {
    return this.config.allowedPatterns.some((pattern) => matchPattern(pattern, filePath));
  }
}
