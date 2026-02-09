/**
 * Tests for PreCompact Hook - Decision Preservation
 *
 * Tests: decision extraction, DB filtering, 7-section compaction prompt,
 * warning messages, feature gating.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const hookPath = path.join(__dirname, '../../scripts/precompact-hook.js');
const hook = require(hookPath);

const originalEnv = { ...process.env };

describe('Story M4.1: PreCompact Hook - Decision Preservation', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Hook Structure', () => {
    it('should export required functions', () => {
      expect(hook).toHaveProperty('extractDecisionCandidates');
      expect(hook).toHaveProperty('filterUnsaved');
      expect(hook).toHaveProperty('buildCompactionPrompt');
      expect(hook).toHaveProperty('buildWarningMessage');
      expect(hook).toHaveProperty('getEnabledFeatures');
      expect(typeof hook.extractDecisionCandidates).toBe('function');
      expect(typeof hook.filterUnsaved).toBe('function');
      expect(typeof hook.buildCompactionPrompt).toBe('function');
      expect(typeof hook.buildWarningMessage).toBe('function');
    });

    it('should be executable script with shebang', () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    });
  });

  describe('Decision Candidate Extraction', () => {
    it('should extract "decided:" patterns', () => {
      const transcript = JSON.stringify({
        content: 'We decided: Use PostgreSQL for the main database',
      });
      const results = hook.extractDecisionCandidates(transcript);
      expect(results.length).toBe(1);
      expect(results[0]).toContain('Use PostgreSQL');
    });

    it('should extract "architecture:" patterns', () => {
      const transcript = JSON.stringify({
        content: 'architecture: microservices with event sourcing pattern',
      });
      const results = hook.extractDecisionCandidates(transcript);
      expect(results.length).toBe(1);
      expect(results[0]).toContain('microservices');
    });

    it('should extract Korean decision patterns', () => {
      const transcript = JSON.stringify({
        content: '결정: JWT 토큰을 사용하여 인증 구현',
      });
      const results = hook.extractDecisionCandidates(transcript);
      expect(results.length).toBe(1);
      expect(results[0]).toContain('JWT');
    });

    it('should skip candidates shorter than 10 characters', () => {
      const transcript = JSON.stringify({
        content: 'decided: yes',
      });
      const results = hook.extractDecisionCandidates(transcript);
      expect(results.length).toBe(0);
    });

    it('should deduplicate identical candidates', () => {
      const lines = [
        JSON.stringify({ content: 'decided: Use Redis for caching layer implementation' }),
        JSON.stringify({ content: 'decided: Use Redis for caching layer implementation' }),
      ].join('\n');
      const results = hook.extractDecisionCandidates(lines);
      expect(results.length).toBe(1);
    });

    it('should limit to 5 most recent candidates', () => {
      const lines = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ content: `decided: Decision number ${i} with enough characters` })
      ).join('\n');
      const results = hook.extractDecisionCandidates(lines);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should skip decisions with already-saved topics', () => {
      const lines = [
        JSON.stringify({ content: 'mama_save topic: database_choice' }),
        JSON.stringify({
          content: 'decided: database_choice is PostgreSQL for performance reasons',
        }),
      ].join('\n');
      const results = hook.extractDecisionCandidates(lines);
      expect(results.length).toBe(0);
    });

    it('should handle non-JSON lines gracefully', () => {
      const transcript =
        'not json\n' +
        JSON.stringify({ content: 'decided: Use TypeScript for type safety checks' });
      const results = hook.extractDecisionCandidates(transcript);
      expect(results.length).toBe(1);
    });

    it('should handle empty transcript', () => {
      expect(hook.extractDecisionCandidates('')).toEqual([]);
    });
  });

  describe('Filter Unsaved', () => {
    it('should keep candidates not in saved topics', () => {
      const candidates = ['Use PostgreSQL for main DB'];
      const savedTopics = new Set(['redis_caching']);
      const result = hook.filterUnsaved(candidates, savedTopics);
      expect(result).toEqual(['Use PostgreSQL for main DB']);
    });

    it('should remove candidates matching saved topics', () => {
      const candidates = ['use postgresql for main database'];
      const savedTopics = new Set(['use postgresql for main database']);
      const result = hook.filterUnsaved(candidates, savedTopics);
      expect(result).toEqual([]);
    });

    it('should handle substring matching both directions', () => {
      const candidates = ['Use JWT tokens'];
      const savedTopics = new Set(['use jwt tokens for auth']);
      const result = hook.filterUnsaved(candidates, savedTopics);
      expect(result).toEqual([]);
    });

    it('should return all candidates when no saved topics', () => {
      const candidates = ['Decision A', 'Decision B'];
      const savedTopics = new Set();
      const result = hook.filterUnsaved(candidates, savedTopics);
      expect(result).toEqual(['Decision A', 'Decision B']);
    });
  });

  describe('7-Section Compaction Prompt', () => {
    it('should contain all 7 sections', () => {
      const prompt = hook.buildCompactionPrompt('test\nlines', []);
      expect(prompt).toContain('## 1. User Requests');
      expect(prompt).toContain('## 2. Final Goal');
      expect(prompt).toContain('## 3. Work Completed');
      expect(prompt).toContain('## 4. Remaining Tasks');
      expect(prompt).toContain('## 5. Active Working Context');
      expect(prompt).toContain('## 6. Explicit Constraints');
      expect(prompt).toContain('## 7. Agent Verification State');
    });

    it('should include unsaved decisions section when present', () => {
      const prompt = hook.buildCompactionPrompt('test', ['Use Redis for caching']);
      expect(prompt).toContain('## Unsaved Decisions');
      expect(prompt).toContain('Use Redis for caching');
      expect(prompt).toContain('mama_save');
    });

    it('should not include unsaved section when empty', () => {
      const prompt = hook.buildCompactionPrompt('test', []);
      expect(prompt).not.toContain('## Unsaved Decisions');
    });

    it('should include line count from transcript', () => {
      const prompt = hook.buildCompactionPrompt('line1\nline2\nline3', []);
      expect(prompt).toContain('~3 lines before compaction');
    });

    it('should start with Compaction Summary header', () => {
      const prompt = hook.buildCompactionPrompt('test', []);
      expect(prompt.startsWith('# Compaction Summary')).toBe(true);
    });
  });

  describe('Warning Message', () => {
    it('should return empty string for no unsaved decisions', () => {
      expect(hook.buildWarningMessage([])).toBe('');
    });

    it('should include count of unsaved decisions', () => {
      const msg = hook.buildWarningMessage(['Decision A', 'Decision B']);
      expect(msg).toContain('2 potential unsaved decision(s)');
    });

    it('should include numbered list', () => {
      const msg = hook.buildWarningMessage(['Use Redis', 'Use PostgreSQL']);
      expect(msg).toContain('1. Use Redis');
      expect(msg).toContain('2. Use PostgreSQL');
    });

    it('should include MAMA PreCompact Warning header', () => {
      const msg = hook.buildWarningMessage(['Test decision']);
      expect(msg).toContain('[MAMA PreCompact Warning]');
    });

    it('should include mama_save instruction', () => {
      const msg = hook.buildWarningMessage(['Test decision']);
      expect(msg).toContain('mama_save');
    });
  });

  describe('Feature Gating', () => {
    it('should use hook-features.js for feature gating', () => {
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('getEnabledFeatures');
      expect(content).toContain("features.has('memory')");
    });

    it('should enable all features when not in daemon mode', () => {
      delete process.env.MAMA_DAEMON;
      delete process.env.MAMA_HOOK_FEATURES;
      delete process.env.MAMA_DISABLE_HOOKS;
      const features = hook.getEnabledFeatures();
      expect(features.has('memory')).toBe(true);
    });

    it('should disable when MAMA_DISABLE_HOOKS=true', () => {
      process.env.MAMA_DISABLE_HOOKS = 'true';
      const features = hook.getEnabledFeatures();
      expect(features.size).toBe(0);
    });
  });
});
