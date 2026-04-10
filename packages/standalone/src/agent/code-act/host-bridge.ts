import type { GatewayToolExecutor } from '../gateway-tool-executor.js';
import type { GatewayToolInput, GatewayToolResult } from '../types.js';
import type { CodeActSandbox } from './sandbox.js';
import type { FunctionDescriptor } from './types.js';
import type { RoleConfig } from '../../cli/config/types.js';
import { RoleManager } from '../role-manager.js';

/** Tool metadata for .d.ts generation */
export interface ToolMeta {
  name: string;
  description: string;
  params: { name: string; type: string; required: boolean; description?: string }[];
  returnType: string;
  category: FunctionDescriptor['category'];
}

/** All gateway tool metadata */
const TOOL_REGISTRY: ToolMeta[] = [
  // Memory
  {
    name: 'mama_search',
    description: 'Search decisions and checkpoints',
    params: [
      { name: 'query', type: 'string', required: false, description: 'Search query' },
      { name: 'type', type: "'decision' | 'checkpoint' | 'all'", required: false },
      { name: 'limit', type: 'number', required: false },
    ],
    returnType: '{ results: SearchResult[]; count: number }',
    category: 'memory',
  },
  {
    name: 'mama_save',
    description: 'Save a decision or checkpoint',
    params: [
      { name: 'type', type: "'decision' | 'checkpoint'", required: true },
      { name: 'topic', type: 'string', required: false },
      { name: 'decision', type: 'string', required: false },
      { name: 'reasoning', type: 'string', required: false },
      { name: 'confidence', type: 'number', required: false },
      { name: 'summary', type: 'string', required: false },
      { name: 'next_steps', type: 'string', required: false },
    ],
    returnType: '{ id: string }',
    category: 'memory',
  },
  {
    name: 'mama_update',
    description: 'Update decision outcome',
    params: [
      { name: 'id', type: 'string', required: true },
      { name: 'outcome', type: "'success' | 'failed' | 'partial'", required: true },
      { name: 'reason', type: 'string', required: false },
    ],
    returnType: '{ message?: string }',
    category: 'memory',
  },
  {
    name: 'mama_load_checkpoint',
    description: 'Load last session checkpoint',
    params: [],
    returnType:
      '{ summary?: string; next_steps?: string; open_files?: string[]; message?: string }',
    category: 'memory',
  },
  // Dashboard
  {
    name: 'report_publish',
    description:
      'Update dashboard report slots with HTML. Each slot is a section you write as HTML. Write analysis, not data listing.',
    params: [
      {
        name: 'slots',
        type: 'Record<string, string>',
        required: true,
        description:
          'Object mapping slot IDs to HTML strings. Keys: briefing, alerts, activity, pipeline. Values: your analysis as styled HTML.',
      },
    ],
    returnType: '{ success: boolean; message: string }',
    category: 'os',
  },
  // Wiki
  {
    name: 'wiki_publish',
    description:
      'Publish compiled wiki pages to Obsidian vault. Each page becomes a markdown file with YAML frontmatter.',
    params: [
      {
        name: 'pages',
        type: 'Array<{ path: string; title: string; type: string; content: string; confidence: string }>',
        required: true,
        description:
          'Array of wiki pages to publish. Each page has path, title, type (entity/lesson/synthesis/process), content (markdown), confidence (high/medium/low).',
      },
    ],
    returnType: '{ success: boolean; message: string }',
    category: 'os',
  },
  // Obsidian CLI — vault management
  {
    name: 'obsidian',
    description:
      'Execute Obsidian CLI command on the wiki vault. Search existing pages before creating new ones to prevent duplicates. ' +
      'Commands: search, read, create, append, prepend, move, delete, find, ' +
      'property:set, property:get, property:list, tags, tags:counts, tags:rename, ' +
      'backlinks, js, daily, daily:append, daily:create.',
    params: [
      {
        name: 'command',
        type: 'string',
        required: true,
        description:
          'CLI command: search, read, create, append, prepend, move, delete, find, ' +
          'property:set, property:get, property:list, tags, tags:counts, tags:rename, ' +
          'backlinks, js, daily, daily:append, daily:create',
      },
      {
        name: 'args',
        type: 'Record<string, string>',
        required: false,
        description:
          'Named arguments as key-value pairs. Common keys: query, limit, file, path, ' +
          'name, content, template, to, old, new, tag, code. ' +
          'Boolean flags (silent, overwrite, total): set value to "true".',
      },
    ],
    returnType: '{ output: string }',
    category: 'os',
  },
  // File I/O
  {
    name: 'Read',
    description: 'Read file contents',
    params: [{ name: 'path', type: 'string', required: true }],
    returnType: '{ content: string }',
    category: 'file',
  },
  {
    name: 'Write',
    description: 'Write content to file',
    params: [
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
    ],
    returnType: 'true',
    category: 'file',
  },
  {
    name: 'Bash',
    description: 'Execute shell command (60s timeout)',
    params: [
      { name: 'command', type: 'string', required: true },
      { name: 'workdir', type: 'string', required: false },
    ],
    returnType: '{ output: string }',
    category: 'os',
  },
  // Communication
  {
    name: 'discord_send',
    description: 'Send message or file to Discord channel',
    params: [
      { name: 'channel_id', type: 'string', required: true },
      { name: 'message', type: 'string', required: false },
      { name: 'file_path', type: 'string', required: false },
    ],
    returnType: 'true',
    category: 'communication',
  },
  {
    name: 'slack_send',
    description: 'Send message or file to Slack channel',
    params: [
      { name: 'channel_id', type: 'string', required: true },
      { name: 'message', type: 'string', required: false },
      { name: 'file_path', type: 'string', required: false },
    ],
    returnType: 'true',
    category: 'communication',
  },
  {
    name: 'telegram_send',
    description: 'Send message, file, or sticker to Telegram chat',
    params: [
      { name: 'chat_id', type: 'string', required: true },
      { name: 'message', type: 'string', required: false },
      { name: 'file_path', type: 'string', required: false },
      { name: 'sticker_emotion', type: 'string', required: false },
    ],
    returnType: 'true',
    category: 'communication',
  },
  {
    name: 'webchat_send',
    description: 'Send message or file to webchat viewer',
    params: [
      { name: 'message', type: 'string', required: false },
      { name: 'file_path', type: 'string', required: false },
      { name: 'session_id', type: 'string', required: false },
    ],
    returnType: '{ message?: string }',
    category: 'communication',
  },
  // Browser
  {
    name: 'browser_navigate',
    description: 'Navigate browser to URL',
    params: [{ name: 'url', type: 'string', required: true }],
    returnType: '{ title: string }',
    category: 'browser',
  },
  {
    name: 'browser_screenshot',
    description: 'Take browser screenshot',
    params: [
      { name: 'selector', type: 'string', required: false },
      { name: 'full_page', type: 'boolean', required: false },
    ],
    returnType: '{ path: string }',
    category: 'browser',
  },
  {
    name: 'browser_click',
    description: 'Click element in browser',
    params: [{ name: 'selector', type: 'string', required: true }],
    returnType: 'true',
    category: 'browser',
  },
  {
    name: 'browser_type',
    description: 'Type text into browser element',
    params: [
      { name: 'selector', type: 'string', required: true },
      { name: 'text', type: 'string', required: true },
    ],
    returnType: 'true',
    category: 'browser',
  },
  {
    name: 'browser_get_text',
    description: 'Get page text content',
    params: [],
    returnType: '{ text: string }',
    category: 'browser',
  },
  {
    name: 'browser_scroll',
    description: 'Scroll browser page',
    params: [{ name: 'direction', type: "'up' | 'down'", required: true }],
    returnType: 'true',
    category: 'browser',
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for element/condition',
    params: [
      { name: 'selector', type: 'string', required: false },
      { name: 'timeout', type: 'number', required: false },
    ],
    returnType: 'true',
    category: 'browser',
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in browser',
    params: [{ name: 'script', type: 'string', required: true }],
    returnType: 'unknown',
    category: 'browser',
  },
  {
    name: 'browser_pdf',
    description: 'Save page as PDF',
    params: [{ name: 'path', type: 'string', required: false }],
    returnType: '{ path: string }',
    category: 'browser',
  },
  {
    name: 'browser_close',
    description: 'Close browser',
    params: [],
    returnType: 'true',
    category: 'browser',
  },
  // OS Management
  {
    name: 'os_add_bot',
    description: 'Add a new bot platform',
    params: [
      { name: 'platform', type: "'discord' | 'slack' | 'telegram'", required: true },
      { name: 'token', type: 'string', required: true },
    ],
    returnType: 'true',
    category: 'os',
  },
  {
    name: 'os_list_bots',
    description: 'List configured bots',
    params: [],
    returnType: '{ bots?: BotStatus[] }',
    category: 'os',
  },
  {
    name: 'os_restart_bot',
    description: 'Restart a bot',
    params: [{ name: 'platform', type: 'string', required: true }],
    returnType: 'true',
    category: 'os',
  },
  {
    name: 'os_stop_bot',
    description: 'Stop a bot',
    params: [{ name: 'platform', type: 'string', required: true }],
    returnType: 'true',
    category: 'os',
  },
  {
    name: 'os_set_permissions',
    description: 'Set role permissions',
    params: [
      { name: 'role', type: 'string', required: true },
      { name: 'permissions', type: 'object', required: true },
    ],
    returnType: 'true',
    category: 'os',
  },
  {
    name: 'os_get_config',
    description: 'Get MAMA configuration',
    params: [{ name: 'section', type: 'string', required: false }],
    returnType: 'object',
    category: 'os',
  },
  {
    name: 'os_set_model',
    description: 'Set model for agent',
    params: [
      { name: 'agent_id', type: 'string', required: true },
      { name: 'model', type: 'string', required: true },
    ],
    returnType: 'true',
    category: 'os',
  },
  // PR Review
  {
    name: 'pr_review_threads',
    description: 'Get PR review threads from GitHub',
    params: [
      { name: 'owner', type: 'string', required: true },
      { name: 'repo', type: 'string', required: true },
      { name: 'pr', type: 'number', required: true },
      { name: 'filter', type: "'unresolved' | 'resolved' | 'all'", required: false },
    ],
    returnType: '{ threads?: ReviewThread[]; summary?: string }',
    category: 'os',
  },
  // Delegation — Tier 1 only (Conductor can delegate tasks to other agents)
  {
    name: 'delegate',
    description:
      'Delegate a task to another agent with its own persona, tools, and persistent session. Returns the agent response.',
    params: [
      {
        name: 'agentId',
        type: 'string',
        required: true,
        description: 'Target agent ID (e.g., "developer", "reviewer")',
      },
      {
        name: 'task',
        type: 'string',
        required: true,
        description: 'Task description for the target agent',
      },
      {
        name: 'background',
        type: 'boolean',
        required: false,
        description: 'If true, fire-and-forget. Default: false',
      },
    ],
    returnType: '{ agentId: string; response?: string; taskId?: string; message?: string }',
    category: 'os',
  },
  // System — agent activity notices
  {
    name: 'agent_notices',
    description: 'Get recent agent activity notices.',
    params: [
      { name: 'limit', type: 'number', required: false, description: 'Max notices (default: 10)' },
    ],
    returnType:
      '{ data: { notices: Array<{ agent: string; action: string; target: string; timestamp: string }> } }',
    category: 'system',
  },
  // Kagemusha Query — progressive business data exploration
  {
    name: 'kagemusha_overview',
    description:
      'Get overview of all business data: room counts, task stats, message volume. Start here.',
    params: [],
    returnType:
      '{ rooms: { total: number; byChannel: Record<string, number> }; tasks: { total: number; byStatus: Record<string, number> }; messages: { total: number; recent30d: number } }',
    category: 'memory',
  },
  {
    name: 'kagemusha_entities',
    description: 'List people and project channels with activity stats. Like browsing a file tree.',
    params: [
      {
        name: 'channel',
        type: 'string',
        required: false,
        description: "Filter by platform: 'kakao', 'slack', 'chatwork', 'line', 'telegram'",
      },
      {
        name: 'activeOnly',
        type: 'boolean',
        required: false,
        description: 'Only entities active in last 30 days',
      },
      { name: 'limit', type: 'number', required: false },
    ],
    returnType:
      'Array<{ id: string; name: string; channel: string; type: string; totalMessages: number; recentMessages: number; activeTasks: number; totalTasks: number; lastActive: string }>',
    category: 'memory',
  },
  {
    name: 'kagemusha_tasks',
    description:
      'Query tasks by room, status, priority, or text search. Like reading type definitions.',
    params: [
      {
        name: 'sourceRoom',
        type: 'string',
        required: false,
        description: 'Room ID from kagemusha_entities (e.g., "slack:CHANNEL_ID")',
      },
      {
        name: 'status',
        type: 'string',
        required: false,
        description: 'pending, in_progress, done, completed, dismissed',
      },
      { name: 'priority', type: 'string', required: false, description: 'urgent, high, normal' },
      { name: 'search', type: 'string', required: false, description: 'Text search in title' },
      { name: 'limit', type: 'number', required: false },
    ],
    returnType:
      'Array<{ id: number; title: string; status: string; priority: string; deadline: string | null; sourceRoom: string | null; createdAt: string }>',
    category: 'memory',
  },
  {
    name: 'kagemusha_messages',
    description:
      'Read raw messages from a specific channel. Like reading source code. Follow entity → task → messages.',
    params: [
      {
        name: 'channelId',
        type: 'string',
        required: true,
        description: 'Channel ID from kagemusha_entities result (e.g., "kakao:ROOM_NAME")',
      },
      {
        name: 'since',
        type: 'string',
        required: false,
        description: 'ISO date (default: 7 days ago)',
      },
      { name: 'limit', type: 'number', required: false },
      { name: 'search', type: 'string', required: false, description: 'Text search in content' },
    ],
    returnType:
      'Array<{ id: number; channel: string; author: string; content: string; timestamp: string }>',
    category: 'memory',
  },
];

