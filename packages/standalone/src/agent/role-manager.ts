/**
 * Role Manager for Agent Permission Control
 *
 * Manages role-based permissions for different message sources (viewer, discord, etc.)
 * Determines which tools and paths are accessible based on the agent's role.
 */

import { minimatch } from 'minimatch';
import { RoleConfig, RolesConfig, DEFAULT_ROLES } from '../cli/config/types.js';

/**
 * Options for RoleManager initialization
 */
export interface RoleManagerOptions {
  /** Custom roles configuration (defaults to DEFAULT_ROLES) */
  rolesConfig?: RolesConfig;
}

/**
 * RoleManager handles role-based permission checks
 */
export class RoleManager {
  private rolesConfig: RolesConfig;

  constructor(options: RoleManagerOptions = {}) {
    this.rolesConfig = options.rolesConfig ?? DEFAULT_ROLES;
  }

  /**
   * Get the role configuration for a given source
   * @param source - Message source (e.g., "viewer", "discord", "telegram")
   * @returns Role configuration for the source
   */
  getRoleForSource(source: string): { roleName: string; role: RoleConfig } {
    const normalizedSource = source.toLowerCase();
    const roleName = this.rolesConfig.sourceMapping[normalizedSource];

    if (!roleName) {
      // Default to chat_bot for unknown sources (secure default)
      const defaultRoleName = 'chat_bot';
      const defaultRole = this.rolesConfig.definitions[defaultRoleName];

      if (!defaultRole) {
        // Fallback to minimal permissions if chat_bot not defined
        return {
          roleName: 'restricted',
          role: {
            allowedTools: ['mama_search', 'Read'],
            blockedTools: ['Bash', 'Write', 'save_integration_token'],
            allowedPaths: [],
            systemControl: false,
            sensitiveAccess: false,
          },
        };
      }

      return { roleName: defaultRoleName, role: defaultRole };
    }

    const role = this.rolesConfig.definitions[roleName];
    if (!role) {
      // Role name exists in mapping but definition is missing
      throw new Error(
        `Role "${roleName}" is mapped to source "${source}" but not defined in roles.definitions`
      );
    }

    return { roleName, role };
  }

  /**
   * Check if a tool is allowed for the given role
   * @param role - Role configuration
   * @param toolName - Name of the tool to check
   * @returns true if tool is allowed, false otherwise
   */
  isToolAllowed(role: RoleConfig, toolName: string): boolean {
    // Check blocked tools first (takes precedence)
    if (role.blockedTools && role.blockedTools.length > 0) {
      for (const pattern of role.blockedTools) {
        if (this.matchesPattern(toolName, pattern)) {
          return false;
        }
      }
    }

    // Check allowed tools
    for (const pattern of role.allowedTools) {
      if (this.matchesPattern(toolName, pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a path is allowed for the given role
   * @param role - Role configuration
   * @param path - File path to check
   * @returns true if path is allowed, false otherwise
   */
  isPathAllowed(role: RoleConfig, path: string): boolean {
    // If no path restrictions, allow all
    if (!role.allowedPaths || role.allowedPaths.length === 0) {
      return true;
    }

    // Expand ~ to home directory for comparison
    const expandedPath = this.expandPath(path);

    for (const pattern of role.allowedPaths) {
      const expandedPattern = this.expandPath(pattern);
      if (minimatch(expandedPath, expandedPattern, { dot: true })) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if the role can perform system control operations
   * @param role - Role configuration
   * @returns true if system control is allowed
   */
  canSystemControl(role: RoleConfig): boolean {
    return role.systemControl ?? false;
  }

  /**
   * Check if the role can access sensitive data
   * @param role - Role configuration
   * @returns true if sensitive access is allowed
   */
  canAccessSensitive(role: RoleConfig): boolean {
    return role.sensitiveAccess ?? false;
  }

  /**
   * Get human-readable capabilities list for a role
   * @param role - Role configuration
   * @returns Array of capability descriptions
   */
  getCapabilities(role: RoleConfig): string[] {
    const capabilities: string[] = [];

    // Add allowed tools (expand wildcards to readable format)
    for (const pattern of role.allowedTools) {
      if (pattern === '*') {
        capabilities.push('All tools');
      } else if (pattern.includes('*')) {
        capabilities.push(`${pattern.replace('*', '').replace('_', ' ')} tools`);
      } else {
        capabilities.push(pattern);
      }
    }

    if (role.systemControl) {
      capabilities.push('System control');
    }

    if (role.sensitiveAccess) {
      capabilities.push('Sensitive data access');
    }

    return capabilities;
  }

  /**
   * Get human-readable limitations list for a role
   * @param role - Role configuration
   * @returns Array of limitation descriptions
   */
  getLimitations(role: RoleConfig): string[] {
    const limitations: string[] = [];

    // Add blocked tools
    if (role.blockedTools && role.blockedTools.length > 0) {
      for (const tool of role.blockedTools) {
        limitations.push(`Cannot use ${tool}`);
      }
    }

    // Add path restrictions
    if (role.allowedPaths && role.allowedPaths.length > 0) {
      limitations.push('Limited file access');
    }

    if (!role.systemControl) {
      limitations.push('No system control');
    }

    if (!role.sensitiveAccess) {
      limitations.push('No sensitive data access');
    }

    return limitations;
  }

  /**
   * Update roles configuration
   * @param newConfig - New roles configuration
   */
  updateRolesConfig(newConfig: RolesConfig): void {
    this.rolesConfig = newConfig;
  }

  /**
   * Get current roles configuration
   * @returns Current roles configuration
   */
  getRolesConfig(): RolesConfig {
    return this.rolesConfig;
  }

  /**
   * Match a string against a wildcard pattern
   * Supports glob patterns: "mama_*" matches "mama_search", "mama_save"
   * Uses minimatch for consistent pattern matching with isPathAllowed
   */
  private matchesPattern(value: string, pattern: string): boolean {
    if (pattern === '*') {
      return true;
    }

    // Use minimatch for consistent glob pattern matching
    return minimatch(value, pattern);
  }

  /**
   * Expand ~ to home directory in path
   */
  private expandPath(path: string): string {
    if (path.startsWith('~')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      return path.replace(/^~/, home);
    }
    return path;
  }
}

/**
 * Singleton instance for global access
 */
let globalRoleManager: RoleManager | null = null;

/**
 * Get or create the global RoleManager instance
 * @param options - Options for initialization (only used on first call)
 * @returns Global RoleManager instance
 */
export function getRoleManager(options?: RoleManagerOptions): RoleManager {
  if (!globalRoleManager) {
    globalRoleManager = new RoleManager(options);
  }
  return globalRoleManager;
}

/**
 * Reset the global RoleManager instance (for testing)
 */
export function resetRoleManager(): void {
  globalRoleManager = null;
}
