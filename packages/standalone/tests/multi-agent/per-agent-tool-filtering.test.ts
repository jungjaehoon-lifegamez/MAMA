/**
 * Tests for per-agent allowed_tools filtering via ToolRegistry (STORY-018)
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry.js';

describe('Per-agent tool filtering', () => {
  describe('generatePrompt() with allowed_tools patterns', () => {
    it('should filter to memory tools only', () => {
      const prompt = ToolRegistry.generatePrompt(['mama_*']);
      expect(prompt).toContain('mama_save');
      expect(prompt).toContain('mama_search');
      expect(prompt).not.toContain('Read');
      expect(prompt).not.toContain('browser_navigate');
    });

    it('should filter to browser + utility tools', () => {
      const prompt = ToolRegistry.generatePrompt(['browser_*', 'Read', 'Write', 'Bash']);
      expect(prompt).toContain('browser_navigate');
      expect(prompt).toContain('Read');
      expect(prompt).toContain('Bash');
      expect(prompt).not.toContain('mama_save');
      expect(prompt).not.toContain('os_add_bot');
    });

    it('should return full prompt for wildcard', () => {
      const full = ToolRegistry.generatePrompt();
      const wildcard = ToolRegistry.generatePrompt(['*']);
      expect(wildcard).toBe(full);
    });

    it('should return empty sections for non-matching filter', () => {
      const prompt = ToolRegistry.generatePrompt(['nonexistent_*']);
      // Should only have header, no tool entries
      expect(prompt).toBe('# Gateway Tools');
    });

    it('should support mixed exact + wildcard patterns', () => {
      const prompt = ToolRegistry.generatePrompt(['mama_*', 'Read', 'webchat_*']);
      expect(prompt).toContain('mama_save');
      expect(prompt).toContain('Read');
      expect(prompt).toContain('webchat_send');
      expect(prompt).not.toContain('Write');
      expect(prompt).not.toContain('browser_navigate');
    });
  });

  describe('Tier-based filtering integration', () => {
    it('Tier 2 agents get read-only tools', () => {
      const tier2Tools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
      const filtered = ToolRegistry.getFilteredTools(tier2Tools);
      // Only Read is in the gateway registry (Grep/Glob/WebSearch are Claude-native)
      expect(filtered.map((t) => t.name)).toContain('Read');
      expect(filtered.map((t) => t.name)).not.toContain('Write');
      expect(filtered.map((t) => t.name)).not.toContain('Bash');
    });

    it('Tier 1 agents get all tools', () => {
      const filtered = ToolRegistry.getFilteredTools(['*']);
      expect(filtered.length).toBe(ToolRegistry.count);
    });
  });
});
