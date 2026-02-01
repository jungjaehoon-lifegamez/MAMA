/**
 * Unit tests for ClaudeClient
 *
 * Tests the SDK-based Claude client with OAuth token support (Stealth Mode)
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ClaudeClient } from '../../src/agent/claude-client.js';
import { AgentError } from '../../src/agent/types.js';
import type { OAuthManager } from '../../src/auth/index.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn();
  MockAnthropic.prototype.messages = {
    create: vi.fn(),
  };
  MockAnthropic.APIError = class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'APIError';
    }
  };
  return { default: MockAnthropic };
});

import Anthropic from '@anthropic-ai/sdk';

describe('ClaudeClient', () => {
  let mockOAuthManager: OAuthManager;
  let mockCreate: Mock;

  const mockToken = 'sk-ant-oat01-test-token';

  const mockSdkResponse = {
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello!' }],
    model: 'claude-sonnet-4-20250514',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockOAuthManager = {
      getToken: vi.fn().mockResolvedValue(mockToken),
    } as unknown as OAuthManager;

    // Get the mocked create function
    mockCreate =
      (Anthropic as unknown as Mock).mock.results[0]?.value?.messages?.create ??
      vi.fn().mockResolvedValue(mockSdkResponse);

    // Reset the mock for each test
    (Anthropic.prototype.messages.create as Mock).mockReset();
    (Anthropic.prototype.messages.create as Mock).mockResolvedValue(mockSdkResponse);
  });

  describe('sendMessage()', () => {
    it('should send message and return response', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      const response = await client.sendMessage([{ role: 'user', content: 'Hello' }]);

      expect(response.id).toBe('msg_test123');
      expect(response.content).toHaveLength(1);
      expect(response.content[0]).toEqual({ type: 'text', text: 'Hello!' });
      expect(response.stop_reason).toBe('end_turn');
    });

    it('should create Anthropic client with authToken', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([{ role: 'user', content: 'Hello' }]);

      // Verify Anthropic was constructed with correct options
      expect(Anthropic).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: mockToken,
          dangerouslyAllowBrowser: true,
          defaultHeaders: expect.objectContaining({
            'anthropic-beta': expect.stringContaining('claude-code'),
            'user-agent': expect.stringContaining('claude-cli'),
            'x-app': 'cli',
          }),
        })
      );
    });

    it('should include system prompt with cache_control', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([{ role: 'user', content: 'Hello' }], {
        system: 'You are a helpful assistant.',
      });

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('Claude Code'),
              cache_control: { type: 'ephemeral' },
            }),
            expect.objectContaining({
              type: 'text',
              text: 'You are a helpful assistant.',
              cache_control: { type: 'ephemeral' },
            }),
          ]),
        })
      );
    });

    it('should include Claude Code system prefix', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([{ role: 'user', content: 'Hello' }]);

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining("Claude Code, Anthropic's official CLI"),
            }),
          ]),
        })
      );
    });

    it('should include tools when provided', async () => {
      const tools = [
        {
          name: 'test_tool',
          description: 'A test tool',
          input_schema: { type: 'object' as const, properties: {} },
        },
      ];

      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([{ role: 'user', content: 'Hello' }], { tools });

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: 'test_tool',
              description: 'A test tool',
            }),
          ]),
        })
      );
    });

    it('should use custom model when provided', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-20250514',
      });

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-20250514',
        })
      );
    });

    it('should use default model when not provided', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([{ role: 'user', content: 'Hello' }]);

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-20250514',
        })
      );
    });

    it('should use custom maxTokens when provided', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([{ role: 'user', content: 'Hello' }], { maxTokens: 8192 });

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          max_tokens: 8192,
        })
      );
    });
  });

  describe('message conversion', () => {
    it('should convert user string message', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([{ role: 'user', content: 'Hello' }]);

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: 'Hello',
            }),
          ]),
        })
      );
    });

    it('should convert tool_result messages', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_123',
              content: 'Tool output',
              is_error: false,
            },
          ],
        },
      ]);

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'tool_result',
                  tool_use_id: 'tool_123',
                  content: 'Tool output',
                }),
              ]),
            }),
          ]),
        })
      );
    });

    it('should convert assistant message with tool_use', async () => {
      const client = new ClaudeClient(mockOAuthManager);
      await client.sendMessage([
        { role: 'user', content: 'Search for auth' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_123',
              name: 'search',
              input: { query: 'auth' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_123',
              content: 'Found 3 results',
            },
          ],
        },
      ]);

      expect(Anthropic.prototype.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'tool_use',
                  id: 'tool_123',
                  name: 'search',
                }),
              ]),
            }),
          ]),
        })
      );
    });
  });

  describe('response conversion', () => {
    it('should convert text response', async () => {
      (Anthropic.prototype.messages.create as Mock).mockResolvedValue({
        id: 'msg_abc',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response text' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const client = new ClaudeClient(mockOAuthManager);
      const response = await client.sendMessage([{ role: 'user', content: 'Hello' }]);

      expect(response.content).toEqual([{ type: 'text', text: 'Response text' }]);
      expect(response.stop_reason).toBe('end_turn');
    });

    it('should convert tool_use response', async () => {
      (Anthropic.prototype.messages.create as Mock).mockResolvedValue({
        id: 'msg_abc',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_456',
            name: 'save',
            input: { topic: 'test' },
          },
        ],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 15 },
      });

      const client = new ClaudeClient(mockOAuthManager);
      const response = await client.sendMessage([{ role: 'user', content: 'Save this' }]);

      expect(response.content).toEqual([
        {
          type: 'tool_use',
          id: 'tool_456',
          name: 'save',
          input: { topic: 'test' },
        },
      ]);
      expect(response.stop_reason).toBe('tool_use');
    });
  });

  describe('error handling', () => {
    it('should throw AgentError on API error', async () => {
      const apiError = new (
        Anthropic as unknown as { APIError: new (status: number, message: string) => Error }
      ).APIError(400, 'Invalid request');
      (apiError as { status: number }).status = 400;

      (Anthropic.prototype.messages.create as Mock).mockRejectedValue(apiError);

      const client = new ClaudeClient(mockOAuthManager);
      await expect(client.sendMessage([{ role: 'user', content: 'Hello' }])).rejects.toThrow(
        AgentError
      );
    });

    it('should set RATE_LIMIT code for 429 errors', async () => {
      const apiError = new (
        Anthropic as unknown as { APIError: new (status: number, message: string) => Error }
      ).APIError(429, 'Rate limited');
      (apiError as { status: number }).status = 429;

      (Anthropic.prototype.messages.create as Mock).mockRejectedValue(apiError);

      const client = new ClaudeClient(mockOAuthManager);
      await expect(client.sendMessage([{ role: 'user', content: 'Hello' }])).rejects.toMatchObject({
        code: 'RATE_LIMIT',
      });
    });

    it('should mark retryable errors correctly', async () => {
      const apiError = new (
        Anthropic as unknown as { APIError: new (status: number, message: string) => Error }
      ).APIError(500, 'Server error');
      (apiError as { status: number }).status = 500;

      (Anthropic.prototype.messages.create as Mock).mockRejectedValue(apiError);

      const client = new ClaudeClient(mockOAuthManager);
      try {
        await client.sendMessage([{ role: 'user', content: 'Hello' }]);
      } catch (error) {
        expect(error).toBeInstanceOf(AgentError);
        expect((error as AgentError).retryable).toBe(true);
      }
    });

    it('should throw AgentError on generic errors', async () => {
      (Anthropic.prototype.messages.create as Mock).mockRejectedValue(new Error('Network error'));

      const client = new ClaudeClient(mockOAuthManager);
      await expect(client.sendMessage([{ role: 'user', content: 'Hello' }])).rejects.toThrow(
        AgentError
      );
      await expect(client.sendMessage([{ role: 'user', content: 'Hello' }])).rejects.toMatchObject({
        code: 'API_ERROR',
      });
    });
  });

  describe('static methods', () => {
    it('should return default model', () => {
      expect(ClaudeClient.getDefaultModel()).toBe('claude-sonnet-4-20250514');
    });

    it('should return default max tokens', () => {
      expect(ClaudeClient.getDefaultMaxTokens()).toBe(4096);
    });
  });
});
