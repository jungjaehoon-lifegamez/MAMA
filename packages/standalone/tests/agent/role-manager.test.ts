/**
 * Unit tests for RoleManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RoleManager, getRoleManager, resetRoleManager } from '../../src/agent/role-manager.js';
import type { RolesConfig, RoleConfig } from '../../src/cli/config/types.js';

describe('RoleManager', () => {
  afterEach(() => {
    resetRoleManager();
  });

  describe('getRoleForSource()', () => {
    it('should return os_agent role for viewer source', () => {
      const manager = new RoleManager();
      const { roleName, role } = manager.getRoleForSource('viewer');

      expect(roleName).toBe('os_agent');
      expect(role.allowedTools).toContain('*');
      expect(role.systemControl).toBe(true);
      expect(role.sensitiveAccess).toBe(true);
    });

    it('should return chat_bot role for discord source', () => {
      const manager = new RoleManager();
      const { roleName, role } = manager.getRoleForSource('discord');

      expect(roleName).toBe('chat_bot');
      expect(role.allowedTools).not.toContain('*');
      expect(role.blockedTools).toContain('Bash');
      expect(role.systemControl).toBe(false);
    });

    it('should return chat_bot role for telegram source', () => {
      const manager = new RoleManager();
      const { roleName, role } = manager.getRoleForSource('telegram');

      expect(roleName).toBe('chat_bot');
      expect(role.blockedTools).toContain('Write');
    });

    it('should return chat_bot role for unknown source (safe default)', () => {
      const manager = new RoleManager();
      const { roleName, role } = manager.getRoleForSource('unknown_platform');

      expect(roleName).toBe('chat_bot');
      expect(role.systemControl).toBe(false);
    });

    it('should be case-insensitive for source matching', () => {
      const manager = new RoleManager();
      const lower = manager.getRoleForSource('discord');
      const upper = manager.getRoleForSource('DISCORD');
      const mixed = manager.getRoleForSource('DiScOrD');

      expect(lower.roleName).toBe(upper.roleName);
      expect(lower.roleName).toBe(mixed.roleName);
    });

    it('should use custom roles config', () => {
      const customConfig: RolesConfig = {
        definitions: {
          admin: {
            allowedTools: ['*'],
            systemControl: true,
            sensitiveAccess: true,
          },
          readonly: {
            allowedTools: ['Read', 'mama_search'],
            blockedTools: ['Write', 'Bash'],
            systemControl: false,
            sensitiveAccess: false,
          },
        },
        sourceMapping: {
          viewer: 'admin',
          discord: 'readonly',
        },
      };

      const manager = new RoleManager({ rolesConfig: customConfig });
      const { roleName } = manager.getRoleForSource('discord');

      expect(roleName).toBe('readonly');
    });
  });

  describe('isToolAllowed()', () => {
    it('should allow all tools when allowedTools is ["*"]', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('viewer');

      expect(manager.isToolAllowed(role, 'Bash')).toBe(true);
      expect(manager.isToolAllowed(role, 'Write')).toBe(true);
      expect(manager.isToolAllowed(role, 'mama_search')).toBe(true);
      expect(manager.isToolAllowed(role, 'anything')).toBe(true);
    });

    it('should allow tools matching wildcard patterns', () => {
      const role: RoleConfig = {
        allowedTools: ['mama_*', 'Read'],
      };
      const manager = new RoleManager();

      expect(manager.isToolAllowed(role, 'mama_search')).toBe(true);
      expect(manager.isToolAllowed(role, 'mama_save')).toBe(true);
      expect(manager.isToolAllowed(role, 'mama_update')).toBe(true);
      expect(manager.isToolAllowed(role, 'Read')).toBe(true);
    });

    it('should block tools not matching any pattern', () => {
      const role: RoleConfig = {
        allowedTools: ['mama_*', 'Read'],
      };
      const manager = new RoleManager();

      expect(manager.isToolAllowed(role, 'Bash')).toBe(false);
      expect(manager.isToolAllowed(role, 'Write')).toBe(false);
      expect(manager.isToolAllowed(role, 'discord_send')).toBe(false);
    });

    it('should block tools in blockedTools even if allowedTools allows', () => {
      const role: RoleConfig = {
        allowedTools: ['*'],
        blockedTools: ['Bash', 'Write'],
      };
      const manager = new RoleManager();

      expect(manager.isToolAllowed(role, 'Read')).toBe(true);
      expect(manager.isToolAllowed(role, 'mama_search')).toBe(true);
      expect(manager.isToolAllowed(role, 'Bash')).toBe(false);
      expect(manager.isToolAllowed(role, 'Write')).toBe(false);
    });

    it('should support wildcard in blockedTools', () => {
      const role: RoleConfig = {
        allowedTools: ['*'],
        blockedTools: ['browser_*'],
      };
      const manager = new RoleManager();

      expect(manager.isToolAllowed(role, 'browser_navigate')).toBe(false);
      expect(manager.isToolAllowed(role, 'browser_screenshot')).toBe(false);
      expect(manager.isToolAllowed(role, 'Read')).toBe(true);
    });
  });

  describe('isPathAllowed()', () => {
    it('should allow all paths when allowedPaths is empty', () => {
      const role: RoleConfig = {
        allowedTools: ['Read'],
        allowedPaths: [],
      };
      const manager = new RoleManager();

      expect(manager.isPathAllowed(role, '/etc/passwd')).toBe(true);
      expect(manager.isPathAllowed(role, '/home/user/.bashrc')).toBe(true);
    });

    it('should allow all paths when allowedPaths is undefined', () => {
      const role: RoleConfig = {
        allowedTools: ['Read'],
      };
      const manager = new RoleManager();

      expect(manager.isPathAllowed(role, '/etc/passwd')).toBe(true);
    });

    it('should only allow paths matching patterns', () => {
      const role: RoleConfig = {
        allowedTools: ['Read'],
        allowedPaths: ['~/.mama/workspace/**'],
      };
      const manager = new RoleManager();
      const home = process.env.HOME || '';

      expect(manager.isPathAllowed(role, `${home}/.mama/workspace/test.txt`)).toBe(true);
      expect(manager.isPathAllowed(role, `${home}/.mama/workspace/nested/file.js`)).toBe(true);
      expect(manager.isPathAllowed(role, `${home}/.mama/config.yaml`)).toBe(false);
      expect(manager.isPathAllowed(role, '/etc/passwd')).toBe(false);
    });

    it('should handle ~ expansion', () => {
      const role: RoleConfig = {
        allowedTools: ['Read'],
        allowedPaths: ['~/.mama/**'],
      };
      const manager = new RoleManager();
      const home = process.env.HOME || '';

      expect(manager.isPathAllowed(role, `${home}/.mama/test.txt`)).toBe(true);
      expect(manager.isPathAllowed(role, '~/.mama/test.txt')).toBe(true);
    });
  });

  describe('canSystemControl()', () => {
    it('should return true for roles with systemControl', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('viewer');

      expect(manager.canSystemControl(role)).toBe(true);
    });

    it('should return false for roles without systemControl', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('discord');

      expect(manager.canSystemControl(role)).toBe(false);
    });
  });

  describe('canAccessSensitive()', () => {
    it('should return true for roles with sensitiveAccess', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('viewer');

      expect(manager.canAccessSensitive(role)).toBe(true);
    });

    it('should return false for roles without sensitiveAccess', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('discord');

      expect(manager.canAccessSensitive(role)).toBe(false);
    });
  });

  describe('getCapabilities()', () => {
    it('should return readable capabilities for os_agent', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('viewer');
      const capabilities = manager.getCapabilities(role);

      expect(capabilities).toContain('All tools');
      expect(capabilities).toContain('System control');
      expect(capabilities).toContain('Sensitive data access');
    });

    it('should return tool patterns for chat_bot', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('discord');
      const capabilities = manager.getCapabilities(role);

      expect(capabilities.some((c) => c.includes('mama'))).toBe(true);
      expect(capabilities).not.toContain('System control');
    });
  });

  describe('getLimitations()', () => {
    it('should return blocked tools', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('discord');
      const limitations = manager.getLimitations(role);

      expect(limitations.some((l) => l.includes('Bash'))).toBe(true);
      expect(limitations.some((l) => l.includes('Write'))).toBe(true);
    });

    it('should return no system control for chat_bot', () => {
      const manager = new RoleManager();
      const { role } = manager.getRoleForSource('discord');
      const limitations = manager.getLimitations(role);

      expect(limitations).toContain('No system control');
      expect(limitations).toContain('No sensitive data access');
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance from getRoleManager()', () => {
      const instance1 = getRoleManager();
      const instance2 = getRoleManager();

      expect(instance1).toBe(instance2);
    });

    it('should reset instance with resetRoleManager()', () => {
      const instance1 = getRoleManager();
      resetRoleManager();
      const instance2 = getRoleManager();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('updateRolesConfig()', () => {
    it('should update roles configuration', () => {
      const manager = new RoleManager();

      const newConfig: RolesConfig = {
        definitions: {
          super_admin: {
            allowedTools: ['*'],
            systemControl: true,
            sensitiveAccess: true,
          },
        },
        sourceMapping: {
          viewer: 'super_admin',
        },
      };

      manager.updateRolesConfig(newConfig);
      const { roleName } = manager.getRoleForSource('viewer');

      expect(roleName).toBe('super_admin');
    });
  });
});
