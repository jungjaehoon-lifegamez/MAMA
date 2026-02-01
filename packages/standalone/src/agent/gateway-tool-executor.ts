/**
 * MAMA Tool Executor for MAMA Standalone
 *
 * Executes MAMA gateway tools (mama_search, mama_save, mama_update, mama_load_checkpoint, Read, discord_send).
 * NOT MCP - uses Claude Messages API tool definitions.
 * Supports both direct API integration and mock API for testing.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
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
} from './types.js';
import { AgentError } from './types.js';
import { getBrowserTool, type BrowserTool } from '../tools/browser-tool.js';

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
];

export class GatewayToolExecutor {
  private mamaApi: MAMAApiInterface | null = null;
  private readonly mamaDbPath?: string;
  private sessionStore?: any;
  private discordGateway: DiscordGatewayInterface | null = null;
  private browserTool: BrowserTool;

  constructor(options: GatewayToolExecutorOptions = {}) {
    this.mamaDbPath = options.mamaDbPath;
    this.sessionStore = options.sessionStore;
    this.browserTool = getBrowserTool({
      screenshotDir: join(process.env.HOME || '', '.mama', 'workspace', 'media', 'outbound'),
    });

    if (options.mamaApi) {
      this.mamaApi = options.mamaApi;
    }
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
   * Execute an MCP tool
   *
   * @param toolName - Name of the tool to execute
   * @param input - Tool input parameters
   * @returns Tool execution result
   * @throws AgentError on tool errors
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
    if (checkpoint && (checkpoint as any).recentConversation && this.sessionStore) {
      this.sessionStore.restoreMessages((checkpoint as any).recentConversation);
    }
    return checkpoint;
  }

  /**
   * Execute read tool - Read file from filesystem
   */
  private async executeRead(input: {
    path: string;
  }): Promise<{ success: boolean; content?: string; error?: string }> {
    const { path: filePath } = input;

    if (!filePath) {
      return { success: false, error: 'Path is required' };
    }

    // Expand ~ to home directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const expandedPath = filePath.startsWith('~/') ? join(homeDir, filePath.slice(2)) : filePath;

    // Security: Only allow reading from ~/.mama/ directory
    const mamaDir = join(homeDir, '.mama');
    if (!expandedPath.startsWith(mamaDir)) {
      return { success: false, error: `Access denied: Can only read files from ${mamaDir}` };
    }

    if (!existsSync(expandedPath)) {
      return { success: false, error: `File not found: ${expandedPath}` };
    }

    try {
      const content = readFileSync(expandedPath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: `Failed to read file: ${err}` };
    }
  }

  /**
   * Execute Write tool - Write content to a file
   */
  private async executeWrite(input: {
    path: string;
    content: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { path, content } = input;

    if (!path) {
      return { success: false, error: 'path is required' };
    }

    try {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content, 'utf-8');
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

    try {
      const output = execSync(command, {
        cwd: workdir || process.cwd(),
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });
      return { success: true, output };
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
