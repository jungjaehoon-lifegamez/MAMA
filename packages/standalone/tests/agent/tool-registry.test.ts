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
      expect(names).toContain('telegram_send');
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
        'mama_provenance',
        'mama_update',
        'mama_load_checkpoint',
      ]);
    });

    it('should filter by non-trailing glob pattern', () => {
      const filtered = ToolRegistry.getFilteredTools(['mama_*ch']);

      expect(filtered.map((tool) => tool.name)).toEqual(['mama_search']);
    });

    it('should support mixed patterns', () => {
      const filtered = ToolRegistry.getFilteredTools(['mama_*', 'Read', 'task_*']);
      expect(filtered.length).toBeGreaterThan(10);
      const names = filtered.map((t) => t.name);
      expect(names).toContain('mama_save');
      expect(names).toContain('Read');
      expect(names).toContain('task_list');
      expect(names).not.toContain('Write');
    });

    it('should return empty for non-matching filter', () => {
      const filtered = ToolRegistry.getFilteredTools(['nonexistent_*']);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('getHostToolDefinitions()', () => {
    it('defines bound external lifecycle tools with closed input schemas', () => {
      const definitions = ToolRegistry.getHostToolDefinitions({
        allowedTools: ['task_external_bind', 'task_lifecycle_reconcile'],
      });

      expect(definitions).toEqual([
        expect.objectContaining({
          name: 'task_external_bind',
          inputSchema: {
            type: 'object',
            properties: {
              candidate_id: { type: 'string' },
              decision: { enum: ['bind', 'decline'] },
              reason: { type: 'string' },
              expected_revision: { type: 'integer', minimum: 1 },
            },
            required: ['candidate_id', 'decision', 'reason', 'expected_revision'],
            additionalProperties: false,
          },
        }),
        expect.objectContaining({
          name: 'task_lifecycle_reconcile',
          inputSchema: {
            type: 'object',
            properties: {
              candidate_id: { type: 'string' },
              decision: { enum: ['apply', 'retain'] },
              reason: { type: 'string' },
              expected_revision: { type: 'integer', minimum: 1 },
            },
            required: ['candidate_id', 'decision', 'reason', 'expected_revision'],
            additionalProperties: false,
          },
        }),
      ]);
    });

    it('should advertise all non-viewer registered tools when allowedTools is undefined', () => {
      const definitions = ToolRegistry.getHostToolDefinitions();

      expect(definitions.length).toBeGreaterThan(0);
      expect(definitions.map((tool) => tool.name)).toContain('mama_search');
      expect(definitions.map((tool) => tool.name)).not.toContain('os_get_config');
      expect(definitions.every((tool) => ToolRegistry.isRegistered(tool.name))).toBe(true);
      expect(definitions.every((tool) => !tool.name.startsWith('mcp__'))).toBe(true);
    });

    it('should advertise no tools when allowedTools is empty', () => {
      expect(ToolRegistry.getHostToolDefinitions({ allowedTools: [] })).toEqual([]);
    });

    it('should restrict advertised tools with allowed wildcard patterns', () => {
      const definitions = ToolRegistry.getHostToolDefinitions({ allowedTools: ['mama_*ch'] });

      expect(definitions.map((tool) => tool.name)).toEqual(['mama_search']);
    });

    it('should let blockedTools take precedence over allowedTools', () => {
      const definitions = ToolRegistry.getHostToolDefinitions({
        allowedTools: ['mama_*'],
        blockedTools: ['mama_search', 'mama_?ecall'],
      });

      expect(definitions.map((tool) => tool.name)).not.toContain('mama_search');
      expect(definitions.map((tool) => tool.name)).not.toContain('mama_recall');
      expect(definitions.map((tool) => tool.name)).toContain('mama_save');
    });

    it('should let instance disallowedTools take precedence over allowedTools', () => {
      const definitions = ToolRegistry.getHostToolDefinitions({
        allowedTools: ['*'],
        disallowedTools: ['Read', 'task_*te'],
      });

      expect(definitions.map((tool) => tool.name)).not.toContain('Read');
      expect(definitions.map((tool) => tool.name)).not.toContain('task_create');
      expect(definitions.map((tool) => tool.name)).not.toContain('task_update');
      expect(definitions.map((tool) => tool.name)).toContain('task_list');
      expect(definitions.map((tool) => tool.name)).toContain('Write');
    });

    it('should include viewerOnly tools only for authorized viewer runs', () => {
      const unauthorized = ToolRegistry.getHostToolDefinitions({
        allowedTools: ['os_get_config'],
      });
      const authorized = ToolRegistry.getHostToolDefinitions({
        allowedTools: ['os_get_config'],
        viewer: true,
      });

      expect(unauthorized).toEqual([]);
      expect(authorized.map((tool) => tool.name)).toEqual(['os_get_config']);
    });

    it('should convert metadata to permissive dynamic function definitions', () => {
      const [definition] = ToolRegistry.getHostToolDefinitions({
        allowedTools: ['mama_search'],
      });

      expect(definition).toEqual({
        type: 'function',
        name: 'mama_search',
        description: expect.stringContaining('query?'),
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      });
    });

    it('should expose the exact native outer code_act input schema', () => {
      const [definition] = ToolRegistry.getHostToolDefinitions({
        allowedTools: ['code_act'],
      });

      expect(definition).toEqual({
        type: 'function',
        name: 'code_act',
        description: expect.stringContaining('QuickJS'),
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            allowedTools: { type: 'array', items: { type: 'string' } },
            blockedTools: { type: 'array', items: { type: 'string' } },
          },
          required: ['code'],
          additionalProperties: false,
        },
      });
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
        'mama_provenance',
        'context_compile',
        'mama_update',
        'mama_load_checkpoint',
      ]);
      expect(grouped.has('business_data')).toBe(true);
      expect(grouped.get('business_data')!.length).toBeGreaterThan(5);
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
      expect(prompt).toContain('## Business Data');
    });

    it('should generate filtered prompt', () => {
      const prompt = ToolRegistry.generatePrompt(['mama_*']);
      expect(prompt).toContain('mama_save');
      expect(prompt).not.toContain('Read');
      expect(prompt).not.toContain('task_list');
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
      const tool = ToolRegistry.getTool('os_get_config');
      expect(tool?.viewerOnly).toBe(true);
    });

    it('should not mark utility tools as viewerOnly', () => {
      const tool = ToolRegistry.getTool('Read');
      expect(tool?.viewerOnly).toBeUndefined();
    });
  });
});
