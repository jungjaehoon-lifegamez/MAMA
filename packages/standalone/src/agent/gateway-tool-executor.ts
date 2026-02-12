/**
 * MAMA Tool Executor for MAMA Standalone
 *
 * Executes MAMA gateway tools (mama_search, mama_save, mama_update, mama_load_checkpoint, Read, discord_send).
 * NOT MCP - uses Claude Messages API tool definitions.
 * Supports both direct API integration and mock API for testing.
 *
 * Role-Based Permission Control:
 * - Each tool execution is checked against the current AgentContext's role
 * - Blocked tools return permission errors instead of executing
 * - Path-based tools (Read, Write) also check path permissions
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { execSync, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import type {
  GatewayToolName,
  GatewayToolInput,
  GatewayToolResult,
  SaveInput,
  SaveDecisionInput,
  SaveCheckpointInput,
  SearchInput,
  UpdateInput,
  LoadCheckpointInput,
  SaveResult,
  SearchResult,
  UpdateResult,
  LoadCheckpointResult,
  GatewayToolExecutorOptions,
  MAMAApiInterface,
  BrowserNavigateInput,
  BrowserScreenshotInput,
  BrowserClickInput,
  BrowserTypeInput,
  BrowserScrollInput,
  BrowserWaitForInput,
  BrowserEvaluateInput,
  BrowserPdfInput,
  AgentContext,
  AddBotInput,
  SetPermissionsInput,
  GetConfigInput,
  SetModelInput,
  ListBotsInput,
  RestartBotInput,
  StopBotInput,
  BotStatus,
  BotPlatform,
} from './types.js';
import { AgentError } from './types.js';
import { getBrowserTool, type BrowserTool } from '../tools/browser-tool.js';
import { RoleManager, getRoleManager } from './role-manager.js';
import { loadConfig, saveConfig } from '../cli/config/config-manager.js';
import type { RoleConfig } from '../cli/config/types.js';
import { DEFAULT_ROLES } from '../cli/config/types.js';

/**
 * Discord gateway interface for sending messages
 */
export interface DiscordGatewayInterface {
  sendMessage(channelId: string, message: string): Promise<void>;
  sendFile(channelId: string, filePath: string, caption?: string): Promise<void>;
  sendImage(channelId: string, imagePath: string, caption?: string): Promise<void>;
}

/**
 * Valid MAMA gateway tools
 * These tools are executed by GatewayToolExecutor
 * Includes MAMA tools (mama_search, mama_save, mama_update, mama_load_checkpoint)
 * and utility tools (Read, Write, Bash, discord_send)
 */
const VALID_TOOLS: GatewayToolName[] = [
  'mama_search',
  'mama_save',
  'mama_update',
  'mama_load_checkpoint',
  'Read',
  'Write',
  'Bash',
  'discord_send',
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_get_text',
  'browser_scroll',
  'browser_wait_for',
  'browser_evaluate',
  'browser_pdf',
  'browser_close',
  // OS Management tools (viewer-only)
  'os_add_bot',
  'os_set_permissions',
  'os_get_config',
  'os_set_model',
  // OS Monitoring tools (viewer-only)
  'os_list_bots',
  'os_restart_bot',
  'os_stop_bot',
  // PR Review tools
  'pr_review_threads',
];

/**
 * Sensitive patterns that should be masked in config output
 */
const SENSITIVE_KEYS = ['token', 'bot_token', 'app_token', 'api_token', 'api_key', 'secret'];
const execFileAsync = promisify(execFile);

interface GHReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      path: string;
      line: number | null;
      body: string;
      author: { login: string } | null;
    }>;
  };
}

interface GHGraphQLResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: GHReviewThread[];
        };
      };
    };
  };
}

export class GatewayToolExecutor {
  private mamaApi: MAMAApiInterface | null = null;
  private readonly mamaDbPath?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionStore?: any;
  private discordGateway: DiscordGatewayInterface | null = null;
  private browserTool: BrowserTool;
  private roleManager: RoleManager;
  private currentContext: AgentContext | null = null;

  constructor(options: GatewayToolExecutorOptions = {}) {
    this.mamaDbPath = options.mamaDbPath;
    this.sessionStore = options.sessionStore;
    this.browserTool = getBrowserTool({
      screenshotDir: join(process.env.HOME || '', '.mama', 'workspace', 'media', 'outbound'),
    });
    // Pass rolesConfig from config.yaml to RoleManager
    this.roleManager = getRoleManager(
      options.rolesConfig ? { rolesConfig: options.rolesConfig } : undefined
    );

    if (options.mamaApi) {
      this.mamaApi = options.mamaApi;
    }
  }

  /**
   * Set the current agent context for permission checks
   * @param context - AgentContext with role and permissions
   */
  setAgentContext(context: AgentContext | null): void {
    this.currentContext = context;
  }

  /**
   * Get the current agent context
   */
  getAgentContext(): AgentContext | null {
    return this.currentContext;
  }

  setDiscordGateway(gateway: DiscordGatewayInterface): void {
    this.discordGateway = gateway;
  }

