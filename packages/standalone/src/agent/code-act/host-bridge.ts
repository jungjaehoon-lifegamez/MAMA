import type { GatewayToolExecutor } from '../gateway-tool-executor.js';
import type { CodeActSandbox } from './sandbox.js';
import type { FunctionDescriptor } from './types.js';
import type { RoleConfig } from '../../cli/config/types.js';
import { RoleManager } from '../role-manager.js';

/** Tool metadata for .d.ts generation */
interface ToolMeta {
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
    returnType: 'SearchResult[]',
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
    returnType: '{ success: boolean }',
    category: 'memory',
  },
  {
    name: 'mama_load_checkpoint',
    description: 'Load last session checkpoint',
    params: [],
    returnType: '{ summary: string; next_steps: string; open_files: string[] } | null',
    category: 'memory',
  },
  // File I/O
  {
    name: 'Read',
    description: 'Read file contents',
    params: [{ name: 'path', type: 'string', required: true }],
    returnType: 'string',
    category: 'file',
  },
  {
    name: 'Write',
    description: 'Write content to file',
    params: [
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
    ],
    returnType: '{ success: boolean }',
    category: 'file',
  },
  {
    name: 'Bash',
    description: 'Execute shell command (60s timeout)',
    params: [
      { name: 'command', type: 'string', required: true },
      { name: 'workdir', type: 'string', required: false },
    ],
    returnType: '{ stdout: string; stderr: string; exitCode: number }',
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
    returnType: '{ success: boolean }',
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
    returnType: '{ success: boolean }',
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
    returnType: '{ success: boolean; message?: string }',
    category: 'communication',
  },
  // Browser
  {
    name: 'browser_navigate',
    description: 'Navigate browser to URL',
    params: [{ name: 'url', type: 'string', required: true }],
    returnType: '{ success: boolean; title: string }',
    category: 'browser',
  },
  {
    name: 'browser_screenshot',
    description: 'Take browser screenshot',
    params: [
      { name: 'selector', type: 'string', required: false },
      { name: 'full_page', type: 'boolean', required: false },
    ],
    returnType: '{ success: boolean; path: string }',
    category: 'browser',
  },
  {
    name: 'browser_click',
    description: 'Click element in browser',
    params: [{ name: 'selector', type: 'string', required: true }],
    returnType: '{ success: boolean }',
    category: 'browser',
  },
  {
    name: 'browser_type',
    description: 'Type text into browser element',
    params: [
      { name: 'selector', type: 'string', required: true },
      { name: 'text', type: 'string', required: true },
    ],
    returnType: '{ success: boolean }',
    category: 'browser',
  },
  {
    name: 'browser_get_text',
    description: 'Get page text content',
    params: [],
    returnType: 'string',
    category: 'browser',
  },
  {
    name: 'browser_scroll',
    description: 'Scroll browser page',
    params: [{ name: 'direction', type: "'up' | 'down'", required: true }],
    returnType: '{ success: boolean }',
    category: 'browser',
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for element/condition',
    params: [
      { name: 'selector', type: 'string', required: false },
      { name: 'timeout', type: 'number', required: false },
    ],
    returnType: '{ success: boolean }',
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
    returnType: '{ success: boolean; path: string }',
    category: 'browser',
  },
  {
    name: 'browser_close',
    description: 'Close browser',
    params: [],
    returnType: '{ success: boolean }',
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
    returnType: '{ success: boolean }',
    category: 'os',
  },
  {
    name: 'os_list_bots',
    description: 'List configured bots',
    params: [],
    returnType: 'BotStatus[]',
    category: 'os',
  },
  {
    name: 'os_restart_bot',
    description: 'Restart a bot',
    params: [{ name: 'platform', type: 'string', required: true }],
    returnType: '{ success: boolean }',
    category: 'os',
  },
  {
    name: 'os_stop_bot',
    description: 'Stop a bot',
    params: [{ name: 'platform', type: 'string', required: true }],
    returnType: '{ success: boolean }',
    category: 'os',
  },
  {
    name: 'os_set_permissions',
    description: 'Set role permissions',
    params: [
      { name: 'role', type: 'string', required: true },
      { name: 'permissions', type: 'object', required: true },
    ],
    returnType: '{ success: boolean }',
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
    returnType: '{ success: boolean }',
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
    returnType: 'ReviewThread[]',
    category: 'os',
  },
  // Playground
  {
    name: 'playground_create',
    description:
      'Create an interactive HTML playground. Use file_path for large HTML instead of inline.',
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'html', type: 'string', required: false, description: 'Inline HTML content' },
      {
        name: 'file_path',
        type: 'string',
        required: false,
        description: 'Path to HTML file (use instead of html for large content)',
      },
    ],
    returnType: '{ success: boolean; path: string; url: string }',
    category: 'os',
  },
];

/** Read-only tool names for Tier 2/3 */
const READ_ONLY_TOOLS = new Set([
  'mama_search',
  'mama_load_checkpoint',
  'Read',
  'browser_get_text',
  'browser_screenshot',
  'os_list_bots',
  'os_get_config',
  'pr_review_threads',
]);

export class HostBridge {
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

        const result = await this.executor.execute(desc.name, input as any);

        if (!result.success) {
          const msg = (result as any).message || (result as any).error || `${desc.name} failed`;
          throw new Error(`${desc.name}(): ${msg}`);
        }

        return result;
      });
    }
  }

  /** Get available function descriptors filtered by tier */
  getAvailableFunctions(tier: 1 | 2 | 3 = 1): FunctionDescriptor[] {
    return TOOL_REGISTRY.filter((meta) => {
      if (tier === 1) return true;
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
