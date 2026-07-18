/**
 * Story OPS-1 / S1-T2: prompt-permission coherence
 *
 * The chat system prompt must advertise ONLY the tools the resolved role can
 * execute. Advertising the full catalog taught the model to call tools the
 * executor then denied (live: 47 denials/day). The composition under test is
 * exactly what MessageRouter.buildSystemPrompt wires: registry names filtered
 * through RoleManager into getGatewayToolsPrompt(disallowed).
 */

import { describe, expect, it } from 'vitest';
import { getGatewayToolsPrompt } from '../../src/agent/agent-loop.js';
import { RoleManager } from '../../src/agent/role-manager.js';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';

function promptForRole(roleName: 'chat_bot' | 'owner_console'): string {
  const rm = new RoleManager({ rolesConfig: DEFAULT_ROLES });
  const role = DEFAULT_ROLES.definitions[roleName];
  const disallowed = ToolRegistry.getValidToolNames().filter(
    (name) => !rm.isToolAllowed(role, name)
  );
  return getGatewayToolsPrompt(disallowed) || '';
}

describe('Story OPS-1: role-filtered tool advertising (S1-T2)', () => {
  describe('AC #1: advertised set equals the executable set', () => {
    it('chat_bot prompt omits business tools it cannot execute', () => {
      const prompt = promptForRole('chat_bot');
      expect(prompt).toContain('mama_search');
      expect(prompt).not.toContain('kagemusha_tasks');
      expect(prompt).not.toContain('task_create');
      expect(prompt).not.toContain('delegate');
      expect(prompt).not.toContain('os_restart_bot');
    });

    it('owner_console prompt includes its business tools but never execution tools', () => {
      const prompt = promptForRole('owner_console');
      expect(prompt).toContain('kagemusha_tasks');
      expect(prompt).toContain('task_create');
      expect(prompt).toContain('schedule_upcoming');
      expect(prompt).toContain('mama_save');
      expect(prompt).toContain('workorder_request');
      expect(prompt).toContain('workorder_status');
      expect(prompt).not.toContain('os_restart_bot');
      expect(prompt).not.toContain('delegate');
      expect(prompt).not.toContain('browser_navigate');
    });
  });

  describe('AC #2: the Gateway Tools marker survives filtering', () => {
    it('keeps the marker AgentLoop uses to avoid double-injecting an unfiltered catalog', () => {
      for (const roleName of ['chat_bot', 'owner_console'] as const) {
        const prompt = promptForRole(roleName);
        // agent-loop's alreadyHasTools checks '# Gateway Tools' (doc H1 title).
        expect(prompt).toContain('# Gateway Tools');
      }
    });
  });

  describe('AC #3: per-role outputs differ (no shared-cache cross-contamination)', () => {
    it('returns different catalogs for different roles on repeated calls', () => {
      const chatFirst = promptForRole('chat_bot');
      const ownerFirst = promptForRole('owner_console');
      const chatSecond = promptForRole('chat_bot');
      expect(ownerFirst).not.toBe(chatFirst);
      expect(chatSecond).toBe(chatFirst);
      expect(ownerFirst).toContain('kagemusha_tasks');
      expect(chatSecond).not.toContain('kagemusha_tasks');
    });
  });
});
