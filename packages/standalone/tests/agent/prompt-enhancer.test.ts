/**
 * Unit tests for PromptEnhancer
 *
 * Story: Prompt enhancement with keyword detection, AGENTS.md discovery, and rules injection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptEnhancer } from '../../src/agent/prompt-enhancer.js';

describe('PromptEnhancer', () => {
  let enhancer: PromptEnhancer;

  beforeEach(() => {
    enhancer = new PromptEnhancer();
  });

  // ─────────────────────────────────────────────────────
  // detectKeywords()
  // ─────────────────────────────────────────────────────
  describe('detectKeywords()', () => {
    it('should detect "ultrawork" keyword (case insensitive)', () => {
      const result = enhancer.detectKeywords('Please run in Ultrawork mode');
      expect(result).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect "ulw" short form', () => {
      const result = enhancer.detectKeywords('do this ulw');
      expect(result).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect "[ultrawork]" bracket form', () => {
      const result = enhancer.detectKeywords('[ultrawork] fix the bug');
      expect(result).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect "[ulw]" bracket form', () => {
      const result = enhancer.detectKeywords('[ulw] deploy changes');
      expect(result).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect "[ulw-loop]" bracket form', () => {
      const result = enhancer.detectKeywords('[ulw-loop] keep going');
      expect(result).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect "search-mode" keyword', () => {
      const result = enhancer.detectKeywords('enter search-mode please');
      expect(result).toContain('SEARCH MODE');
    });

    it('should detect "search mode" with space', () => {
      const result = enhancer.detectKeywords('use search mode now');
      expect(result).toContain('SEARCH MODE');
    });

    it('should detect "[search-mode]" bracket form', () => {
      const result = enhancer.detectKeywords('[search-mode] find all usages');
      expect(result).toContain('SEARCH MODE');
    });

    it('should detect "find all" pattern for search mode', () => {
      const result = enhancer.detectKeywords('find all instances across the codebase');
      expect(result).toContain('SEARCH MODE');
    });

    it('should detect "explore codebase" pattern for search mode', () => {
      const result = enhancer.detectKeywords('explore the codebase for patterns');
      expect(result).toContain('SEARCH MODE');
    });

    it('should detect "analyze-mode" keyword', () => {
      const result = enhancer.detectKeywords('enter analyze-mode');
      expect(result).toContain('ANALYSIS MODE');
    });

    it('should detect "investigate" keyword for analyze mode', () => {
      const result = enhancer.detectKeywords('investigate this crash');
      expect(result).toContain('ANALYSIS MODE');
    });

    it('should detect "research deep" pattern for analyze mode', () => {
      const result = enhancer.detectKeywords('research deep into the auth flow');
      expect(result).toContain('ANALYSIS MODE');
    });

    it('should detect "debug thorough" pattern for analyze mode', () => {
      const result = enhancer.detectKeywords('debug thorough the memory leak');
      expect(result).toContain('ANALYSIS MODE');
    });

    it('should return empty string when no keyword matches', () => {
      const result = enhancer.detectKeywords('just a normal message');
      expect(result).toBe('');
    });

    it('should return empty string for empty input', () => {
      expect(enhancer.detectKeywords('')).toBe('');
    });

    it('should return empty string for null/undefined input', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(enhancer.detectKeywords(null as unknown as string)).toBe('');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(enhancer.detectKeywords(undefined as unknown as string)).toBe('');
    });

    it('should strip triple-backtick code blocks before keyword detection', () => {
      const message = 'Here is code:\n```\nultrawork mode activated\n```\nThat is all.';
      const result = enhancer.detectKeywords(message);
      expect(result).toBe('');
    });

    it('should strip inline code before keyword detection', () => {
      const message = 'The variable `ultrawork` should be renamed';
      const result = enhancer.detectKeywords(message);
      expect(result).toBe('');
    });

    it('should combine multiple keyword matches with --- separator', () => {
      const message = 'ultrawork and also investigate this issue';
      const result = enhancer.detectKeywords(message);
      expect(result).toContain('ULTRAWORK MODE ACTIVATED');
      expect(result).toContain('ANALYSIS MODE');
      expect(result).toContain('---');
    });

    it('should detect keywords outside code blocks even when code blocks are present', () => {
      const message = '```\nsome code\n```\nultrawork mode please';
      const result = enhancer.detectKeywords(message);
      expect(result).toContain('ULTRAWORK MODE ACTIVATED');
    });

    // Multilingual: ultrawork
    it('should detect Korean "울트라워크"', () => {
      expect(enhancer.detectKeywords('울트라워크 모드로 진행')).toContain(
        'ULTRAWORK MODE ACTIVATED'
      );
    });

    it('should detect Korean "자율 작업"', () => {
      expect(enhancer.detectKeywords('자율 작업으로 해줘')).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect Korean "딥 워크"', () => {
      expect(enhancer.detectKeywords('딥 워크로 시작')).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect Japanese "ウルトラワーク"', () => {
      expect(enhancer.detectKeywords('ウルトラワークで進めて')).toContain(
        'ULTRAWORK MODE ACTIVATED'
      );
    });

    it('should detect Japanese "自律作業"', () => {
      expect(enhancer.detectKeywords('自律作業モードで')).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect Chinese "超级工作"', () => {
      expect(enhancer.detectKeywords('超级工作模式开始')).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect Chinese "自主工作"', () => {
      expect(enhancer.detectKeywords('请用自主工作模式')).toContain('ULTRAWORK MODE ACTIVATED');
    });

    it('should detect Vietnamese "tự động hoàn toàn"', () => {
      expect(enhancer.detectKeywords('hãy tự động hoàn toàn')).toContain(
        'ULTRAWORK MODE ACTIVATED'
      );
    });

    it('should detect English "deep work"', () => {
      expect(enhancer.detectKeywords('do this in deep work mode')).toContain(
        'ULTRAWORK MODE ACTIVATED'
      );
    });

    it('should detect English "autonomous"', () => {
      expect(enhancer.detectKeywords('run autonomous please')).toContain(
        'ULTRAWORK MODE ACTIVATED'
      );
    });

    it('should detect English "full auto"', () => {
      expect(enhancer.detectKeywords('full auto mode on')).toContain('ULTRAWORK MODE ACTIVATED');
    });

    // Multilingual: search
    it('should detect Korean "검색 모드"', () => {
      expect(enhancer.detectKeywords('검색 모드로 찾아줘')).toContain('SEARCH MODE');
    });

    it('should detect Korean "전부 찾아"', () => {
      expect(enhancer.detectKeywords('관련된거 전부 찾아')).toContain('SEARCH MODE');
    });

    it('should detect Korean "어디.*사용"', () => {
      expect(enhancer.detectKeywords('이 함수 어디서 사용해?')).toContain('SEARCH MODE');
    });

    it('should detect Japanese "検索モード"', () => {
      expect(enhancer.detectKeywords('検索モードで探して')).toContain('SEARCH MODE');
    });

    it('should detect Chinese "搜索模式"', () => {
      expect(enhancer.detectKeywords('搜索模式开始')).toContain('SEARCH MODE');
    });

    it('should detect Vietnamese "tìm tất cả"', () => {
      expect(enhancer.detectKeywords('hãy tìm tất cả các file')).toContain('SEARCH MODE');
    });

    it('should detect English "find all"', () => {
      expect(enhancer.detectKeywords('find all usages of this function')).toContain('SEARCH MODE');
    });

    it('should detect English "show me all"', () => {
      expect(enhancer.detectKeywords('show me all imports')).toContain('SEARCH MODE');
    });

    it('should detect English "where is used"', () => {
      expect(enhancer.detectKeywords('where is this function used')).toContain('SEARCH MODE');
    });

    // Multilingual: analyze
    it('should detect Korean "분석 모드"', () => {
      expect(enhancer.detectKeywords('분석 모드로 봐줘')).toContain('ANALYSIS MODE');
    });

    it('should detect Korean "근본 원인"', () => {
      expect(enhancer.detectKeywords('근본 원인을 찾아줘')).toContain('ANALYSIS MODE');
    });

    it('should detect Korean "왜 안 되"', () => {
      expect(enhancer.detectKeywords('왜 안 되는거야?')).toContain('ANALYSIS MODE');
    });

    it('should detect Japanese "分析モード"', () => {
      expect(enhancer.detectKeywords('分析モードで調べて')).toContain('ANALYSIS MODE');
    });

    it('should detect Japanese "根本原因"', () => {
      expect(enhancer.detectKeywords('根本原因を見つけて')).toContain('ANALYSIS MODE');
    });

    it('should detect Chinese "深入分析"', () => {
      expect(enhancer.detectKeywords('请深入分析这个问题')).toContain('ANALYSIS MODE');
    });

    it('should detect Vietnamese "phân tích sâu"', () => {
      expect(enhancer.detectKeywords('hãy phân tích sâu vấn đề này')).toContain('ANALYSIS MODE');
    });

    it('should detect English "root cause"', () => {
      expect(enhancer.detectKeywords('find the root cause of this crash')).toContain(
        'ANALYSIS MODE'
      );
    });

    it('should detect English "deep dive"', () => {
      expect(enhancer.detectKeywords('do a deep dive into the auth module')).toContain(
        'ANALYSIS MODE'
      );
    });

    it('should detect English "diagnose"', () => {
      expect(enhancer.detectKeywords('diagnose why the test is failing')).toContain(
        'ANALYSIS MODE'
      );
    });
  });

  // ─────────────────────────────────────────────────────
  // discoverAgentsMd()
  // ─────────────────────────────────────────────────────
  describe('discoverAgentsMd()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'mama-test-agents-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should find AGENTS.md in parent directories', () => {
      // Structure:
      // tmpDir/
      //   .git/              (project root)
      //   packages/
      //     AGENTS.md        (should be found)
      //     sub/
      //       file.ts        (workspace path)
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      mkdirSync(join(tmpDir, 'packages', 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), '# Package Agents');
      writeFileSync(join(tmpDir, 'packages', 'sub', 'file.ts'), '');

      const result = enhancer.discoverAgentsMd(join(tmpDir, 'packages', 'sub', 'file.ts'));
      expect(result).toContain('# Package Agents');
      expect(result).toContain('AGENTS.md from');
    });

    it('should skip project root AGENTS.md', () => {
      // Structure:
      // tmpDir/
      //   .git/              (project root marker)
      //   AGENTS.md          (project root — should be SKIPPED)
      //   packages/
      //     sub/
      //       file.ts
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      mkdirSync(join(tmpDir, 'packages', 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'AGENTS.md'), '# Root Agents');
      writeFileSync(join(tmpDir, 'packages', 'sub', 'file.ts'), '');

      const result = enhancer.discoverAgentsMd(join(tmpDir, 'packages', 'sub', 'file.ts'));
      expect(result).toBe('');
    });

    it('should find non-root AGENTS.md while skipping root one', () => {
      // tmpDir/
      //   .git/
      //   AGENTS.md          (root — skipped)
      //   packages/
      //     AGENTS.md        (found)
      //     sub/
      //       file.ts
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      mkdirSync(join(tmpDir, 'packages', 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'AGENTS.md'), '# Root Agents');
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), '# Package Agents');
      writeFileSync(join(tmpDir, 'packages', 'sub', 'file.ts'), '');

      const result = enhancer.discoverAgentsMd(join(tmpDir, 'packages', 'sub', 'file.ts'));
      expect(result).toContain('# Package Agents');
      expect(result).not.toContain('# Root Agents');
    });

    it('should return empty string for non-existent workspace path', () => {
      const result = enhancer.discoverAgentsMd('/totally/nonexistent/path/xyz');
      expect(result).toBe('');
    });

    it('should return empty string for empty workspace path', () => {
      const result = enhancer.discoverAgentsMd('');
      expect(result).toBe('');
    });

    it('should respect maxDepth of 5 levels', () => {
      // Create a deeply nested structure: 8 levels deep
      // AGENTS.md at level 7 from workspace (beyond maxDepth=5)
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      const deepPath = join(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
      mkdirSync(deepPath, { recursive: true });
      writeFileSync(join(tmpDir, 'a', 'AGENTS.md'), '# Deep Agents');
      writeFileSync(join(deepPath, 'file.ts'), '');

      // From h -> g -> f -> e -> d -> c (5 levels) — 'a' is at depth 6+, shouldn't reach
      const result = enhancer.discoverAgentsMd(join(deepPath, 'file.ts'));
      expect(result).toBe('');
    });

    it('should handle workspace path as directory', () => {
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      mkdirSync(join(tmpDir, 'packages', 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), '# Agents Here');

      const result = enhancer.discoverAgentsMd(join(tmpDir, 'packages', 'sub'));
      expect(result).toContain('# Agents Here');
    });

    it('should include distance in AGENTS.md comment', () => {
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      mkdirSync(join(tmpDir, 'packages', 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), '# Agents');
      writeFileSync(join(tmpDir, 'packages', 'sub', 'file.ts'), '');

      const result = enhancer.discoverAgentsMd(join(tmpDir, 'packages', 'sub', 'file.ts'));
      expect(result).toMatch(/distance: \d+/);
    });
  });

  // ─────────────────────────────────────────────────────
  // discoverRules()
  // ─────────────────────────────────────────────────────
  describe('discoverRules()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'mama-test-rules-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should find .copilot-instructions at project root', () => {
      // tmpDir/
      //   package.json       (project root marker)
      //   .copilot-instructions
      //   sub/
      //     file.ts
      writeFileSync(join(tmpDir, 'package.json'), '{}');
      writeFileSync(join(tmpDir, '.copilot-instructions'), 'Use semicolons always');
      mkdirSync(join(tmpDir, 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'sub', 'file.ts'), '');

      const result = enhancer.discoverRules(join(tmpDir, 'sub', 'file.ts'));
      expect(result).toContain('Use semicolons always');
      expect(result).toContain('.copilot-instructions');
    });

    it('should find .claude/rules/*.md files', () => {
      // tmpDir/
      //   package.json
      //   .claude/
      //     rules/
      //       rule1.md
      //       rule2.md
      //   sub/
      //     file.ts
      writeFileSync(join(tmpDir, 'package.json'), '{}');
      mkdirSync(join(tmpDir, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'rules', 'rule1.md'), 'Rule one content');
      writeFileSync(join(tmpDir, '.claude', 'rules', 'rule2.md'), 'Rule two content');
      mkdirSync(join(tmpDir, 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'sub', 'file.ts'), '');

      const result = enhancer.discoverRules(join(tmpDir, 'sub', 'file.ts'));
      expect(result).toContain('Rule one content');
      expect(result).toContain('Rule two content');
    });

    it('should ignore non-.md files in rules directory', () => {
      writeFileSync(join(tmpDir, 'package.json'), '{}');
      mkdirSync(join(tmpDir, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'rules', 'rule1.md'), 'Valid rule');
      writeFileSync(join(tmpDir, '.claude', 'rules', 'ignored.txt'), 'Should be ignored');
      writeFileSync(join(tmpDir, '.claude', 'rules', 'data.json'), '{}');
      mkdirSync(join(tmpDir, 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'sub', 'file.ts'), '');

      const result = enhancer.discoverRules(join(tmpDir, 'sub', 'file.ts'));
      expect(result).toContain('Valid rule');
      expect(result).not.toContain('Should be ignored');
      expect(result).not.toContain('data.json');
    });

    it('should return empty string when no project root found', () => {
      // No project root markers in temp dir (no .git, package.json, etc.)
      // Create a deeply nested structure without any markers
      const isolatedTmp = mkdtempSync(join(tmpdir(), 'mama-no-root-'));
      try {
        mkdirSync(join(isolatedTmp, 'sub'), { recursive: true });
        writeFileSync(join(isolatedTmp, 'sub', 'file.ts'), '');

        const result = enhancer.discoverRules(join(isolatedTmp, 'sub', 'file.ts'));
        expect(result).toBe('');
      } finally {
        rmSync(isolatedTmp, { recursive: true, force: true });
      }
    });

    it('should return empty string for empty workspace path', () => {
      const result = enhancer.discoverRules('');
      expect(result).toBe('');
    });

    it('should find directory-level .claude/rules/*.md walking up from workspace', () => {
      // tmpDir/
      //   package.json       (project root)
      //   sub/
      //     .claude/
      //       rules/
      //         local-rule.md
      //     deep/
      //       file.ts
      writeFileSync(join(tmpDir, 'package.json'), '{}');
      mkdirSync(join(tmpDir, 'sub', '.claude', 'rules'), { recursive: true });
      writeFileSync(join(tmpDir, 'sub', '.claude', 'rules', 'local-rule.md'), 'Local rule here');
      mkdirSync(join(tmpDir, 'sub', 'deep'), { recursive: true });
      writeFileSync(join(tmpDir, 'sub', 'deep', 'file.ts'), '');

      const result = enhancer.discoverRules(join(tmpDir, 'sub', 'deep', 'file.ts'));
      expect(result).toContain('Local rule here');
    });

    it('should combine .copilot-instructions and .claude/rules', () => {
      writeFileSync(join(tmpDir, 'package.json'), '{}');
      writeFileSync(join(tmpDir, '.copilot-instructions'), 'Copilot instructions');
      mkdirSync(join(tmpDir, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'rules', 'style.md'), 'Style rules');
      mkdirSync(join(tmpDir, 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'sub', 'file.ts'), '');

      const result = enhancer.discoverRules(join(tmpDir, 'sub', 'file.ts'));
      expect(result).toContain('Copilot instructions');
      expect(result).toContain('Style rules');
      expect(result).toContain('---');
    });

    it('should skip empty .copilot-instructions files', () => {
      writeFileSync(join(tmpDir, 'package.json'), '{}');
      writeFileSync(join(tmpDir, '.copilot-instructions'), '   ');
      mkdirSync(join(tmpDir, 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'sub', 'file.ts'), '');

      const result = enhancer.discoverRules(join(tmpDir, 'sub', 'file.ts'));
      expect(result).toBe('');
    });
  });

  // ─────────────────────────────────────────────────────
  // enhance() integration tests
  // ─────────────────────────────────────────────────────
  describe('enhance()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'mama-test-enhance-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return all three fields', () => {
      const result = enhancer.enhance('hello world', '/nonexistent/path');
      expect(result).toHaveProperty('keywordInstructions');
      expect(result).toHaveProperty('agentsContent');
      expect(result).toHaveProperty('rulesContent');
    });

    it('should return empty strings when nothing matches', () => {
      const result = enhancer.enhance('normal message', '/nonexistent');
      expect(result.keywordInstructions).toBe('');
      expect(result.agentsContent).toBe('');
      expect(result.rulesContent).toBe('');
    });

    it('should combine keyword + agents + rules correctly', () => {
      // Set up filesystem structure with AGENTS.md and rules
      writeFileSync(join(tmpDir, 'package.json'), '{}');
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      mkdirSync(join(tmpDir, 'packages', 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), '# Package Agents Content');
      mkdirSync(join(tmpDir, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'rules', 'test.md'), 'Test rule content');
      writeFileSync(join(tmpDir, 'packages', 'sub', 'file.ts'), '');

      const result = enhancer.enhance(
        'ultrawork fix everything',
        join(tmpDir, 'packages', 'sub', 'file.ts')
      );

      expect(result.keywordInstructions).toContain('ULTRAWORK MODE ACTIVATED');
      expect(result.agentsContent).toContain('# Package Agents Content');
      expect(result.rulesContent).toContain('Test rule content');
    });

    it('should return EnhancedPromptContext type with correct structure', () => {
      const result = enhancer.enhance('', '');
      expect(typeof result.keywordInstructions).toBe('string');
      expect(typeof result.agentsContent).toBe('string');
      expect(typeof result.rulesContent).toBe('string');
    });
  });

  // ─────────────────────────────────────────────────────
  // File cache tests
  // ─────────────────────────────────────────────────────
  describe('file cache', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'mama-test-cache-'));
    });

    afterEach(() => {
      vi.useRealTimers();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should use cached content on second call within TTL', () => {
      // Set up a structure with AGENTS.md
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      mkdirSync(join(tmpDir, 'packages', 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), 'Original content');
      writeFileSync(join(tmpDir, 'packages', 'sub', 'file.ts'), '');

      const workspacePath = join(tmpDir, 'packages', 'sub', 'file.ts');

      // First call — reads from disk
      const result1 = enhancer.discoverAgentsMd(workspacePath);
      expect(result1).toContain('Original content');

      // Modify file on disk
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), 'Modified content');

      // Second call within TTL — should still see original (cached)
      const result2 = enhancer.discoverAgentsMd(workspacePath);
      expect(result2).toContain('Original content');
      expect(result2).not.toContain('Modified content');
    });

    it('should expire cache after TTL (60000ms)', () => {
      vi.useFakeTimers();

      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      mkdirSync(join(tmpDir, 'packages', 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), 'Original content');
      writeFileSync(join(tmpDir, 'packages', 'sub', 'file.ts'), '');

      const workspacePath = join(tmpDir, 'packages', 'sub', 'file.ts');

      // First call — reads from disk
      const result1 = enhancer.discoverAgentsMd(workspacePath);
      expect(result1).toContain('Original content');

      // Modify file on disk
      writeFileSync(join(tmpDir, 'packages', 'AGENTS.md'), 'Updated content');

      // Advance time past TTL
      vi.advanceTimersByTime(61_000);

      // Third call — cache expired, should read updated file
      const result2 = enhancer.discoverAgentsMd(workspacePath);
      expect(result2).toContain('Updated content');
      expect(result2).not.toContain('Original content');
    });

    it('should cache rules files too', () => {
      writeFileSync(join(tmpDir, 'package.json'), '{}');
      mkdirSync(join(tmpDir, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'rules', 'rule.md'), 'Rule v1');
      mkdirSync(join(tmpDir, 'sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'sub', 'file.ts'), '');

      const workspacePath = join(tmpDir, 'sub', 'file.ts');

      // First call
      const result1 = enhancer.discoverRules(workspacePath);
      expect(result1).toContain('Rule v1');

      // Modify on disk
      writeFileSync(join(tmpDir, '.claude', 'rules', 'rule.md'), 'Rule v2');

      // Should still see cached version
      const result2 = enhancer.discoverRules(workspacePath);
      expect(result2).toContain('Rule v1');
    });
  });
});
