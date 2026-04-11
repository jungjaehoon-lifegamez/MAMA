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
  | 'business_data'
  | 'utility'
  | 'browser'
  | 'os_management'
  | 'os_monitoring'
  | 'pr_review'
  | 'webchat'
  | 'code_act'
  | 'multi_agent'
  | 'system';

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
  name: 'mama_recall',
  description: 'Recall memory bundle with profile, memories, and graph context',
  category: 'memory',
  params: 'query, scopes?, includeProfile?',
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
register({
  name: 'report_publish',
  description:
    'Update dashboard report slots with HTML content. Each slot is a section of the dashboard that you write as HTML.',
  category: 'os_monitoring',
  params: 'slots: { briefing?: html, alerts?: html, activity?: html, pipeline?: html }',
});
register({
  name: 'wiki_publish',
  description:
    'Publish compiled wiki pages to Obsidian vault. Each page becomes a markdown file with YAML frontmatter.',
  category: 'os_monitoring',
  params: 'pages: [{path, title, type, content, confidence}]',
});
register({
  name: 'obsidian',
  description:
    'Execute Obsidian CLI command on the wiki vault. Search, read, create, append, move, delete pages, manage tags and backlinks.',
  category: 'os_monitoring',
  params: 'command, args?',
});
register({
  name: 'mama_add',
  description: 'Auto-extract and save facts from conversation content via Haiku',
  category: 'memory',
  params: 'content',
});
register({
  name: 'mama_ingest',
  description: 'Ingest raw content into memory v2',
  category: 'memory',
  params: 'content, scopes?, source?',
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

// Multi-Agent delegation
register({
  name: 'delegate',
  description:
    "Delegate a task to another agent. The target agent has its own persona, tools, and persistent session. Use this to assign specialized work (coding, review, research) to the right agent. Optional `skill` loads `~/.mama/skills/{skill}.md` and prepends it to the delegation prompt. Returns the agent's response.",
  category: 'multi_agent',
  params: 'agentId, task, background?, skill?',
});

// Business Data — progressive exploration of operational data
register({
  name: 'kagemusha_overview',
  description: 'Get overview: room/task/message counts across all channels',
  category: 'business_data',
  params: '(none)',
});
register({
  name: 'kagemusha_entities',
  description: 'List people and project channels with activity stats',
  category: 'business_data',
  params: 'channel?, activeOnly?, limit?',
});
register({
  name: 'kagemusha_tasks',
  description: 'Query tasks by room, status, priority, or text search',
  category: 'business_data',
  params: 'sourceRoom?, status?, priority?, search?, limit?',
});
register({
  name: 'kagemusha_messages',
  description: 'Read raw messages from a specific channel (follow entities -> tasks -> messages)',
  category: 'business_data',
  params: 'channelId (required), since?, limit?, search?',
});

// System tools
register({
  name: 'agent_notices',
  description:
    'Get recent agent activity notices (dashboard reports, wiki compilations, delegations). Use to check what other agents have done recently.',
  category: 'system',
  params: 'limit?',
});

// Agent management tools (Managed Agents pattern)
register({
  name: 'agent_get',
  description: 'Get agent config, persona, and current version',
  category: 'os_management',
  params: 'agent_id',
});
register({
  name: 'agent_update',
  description:
    'Update agent config. Requires current version for optimistic concurrency. Bumps version on change.',
  category: 'os_management',
  params: 'agent_id, version, changes: {model?, tier?, system?, tools?, ...}, change_note',
});
register({
  name: 'agent_create',
  description: 'Create new agent with initial config and persona',
  category: 'os_management',
  params: 'id, name, model, tier, system?, backend?',
});
register({
  name: 'agent_compare',
  description: 'Compare metrics between two versions of an agent (Before/After)',
  category: 'os_monitoring',
  params: 'agent_id, version_a, version_b',
});

// Viewer control tools (SmartStore pattern)
register({
  name: 'viewer_state',
  description:
    'Get current viewer state (active tab, page context). Call this to know what the user is looking at.',
  category: 'os_management',
  params: '',
});
register({
  name: 'viewer_navigate',
  description: 'Navigate viewer to a specific page/tab (e.g., agent detail, metrics)',
  category: 'os_management',
  params: 'route, params?: {id?, tab?, compareV1?, compareV2?}',
});
register({
  name: 'viewer_notify',
  description: 'Show toast or alert card in viewer',
  category: 'os_management',
  params: 'type: info|warning|suggest, message, action?: {label, navigate}',
});

// Agent lifecycle tools
register({
  name: 'agent_test',
  description: 'Test agent with connector data. Auto-scores pass/fail ratio.',
  category: 'os_management',
  params: 'agent_id, sample_count?, test_data?',
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
      business_data:
        'Business Data (progressive exploration: overview -> entities -> tasks -> messages)',
      utility: 'Utility',
      browser: 'Browser (Playwright)',
      os_management: 'OS Management (viewer-only)',
      os_monitoring: 'OS Monitoring (viewer-only)',
      pr_review: 'PR Review',
      webchat: 'Webchat',
      code_act: 'Code-Act Sandbox',
      multi_agent: 'Multi-Agent Delegation',
      system: 'System',
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
