import type { GatewayToolExecutor } from '../gateway-tool-executor.js';
import type { GatewayToolExecutionContext, GatewayToolInput, GatewayToolResult } from '../types.js';
import type { CodeActSandbox } from './sandbox.js';
import type { FunctionDescriptor } from './types.js';
import type { RoleConfig } from '../../cli/config/types.js';
import { RoleManager } from '../role-manager.js';

/** Tool metadata for .d.ts generation */
export interface ToolMeta {
  readonly name: string;
  readonly description: string;
  readonly params: readonly {
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly description?: string;
  }[];
  readonly returnType: string;
  readonly category: FunctionDescriptor['category'];
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
      {
        name: 'scopes',
        type: "Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>",
        required: false,
      },
      { name: 'strict', type: 'boolean', required: false },
      { name: 'strictness', type: "'recall' | 'balanced' | 'strict'", required: false },
      { name: 'threshold', type: 'number', required: false },
      { name: 'disableRecency', type: 'boolean', required: false },
      { name: 'includeRelated', type: 'boolean', required: false },
      { name: 'topicPrefix', type: 'string', required: false },
      { name: 'minLexicalSupport', type: 'boolean', required: false },
      { name: 'diagnostics', type: 'boolean', required: false },
    ],
    returnType:
      '{ results: Array<Record<string, unknown>>; count: number; diagnostics?: Record<string, unknown> | null; meta?: Record<string, unknown> }',
    category: 'memory',
  },
  {
    name: 'mama_recall',
    description: 'Recall a scoped memory bundle with profile, memories, and graph context',
    params: [
      { name: 'query', type: 'string', required: true },
      {
        name: 'scopes',
        type: "Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>",
        required: false,
      },
    ],
    returnType:
      '{ bundle: { profile: { static: Array<Record<string, unknown>>; dynamic: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>> }; memories: Array<Record<string, unknown>>; graph_context: { primary: Array<Record<string, unknown>>; expanded: Array<Record<string, unknown>>; edge_count: number } } }',
    category: 'memory',
  },
  {
    name: 'context_compile',
    description: 'Compile a scoped context packet from visible evidence',
    params: [
      { name: 'task', type: 'string', required: true },
      {
        name: 'scopes',
        type: "Array<{ kind: 'global' | 'user' | 'channel' | 'project'; id: string }>",
        required: false,
      },
      { name: 'connectors', type: 'string[]', required: false },
      { name: 'seed_refs', type: 'Array<Record<string, unknown>>', required: false },
      { name: 'range', type: '{ start_ms?: number; end_ms?: number }', required: false },
      { name: 'as_of', type: 'string | number | null', required: false },
      { name: 'limit', type: 'number', required: false },
      { name: 'max_tool_calls', type: 'number', required: false },
      { name: 'max_ms', type: 'number', required: false },
      { name: 'max_tokens', type: 'number', required: false },
      { name: 'strictness', type: "'recall' | 'balanced' | 'strict'", required: false },
    ],
    returnType:
      '{ packet_id: string; packet: Record<string, unknown>; model_run_id?: string; parent_model_run_id?: string | null }',
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
      { name: 'context_packet_id', type: 'string', required: false },
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
  {
    name: 'report_request',
    description: 'Start a fresh full operator report and acknowledge that it is on its way',
    params: [],
    returnType: '{ message: string }',
    category: 'os',
  },
  {
    name: 'board_read',
    description: 'Read the current owner dashboard report slots',
    params: [],
    returnType: '{ slots: Record<string, { html: string; updatedAt?: string | null }> }',
    category: 'os',
  },
  {
    name: 'workorder_request',
    description: 'Enqueue a priority system workorder and acknowledge it without waiting',
    params: [
      {
        name: 'kind',
        type: "'board' | 'wiki' | 'memory-curation'",
        required: true,
      },
    ],
    returnType: '{ message: string }',
    category: 'os',
  },
  {
    name: 'workorder_status',
    description: 'Read per-kind system workorder status and failure counts',
    params: [],
    returnType:
      "{ data: { kinds: Array<{ workKind: 'board' | 'wiki' | 'memory-curation' | 'temporal'; lastRunAt: number | null; lastStatus: 'pending' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled' | 'failed' | null; failedCount: number; lastFailureReason: string | null }> } }",
    category: 'os',
  },
  {
    name: 'audit_findings_read',
    description: 'Read the latest deterministic system-audit findings',
    params: [],
    returnType: '{ findings: unknown; message?: string }',
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
        type: "Array<{ path: string; title: string; type: string; content: string; confidence?: 'high' | 'medium' | 'low'; sourceIds?: string[]; sourceRefs?: Array<{ kind: string; id: string; connector?: string }> }>",
        required: true,
        description:
          'Array of wiki pages to publish. Path must be relative to the wiki directory. sourceRefs is canonical vNext provenance; sourceIds is legacy-compatible provenance.',
      },
    ],
    returnType: '{ success: boolean; message: string; artifactsStored?: number }',
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
    returnType: '{ data: { output: string } }',
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
    name: 'ocr_image',
    description: 'OCR a private-workspace image',
    params: [
      { name: 'path', type: 'string', required: true },
      { name: 'lang', type: 'string', required: false },
    ],
    returnType: '{regions:{bbox:number[][];text:string}[]}',
    category: 'file',
  },
  {
    name: 'create_fb_overlay',
    description: 'Render translated OCR boxes',
    params: [
      { name: 'imagePath', type: 'string', required: true },
      {
        name: 'annotations',
        type: '{bbox:number[][];translated:string}[]',
        required: true,
      },
      { name: 'outputPath', type: 'string', required: false },
    ],
    returnType: '{outputPath:string}',
    category: 'file',
  },
  {
    name: 'translate_conti',
    description: 'Two-step storyboard OCR and overlay',
    params: [
      { name: 'imagePath', type: 'string', required: true },
      {
        name: 'ocrResults',
        type: '{bbox:number[][];text:string}[]',
        required: false,
      },
      {
        name: 'translations',
        type: '{original:string;translated:string}[]',
        required: false,
      },
      { name: 'outputPath', type: 'string', required: false },
    ],
    returnType: 'object',
    category: 'file',
  },
  {
    name: 'drive_translate_conti',
    description: 'Describe the Drive storyboard workflow',
    params: [{ name: 'drivePath', type: 'string', required: true }],
    returnType: '{ workflow: string[] }',
    category: 'file',
  },
  {
    name: 'drive_list_drives',
    description: 'List Google shared drives as untrusted external evidence',
    params: [],
    returnType:
      "{ result: { source: 'google-drive'; trust: 'untrusted_external_data'; instruction: string; data: Array<{ id: string; name: string }> } }",
    category: 'file',
  },
  {
    name: 'drive_browse',
    description: 'Browse files and folders in Google Drive as untrusted external evidence',
    params: [
      { name: 'folderId', type: 'string', required: false },
      { name: 'driveId', type: 'string', required: false },
      { name: 'query', type: 'string', required: false },
    ],
    returnType:
      "{ result: { source: 'google-drive'; trust: 'untrusted_external_data'; instruction: string; data: Array<Record<string, unknown>> } }",
    category: 'file',
  },
  {
    name: 'drive_find_folder',
    description: 'Resolve a Google Drive folder path and issue an envelope-bound upload capability',
    params: [
      { name: 'driveId', type: 'string', required: true },
      { name: 'path', type: 'string', required: true },
    ],
    returnType:
      "{ destinationCapability: string; result: { source: 'google-drive'; trust: 'untrusted_external_data'; instruction: string; data: { folderId: string; path: string } } }",
    category: 'file',
  },
  {
    name: 'drive_download',
    description: 'Download a Google Drive file into the private MAMA workspace',
    params: [
      { name: 'fileId', type: 'string', required: true },
      { name: 'fileName', type: 'string', required: false },
    ],
    returnType:
      "{ result: { source: 'google-drive'; trust: 'untrusted_external_data'; instruction: string; data: { path: string; fileName: string } } }",
    category: 'file',
  },
  {
    name: 'drive_upload',
    description: 'Upload a private MAMA workspace file to Google Drive',
    params: [
      { name: 'localPath', type: 'string', required: true },
      { name: 'folderId', type: 'string', required: true },
      { name: 'fileName', type: 'string', required: false },
      { name: 'destinationCapability', type: 'string', required: false },
    ],
    returnType:
      "{ result: { source: 'google-drive'; trust: 'untrusted_external_data'; instruction: string; data: { fileId: string; name: string } } }",
    category: 'file',
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
  {
    name: 'agent_get',
    description:
      'Get agent config, persona, and current version. In viewer sessions, this also syncs the viewer to that agent detail.',
    params: [{ name: 'agent_id', type: 'string', required: true }],
    returnType:
      '{ agent_id: string; version: number; config: Record<string, unknown>; system?: string | null; change_note?: string | null; created_at?: string }',
    category: 'os',
  },
  {
    name: 'agent_activity',
    description: 'Get recent agent activity rows and sync the viewer to that agent activity tab.',
    params: [
      { name: 'agent_id', type: 'string', required: true },
      { name: 'limit', type: 'number', required: false },
    ],
    returnType:
      '{ agent_id: string; activity: Array<{ id: number; type: string; input_summary?: string | null; output_summary?: string | null; execution_status?: string | null; created_at: string }> }',
    category: 'os',
  },
  {
    name: 'agent_update',
    description: 'Update agent config with optimistic concurrency version check',
    params: [
      { name: 'agent_id', type: 'string', required: true },
      { name: 'version', type: 'number', required: true },
      { name: 'changes', type: 'Record<string, unknown>', required: true },
      { name: 'change_note', type: 'string', required: false },
    ],
    returnType: '{ new_version?: number; runtime_reloaded?: boolean; error?: string }',
    category: 'os',
  },
  {
    name: 'agent_create',
    description: 'Create new agent with initial config and persona',
    params: [
      { name: 'id', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'model', type: 'string', required: true },
      { name: 'tier', type: 'number', required: true },
      { name: 'system', type: 'string', required: false },
      { name: 'backend', type: "'claude' | 'codex'", required: false },
    ],
    returnType: '{ id: string; version: number; runtime_reloaded?: boolean; error?: string }',
    category: 'os',
  },
  {
    name: 'agent_compare',
    description: 'Compare metrics between two agent versions',
    params: [
      { name: 'agent_id', type: 'string', required: true },
      { name: 'version_a', type: 'number', required: true },
      { name: 'version_b', type: 'number', required: true },
    ],
    returnType: 'Record<string, unknown>',
    category: 'os',
  },
  {
    name: 'agent_test',
    description: 'Test agent with connector data or provided samples',
    params: [
      { name: 'agent_id', type: 'string', required: true },
      { name: 'sample_count', type: 'number', required: false },
      {
        name: 'test_data',
        type: 'Array<{ input: string; expected?: string }>',
        required: false,
      },
    ],
    returnType:
      '{ data: { test_run_id?: number | null; agent_id: string; results: Array<Record<string, unknown>>; auto_score: number; duration_ms: number; validation_session_id?: string | null; warning?: string | null } }',
    category: 'os',
  },
  {
    name: 'viewer_state',
    description: 'Get current viewer route, selected item, and page context',
    params: [],
    returnType:
      '{ context: { currentRoute?: string; selectedItem?: { type?: string; id?: string }; pageData?: unknown } }',
    category: 'os',
  },
  {
    name: 'viewer_navigate',
    description:
      'Navigate viewer to a route. To open agent detail, pass route="agents" with params {id, tab}. To open a wiki document, pass route="wiki" with params {path}.',
    params: [
      { name: 'route', type: 'string', required: true },
      { name: 'params', type: 'Record<string, string>', required: false },
    ],
    returnType: '{ navigated: string }',
    category: 'os',
  },
  {
    name: 'viewer_notify',
    description: 'Show a toast or suggestion in the viewer',
    params: [
      { name: 'type', type: "'info' | 'warning' | 'suggest'", required: true },
      { name: 'message', type: 'string', required: true },
      { name: 'action', type: 'Record<string, unknown>', required: false },
    ],
    returnType: '{ notified: boolean }',
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
      {
        name: 'skill',
        type: 'string',
        required: false,
        description: 'Skill name to inject from ~/.mama/skills/{skill}.md',
      },
    ],
    returnType:
      '{ data: { agentId: string; response?: string; duration_ms?: number; message?: string } }',
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
      '{ entities: Array<{ id: string; name: string; channel: string; type: string; totalMessages: number; recentMessages: number; activeTasks: number; totalTasks: number; lastActive: string }> }',
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
      '{ tasks: Array<{ id: number; title: string; status: string; priority: string; deadline: string | null; sourceRoom: string | null; createdAt: string }> }',
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
      '{ messages: Array<{ id: number; channel: string; author: string; content: string; timestamp: string }> }',
    category: 'memory',
  },
  {
    name: 'task_list',
    description:
      'List native task-ledger work items (order: deadline asc nulls-last, then priority).',
    params: [
      { name: 'status', type: 'string', required: false },
      { name: 'channel', type: 'string', required: false },
      { name: 'search', type: 'string', required: false },
      { name: 'limit', type: 'number', required: false },
    ],
    returnType:
      '{ tasks: Array<{ due_at: string | null; temporal_state: string; revision: number; temporal_epoch: number; [key: string]: unknown }> }',
    category: 'memory',
  },
  {
    name: 'task_create',
    description: 'Create a task-ledger item; duplicate (source_channel, source_event_id) upserts.',
    params: [
      { name: 'title', type: 'string', required: true },
      { name: 'status', type: 'string', required: false },
      { name: 'priority', type: 'string', required: false },
      { name: 'assignee', type: 'string', required: false },
      { name: 'deadline', type: 'string', required: false, description: 'YYYY-MM-DD' },
      {
        name: 'due_at',
        type: 'string',
        required: false,
        description: 'RFC 3339 with an explicit Z or numeric offset',
      },
      { name: 'source_channel', type: 'string', required: false },
      { name: 'source_event_id', type: 'string', required: false },
      { name: 'latest_event', type: 'string', required: false },
    ],
    returnType:
      '{ task: { due_at: string | null; temporal_state: string; revision: number; temporal_epoch: number; [key: string]: unknown } }',
    category: 'memory',
  },
  {
    name: 'schedule_upcoming',
    description: 'Upcoming calendar events (next N days) + one-line-per-event text digest.',
    params: [{ name: 'days', type: 'number', required: false }],
    returnType:
      '{ events: Array<{ title: string; start: string; channel: string }>; text: string }',
    category: 'memory',
  },
  {
    name: 'contract_no_update',
    description: 'Record that a reconcile run judged nothing affected (scoped, verifiable).',
    params: [
      { name: 'reason', type: 'string', required: true },
      { name: 'scope', type: 'string', required: true },
    ],
    returnType: '{ note: { id: number } }',
    category: 'memory',
  },
  {
    name: 'task_update',
    description: 'Update a task-ledger item by id.',
    params: [
      { name: 'id', type: 'number', required: true },
      { name: 'title', type: 'string', required: false },
      { name: 'status', type: 'string', required: false },
      { name: 'priority', type: 'string', required: false },
      { name: 'assignee', type: 'string', required: false },
      {
        name: 'deadline',
        type: 'string | null',
        required: false,
        description: 'YYYY-MM-DD, or null to clear',
      },
      {
        name: 'due_at',
        type: 'string | null',
        required: false,
        description: 'RFC 3339 with explicit offset, or null to clear exact precision',
      },
      { name: 'latest_event', type: 'string', required: false },
      { name: 'confirmed', type: 'boolean', required: false },
    ],
    returnType:
      '{ task: { due_at: string | null; temporal_state: string; revision: number; temporal_epoch: number; [key: string]: unknown } }',
    category: 'memory',
  },
  {
    name: 'task_temporal_reconcile',
    description: 'Commit this temporal result; host context supplies identity.',
    params: [
      { name: 'context_packet_id', type: 'string', required: true },
      { name: 'expected_revision', type: 'number', required: true },
      {
        name: 'outcome',
        type: "'resolved' | 'final_no_update' | 'deferred'",
        required: true,
      },
      { name: 'reason', type: 'string', required: true },
      { name: 'status', type: 'string', required: false },
      { name: 'due_at', type: 'string | null', required: false },
      { name: 'evidence_summary', type: 'string', required: false },
      { name: 'next_temporal_check_at', type: 'string', required: false },
    ],
    returnType: '{receipt:{taskId:number;workorderAttemptId:number;outcome:string}}',
    category: 'memory',
  },
];