  /**
   * Initialize the MAMA API by importing from mcp-server package
   * Called lazily on first tool execution if not provided in constructor
   */
  private async initializeMAMAApi(): Promise<MAMAApiInterface> {
    if (this.mamaApi) {
      return this.mamaApi;
    }

    try {
      // Set database path if provided
      if (this.mamaDbPath) {
        process.env.MAMA_DB_PATH = this.mamaDbPath;
      }

      // Dynamic import of MAMA mama-core modules
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mama = require('@jungjaehoon/mama-core/mama-api');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initDB } = require('@jungjaehoon/mama-core/db-manager');

      // Initialize the database before using mama-api functions
      await initDB();

      this.mamaApi = {
        save: mama.save.bind(mama),
        saveCheckpoint: mama.saveCheckpoint.bind(mama),
        listDecisions: mama.list.bind(mama), // Note: mama exports listDecisions as 'list'
        suggest: mama.suggest.bind(mama),
        updateOutcome: mama.updateOutcome.bind(mama),
        loadCheckpoint: mama.loadCheckpoint.bind(mama),
      };

      return this.mamaApi;
    } catch (error) {
      throw new AgentError(
        `Failed to initialize MAMA API: ${error instanceof Error ? error.message : String(error)}`,
        'TOOL_ERROR',
        error instanceof Error ? error : undefined,
        false
      );
    }
  }

  /**
   * Check if a tool is allowed for the current context
   * @param toolName - Name of the tool to check
   * @returns Object with allowed status and optional error message
   */
  private checkToolPermission(toolName: string): { allowed: boolean; error?: string } {
    // If no context set, allow all tools (backward compatibility)
    if (!this.currentContext) {
      return { allowed: true };
    }

    const role = this.currentContext.role;

    if (!this.roleManager.isToolAllowed(role, toolName)) {
      return {
        allowed: false,
        error: `Permission denied: ${toolName} is not allowed for role "${this.currentContext.roleName}"`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a path is allowed for the current context
   * @param path - File path to check
   * @returns Object with allowed status and optional error message
   */
  private checkPathPermission(path: string): { allowed: boolean; error?: string } {
    // If no context set, allow all paths (backward compatibility)
    if (!this.currentContext) {
      return { allowed: true };
    }

    const role = this.currentContext.role;

    if (!this.roleManager.isPathAllowed(role, path)) {
      return {
        allowed: false,
        error: `Permission denied: Access to "${path}" is not allowed for role "${this.currentContext.roleName}"`,
      };
    }

    return { allowed: true };
  }

  /**
   * Execute a gateway tool with permission checks
   *
   * @param toolName - Name of the tool to execute
   * @param input - Tool input parameters
   * @returns Tool execution result
   * @throws AgentError on tool errors or permission denial
   */
  async execute(toolName: string, input: GatewayToolInput): Promise<GatewayToolResult> {
    if (!VALID_TOOLS.includes(toolName as GatewayToolName)) {
      throw new AgentError(
        `Unknown tool: ${toolName}. Valid tools: ${VALID_TOOLS.join(', ')}`,
        'UNKNOWN_TOOL',
        undefined,
        false
      );
    }

    // Check tool permission
    const toolPermission = this.checkToolPermission(toolName);
    if (!toolPermission.allowed) {
      return {
        success: false,
        error: toolPermission.error,
      } as GatewayToolResult;
    }

    try {
      // Handle non-MAMA tools first
      switch (toolName) {
        case 'Read':
          return await this.executeRead(input as { path: string });
        case 'Write':
          return await this.executeWrite(input as { path: string; content: string });
        case 'Bash':
          return await this.executeBash(input as { command: string; workdir?: string });
        case 'discord_send':
          return await this.executeDiscordSend(
            input as { channel_id: string; message?: string; image_path?: string }
          );
        // Browser tools
        case 'browser_navigate':
          return await this.executeBrowserNavigate(input as BrowserNavigateInput);
        case 'browser_screenshot':
          return await this.executeBrowserScreenshot(input as BrowserScreenshotInput);
        case 'browser_click':
          return await this.executeBrowserClick(input as BrowserClickInput);
        case 'browser_type':
          return await this.executeBrowserType(input as BrowserTypeInput);
        case 'browser_get_text':
          return await this.executeBrowserGetText();
        case 'browser_scroll':
          return await this.executeBrowserScroll(input as BrowserScrollInput);
        case 'browser_wait_for':
          return await this.executeBrowserWaitFor(input as BrowserWaitForInput);
        case 'browser_evaluate':
          return await this.executeBrowserEvaluate(input as BrowserEvaluateInput);
        case 'browser_pdf':
          return await this.executeBrowserPdf(input as BrowserPdfInput);
        case 'browser_close':
          return await this.executeBrowserClose();
        // OS Management tools (viewer-only)
        case 'os_add_bot':
          return await this.executeAddBot(input as AddBotInput);
        case 'os_set_permissions':
          return await this.executeSetPermissions(input as SetPermissionsInput);
        case 'os_get_config':
          return await this.executeGetConfig(input as GetConfigInput);
        case 'os_set_model':
          return await this.executeSetModel(input as SetModelInput);
        // OS Monitoring tools
        case 'os_list_bots':
          return await this.executeListBots(input as ListBotsInput);
        case 'os_restart_bot':
          return await this.executeRestartBot(input as RestartBotInput);
        case 'os_stop_bot':
          return await this.executeStopBot(input as StopBotInput);
        // PR Review tools
        case 'pr_review_threads':
          return await this.executePrReviewThreads(
            input as { pr_url?: string; owner?: string; repo?: string; pr_number?: number }
          );
      }

      // MAMA tools require API
      const api = await this.initializeMAMAApi();

      switch (toolName as GatewayToolName) {
        case 'mama_save':
          return await this.executeSave(api, input as SaveInput);
        case 'mama_search':
          return await this.executeSearch(api, input as SearchInput);
        case 'mama_update':
          return await this.executeUpdate(api, input as UpdateInput);
        case 'mama_load_checkpoint':
          return await this.executeLoadCheckpoint(api, input as LoadCheckpointInput);
        default:
          throw new AgentError(`Unknown tool: ${toolName}`, 'UNKNOWN_TOOL', undefined, false);
      }
    } catch (error) {
      if (error instanceof AgentError) {
        throw error;
      }

      throw new AgentError(
        `Tool execution failed (${toolName}): ${error instanceof Error ? error.message : String(error)}`,
        'TOOL_ERROR',
        error instanceof Error ? error : undefined,
        false
      );
    }
  }

  /**
   * Execute save tool (decision or checkpoint)
   */
  private async executeSave(api: MAMAApiInterface, input: SaveInput): Promise<SaveResult> {
    if (input.type === 'decision') {
      const decisionInput = input as SaveDecisionInput;

      if (!decisionInput.topic || !decisionInput.decision || !decisionInput.reasoning) {
        return {
          success: false,
          message: 'Decision requires: topic, decision, reasoning',
        };
      }

      // Map MCP 'decision' type to mama-api 'user_decision' type
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await api.save({
        topic: decisionInput.topic,
        decision: decisionInput.decision,
        reasoning: decisionInput.reasoning,
        confidence: decisionInput.confidence ?? 0.5,
        type: 'user_decision', // mama-api expects 'user_decision' not 'decision'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    if (input.type === 'checkpoint') {
      const checkpointInput = input as SaveCheckpointInput;

      if (!checkpointInput.summary) {
        return {
          success: false,
          message: 'Checkpoint requires: summary',
        };
      }

      const recentConversation = this.sessionStore?.getRecentMessages() || [];
      return await api.saveCheckpoint(
        checkpointInput.summary,
        checkpointInput.open_files ?? [],
        checkpointInput.next_steps ?? '',
        recentConversation
      );
    }

    return {
      success: false,
      message: `Invalid save type: ${(input as { type?: string }).type}. Must be 'decision' or 'checkpoint'`,
    };
  }

  /**
   * Execute search tool
   */
  private async executeSearch(api: MAMAApiInterface, input: SearchInput): Promise<SearchResult> {
    const { query, type, limit = 10 } = input;

    // If no query provided, return recent items using listDecisions
    if (!query) {
      const decisions = await api.listDecisions({ limit });
      const results = Array.isArray(decisions) ? decisions : [];

      // Filter by type if specified
      const filteredResults =
        type && type !== 'all'
          ? results.filter((item) => {
              const typedItem = item as { type?: string };
              return typedItem.type === type;
            })
          : results;

      return {
        success: true,
        results: filteredResults as SearchResult['results'],
        count: filteredResults.length,
      };
    }

    // Semantic search using suggest
    const result = await api.suggest(query, { limit });

    // Filter by type if specified
    let filteredResults = result.results ?? [];

    if (type && type !== 'all') {
      filteredResults = filteredResults.filter((item) => item.type === type);
    }

    return {
      success: true,
      results: filteredResults,
      count: filteredResults.length,
    };
  }

  /**
   * Execute update tool
   */
  private async executeUpdate(api: MAMAApiInterface, input: UpdateInput): Promise<UpdateResult> {
    const { id, outcome, reason } = input;

    if (!id) {
      return {
        success: false,
        message: 'Update requires: id',
      };
    }

    if (!outcome) {
      return {
        success: false,
        message: 'Update requires: outcome',
      };
    }

    // Normalize outcome to uppercase
    const normalizedOutcome = outcome.toUpperCase();
    const validOutcomes = ['SUCCESS', 'FAILED', 'PARTIAL'];

    if (!validOutcomes.includes(normalizedOutcome)) {
      return {
        success: false,
        message: `Invalid outcome: ${outcome}. Must be one of: success, failed, partial`,
      };
    }

    return await api.updateOutcome(id, {
      outcome: normalizedOutcome,
      failure_reason: reason,
    });
  }

  /**
   * Execute load_checkpoint tool
   */
  private async executeLoadCheckpoint(
    api: MAMAApiInterface,
    _input: LoadCheckpointInput
  ): Promise<LoadCheckpointResult> {
    const checkpoint = await api.loadCheckpoint();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (checkpoint && (checkpoint as any).recentConversation && this.sessionStore) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.sessionStore.restoreMessages((checkpoint as any).recentConversation);
    }
    return checkpoint;
  }

  /**
   * Execute read tool - Read file from filesystem
   * Checks path permissions based on current AgentContext
   */
  private async executeRead(input: {
    path?: string;
    file_path?: string;
    file?: string;
  }): Promise<{ success: boolean; content?: string; error?: string }> {
    // Accept common parameter name variations
    const filePath = input.path || input.file_path || input.file;

    if (!filePath) {
      return {
        success: false,
        error: `Path is required. Use: {"name": "Read", "input": {"path": "/file/path"}}`,
      };
    }

    // Expand ~ to home directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const expandedPath = filePath.startsWith('~/') ? join(homeDir, filePath.slice(2)) : filePath;

    // Check path permission based on role
    const pathPermission = this.checkPathPermission(expandedPath);
    if (!pathPermission.allowed) {
      return { success: false, error: pathPermission.error };
    }

    // Fallback security for contexts without path restrictions:
    // Only allow reading from ~/.mama/ directory
    if (!this.currentContext?.role.allowedPaths?.length) {
      const mamaDir = join(homeDir, '.mama');
      if (!expandedPath.startsWith(mamaDir)) {
        return { success: false, error: `Access denied: Can only read files from ${mamaDir}` };
      }
    }

    if (!existsSync(expandedPath)) {
      return { success: false, error: `File not found: ${expandedPath}` };
    }

    try {
      // Guard against reading huge files (e.g. daemon.log) that would blow up the prompt
      const MAX_READ_BYTES = 200_000; // 200KB
      const fileSize = statSync(expandedPath).size;
      if (fileSize > MAX_READ_BYTES) {
        const truncated = readFileSync(expandedPath, { encoding: 'utf-8', flag: 'r' }).slice(
          0,
          MAX_READ_BYTES
        );
        return {
          success: true,
          content:
            truncated +
            `\n\n[Truncated: file is ${(fileSize / 1024).toFixed(0)}KB, showing first ${MAX_READ_BYTES / 1000}KB]`,
        };
      }
      const content = readFileSync(expandedPath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: `Failed to read file: ${err}` };
    }
  }

  /**
   * Execute Write tool - Write content to a file
   * Checks path permissions based on current AgentContext
   */
  private async executeWrite(input: {
    path: string;
    content: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { path, content } = input;

    if (!path) {
      return { success: false, error: 'path is required' };
    }

    // Expand ~ to home directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const expandedPath = path.startsWith('~/') ? join(homeDir, path.slice(2)) : path;

    // Check path permission based on role
    const pathPermission = this.checkPathPermission(expandedPath);
    if (!pathPermission.allowed) {
      return { success: false, error: pathPermission.error };
    }

    // Fallback security for contexts without path restrictions:
    // Only allow writing to ~/.mama/ directory
    if (!this.currentContext?.role.allowedPaths?.length) {
      const mamaDir = join(homeDir, '.mama');
      if (!expandedPath.startsWith(mamaDir)) {
        return { success: false, error: `Access denied: Can only write files to ${mamaDir}` };
      }
    }

    try {
      const dir = dirname(expandedPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(expandedPath, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to write file: ${err}` };
    }
  }

  /**
   * Execute Bash tool - Execute bash command
   */
  private async executeBash(input: {
    command: string;
    workdir?: string;
  }): Promise<{ success: boolean; output?: string; error?: string }> {
    const { command, workdir } = input;

    if (!command) {
      return { success: false, error: 'command is required' };
    }

    // Block destructive commands (stop/kill) - these would permanently kill the agent
    const destructive = /(systemctl\s+--user\s+stop\s+mama-os|kill\s.*mama|pkill\s.*mama)/i;
    if (destructive.test(command)) {
      return {
        success: false,
        error:
          'Cannot stop mama-os from within the agent. Ask the user to run this command from their terminal.',
      };
    }

    // Block sandbox escape via cd command using path-based validation
    // Check ALL cd occurrences in chained commands (cd foo && cd bar)
    // Also detect bare cd commands (cd, cd;, cd &&) which go to home directory
    const sandboxRoot = join(homedir(), '.mama');
    const cwd = workdir || process.env.MAMA_WORKSPACE || join(sandboxRoot, 'workspace');

    // Pattern to match cd with optional target (handles: cd path, cd "path", cd 'path', bare cd)
    const cdPattern =
      /(?:^|&&|\|\||;)\s*cd(?:\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+)))?(?=\s*(?:$|&&|\|\||;))/g;
    const cdMatches = [...command.matchAll(cdPattern)];

    for (const cdMatch of cdMatches) {
      const cdTarget = cdMatch[1] || cdMatch[2] || cdMatch[3];

      // Expand ~ to home directory for path resolution
      let resolvedTarget: string;
      if (!cdTarget || cdTarget === '~' || cdTarget === '~/') {
        // Bare cd or cd ~ goes to home directory (outside sandbox)
        resolvedTarget = homedir();
      } else if (cdTarget.startsWith('~/')) {
        resolvedTarget = join(homedir(), cdTarget.slice(2));
      } else if (cdTarget.startsWith('/')) {
        resolvedTarget = cdTarget;
      } else {
        resolvedTarget = join(cwd, cdTarget);
      }

      // Resolve any .. or . in the path
      const normalizedTarget = resolve(resolvedTarget);

      // Check if target is within sandbox
      if (!normalizedTarget.startsWith(sandboxRoot)) {
        return {
          success: false,
          error:
            'Cannot change directory outside ~/.mama/ sandbox. Use Read/Write tools for files outside sandbox.',
        };
      }
    }

    // Handle restart: deferred restart (agent survives to respond, service restarts after 3s)
    const restartPattern = /systemctl\s+--user\s+restart\s+mama-os/i;
    if (restartPattern.test(command)) {
      const child = spawn('bash', ['-c', 'sleep 3 && systemctl --user restart mama-os'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return {
        success: true,
        output: 'mama-os restart will execute in 3 seconds. Current session will be terminated.',
      };
    }

    try {
      const output = execSync(command, {
        cwd: workdir || process.env.MAMA_WORKSPACE || join(homedir(), '.mama', 'workspace'),
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });
      return { success: true, output };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      return {
        success: false,
        error: `Command failed: ${err.message}`,
        output: err.stdout || err.stderr,
      };
    }
  }

  /**
   * Execute discord_send tool - Send message/file to Discord channel
   * Supports images, documents, and any file type
   */
  private async executeDiscordSend(input: {
    channel_id: string;
    message?: string;
    image_path?: string;
    file_path?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { channel_id, message, image_path, file_path } = input;

    if (!channel_id) {
      return { success: false, error: 'channel_id is required' };
    }

    if (!this.discordGateway) {
      return { success: false, error: 'Discord gateway not configured' };
    }

    try {
      // file_path takes precedence, fallback to image_path for backwards compatibility
      const filePath = file_path || image_path;

      if (filePath) {
        await this.discordGateway.sendFile(channel_id, filePath, message);
      } else if (message) {
        await this.discordGateway.sendMessage(channel_id, message);
      } else {
        return { success: false, error: 'Either message, file_path, or image_path is required' };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to send to Discord: ${err}` };
    }
  }

  // ============================================================================
  // Browser Tool Execution
  // ============================================================================

  /**
   * Navigate to a URL
   */
  private async executeBrowserNavigate(
    input: BrowserNavigateInput
  ): Promise<{ success: boolean; title?: string; url?: string; error?: string }> {
    try {
      const result = await this.browserTool.navigate(input.url);
      return { success: true, title: result.title, url: result.url };
    } catch (err) {
      return { success: false, error: `Navigation failed: ${err}` };
    }
  }

  /**
   * Take a screenshot
   */
  private async executeBrowserScreenshot(
    input: BrowserScreenshotInput
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const result = input.full_page
        ? await this.browserTool.screenshotFullPage(input.filename)
        : await this.browserTool.screenshot(input.filename);
      return { success: true, path: result.path };
    } catch (err) {
      return { success: false, error: `Screenshot failed: ${err}` };
    }
  }

  /**
   * Click an element
   */
  private async executeBrowserClick(
    input: BrowserClickInput
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.click(input.selector);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Click failed: ${err}` };
    }
  }

  /**
   * Type text into an element
   */
  private async executeBrowserType(
    input: BrowserTypeInput
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.type(input.selector, input.text);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Type failed: ${err}` };
    }
  }

  /**
   * Get page text content
   */
  private async executeBrowserGetText(): Promise<{
    success: boolean;
    text?: string;
    error?: string;
  }> {
    try {
      const result = await this.browserTool.getText();
      return { success: true, text: result.text };
    } catch (err) {
      return { success: false, error: `Get text failed: ${err}` };
    }
  }

  /**
   * Scroll the page
   */
  private async executeBrowserScroll(
    input: BrowserScrollInput
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.scroll(input.direction, input.amount);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Scroll failed: ${err}` };
    }
  }

  /**
   * Wait for element
   */
  private async executeBrowserWaitFor(
    input: BrowserWaitForInput
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.waitFor(input.selector, input.timeout);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Wait failed: ${err}` };
    }
  }

  /**
   * Evaluate JavaScript in page
   */
  private async executeBrowserEvaluate(
    input: BrowserEvaluateInput
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    try {
      const result = await this.browserTool.evaluate(input.script);
      return { success: true, result: result.result };
    } catch (err) {
      return { success: false, error: `Evaluate failed: ${err}` };
    }
  }

  /**
   * Generate PDF of page
   */
  private async executeBrowserPdf(
    input: BrowserPdfInput
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const result = await this.browserTool.pdf(input.filename);
      return { success: true, path: result.path };
    } catch (err) {
      return { success: false, error: `PDF failed: ${err}` };
    }
  }

  /**
   * Close the browser
   */
  private async executeBrowserClose(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.browserTool.close();
      return { success: true };
    } catch (err) {
      return { success: false, error: `Close failed: ${err}` };
    }
  }

  // ============================================================================
  // OS Management Tools (viewer-only)
  // ============================================================================

  /**
   * Check if current context is from viewer (OS agent)
   * Returns error message if not allowed
   */
  private checkViewerOnly(): string | null {
    if (!this.currentContext) {
      // No context = backward compatibility, allow
      return null;
    }

    if (this.currentContext.source !== 'viewer') {
      return `Permission denied: This operation is only available from MAMA OS Viewer. Current source: ${this.currentContext.source}`;
    }

    if (!this.currentContext.role.systemControl) {
      return `Permission denied: Role "${this.currentContext.roleName}" does not have system control permissions`;
    }

    return null;
  }

  /**
   * Execute os_add_bot tool - Add a new bot to config
   * Viewer-only: requires systemControl permission
   */
  private async executeAddBot(
    input: AddBotInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const { platform, token, bot_token, app_token, default_channel_id, allowed_chats, room_ids } =
      input;

    if (!platform) {
      return { success: false, error: 'Platform is required (discord, telegram, slack, chatwork)' };
    }

    try {
      const config = await loadConfig();

      switch (platform) {
        case 'discord':
          if (!token) {
            return { success: false, error: 'Discord bot token is required' };
          }
          config.discord = {
            enabled: true,
            token,
            default_channel_id,
          };
          break;

        case 'telegram':
          if (!token) {
            return { success: false, error: 'Telegram bot token is required' };
          }
          config.telegram = {
            enabled: true,
            token,
            allowed_chats,
          };
          break;

        case 'slack':
          if (!bot_token || !app_token) {
            return { success: false, error: 'Slack requires both bot_token and app_token' };
          }
          config.slack = {
            enabled: true,
            bot_token,
            app_token,
          };
          break;

        case 'chatwork':
          if (!token) {
            return { success: false, error: 'Chatwork API token is required' };
          }
          config.chatwork = {
            enabled: true,
            api_token: token,
            room_ids,
          };
          break;

        default:
          return { success: false, error: `Unknown platform: ${platform}` };
      }

      await saveConfig(config);

      return {
        success: true,
        message: `${platform} bot added successfully. Restart MAMA to apply changes.`,
      };
    } catch (err) {
      return { success: false, error: `Failed to add bot: ${err}` };
    }
  }

  /**
   * Execute os_set_permissions tool - Modify role permissions
   * Viewer-only: requires systemControl permission
   */
  private async executeSetPermissions(
    input: SetPermissionsInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const {
      role,
      allowedTools,
      blockedTools,
      allowedPaths,
      systemControl,
      sensitiveAccess,
      mapSource,
    } = input;

    if (!role) {
      return { success: false, error: 'Role name is required' };
    }

    try {
      const config = await loadConfig();

      // Initialize roles if not present
      if (!config.roles) {
        config.roles = { ...DEFAULT_ROLES };
      }

      // Get or create role definition
      const existingRole = config.roles.definitions[role] || {
        allowedTools: ['mama_*', 'Read'],
      };

      // Update role properties
      const updatedRole: RoleConfig = {
        allowedTools: allowedTools ?? existingRole.allowedTools,
        blockedTools: blockedTools ?? existingRole.blockedTools,
        allowedPaths: allowedPaths ?? existingRole.allowedPaths,
        systemControl: systemControl ?? existingRole.systemControl,
        sensitiveAccess: sensitiveAccess ?? existingRole.sensitiveAccess,
      };

      // Clean up undefined values
      if (!updatedRole.blockedTools?.length) delete updatedRole.blockedTools;
      if (!updatedRole.allowedPaths?.length) delete updatedRole.allowedPaths;
      if (updatedRole.systemControl === undefined) delete updatedRole.systemControl;
      if (updatedRole.sensitiveAccess === undefined) delete updatedRole.sensitiveAccess;

      config.roles.definitions[role] = updatedRole;

      // Map source to role if specified
      if (mapSource) {
        config.roles.sourceMapping[mapSource] = role;
      }

      await saveConfig(config);

      // Update RoleManager with new config
      this.roleManager.updateRolesConfig(config.roles);

      return {
        success: true,
        message: `Role "${role}" updated successfully.${mapSource ? ` Source "${mapSource}" now maps to this role.` : ''}`,
      };
    } catch (err) {
      return { success: false, error: `Failed to set permissions: ${err}` };
    }
  }

  /**
   * Execute os_get_config tool - Get current configuration
   * Masks sensitive data for non-viewer sources
   */
  private async executeGetConfig(
    input: GetConfigInput
  ): Promise<{ success: boolean; config?: Record<string, unknown>; error?: string }> {
    const { section, includeSensitive } = input;

    try {
      const config = await loadConfig();

      // Determine if we should show sensitive data
      const showSensitive =
        includeSensitive &&
        this.currentContext?.source === 'viewer' &&
        this.currentContext?.role.sensitiveAccess;

      // Mask sensitive data
      const maskedConfig = this.maskSensitiveData(
        config as unknown as Record<string, unknown>,
        showSensitive
      );

      // Return specific section or full config
      if (section) {
        const sectionData = maskedConfig[section];
        if (sectionData === undefined) {
          return { success: false, error: `Unknown section: ${section}` };
        }
        return { success: true, config: { [section]: sectionData } };
      }

      return { success: true, config: maskedConfig };
    } catch (err) {
      return { success: false, error: `Failed to get config: ${err}` };
    }
  }

  /**
   * Recursively mask sensitive data in config object
   */
  private maskSensitiveData(
    obj: Record<string, unknown>,
    showSensitive: boolean = false
  ): Record<string, unknown> {
    if (showSensitive) {
      return obj;
    }

    const masked: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        masked[key] = value;
        continue;
      }

      // Check if key is sensitive
      const isSensitive = SENSITIVE_KEYS.some((pattern) =>
        key.toLowerCase().includes(pattern.toLowerCase())
      );

      if (isSensitive && typeof value === 'string' && value.length > 0) {
        // Fully mask sensitive values - don't expose any characters
        // Show only length hint for debugging without revealing content
        masked[key] = `***[${value.length} chars]***`;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        masked[key] = this.maskSensitiveData(value as Record<string, unknown>, showSensitive);
      } else {
        masked[key] = value;
      }
    }

    return masked;
  }

  /**
   * Execute os_set_model tool - Set model configuration for a role or globally
   * Viewer-only: requires systemControl permission
   *
   * Usage:
   * - Set role-specific model: { role: 'chat_bot', model: 'claude-3-haiku-20240307' }
   * - Set global model: { model: 'claude-sonnet-4-20250514' }
   */
  private async executeSetModel(
    input: SetModelInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const { role, model, maxTurns, timeout } = input;

    if (!model) {
      return { success: false, error: 'Model name is required' };
    }

    // Validate model name format - Claude/Anthropic models only
    // Valid formats per Anthropic API docs:
    // - Pinned snapshots: claude-sonnet-4-20250514, claude-3-5-sonnet-20241022
    // - Rolling aliases: claude-3-7-sonnet-latest, claude-opus-4-latest
    // - Family aliases: claude-opus-4-5, claude-sonnet-4-0
    const claudeModelPattern =
      /^claude-(?:opus|sonnet|haiku|3|3-5|3-7)-?[a-z0-9-]*(?:-\d{8}|-latest)?$/i;
    const isValidModel = claudeModelPattern.test(model);

    if (!isValidModel) {
      return {
        success: false,
        error: `Invalid model name format: ${model}. Expected Claude model format (e.g., claude-sonnet-4-20250514, claude-opus-4-latest)`,
      };
    }

    if (maxTurns !== undefined && (maxTurns < 1 || maxTurns > 100)) {
      return { success: false, error: 'maxTurns must be between 1 and 100' };
    }

    if (timeout !== undefined && (timeout < 10000 || timeout > 600000)) {
      return { success: false, error: 'timeout must be between 10000ms and 600000ms (10s-10min)' };
    }

    try {
      const config = await loadConfig();

      // If role is specified, update that role's model
      if (role) {
        // Initialize roles if not present
        if (!config.roles) {
          config.roles = { ...DEFAULT_ROLES };
        }

        // Check if role exists
        if (!config.roles.definitions[role]) {
          return {
            success: false,
            error: `Role "${role}" not found. Available roles: ${Object.keys(config.roles.definitions).join(', ')}`,
          };
        }

        // Update role-specific settings
        config.roles.definitions[role].model = model;
        if (maxTurns !== undefined) {
          config.roles.definitions[role].maxTurns = maxTurns;
        }

        await saveConfig(config);

        // Update RoleManager with new config
        this.roleManager.updateRolesConfig(config.roles);

        const changes = [`model: ${model}`];
        if (maxTurns !== undefined) changes.push(`maxTurns: ${maxTurns}`);

        return {
          success: true,
          message: `Role "${role}" updated: ${changes.join(', ')}. New conversations for this role will use these settings.`,
        };
      }

      // No role specified - update global agent config
      if (!config.agent) {
        config.agent = {
          model: 'claude-sonnet-4-20250514',
          max_turns: 10,
          timeout: 300000,
        };
      }

      config.agent.model = model;
      if (maxTurns !== undefined) {
        config.agent.max_turns = maxTurns;
      }
      if (timeout !== undefined) {
        config.agent.timeout = timeout;
      }

      await saveConfig(config);

      const changes = [`model: ${model}`];
      if (maxTurns !== undefined) changes.push(`maxTurns: ${maxTurns}`);
      if (timeout !== undefined) changes.push(`timeout: ${timeout}ms`);

      return {
        success: true,
        message: `Global agent settings updated: ${changes.join(', ')}. New conversations will use these settings.`,
      };
    } catch (err) {
      return { success: false, error: `Failed to set model: ${err}` };
    }
  }

  // ============================================================================
  // OS Monitoring Tools (viewer-only)
  // ============================================================================

  /**
   * Callback to get bot status from running gateways
   * Set by the main application when gateways are initialized
   */
  private botStatusCallback: (() => Map<BotPlatform, { running: boolean; error?: string }>) | null =
    null;

  /**
   * Callback to control bots
   * Set by the main application when gateways are initialized
   */
  private botControlCallback:
    | ((
        platform: BotPlatform,
        action: 'start' | 'stop'
      ) => Promise<{ success: boolean; error?: string }>)
    | null = null;

  /**
   * Set the bot status callback (called by main app)
   */
  setBotStatusCallback(
    callback: () => Map<BotPlatform, { running: boolean; error?: string }>
  ): void {
    this.botStatusCallback = callback;
  }

  /**
   * Set the bot control callback (called by main app)
   */
  setBotControlCallback(
    callback: (
      platform: BotPlatform,
      action: 'start' | 'stop'
    ) => Promise<{ success: boolean; error?: string }>
  ): void {
    this.botControlCallback = callback;
  }

  /**
   * Execute os_list_bots tool - List all configured bots and their status
   */
  private async executeListBots(
    input: ListBotsInput
  ): Promise<{ success: boolean; bots?: BotStatus[]; error?: string }> {
    const { platform } = input;

    try {
      const config = await loadConfig();
      const platforms: BotPlatform[] = ['discord', 'telegram', 'slack', 'chatwork'];
      const bots: BotStatus[] = [];

      // Get runtime status if callback is available
      const runtimeStatus = this.botStatusCallback?.() ?? new Map();

      for (const p of platforms) {
        // Skip if filtering by platform
        if (platform && p !== platform) continue;

        const platformConfig = config[p];
        const configured = !!platformConfig;
        const enabled = configured && platformConfig.enabled === true;
        const runtime = runtimeStatus.get(p);

        let status: BotStatus['status'];
        if (!configured) {
          status = 'not_configured';
        } else if (runtime?.running) {
          status = 'running';
        } else if (runtime?.error) {
          status = 'error';
        } else if (enabled) {
          status = 'stopped';
        } else {
          status = 'stopped';
        }

        bots.push({
          platform: p,
          enabled,
          configured,
          status,
          error: runtime?.error,
        });
      }

      return { success: true, bots };
    } catch (err) {
      return { success: false, error: `Failed to list bots: ${err}` };
    }
  }

  /**
   * Execute os_restart_bot tool - Restart a bot
   * Viewer-only: requires systemControl permission
   */
  private async executeRestartBot(
    input: RestartBotInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const { platform } = input;

    if (!platform) {
      return { success: false, error: 'Platform is required' };
    }

    if (!this.botControlCallback) {
      return {
        success: false,
        error:
          'Bot control not available. Please restart MAMA server to apply configuration changes.',
      };
    }

    try {
      // Stop then start
      const stopResult = await this.botControlCallback(platform, 'stop');
      if (!stopResult.success && stopResult.error !== 'Bot not running') {
        return { success: false, error: `Failed to stop bot: ${stopResult.error}` };
      }

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const startResult = await this.botControlCallback(platform, 'start');
      if (!startResult.success) {
        return { success: false, error: `Failed to start bot: ${startResult.error}` };
      }

      return { success: true, message: `${platform} bot restarted successfully` };
    } catch (err) {
      return { success: false, error: `Failed to restart bot: ${err}` };
    }
  }

  /**
   * Execute os_stop_bot tool - Stop a bot
   * Viewer-only: requires systemControl permission
   */
  private async executeStopBot(
    input: StopBotInput
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    // Check viewer-only permission
    const permError = this.checkViewerOnly();
    if (permError) {
      return { success: false, error: permError };
    }

    const { platform } = input;

    if (!platform) {
      return { success: false, error: 'Platform is required' };
    }

    if (!this.botControlCallback) {
      return {
        success: false,
        error:
          'Bot control not available. Manually disable the bot in config.yaml and restart MAMA.',
      };
    }

    try {
      const result = await this.botControlCallback(platform, 'stop');
      if (!result.success) {
        return { success: false, error: `Failed to stop bot: ${result.error}` };
      }

      return { success: true, message: `${platform} bot stopped successfully` };
    } catch (err) {
      return { success: false, error: `Failed to stop bot: ${err}` };
    }
  }

  // ============================================================================
  // PR Review Tools
  // ============================================================================

  private parsePRUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
    const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
  }

  private async executePrReviewThreads(input: {
    pr_url?: string;
    owner?: string;
    repo?: string;
    pr_number?: number;
  }): Promise<{ success: boolean; threads?: unknown[]; summary?: string; error?: string }> {
    let owner: string;
    let repo: string;
    let prNumber: number;

    if (input.pr_url) {
      const parsed = this.parsePRUrl(input.pr_url);
      if (!parsed) return { success: false, error: `Invalid PR URL: ${input.pr_url}` };
      ({ owner, repo, prNumber } = parsed);
    } else if (input.owner && input.repo && input.pr_number) {
      owner = input.owner;
      repo = input.repo;
      prNumber = input.pr_number;
    } else {
      return { success: false, error: 'Provide pr_url or (owner, repo, pr_number)' };
    }

    try {
      const query = `
        query($owner: String!, $repo: String!, $prNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $prNumber) {
              reviewThreads(last: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 10) {
                    nodes { path line body author { login } }
                  }
                }
              }
            }
          }
        }
      `;

      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          'graphql',
          '-f',
          `query=${query}`,
          '-F',
          `owner=${owner}`,
          '-F',
          `repo=${repo}`,
          '-F',
          `prNumber=${prNumber}`,
        ],
        { timeout: 30000 }
      );

      let data: GHGraphQLResponse;
      try {
        data = JSON.parse(stdout) as GHGraphQLResponse;
      } catch {
        return {
          success: false,
          error: `Failed to parse GitHub API response: ${stdout.substring(0, 200)}`,
        };
      }
      const threads = data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

      const unresolved = threads
        .filter((thread) => !thread.isResolved)
        .map((thread) => ({
          id: thread.id,
          comments: thread.comments.nodes.map((comment) => ({
            path: comment.path,
            line: comment.line,
            body: comment.body,
            author: comment.author?.login ?? 'unknown',
          })),
        }));

      // Build summary grouped by file
      const byFile = new Map<string, { line: number | null; body: string; author: string }[]>();
      for (const t of unresolved) {
        const first = t.comments[0];
        if (!first) continue;
        const file = first.path || '(general)';
        const list = byFile.get(file) || [];
        list.push({ line: first.line, body: first.body, author: first.author });
        byFile.set(file, list);
      }

      const summaryLines = [
        `${unresolved.length} unresolved thread(s) across ${byFile.size} file(s)`,
        '',
      ];
      for (const [file, items] of byFile) {
        summaryLines.push(`**${file}** (${items.length})`);
        for (const item of items) {
          const lineRef = item.line ? `L${item.line} ` : '';
          const body = item.body.length > 300 ? item.body.substring(0, 300) + '…' : item.body;
          summaryLines.push(`  • ${lineRef}@${item.author}: ${body}`);
        }
        summaryLines.push('');
      }

      if (byFile.size > 1) {
        summaryLines.push(
          `💡 ${byFile.size} independent files — delegate fixes in parallel (DELEGATE_BG)`
        );
      }

      return { success: true, threads: unresolved, summary: summaryLines.join('\n') };
    } catch (err) {
      return { success: false, error: `Failed to fetch PR threads: ${err}` };
    }
  }

  static getValidTools(): GatewayToolName[] {
    return [...VALID_TOOLS];
  }

  /**
   * Check if a tool name is valid
   */
  static isValidTool(toolName: string): toolName is GatewayToolName {
    return VALID_TOOLS.includes(toolName as GatewayToolName);
  }
}
