/**
 * Tests for ToolPermissionManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolPermissionManager } from '../../src/multi-agent/tool-permission-manager.js';
import type { AgentPersonaConfig } from '../../src/multi-agent/types.js';

function makeAgent(overrides: Partial<AgentPersonaConfig> = {}): AgentPersonaConfig {
  return {
    id: 'test-agent',
    name: 'TestBot',
    display_name: 'TestBot',
    trigger_prefix: '!test',
    persona_file: '~/.mama/personas/test.md',
    ...overrides,
  };
}

describe('ToolPermissionManager', () => {
  let manager: ToolPermissionManager;

  beforeEach(() => {
    manager = new ToolPermissionManager();
  });

  describe('resolvePermissions', () => {
    it('should return Tier 1 defaults (all tools) when tier is not specified', () => {
      const agent = makeAgent();
      const perms = manager.resolvePermissions(agent);
      expect(perms.allowed).toEqual(['*']);
      expect(perms.blocked).toEqual([]);
    });

    it('should return Tier 1 defaults for tier=1', () => {
      const agent = makeAgent({ tier: 1 });
      const perms = manager.resolvePermissions(agent);
      expect(perms.allowed).toEqual(['*']);
      expect(perms.blocked).toEqual([]);
    });

    it('should return Tier 2 defaults for tier=2', () => {
      const agent = makeAgent({ tier: 2 });
      const perms = manager.resolvePermissions(agent);
      expect(perms.allowed).toContain('Read');
      expect(perms.allowed).toContain('Grep');
      expect(perms.allowed).toContain('Glob');
      expect(perms.blocked).toContain('Write');
      expect(perms.blocked).toContain('Edit');
      expect(perms.blocked).toContain('Bash');
    });

    it('should return Tier 3 defaults for tier=3', () => {
      const agent = makeAgent({ tier: 3 });
      const perms = manager.resolvePermissions(agent);
      expect(perms.allowed).toContain('Read');
      expect(perms.blocked).toContain('Write');
      expect(perms.blocked).toContain('Bash');
    });

    it('should use explicit tool_permissions over tier defaults', () => {
      const agent = makeAgent({
        tier: 2,
        tool_permissions: {
          allowed: ['Read', 'Bash'],
          blocked: ['Write'],
        },
      });
      const perms = manager.resolvePermissions(agent);
      expect(perms.allowed).toEqual(['Read', 'Bash']);
      expect(perms.blocked).toEqual(['Write']);
    });

    it('should use tier default for allowed if only blocked is explicitly set', () => {
      const agent = makeAgent({
        tier: 1,
        tool_permissions: {
          blocked: ['Bash'],
        },
      });
      const perms = manager.resolvePermissions(agent);
      expect(perms.allowed).toEqual(['*']);
      expect(perms.blocked).toEqual(['Bash']);
    });

    it('should remove explicitly allowed tools from tier default blocked list', () => {
      const agent = makeAgent({
        tier: 2,
        tool_permissions: {
          allowed: ['Read', 'Write'],
        },
      });
      const perms = manager.resolvePermissions(agent);
      expect(perms.allowed).toEqual(['Read', 'Write']);
      // Write is in allowed, so it should be removed from blocked
      expect(perms.blocked).not.toContain('Write');
      // Edit is NOT in allowed, so it stays blocked
      expect(perms.blocked).toContain('Edit');
      expect(perms.blocked).toContain('Bash');
      expect(perms.blocked).toContain('NotebookEdit');
    });

    it('should fall back to Tier 2 (read-only) for unsupported tier values', () => {
      const agent = makeAgent({ tier: 99 as any });
      const perms = manager.resolvePermissions(agent);
      // Should NOT get Tier 1 all-access (fail-open)
      expect(perms.allowed).not.toEqual(['*']);
      // Should fall back to Tier 2 read-only
      expect(perms.allowed).toContain('Read');
      expect(perms.allowed).toContain('Grep');
      expect(perms.blocked).toContain('Write');
      expect(perms.blocked).toContain('Bash');
    });
  });

  describe('isToolAllowed', () => {
    it('should allow all tools for Tier 1 agent', () => {
      const agent = makeAgent({ tier: 1 });
      expect(manager.isToolAllowed(agent, 'Read')).toBe(true);
      expect(manager.isToolAllowed(agent, 'Write')).toBe(true);
      expect(manager.isToolAllowed(agent, 'Bash')).toBe(true);
      expect(manager.isToolAllowed(agent, 'mama_search')).toBe(true);
    });

    it('should block Write/Edit/Bash for Tier 2 agent', () => {
      const agent = makeAgent({ tier: 2 });
      expect(manager.isToolAllowed(agent, 'Read')).toBe(true);
      expect(manager.isToolAllowed(agent, 'Grep')).toBe(true);
      expect(manager.isToolAllowed(agent, 'Write')).toBe(false);
      expect(manager.isToolAllowed(agent, 'Edit')).toBe(false);
      expect(manager.isToolAllowed(agent, 'Bash')).toBe(false);
    });

    it('should support wildcard matching in allowed list', () => {
      const agent = makeAgent({
        tier: 2,
        tool_permissions: {
          allowed: ['mama_*', 'Read'],
          blocked: [],
        },
      });
      expect(manager.isToolAllowed(agent, 'mama_search')).toBe(true);
      expect(manager.isToolAllowed(agent, 'mama_save')).toBe(true);
      expect(manager.isToolAllowed(agent, 'Read')).toBe(true);
      expect(manager.isToolAllowed(agent, 'Write')).toBe(false);
    });

    it('should support wildcard matching in blocked list', () => {
      const agent = makeAgent({
        tier: 1,
        tool_permissions: {
          allowed: ['*'],
          blocked: ['mama_*'],
        },
      });
      expect(manager.isToolAllowed(agent, 'Read')).toBe(true);
      expect(manager.isToolAllowed(agent, 'mama_search')).toBe(false);
      expect(manager.isToolAllowed(agent, 'mama_save')).toBe(false);
    });

    it('should give blocked precedence over allowed', () => {
      const agent = makeAgent({
        tool_permissions: {
          allowed: ['*'],
          blocked: ['Bash'],
        },
      });
      expect(manager.isToolAllowed(agent, 'Bash')).toBe(false);
      expect(manager.isToolAllowed(agent, 'Read')).toBe(true);
    });
  });

  describe('buildPermissionPrompt', () => {
    it('should show "all tools" for Tier 1', () => {
      const agent = makeAgent({ tier: 1 });
      const prompt = manager.buildPermissionPrompt(agent);
      expect(prompt).toContain('Tier 1');
      expect(prompt).toContain('all tools');
    });

    it('should list allowed and blocked tools for Tier 2', () => {
      const agent = makeAgent({ tier: 2 });
      const prompt = manager.buildPermissionPrompt(agent);
      expect(prompt).toContain('Tier 2');
      expect(prompt).toContain('Read');
      expect(prompt).toContain('Blocked tools');
      expect(prompt).toContain('Write');
    });

    it('should default to Tier 1 when tier is not specified', () => {
      const agent = makeAgent();
      const prompt = manager.buildPermissionPrompt(agent);
      expect(prompt).toContain('Tier 1');
    });
  });

  describe('canDelegate', () => {
    it('should return true for Tier 1 with can_delegate=true', () => {
      const agent = makeAgent({ tier: 1, can_delegate: true });
      expect(manager.canDelegate(agent)).toBe(true);
    });

    it('should return false for Tier 1 without can_delegate', () => {
      const agent = makeAgent({ tier: 1 });
      expect(manager.canDelegate(agent)).toBe(false);
    });

    it('should return false for Tier 2 even with can_delegate=true', () => {
      const agent = makeAgent({ tier: 2, can_delegate: true });
      expect(manager.canDelegate(agent)).toBe(false);
    });

    it('should return true for default tier (1) with can_delegate=true', () => {
      const agent = makeAgent({ can_delegate: true });
      expect(manager.canDelegate(agent)).toBe(true);
    });
  });

  describe('canAutoContinue', () => {
    it('should return true when auto_continue=true', () => {
      const agent = makeAgent({ auto_continue: true });
      expect(manager.canAutoContinue(agent)).toBe(true);
    });

    it('should return false when auto_continue is not set', () => {
      const agent = makeAgent();
      expect(manager.canAutoContinue(agent)).toBe(false);
    });

    it('should return false when auto_continue=false', () => {
      const agent = makeAgent({ auto_continue: false });
      expect(manager.canAutoContinue(agent)).toBe(false);
    });
  });

  describe('buildDelegationPrompt', () => {
    const allAgents: AgentPersonaConfig[] = [
      makeAgent({
        id: 'sisyphus',
        name: 'Sisyphus',
        display_name: '🏔️ Sisyphus',
        tier: 1,
        can_delegate: true,
      }),
      makeAgent({ id: 'developer', name: 'Developer', display_name: '🔧 Developer', tier: 2 }),
      makeAgent({ id: 'reviewer', name: 'Reviewer', display_name: '📝 Reviewer', tier: 3 }),
    ];

    it('should return delegation prompt for Tier 1 with can_delegate', () => {
      const agent = allAgents[0];
      const prompt = manager.buildDelegationPrompt(agent, allAgents);
      expect(prompt).toContain('Delegation');
      expect(prompt).toContain('DELEGATE::');
      expect(prompt).toContain('Developer');
      expect(prompt).toContain('Reviewer');
      // Should not include self
      expect(prompt).not.toContain('🏔️ Sisyphus** (ID: sisyphus');
    });

    it('should return empty for agent without can_delegate', () => {
      const agent = makeAgent({ tier: 1 });
      const prompt = manager.buildDelegationPrompt(agent, allAgents);
      expect(prompt).toBe('');
    });

    it('should return empty for Tier 2 even with can_delegate', () => {
      const agent = makeAgent({ tier: 2, can_delegate: true });
      const prompt = manager.buildDelegationPrompt(agent, allAgents);
      expect(prompt).toBe('');
    });

    it('should exclude disabled agents from delegation list', () => {
      const agents = [
        makeAgent({ id: 'lead', tier: 1, can_delegate: true }),
        makeAgent({ id: 'helper', name: 'Helper', display_name: 'Helper', enabled: false }),
        makeAgent({ id: 'active', name: 'Active', display_name: 'Active' }),
      ];
      const prompt = manager.buildDelegationPrompt(agents[0], agents);
      expect(prompt).toContain('Active');
      expect(prompt).not.toContain('Helper');
    });
  });
});