/** Read-only tool names for Tier 3 (strictest) */
export const READ_ONLY_TOOLS = new Set([
  'mama_search',
  'mama_load_checkpoint',
  'Read',
  'browser_get_text',
  'browser_screenshot',
  'os_list_bots',
  'os_get_config',
  'pr_review_threads',
  'agent_notices',
]);

/** Memory-write tools additionally allowed for Tier 2 */
const MEMORY_WRITE_TOOLS = new Set(['mama_save', 'mama_update']);

export class HostBridge {
  onToolUse?: (toolName: string, input: Record<string, unknown>, result: unknown) => void;

  constructor(
    private executor: GatewayToolExecutor,
    private roleManager?: RoleManager
  ) {}

  /** Inject all allowed functions into sandbox based on tier */
  injectInto(sandbox: CodeActSandbox, tier: 1 | 2 | 3 = 1, role?: RoleConfig): void {
    const allowed = this.getAvailableFunctions(tier);

    for (const desc of allowed) {
      // Additional role-based check if role provided
      if (role && this.roleManager && !this.roleManager.isToolAllowed(role, desc.name)) {
        continue;
      }

      sandbox.registerFunction(desc.name, async (...args: unknown[]) => {
        const input = this._buildInput(desc, args);

        // Validate required params before execution
        const missing = desc.params
          .filter((p) => p.required && (input[p.name] === undefined || input[p.name] === null))
          .map((p) => `${p.name}: ${p.type}`);
        if (missing.length > 0) {
          const sig = desc.params
            .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
            .join(', ');
          throw new Error(
            `${desc.name}() missing required param(s): ${missing.join(', ')}. ` +
              `Usage: ${desc.name}({${sig}}) or ${desc.name}(${desc.params.map((p) => p.name).join(', ')})`
          );
        }

        this.onToolUse?.(desc.name, input, undefined);
        const result = await this.executor.execute(desc.name, input as GatewayToolInput);
        this.onToolUse?.(desc.name, input, result);

        if (!result.success) {
          const r = result as GatewayToolResult & { message?: string; error?: string };
          const msg = r.message || r.error || `${desc.name} failed`;
          throw new Error(`${desc.name}(): ${msg}`);
        }

        // Unwrap: strip `success` field so return shape matches TOOL_REGISTRY returnType
        const { success: _, ...payload } = result as unknown as Record<string, unknown>;
        return Object.keys(payload).length === 0 ? true : payload;
      });
    }
  }

