/**
 * Story OPS-1: trust-conditional owner_console role resolution (plan v6 S1-T1)
 *
 * telegram + allowlist locked + 1:1 DM from an allowlisted chat -> owner_console.
 * Everything else fails closed to the normal transport mapping (chat_bot).
 */

import { describe, expect, it } from 'vitest';
import { RoleManager } from '../../src/agent/role-manager.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';

function makeManager(): RoleManager {
  return new RoleManager({ rolesConfig: DEFAULT_ROLES });
}

describe('Story OPS-1: owner_console trust-conditional resolution', () => {
  describe('AC #1: locked allowlist + private DM resolves owner_console', () => {
    it('escalates only for the allowlisted private chat', () => {
      const rm = makeManager();
      rm.setTelegramTrust(['7777']);

      const owner = rm.getRoleForSource('telegram', { channelId: '7777', chatType: 'private' });
      expect(owner.roleName).toBe('owner_console');
      expect(rm.isToolAllowed(owner.role, 'kagemusha_tasks')).toBe(true);
      expect(rm.isToolAllowed(owner.role, 'task_create')).toBe(true);
      expect(rm.isToolAllowed(owner.role, 'mama_save')).toBe(true);
      expect(rm.isToolAllowed(owner.role, 'Bash')).toBe(false);
      expect(rm.isToolAllowed(owner.role, 'delegate')).toBe(false);
    });
  });

  describe('AC #2: groups never escalate, even when allowlisted', () => {
    it('keeps chat_bot for group and supergroup chats', () => {
      const rm = makeManager();
      rm.setTelegramTrust(['-100888']);
      expect(
        rm.getRoleForSource('telegram', { channelId: '-100888', chatType: 'group' }).roleName
      ).toBe('chat_bot');
      expect(
        rm.getRoleForSource('telegram', { channelId: '-100888', chatType: 'supergroup' }).roleName
      ).toBe('chat_bot');
    });
  });

  describe('AC #3: fail-closed on every missing piece', () => {
    it('falls back to chat_bot without trust, chatType, or allowlist membership', () => {
      const rm = makeManager();

      // No trust configured at all
      expect(
        rm.getRoleForSource('telegram', { channelId: '7777', chatType: 'private' }).roleName
      ).toBe('chat_bot');

      rm.setTelegramTrust(['7777']);
      // chatType missing (metadata lost)
      expect(rm.getRoleForSource('telegram', { channelId: '7777' }).roleName).toBe('chat_bot');
      // chat not in the allowlist
      expect(
        rm.getRoleForSource('telegram', { channelId: '9999', chatType: 'private' }).roleName
      ).toBe('chat_bot');
      // trust cleared again
      rm.setTelegramTrust(undefined);
      expect(
        rm.getRoleForSource('telegram', { channelId: '7777', chatType: 'private' }).roleName
      ).toBe('chat_bot');
    });

    it('never escalates non-telegram sources', () => {
      const rm = makeManager();
      rm.setTelegramTrust(['7777']);
      expect(
        rm.getRoleForSource('discord', { channelId: '7777', chatType: 'private' }).roleName
      ).toBe('chat_bot');
    });
  });

  describe('AC #4: missing owner_console definition falls through safely', () => {
    it('uses the normal mapping when the role definition is absent', () => {
      const stripped = {
        definitions: { chat_bot: DEFAULT_ROLES.definitions.chat_bot },
        sourceMapping: { telegram: 'chat_bot' },
      };
      const rm = new RoleManager({ rolesConfig: stripped });
      rm.setTelegramTrust(['7777']);
      expect(
        rm.getRoleForSource('telegram', { channelId: '7777', chatType: 'private' }).roleName
      ).toBe('chat_bot');
    });
  });
});
