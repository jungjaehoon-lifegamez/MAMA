/**
 * MAMA Tool Executor for MAMA Standalone
 *
 * Executes MAMA gateway tools (mama_search, mama_save, mama_update, mama_load_checkpoint, Read, discord_send).
 * NOT MCP - uses Claude Messages API tool definitions.
 * Supports both direct API integration and mock API for testing.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { handleSaveIntegrationToken } from '../onboarding/phase-7-integrations.js';
import type {
  GatewayToolName,
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
  MAMAApiInterface,
} from './types.js';
import { AgentError } from './types.js';

/**
 * Discord gateway interface for sending messages
 */
export interface DiscordGatewayInterface {
  sendMessage(channelId: string, message: string): Promise<void>;
  sendFile(channelId: string, filePath: string, caption?: string): Promise<void>;
  sendImage(channelId: string, imagePath: string, caption?: string): Promise<void>;
}

/**
 * Valid MAMA tool names (Gateway tools, NOT MCP)
 */
const VALID_TOOLS: GatewayToolName[] = [
  'mama_search',
  'mama_save',
  'mama_update',
  'mama_load_checkpoint',
  'Read',
  'discord_send',
  'save_integration_token',
];

export class MCPExecutor {
  private mamaApi: MAMAApiInterface | null = null;
  private readonly dbPath?: string;
  private discordGateway: DiscordGatewayInterface | null = null;

  constructor(options: { dbPath?: string; mamaApi?: MAMAApiInterface } = {}) {
    this.dbPath = options.dbPath;

    if (options.mamaApi) {
      this.mamaApi = options.mamaApi;
    }
  }

  /**
   * Set Discord gateway for discord_send tool
   */
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
      if (this.dbPath) {
        process.env.MAMA_DB_PATH = this.dbPath;
      }

      // Dynamic import of MAMA core modules
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mama = require('@jungjaehoon/mama-core/mama-api');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dbManager = require('@jungjaehoon/mama-core/db-manager');

      // Initialize the database before using mama-api functions
      await dbManager.initDB();

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
  async execute(toolName: string, input: unknown): Promise<unknown> {
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
        case 'discord_send':
          return await this.executeDiscordSend(
            input as { channel_id: string; message?: string; image_path?: string }
          );
        case 'save_integration_token':
          return await handleSaveIntegrationToken(
            input as {
              platform: 'discord' | 'slack' | 'telegram';
              token: string;
              guild_id?: string;
              chat_id?: string;
            }
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

      return await api.saveCheckpoint(
        checkpointInput.summary,
        checkpointInput.open_files ?? [],
        checkpointInput.next_steps ?? ''
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

    // Checkpoint search: checkpoints live in a separate table, not in decisions
    if (type === 'checkpoint') {
      const checkpoint = await api.loadCheckpoint();
      if (checkpoint && typeof checkpoint === 'object' && 'summary' in checkpoint) {
        const cp = checkpoint as {
          id?: number;
          summary?: string;
          timestamp?: number;
          next_steps?: string;
          open_files?: string[];
        };
        return {
          success: true,
          results: [
            {
              id: `checkpoint_${cp.id ?? 'latest'}`,
              summary: cp.summary,
              created_at: cp.timestamp
                ? new Date(cp.timestamp).toISOString()
                : new Date().toISOString(),
              type: 'checkpoint' as const,
            },
          ] as SearchResult['results'],
          count: 1,
        };
      }
      return { success: true, results: [], count: 0 };
    }

    // If no query provided, return recent items using listDecisions
    if (!query) {
      const decisions = await api.listDecisions({ limit });
      let results = Array.isArray(decisions) ? decisions : [];

      // Filter by type if specified
      if (type && type !== 'all') {
        results = results.filter((item: unknown) => (item as { type?: string }).type === type);
      }

      return {
        success: true,
        results: results as SearchResult['results'],
        count: results.length,
      };
    }

    // Semantic search using suggest
    const result = await api.suggest(query, { limit });

    // Filter by type if specified
    let filteredResults = result.results ?? [];

    if (type && type !== 'all') {
      filteredResults = filteredResults.filter((item: { type?: string }) => item.type === type);
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
    return await api.loadCheckpoint();
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
   * Execute discord_send tool - Send message/image to Discord channel
   */
  private async executeDiscordSend(input: {
    channel_id: string;
    message?: string;
    image_path?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { channel_id, message, image_path } = input;

    if (!channel_id) {
      return { success: false, error: 'channel_id is required' };
    }

    if (!this.discordGateway) {
      return { success: false, error: 'Discord gateway not configured' };
    }

    try {
      if (image_path) {
        await this.discordGateway.sendImage(channel_id, image_path, message);
      } else if (message) {
        await this.discordGateway.sendMessage(channel_id, message);
      } else {
        return { success: false, error: 'Either message or image_path is required' };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to send to Discord: ${err}` };
    }
  }

  /**
   * Get the list of valid tool names
   */
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
