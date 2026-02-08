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
