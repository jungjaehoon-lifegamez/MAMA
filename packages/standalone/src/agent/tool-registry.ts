/**
 * ToolRegistry — Single source of truth for gateway tools (STORY-016)
 *
 * Centralizes tool definitions so that:
 * - VALID_TOOLS array (gateway-tool-executor.ts) is derived, not hand-coded
 * - gateway-tools.md can be generated at build time
 * - Per-agent tool filtering has one canonical list to filter against
 */

import type { GatewayToolName } from './types.js';

// ─── Tool Metadata ───────────────────────────────────────────────────────────

export type ToolCategory =
  | 'memory'
  | 'utility'
  | 'browser'
  | 'os_management'
  | 'os_monitoring'
  | 'pr_review'
  | 'playground'
  | 'webchat'
  | 'code_act';

export interface ToolDefinitionMeta {
  name: GatewayToolName;
  description: string;
  category: ToolCategory;
  /** Short parameter hint for prompt generation (e.g. "query?, type?, limit?") */
  params?: string;
  /** If true, only viewers can use this tool */
  viewerOnly?: boolean;
}

// ─── Registry ────────────────────────────────────────────────────────────────

const _tools = new Map<GatewayToolName, ToolDefinitionMeta>();

function register(meta: ToolDefinitionMeta): void {
  _tools.set(meta.name, meta);
}

// ─── Built-in tool definitions ───────────────────────────────────────────────

// Memory tools
register({
  name: 'mama_save',
  description: 'Save decision (topic, decision, reasoning) or checkpoint (summary, next_steps?)',
  category: 'memory',
});
register({
  name: 'mama_search',
  description: 'Search decisions',
  category: 'memory',
  params: 'query?, type?, limit?',
});
register({
  name: 'mama_update',
  description: 'Update outcome',
  category: 'memory',
  params: 'id, outcome, reason?',
});
register({
  name: 'mama_load_checkpoint',
  description: 'Resume session. No params.',
  category: 'memory',
});

// Utility tools
register({ name: 'Read', description: 'Read file', category: 'utility', params: 'path' });
register({
  name: 'Write',
  description: 'Write file',
  category: 'utility',
  params: 'path, content',
});
register({
  name: 'Bash',
  description: 'Execute command (60s timeout)',
  category: 'utility',
  params: 'command, workdir?',
});
register({
  name: 'discord_send',
  description: 'Send message or file to Discord',
  category: 'utility',
  params: 'channel_id, message?, file_path?',
});
register({
  name: 'slack_send',
  description: 'Send message or file to Slack',
  category: 'utility',
  params: 'channel_id, message?, file_path?',
});
register({
  name: 'telegram_send',
  description: 'Send message, file, or sticker to Telegram',
  category: 'utility',
  params: 'chat_id, message?, file_path?, sticker_emotion?',
});

// Browser tools (Playwright)
register({
  name: 'browser_navigate',
  description: 'Open URL in headless browser',
  category: 'browser',
  params: 'url',
});
register({
  name: 'browser_screenshot',
  description: 'Take screenshot',
  category: 'browser',
  params: 'filename?, fullPage?',
});
register({
  name: 'browser_click',
  description: 'Click element by CSS selector',
  category: 'browser',
  params: 'selector',
});
register({
  name: 'browser_type',
  description: 'Type text into input',
  category: 'browser',
  params: 'selector, text',
});
register({ name: 'browser_get_text', description: 'Get all text from page', category: 'browser' });
register({
  name: 'browser_scroll',
  description: 'Scroll page',
  category: 'browser',
  params: 'direction, amount?',
});
register({
  name: 'browser_wait_for',
  description: 'Wait for element',
  category: 'browser',
  params: 'selector, timeout?',
});
register({
  name: 'browser_evaluate',
  description: 'Run JavaScript in page',
  category: 'browser',
  params: 'script',
});
register({
  name: 'browser_pdf',
  description: 'Save page as PDF',
  category: 'browser',
  params: 'filename?',
});
register({ name: 'browser_close', description: 'Close browser', category: 'browser' });

// OS Management (viewer-only)
register({
  name: 'os_add_bot',
  description: 'Add a bot platform (Discord/Telegram/Slack/Chatwork)',
  category: 'os_management',
  viewerOnly: true,
});
register({
  name: 'os_set_permissions',
  description: 'Set tool/path permissions for a role',
  category: 'os_management',
  viewerOnly: true,
});
register({
  name: 'os_get_config',
  description: 'Get current configuration',
  category: 'os_management',
  viewerOnly: true,
});
register({
  name: 'os_set_model',
  description: 'Set AI model for a role',
  category: 'os_management',
  viewerOnly: true,
});

// OS Monitoring (viewer-only)
register({
  name: 'os_list_bots',
  description: 'List configured bot platforms and status',
  category: 'os_monitoring',
  viewerOnly: true,
});
register({
  name: 'os_restart_bot',
  description: 'Restart a bot platform',
  category: 'os_monitoring',
  viewerOnly: true,
});
register({
  name: 'os_stop_bot',
  description: 'Stop a bot platform',
  category: 'os_monitoring',
  viewerOnly: true,
});

