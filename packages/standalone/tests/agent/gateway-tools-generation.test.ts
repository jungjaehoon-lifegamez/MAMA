/**
 * Tests for gateway-tools.md generation from ToolRegistry (STORY-017)
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry.js';

describe('Gateway tools generation', () => {
  describe('VALID_TOOLS derivation', () => {
    it('should include all expected tools', () => {
      const names = ToolRegistry.getValidToolNames();
      // Core tools that must always exist
      expect(names).toContain('mama_save');
      expect(names).toContain('mama_search');
      expect(names).toContain('Read');
      expect(names).toContain('Write');
      expect(names).toContain('Bash');
      expect(names).toContain('browser_navigate');
      expect(names).toContain('code_act');
    });

    it('should have at least 30 tools', () => {
      expect(ToolRegistry.count).toBeGreaterThanOrEqual(30);
    });
  });

  describe('generatePrompt() with params', () => {
    it('should include parameter hints', () => {
      const prompt = ToolRegistry.generatePrompt();
      expect(prompt).toContain('(path)');
      expect(prompt).toContain('(url)');
      expect(prompt).toContain('(query?, type?, limit?)');
    });

    it('should use dash separator for description', () => {
      const prompt = ToolRegistry.generatePrompt();
      // Format: **name**(params) — description
      expect(prompt).toMatch(/\*\*Read\*\*\(path\) — Read file/);
    });

    it('should show empty parens for tools without params', () => {
      const prompt = ToolRegistry.generatePrompt();
      expect(prompt).toMatch(/\*\*browser_close\*\*\(\) —/);
    });
  });

  describe('generateFallbackPrompt()', () => {
    it('should list all categories', () => {
      const fallback = ToolRegistry.generateFallbackPrompt();
      expect(fallback).toContain('memory');
      expect(fallback).toContain('utility');
      expect(fallback).toContain('browser');
    });
  });
});