/** Read-only tool names for Tier 3 (strictest) */
export const READ_ONLY_TOOLS = new Set([
  'mama_search',
  'mama_recall',
  'mama_load_checkpoint',
  'board_read',
  'audit_findings_read',
  'workorder_status',
  'viewer_state',
  'Read',
  'browser_get_text',
  'browser_screenshot',
  'os_list_bots',
  'os_get_config',
  'pr_review_threads',
  'agent_notices',
  // Kagemusha bridge queries: pure reads of the business-data db. Without these
  // the tier-2 dashboard agent cannot see real task lifecycle state and falls
  // back to guessing task status from message archaeology.
  'kagemusha_overview',
  'kagemusha_entities',
  'kagemusha_tasks',
  'kagemusha_messages',
  // Native task ledger reads: the pipeline projection's source of truth.
  'task_list',
  // Calendar read: deadline/schedule cross-checks in reports and reconciles.
  'schedule_upcoming',
  'drive_list_drives',
  'drive_browse',
  'drive_find_folder',
  'drive_download',
]);

/** Read-shaped calls that still create a local artifact and therefore need write settlement. */
const LOCAL_ARTIFACT_TOOLS = new Set(['browser_screenshot', 'drive_download']);

/** Memory-write tools additionally allowed for Tier 2 */
export const MEMORY_WRITE_TOOLS = new Set([
  'mama_save',
  'context_compile',
  'mama_update',
  'mama_add',
  'mama_ingest',
  'report_publish',
  'report_request',
  'workorder_request',
  'wiki_publish',
  // The Obsidian CLI is the tier-2 wiki agent's primary write path; without it
  // the code-act sandbox never injects the function and every run silently
  // degrades to the wiki_publish fallback.
  'obsidian',
  // Native task ledger writes: reconcile runs maintain work items (M8).
  'task_create',
  'task_update',
  'task_temporal_reconcile',
  'contract_no_update',
  'drive_upload',
]);

