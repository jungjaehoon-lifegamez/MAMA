/**
 * Unit tests for ToolRegistry (STORY-016)
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry.js';

describe('ToolRegistry', () => {
  describe('getValidToolNames()', () => {
    it('should return all registered tool names', () => {
      const names = ToolRegistry.getValidToolNames();
      expect(names.length).toBeGreaterThan(25);
      expect(names).toContain('mama_save');
      expect(names).toContain('Read');
      expect(names).toContain('browser_navigate');
      expect(names).toContain('code_act');
    });
  });

  describe('getTool()', () => {
    it('should return metadata for known tool', () => {
      const tool = ToolRegistry.getTool('mama_save');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('memory');
      expect(tool!.description).toContain('decision');
    });

    it('should return undefined for unknown tool', () => {
      expect(ToolRegistry.getTool('nonexistent')).toBeUndefined();
    });
  });

  describe('isRegistered()', () => {
    it('should return true for registered tools', () => {
      expect(ToolRegistry.isRegistered('Read')).toBe(true);
      expect(ToolRegistry.isRegistered('Bash')).toBe(true);
    });

    it('should return false for unregistered tools', () => {
      expect(ToolRegistry.isRegistered('FakeTool')).toBe(false);
    });
  });

  describe('getFilteredTools()', () => {
    it('should return all tools when no filter', () => {
      const all = ToolRegistry.getAllTools();
      const filtered = ToolRegistry.getFilteredTools();
      expect(filtered).toHaveLength(all.length);
    });

    it('should return all tools for wildcard', () => {
      const filtered = ToolRegistry.getFilteredTools(['*']);
      expect(filtered).toHaveLength(ToolRegistry.count);
    });

    it('should filter by exact name', () => {
      const filtered = ToolRegistry.getFilteredTools(['Read', 'Write']);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((t) => t.name)).toEqual(['Read', 'Write']);
    });

    it('should filter by wildcard pattern', () => {
      const filtered = ToolRegistry.getFilteredTools(['mama_*']);
      expect(filtered.map((tool) => tool.name)).toEqual([
        'mama_save',
        'mama_search',
        'mama_recall',
        'mama_update',
        'mama_load_checkpoint',
        'mama_add',
        'mama_ingest',
      ]);
    });

    it('should support mixed patterns', () => {
      const filtered = ToolRegistry.getFilteredTools(['mama_*', 'Read', 'browser_*']);
      expect(filtered.length).toBeGreaterThan(10);
      const names = filtered.map((t) => t.name);
      expect(names).toContain('mama_save');
      expect(names).toContain('Read');
      expect(names).toContain('browser_navigate');
      expect(names).not.toContain('Write');
    });

    it('should return empty for non-matching filter', () => {
      const filtered = ToolRegistry.getFilteredTools(['nonexistent_*']);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('getByCategory()', () => {
    it('should group tools by category', () => {
      const grouped = ToolRegistry.getByCategory();
      expect(grouped.has('memory')).toBe(true);
      expect(grouped.get('memory')!.map((tool) => tool.name)).toEqual([
        'mama_save',
        'mama_search',
        'mama_recall',
        'mama_update',
        'mama_load_checkpoint',
        'mama_add',
        'mama_ingest',
      ]);
      expect(grouped.has('browser')).toBe(true);
      expect(grouped.get('browser')!.length).toBeGreaterThan(5);
    });
  });

  describe('validateHandlers()', () => {
    it('should return empty when all handlers exist', () => {
      const handlerNames = new Set(ToolRegistry.getValidToolNames());
      expect(ToolRegistry.validateHandlers(handlerNames)).toEqual([]);
    });

    it('should return missing handlers', () => {
      const handlers = new Set(['mama_save', 'Read']);
      const missing = ToolRegistry.validateHandlers(handlers);
      expect(missing.length).toBeGreaterThan(0);
      expect(missing).not.toContain('mama_save');
      expect(missing).not.toContain('Read');
      expect(missing).toContain('Write');
    });
  });

  describe('generatePrompt()', () => {
    it('should generate markdown with all tools', () => {
      const prompt = ToolRegistry.generatePrompt();
      expect(prompt).toContain('# Gateway Tools');
      expect(prompt).toContain('## MAMA Memory');
      expect(prompt).toContain('mama_save');
      expect(prompt).toContain('## Browser');
    });

    it('should generate filtered prompt', () => {
      const prompt = ToolRegistry.generatePrompt(['mama_*']);
      expect(prompt).toContain('mama_save');
      expect(prompt).not.toContain('Read');
      expect(prompt).not.toContain('browser_navigate');
    });
  });

  describe('generateFallbackPrompt()', () => {
    it('should generate compact format', () => {
      const fallback = ToolRegistry.generateFallbackPrompt();
      expect(fallback).toContain('memory');
      expect(fallback).toContain('mama_save');
    });
  });

  describe('count', () => {
    it('should match getValidToolNames length', () => {
      expect(ToolRegistry.count).toBe(ToolRegistry.getValidToolNames().length);
    });
  });

  describe('viewerOnly tools', () => {
    it('should mark OS management tools as viewerOnly', () => {
      const tool = ToolRegistry.getTool('os_add_bot');
      expect(tool?.viewerOnly).toBe(true);
    });

    it('should mark agent_test as viewerOnly', () => {
      const tool = ToolRegistry.getTool('agent_test');
      expect(tool?.viewerOnly).toBe(true);
    });

    it('should not mark utility tools as viewerOnly', () => {
      const tool = ToolRegistry.getTool('Read');
      expect(tool?.viewerOnly).toBeUndefined();
    });
  });
});
