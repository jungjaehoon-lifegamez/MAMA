/**
 * Tests for UserPromptSubmit Hook (Keyword Detection)
 *
 * Story M2.1: UserPromptSubmit Hook — Keyword Detection Only
 * Tests: Keyword patterns, behavior mode injection, feature guard, edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const hookPath = path.join(__dirname, '../../scripts/userpromptsubmit-hook.js');
const hook = require(hookPath);

const originalEnv = { ...process.env };

describe('Story M2.1: UserPromptSubmit Keyword Detection', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Hook Structure', () => {
    it('should export required functions', () => {
      expect(hook).toHaveProperty('detectKeywords');
      expect(hook).toHaveProperty('KEYWORD_DETECTORS');
      expect(hook).toHaveProperty('getEnabledFeatures');
      expect(typeof hook.detectKeywords).toBe('function');
      expect(Array.isArray(hook.KEYWORD_DETECTORS)).toBe(true);
      expect(typeof hook.getEnabledFeatures).toBe('function');
    });

    it('should be executable script with shebang', () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });

    it('should have 3 keyword detector types', () => {
      const types = hook.KEYWORD_DETECTORS.map((d) => d.type);
      expect(types).toContain('ultrawork');
      expect(types).toContain('search');
      expect(types).toContain('analyze');
    });
  });

  describe('Keyword Detection: ultrawork', () => {
    it('should detect "ultrawork" keyword', () => {
      const results = hook.detectKeywords('ultrawork do this task');
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('ultrawork');
    });

    it('should detect "ulw" shorthand', () => {
      const results = hook.detectKeywords('ulw fix this bug');
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('ultrawork');
    });

    it('should detect "[ultrawork]" bracket format', () => {
      const results = hook.detectKeywords('[ultrawork] implement feature');
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('ultrawork');
    });

    it('should include mode activation message', () => {
      const results = hook.detectKeywords('ultrawork');
      expect(results[0].message).toContain('[ultrawork-mode]');
      expect(results[0].message).toContain('Max precision');
    });
  });

  describe('Keyword Detection: search', () => {
    it('should detect "search-mode" keyword', () => {
      const results = hook.detectKeywords('[search-mode] find implementations');
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('search');
    });

    it('should detect "find all" pattern', () => {
      const results = hook.detectKeywords('find all usages across the codebase');
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('search');
    });

    it('should detect "explore codebase" pattern', () => {
      const results = hook.detectKeywords('explore the codebase for auth patterns');
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('search');
    });

    it('should include search mode instructions', () => {
      const results = hook.detectKeywords('[search-mode]');
      expect(results[0].message).toContain('[search-mode]');
      expect(results[0].message).toContain('Explore codebase');
    });
  });

  describe('Keyword Detection: analyze', () => {
    it('should detect "analyze-mode" keyword', () => {
      const results = hook.detectKeywords('[analyze-mode] check architecture');
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('analyze');
    });

    it('should detect "investigate" keyword', () => {
      const results = hook.detectKeywords('investigate why tests fail');
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('analyze');
    });

    it('should include analysis mode instructions', () => {
      const results = hook.detectKeywords('[analyze-mode]');
      expect(results[0].message).toContain('[analyze-mode]');
      expect(results[0].message).toContain('Oracle/Artistry');
    });
  });

  describe('Multiple Keywords', () => {
    it('should detect multiple keyword types in one message', () => {
      const results = hook.detectKeywords('[ultrawork] [analyze-mode] deep dive');
      expect(results.length).toBe(2);
      const types = results.map((r) => r.type);
      expect(types).toContain('ultrawork');
      expect(types).toContain('analyze');
    });
  });

  describe('No Keywords (Edge Cases)', () => {
    it('should return empty array for plain text', () => {
      expect(hook.detectKeywords('fix the bug in auth.js')).toEqual([]);
    });

    it('should return empty array for empty/null/undefined', () => {
      expect(hook.detectKeywords('')).toEqual([]);
      expect(hook.detectKeywords(null)).toEqual([]);
      expect(hook.detectKeywords(undefined)).toEqual([]);
    });

    it('should not detect keywords inside code blocks', () => {
      const text = 'Check this:\n```\nconst mode = "ultrawork";\n```\nDone.';
      expect(hook.detectKeywords(text)).toEqual([]);
    });

    it('should not detect keywords inside inline code', () => {
      expect(hook.detectKeywords('The `ultrawork` variable is set')).toEqual([]);
    });
  });

  describe('Category Routing', () => {
    it('should export detectCategories and CATEGORY_ROUTES', () => {
      expect(hook).toHaveProperty('detectCategories');
      expect(hook).toHaveProperty('CATEGORY_ROUTES');
      expect(typeof hook.detectCategories).toBe('function');
      expect(Array.isArray(hook.CATEGORY_ROUTES)).toBe(true);
    });

    it('should detect test category', () => {
      const results = hook.detectCategories('write unit tests for the user module');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('test');
      expect(results[0].searchHint).toContain('test strategy');
    });

    it('should detect deploy category', () => {
      const results = hook.detectCategories('deploy this to production');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('deploy');
      expect(results[0].searchHint).toContain('deployment');
    });

    it('should detect refactor category', () => {
      const results = hook.detectCategories('refactor the database layer');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('refactor');
      expect(results[0].searchHint).toContain('architecture');
    });

    it('should detect security category', () => {
      const results = hook.detectCategories('review security vulnerabilities');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('security');
    });

    it('should detect performance category', () => {
      const results = hook.detectCategories('optimize database query performance');
      expect(results.length).toBeGreaterThanOrEqual(1);
      const names = results.map((r) => r.name);
      expect(names).toContain('performance');
    });

    it('should detect Korean test keywords', () => {
      const results = hook.detectCategories('테스트 작성해줘');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('test');
    });

    it('should detect Korean deploy keywords', () => {
      const results = hook.detectCategories('배포 준비해줘');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('deploy');
    });

    it('should detect Korean refactor keywords', () => {
      const results = hook.detectCategories('리팩토링 필요해');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('refactor');
    });

    it('should detect multiple categories', () => {
      const results = hook.detectCategories('refactor and add tests for security');
      expect(results.length).toBeGreaterThanOrEqual(2);
      const names = results.map((r) => r.name);
      expect(names).toContain('test');
      expect(names).toContain('refactor');
    });

    it('should return empty array for no category match', () => {
      expect(hook.detectCategories('hello world')).toEqual([]);
    });

    it('should return empty for null/undefined/empty', () => {
      expect(hook.detectCategories('')).toEqual([]);
      expect(hook.detectCategories(null)).toEqual([]);
      expect(hook.detectCategories(undefined)).toEqual([]);
    });

    it('should not match keywords inside code blocks', () => {
      const text = 'Check this:\n```\nconst test = true;\n```\nDone.';
      expect(hook.detectCategories(text)).toEqual([]);
    });

    it('should have 5 category routes defined', () => {
      expect(hook.CATEGORY_ROUTES.length).toBe(5);
      const names = hook.CATEGORY_ROUTES.map((r) => r.name);
      expect(names).toContain('test');
      expect(names).toContain('deploy');
      expect(names).toContain('refactor');
      expect(names).toContain('security');
      expect(names).toContain('performance');
    });
  });

  describe('Feature Guard: getEnabledFeatures', () => {
    it('should enable all features when not in daemon mode', () => {
      delete process.env.MAMA_DAEMON;
      delete process.env.MAMA_HOOK_FEATURES;
      delete process.env.MAMA_DISABLE_HOOKS;
      const features = hook.getEnabledFeatures();
      expect(features.has('keywords')).toBe(true);
      expect(features.has('memory')).toBe(true);
      expect(features.has('rules')).toBe(true);
      expect(features.has('agents')).toBe(true);
      expect(features.has('contracts')).toBe(true);
    });

    it('should disable all features when MAMA_DISABLE_HOOKS=true', () => {
      process.env.MAMA_DISABLE_HOOKS = 'true';
      const features = hook.getEnabledFeatures();
      expect(features.size).toBe(0);
    });

    it('should disable all features when MAMA_DAEMON=1 without MAMA_HOOK_FEATURES', () => {
      process.env.MAMA_DAEMON = '1';
      delete process.env.MAMA_HOOK_FEATURES;
      const features = hook.getEnabledFeatures();
      expect(features.size).toBe(0);
    });

    it('should enable only specified features with MAMA_HOOK_FEATURES', () => {
      process.env.MAMA_DAEMON = '1';
      process.env.MAMA_HOOK_FEATURES = 'keywords,agents';
      const features = hook.getEnabledFeatures();
      expect(features.has('keywords')).toBe(true);
      expect(features.has('agents')).toBe(true);
      expect(features.has('memory')).toBe(false);
      expect(features.has('contracts')).toBe(false);
    });

    it('should handle whitespace in MAMA_HOOK_FEATURES', () => {
      process.env.MAMA_DAEMON = '1';
      process.env.MAMA_HOOK_FEATURES = ' keywords , agents , rules ';
      const features = hook.getEnabledFeatures();
      expect(features.has('keywords')).toBe(true);
      expect(features.has('agents')).toBe(true);
      expect(features.has('rules')).toBe(true);
    });
  });
});
