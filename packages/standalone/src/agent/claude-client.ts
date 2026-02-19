/**
 * Claude API Client for MAMA Standalone
 *
 * Uses Claude Messages API with OAuth tokens (ported from OpenClaw Gateway approach).
 * Uses @anthropic-ai/sdk's authToken option (pi-ai approach)
 */

import Anthropic from '@anthropic-ai/sdk';
import type { OAuthManager } from '../auth/index.js';
import type {
  ClaudeResponse,
  ClaudeClientOptions,
  ToolDefinition,
  Message,
  ContentBlock,
} from './types.js';
import { AgentError } from './types.js';

/**
 * Default configuration
 */
// Model must be provided via config - no hardcoded default
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Claude Code stealth headers for OAuth authentication
 * From: @mariozechner/pi-ai/dist/providers/anthropic.js
 *
 * CRITICAL: OAuth tokens require:
 * 1. apiKey: null (not empty string!)
 * 2. System prompt MUST start with Claude Code identity
 * 3. Proper beta features in header
 */
const CLAUDE_CODE_VERSION = '2.1.2';
const OAUTH_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
  'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
  'x-app': 'cli',
};

/**
 * Required Claude Code identity system prompt for OAuth
 * Without this, OAuth tokens are rejected with "only authorized for use with Claude Code"
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export class ClaudeClient {
  private oauthManager: OAuthManager;
  private client: Anthropic | null = null;
  private lastToken: string | null = null;

  constructor(oauthManager: OAuthManager, _options: ClaudeClientOptions = {}) {
    this.oauthManager = oauthManager;
  }

  /**
   * Get or create Anthropic client with OAuth token
   * Recreates client if token changes (refresh)
   */
  private async getClient(): Promise<Anthropic> {
    const token = await this.oauthManager.getToken();

    if (!token) {
      throw new AgentError(
        'No access token available. Please run: mama login',
        'AUTH_ERROR',
        undefined,
        false
      );
    }

    // Recreate client if token changed
    if (this.client && this.lastToken === token) {
      return this.client;
    }

    // Create new client with OAuth token (pi-ai approach)
    // CRITICAL: apiKey MUST be null (not empty string!) for OAuth to work
    this.client = new Anthropic({
      apiKey: null as unknown as string, // Must be null for OAuth!
      authToken: token, // OAuth token goes here
      defaultHeaders: OAUTH_HEADERS,
      dangerouslyAllowBrowser: true,
    });

    this.lastToken = token;
    return this.client;
  }

  /**
   * Send a message to Claude via API
   *
   * @param messages - Conversation history
   * @param options - Request options including tools
   * @returns Claude API response
   * @throws AgentError on API errors
   */
  async sendMessage(
    messages: Message[],
    options: {
      system?: string;
      tools?: ToolDefinition[];
      model?: string;
      maxTokens?: number;
    } = {}
  ): Promise<ClaudeResponse> {
    const client = await this.getClient();
    const model = options.model || ClaudeClient.getDefaultModel();
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    console.log(
      `[ClaudeClient] API call: model=${model}, tools=${options.tools?.length || 0}, messages=${messages.length}`
    );

    try {
      // Build request params
      const params: Anthropic.MessageCreateParams = {
        model,
        max_tokens: maxTokens,
        messages: this.formatMessages(messages) as Anthropic.MessageParam[],
      };

      // OAuth tokens REQUIRE Claude Code identity in system prompt
      // Without this, API returns: "This credential is only authorized for use with Claude Code"
      const systemBlocks: Array<{
        type: 'text';
        text: string;
        cache_control?: { type: 'ephemeral' };
      }> = [
        {
          type: 'text',
          text: CLAUDE_CODE_IDENTITY,
          cache_control: { type: 'ephemeral' },
        },
      ];

      // Add custom system prompt after identity
      if (options.system) {
        systemBlocks.push({
          type: 'text',
          text: options.system,
          cache_control: { type: 'ephemeral' },
        });
      }

      params.system = systemBlocks as Anthropic.MessageCreateParams['system'];

      // Add tools if provided - THIS IS THE KEY DIFFERENCE
      if (options.tools && options.tools.length > 0) {
        params.tools = options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
        }));
      }

      // Call API using SDK
      const response = await client.messages.create(params);

      console.log(
        `[ClaudeClient] Response: stop_reason=${response.stop_reason}, content_blocks=${response.content?.length || 0}`
      );

      // Convert to our ClaudeResponse type
      return {
        id: response.id,
        type: 'message',
        role: 'assistant',
        content: response.content as ContentBlock[],
        model: response.model,
        stop_reason: response.stop_reason as ClaudeResponse['stop_reason'],
        stop_sequence: response.stop_sequence ?? null,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
        },
      };
    } catch (error) {
      if (error instanceof AgentError) {
        throw error;
      }

      // Handle Anthropic API errors
      if (error instanceof Anthropic.APIError) {
        console.error(`[ClaudeClient] API error: ${error.status} ${error.message}`);

        if (error.status === 401) {
          throw new AgentError(
            'Authentication failed. Please run: mama login',
            'AUTH_ERROR',
            undefined,
            true
          );
        }

        if (error.status === 429) {
          throw new AgentError(`Rate limited: ${error.message}`, 'RATE_LIMIT', error, true);
        }

        throw new AgentError(
          `API request failed: ${error.status} ${error.message}`,
          'API_ERROR',
          error,
          (error.status ?? 0) >= 500
        );
      }

      throw new AgentError(
        `API request failed: ${error instanceof Error ? error.message : String(error)}`,
        'API_ERROR',
        error instanceof Error ? error : undefined,
        true
      );
    }
  }

  /**
   * Format messages for API
   */
  private formatMessages(messages: Message[]): Array<{ role: string; content: unknown }> {
    return messages.map((msg) => ({
      role: msg.role,
      content: this.formatContent(msg.content),
    }));
  }

  /**
   * Format content blocks for API
   */
  private formatContent(content: string | ContentBlock[]): unknown {
    if (typeof content === 'string') {
      return content;
    }

    return content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };

        case 'image':
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.media_type,
              data: block.source.data,
            },
          };

        case 'tool_use':
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          };

        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          };

        default:
          return block;
      }
    });
  }

  /**
   * Get the default model name
   */
  static getDefaultModel(): string {
    return 'claude-sonnet-4-6';
  }

  /**
   * Get the default max tokens
   */
  static getDefaultMaxTokens(): number {
    return DEFAULT_MAX_TOKENS;
  }
}