// PR Review
register({
  name: 'pr_review_threads',
  description: 'Fetch unresolved review threads from GitHub PR',
  category: 'pr_review',
  params: 'pr_url',
});

// Playground
register({
  name: 'playground_create',
  description: 'Create an interactive HTML playground',
  category: 'playground',
  params: 'name, html?, file_path?, description?',
});

// Webchat
register({
  name: 'webchat_send',
  description: 'Send message/file to webchat viewer',
  category: 'webchat',
  params: 'message?, file_path?, session_id?',
});

// Code-Act sandbox
register({
  name: 'code_act',
  description: 'Execute JavaScript in sandboxed QuickJS',
  category: 'code_act',
});

// ─── Public API ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  /**
   * Get all registered tool names.
   */
  static getValidToolNames(): GatewayToolName[] {
    return [..._tools.keys()];
  }

  /**
   * Get tool metadata by name.
   */
  static getTool(name: string): ToolDefinitionMeta | undefined {
    return _tools.get(name as GatewayToolName);
  }

  /**
   * Get all tool definitions.
   */
  static getAllTools(): ToolDefinitionMeta[] {
    return [..._tools.values()];
  }

  /**
   * Get tools filtered by allowed list.
   * If allowedTools is undefined or empty, returns all tools.
   * Supports wildcard patterns: "mama_*", "browser_*", "*"
   */
  static getFilteredTools(allowedTools?: string[]): ToolDefinitionMeta[] {
    if (!allowedTools || allowedTools.length === 0 || allowedTools.includes('*')) {
      return ToolRegistry.getAllTools();
    }

    return ToolRegistry.getAllTools().filter((tool) =>
      allowedTools.some((pattern) => matchToolPattern(pattern, tool.name))
    );
  }

  /**
   * Get tools grouped by category.
   */
  static getByCategory(): Map<ToolCategory, ToolDefinitionMeta[]> {
    const grouped = new Map<ToolCategory, ToolDefinitionMeta[]>();
    for (const tool of _tools.values()) {
      const list = grouped.get(tool.category) || [];
      list.push(tool);
      grouped.set(tool.category, list);
    }
    return grouped;
  }

  /**
   * Check if a tool name is registered.
   */
  static isRegistered(name: string): boolean {
    return _tools.has(name as GatewayToolName);
  }

  /**
   * Validate that all registered tools have handlers in an executor.
   * Returns list of tool names with missing handlers.
   */
  static validateHandlers(handlerNames: Set<string>): string[] {
    const missing: string[] = [];
    for (const name of _tools.keys()) {
      if (!handlerNames.has(name)) {
        missing.push(name);
      }
    }
    return missing;
  }

  /**
   * Generate a markdown prompt listing all tools (or filtered subset).
   */
  static generatePrompt(allowedTools?: string[]): string {
    const tools = ToolRegistry.getFilteredTools(allowedTools);
    const grouped = new Map<ToolCategory, ToolDefinitionMeta[]>();
    for (const tool of tools) {
      const list = grouped.get(tool.category) || [];
      list.push(tool);
      grouped.set(tool.category, list);
    }

    const categoryLabels: Record<ToolCategory, string> = {
      memory: 'MAMA Memory',
      utility: 'Utility',
      browser: 'Browser (Playwright)',
      os_management: 'OS Management (viewer-only)',
      os_monitoring: 'OS Monitoring (viewer-only)',
      pr_review: 'PR Review',
      playground: 'Playground',
      webchat: 'Webchat',
      code_act: 'Code-Act Sandbox',
    };

    const sections: string[] = ['# Gateway Tools\n'];
    for (const [category, label] of Object.entries(categoryLabels)) {
      const catTools = grouped.get(category as ToolCategory);
      if (!catTools || catTools.length === 0) continue;
      sections.push(`## ${label}\n`);
      for (const tool of catTools) {
        const paramHint = tool.params ? `(${tool.params})` : '()';
        sections.push(`- **${tool.name}**${paramHint} — ${tool.description}`);
      }
      sections.push('');
    }

    return sections.join('\n').trim();
  }

  /**
   * Generate a compact fallback prompt (for when gateway-tools.md is not available).
   */
  static generateFallbackPrompt(allowedTools?: string[]): string {
    const tools = ToolRegistry.getFilteredTools(allowedTools);
    const grouped = new Map<ToolCategory, string[]>();
    for (const tool of tools) {
      const list = grouped.get(tool.category) || [];
      list.push(tool.name);
      grouped.set(tool.category, list);
    }

    const parts: string[] = [];
    for (const [category, names] of grouped) {
      parts.push(`**${category}:** ${names.join(', ')}`);
    }
    return parts.join('\n');
  }

  /**
   * Total number of registered tools.
   */
  static get count(): number {
    return _tools.size;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Match a tool name against a pattern (supports trailing wildcard).
 */
function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return pattern === toolName;
}
