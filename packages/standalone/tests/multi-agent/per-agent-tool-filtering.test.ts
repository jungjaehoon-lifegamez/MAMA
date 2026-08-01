/**
 * Tests for per-agent allowed_tools filtering via ToolRegistry (STORY-018)
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import { AgentProcessManager } from '../../src/multi-agent/agent-process-manager.js';
import type { AgentPersonaConfig, MultiAgentConfig } from '../../src/multi-agent/types.js';

const PRIVATE_TOOLS = [
  'kagemusha_overview',
  'kagemusha_entities',
  'kagemusha_tasks',
  'kagemusha_messages',
] as const;

describe('Per-agent tool filtering', () => {
  describe('generatePrompt() with allowed_tools patterns', () => {
    it('should filter to memory tools only', () => {
      const prompt = ToolRegistry.generatePrompt(['mama_*']);
      expect(prompt).toContain('mama_save');
      expect(prompt).toContain('mama_search');
      expect(prompt).not.toContain('Read');
      expect(prompt).not.toContain('task_list');
    });

    it('should filter to task + utility tools', () => {
      const prompt = ToolRegistry.generatePrompt(['task_*', 'Read', 'Write', 'Bash']);
      expect(prompt).toContain('task_list');
      expect(prompt).toContain('Read');
      expect(prompt).toContain('Bash');
      expect(prompt).not.toContain('mama_save');
      expect(prompt).not.toContain('telegram_send');
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
      expect(prompt).not.toContain('task_list');
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

  describe('TG-04: generic multi-agent private connector isolation', () => {
    it.each([true, false])(
      'removes all private tools from a custom wildcard role (Code-Act=%s)',
      async (useCodeAct) => {
        const agentConfig: Omit<AgentPersonaConfig, 'id'> = {
          name: 'Wildcard',
          display_name: 'Wildcard',
          trigger_prefix: '!wildcard',
          persona_file: '/missing/persona.md',
          backend: 'codex',
          model: 'gpt-5.4',
          tier: 1,
          useCodeAct,
          gateway_tool_permissions: { allowed: ['*'] },
          tool_permissions: { allowed: ['*'] },
        };
        const config: MultiAgentConfig = {
          enabled: true,
          agents: { wildcard: agentConfig },
          loop_prevention: {
            max_chain_length: 3,
            global_cooldown_ms: 2_000,
            chain_window_ms: 60_000,
          },
        };
        const manager = new AgentProcessManager(config, {}, { backend: 'codex' });
        const prompt = (
          manager as unknown as {
            buildToolsSection(config: Omit<AgentPersonaConfig, 'id'>): string;
          }
        ).buildToolsSection(agentConfig);

        try {
          expect(prompt.toLowerCase()).not.toContain('kagemusha');
          for (const tool of PRIVATE_TOOLS) {
            expect(prompt).not.toContain(tool);
          }
        } finally {
          await manager.stopAll();
        }
      }
    );
  });
});