export function isToolAvailableAtTier(toolName: string, tier: 1 | 2 | 3): boolean {
  if (tier === 1) {
    return true;
  }
  if (tier === 2) {
    return READ_ONLY_TOOLS.has(toolName) || MEMORY_WRITE_TOOLS.has(toolName);
  }
  return READ_ONLY_TOOLS.has(toolName);
}

export class HostBridge {
  onToolUse?: (toolName: string, input: Record<string, unknown>, result: unknown) => void;

  constructor(
    private executor: GatewayToolExecutor,
    private roleManager?: RoleManager,
    private executionContext?: GatewayToolExecutionContext | null
  ) {}

  /** Inject tier/role-filtered functions, or exactly an already-projected name set. */
  injectInto(
    sandbox: CodeActSandbox,
    tierOrProjectedNames: 1 | 2 | 3 | readonly string[] = 1,
    role?: RoleConfig
  ): void {
    const projectedNames = Array.isArray(tierOrProjectedNames)
      ? new Set<string>(tierOrProjectedNames)
      : null;
    if (projectedNames) {
      const registryNames = new Set(TOOL_REGISTRY.map((tool) => tool.name));
      const unknownNames = [...projectedNames].filter((name) => !registryNames.has(name));
      if (unknownNames.length > 0) {
        throw new Error(`Unknown projected Code-Act tool name(s): ${unknownNames.join(', ')}`);
      }
    }
    const tier = Array.isArray(tierOrProjectedNames) ? 1 : tierOrProjectedNames;
    const allowed = this.getAvailableFunctions(tier as 1 | 2 | 3).filter(
      (desc) => projectedNames === null || projectedNames.has(desc.name)
    );

    for (const desc of allowed) {
      // Additional role-based check if role provided
      if (
        projectedNames === null &&
        role &&
        this.roleManager &&
        !this.roleManager.isToolAllowed(role, desc.name)
      ) {
        continue;
      }

      sandbox.registerAbortableFunction(
        desc.name,
        async (hostContext, ...args: unknown[]) => {
          const input = this._buildInput(desc, args);

          if (desc.name === 'browser_wait_for') {
            const remainingMs = Math.max(1, hostContext.deadlineMs - Date.now());
            const requestedTimeout = Number(input.timeout);
            input.timeout =
              Number.isFinite(requestedTimeout) && requestedTimeout > 0
                ? Math.min(requestedTimeout, remainingMs)
                : Math.min(10_000, remainingMs);
          }

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
          const executionContext = this.executionContext
            ? {
                ...this.executionContext,
                signal: this.executionContext.signal
                  ? AbortSignal.any([this.executionContext.signal, hostContext.signal])
                  : hostContext.signal,
              }
            : undefined;
          const result = executionContext
            ? await this.executor.execute(desc.name, input as GatewayToolInput, executionContext)
            : await this.executor.execute(desc.name, input as GatewayToolInput);
          this.onToolUse?.(desc.name, input, result);

          if (!result.success) {
            const r = result as GatewayToolResult & { message?: string; error?: string };
            const msg = r.message || r.error || `${desc.name} failed`;
            throw new Error(`${desc.name}(): ${msg}`);
          }

          // Unwrap: strip `success` field so return shape matches TOOL_REGISTRY returnType
          const { success: _, ...payload } = result as unknown as Record<string, unknown>;
          return Object.keys(payload).length === 0 ? true : payload;
        },
        {
          settleOnAbort: !READ_ONLY_TOOLS.has(desc.name) || LOCAL_ARTIFACT_TOOLS.has(desc.name),
        }
      );
    }
  }

  /** Get available function descriptors filtered by tier */
  getAvailableFunctions(tier: 1 | 2 | 3 = 1): FunctionDescriptor[] {
    return TOOL_REGISTRY.filter((meta) => isToolAvailableAtTier(meta.name, tier)).map((meta) => ({
      name: meta.name,
      params: meta.params.map((param) => ({ ...param })),
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