  /** Get available function descriptors filtered by tier */
  getAvailableFunctions(tier: 1 | 2 | 3 = 1): FunctionDescriptor[] {
    return TOOL_REGISTRY.filter((meta) => {
      if (tier === 1) {
        return true;
      }
      if (tier === 2) {
        return READ_ONLY_TOOLS.has(meta.name) || MEMORY_WRITE_TOOLS.has(meta.name);
      }
      return READ_ONLY_TOOLS.has(meta.name);
    }).map((meta) => ({
      name: meta.name,
      params: meta.params,
      returnType: meta.returnType,
      description: meta.description,
      category: meta.category,
    }));
  }

  /** Get all tool metadata (for TypeDefinitionGenerator) */
  static getToolRegistry(): readonly ToolMeta[] {
    return TOOL_REGISTRY;
  }

  /** Build input object from positional or object args */
  private _buildInput(desc: FunctionDescriptor, args: unknown[]): Record<string, unknown> {
    // If single object argument passed, use it directly
    if (
      args.length === 1 &&
      typeof args[0] === 'object' &&
      args[0] !== null &&
      !Array.isArray(args[0])
    ) {
      return args[0] as Record<string, unknown>;
    }

    // Map positional args to param names
    const input: Record<string, unknown> = {};
    for (let i = 0; i < desc.params.length && i < args.length; i++) {
      if (args[i] !== undefined) {
        input[desc.params[i].name] = args[i];
      }
    }
    return input;
  }
}
