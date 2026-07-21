/**
 * Unit tests for IModelRunner interface and types (STORY-011)
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ModelRunnerError,
  type IModelRunner,
  type PromptResult,
  type RunnerMetrics,
  type PromptOptions,
  type BackendType,
  type ModelRunnerErrorCode,
  type HostToolBridge,
  type HostToolCall,
  type HostToolCallResult,
  type HostToolDefinition,
  type HostToolInputSchema,
  type HostToolJsonValue,
} from '../../src/agent/model-runner.js';

describe('ModelRunner types', () => {
  describe('ModelRunnerError', () => {
    it('should create error with code and retryable flag', () => {
      const err = new ModelRunnerError('timeout waiting for response', 'timeout', true);
      expect(err.message).toBe('timeout waiting for response');
      expect(err.code).toBe('timeout');
      expect(err.retryable).toBe(true);
      expect(err.name).toBe('ModelRunnerError');
      expect(err).toBeInstanceOf(Error);
    });

    it('should default retryable to false', () => {
      const err = new ModelRunnerError('auth failed', 'auth_failure');
      expect(err.retryable).toBe(false);
    });

    it('should support all error codes', () => {
      const codes: ModelRunnerErrorCode[] = [
        'timeout',
        'crash',
        'context_overflow',
        'auth_failure',
        'rate_limit',
        'unknown',
      ];
      for (const code of codes) {
        const err = new ModelRunnerError(`test ${code}`, code);
        expect(err.code).toBe(code);
      }
    });
  });

  describe('IModelRunner contract', () => {
    it('should be implementable as a mock', () => {
      const mock: IModelRunner = {
        backendType: 'claude' as BackendType,
        prompt: async (content: string) => ({
          response: `echo: ${content}`,
          usage: { input_tokens: 10, output_tokens: 5 },
          session_id: 'test-session',
        }),
        setSessionId: () => {},
        setSystemPrompt: () => {},
        isHealthy: () => true,
        getMetrics: () => ({
          requestCount: 0,
          failureCount: 0,
          avgLatencyMs: 0,
          lastRequestAt: null,
        }),
        stop: () => {},
      };

      expect(mock.backendType).toBe('claude');
      expect(mock.isHealthy()).toBe(true);
    });

    it('should work with optional sendToolResult', async () => {
      const mockWithToolResult: IModelRunner = {
        backendType: 'claude',
        prompt: async () => ({
          response: 'ok',
          usage: { input_tokens: 0, output_tokens: 0 },
          session_id: '',
        }),
        setSessionId: () => {},
        setSystemPrompt: () => {},
        sendToolResult: async (_id, result) => ({
          response: `tool: ${result}`,
          usage: { input_tokens: 0, output_tokens: 0 },
          session_id: '',
        }),
        isHealthy: () => true,
        getMetrics: () => ({
          requestCount: 1,
          failureCount: 0,
          avgLatencyMs: 100,
          lastRequestAt: Date.now(),
        }),
        stop: () => {},
      };

      expect(mockWithToolResult.sendToolResult).toBeDefined();
      const result = await mockWithToolResult.sendToolResult!('id', 'data');
      expect(result.response).toBe('tool: data');
    });

    it('should accept codex backend type without sendToolResult', () => {
      const codexMock: IModelRunner = {
        backendType: 'codex',
        prompt: async () => ({
          response: '',
          usage: { input_tokens: 0, output_tokens: 0 },
          session_id: '',
        }),
        setSessionId: () => {},
        setSystemPrompt: () => {},
        isHealthy: () => false,
        getMetrics: () => ({
          requestCount: 0,
          failureCount: 0,
          avgLatencyMs: 0,
          lastRequestAt: null,
        }),
        stop: () => {},
      };

      expect(codexMock.backendType).toBe('codex');
      expect(codexMock.sendToolResult).toBeUndefined();
    });
  });

  describe('PromptResult shape', () => {
    it('should include optional fields', () => {
      const result: PromptResult = {
        response: 'hello',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
        },
        session_id: 'sess-1',
        cost_usd: 0.003,
        toolUseBlocks: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/tmp' } }],
        hasToolUse: true,
      };

      expect(result.usage.cache_creation_input_tokens).toBe(10);
      expect(result.toolUseBlocks).toHaveLength(1);
      expect(result.hasToolUse).toBe(true);
    });
  });

  describe('RunnerMetrics shape', () => {
    it('should represent initial state', () => {
      const metrics: RunnerMetrics = {
        requestCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        lastRequestAt: null,
      };
      expect(metrics.lastRequestAt).toBeNull();
    });

    it('should represent active state', () => {
      const now = Date.now();
      const metrics: RunnerMetrics = {
        requestCount: 42,
        failureCount: 3,
        avgLatencyMs: 1250,
        lastRequestAt: now,
      };
      expect(metrics.requestCount).toBe(42);
      expect(metrics.avgLatencyMs).toBe(1250);
    });
  });

  describe('PromptOptions', () => {
    it('should be optional fields', () => {
      const empty: PromptOptions = {};
      const full: PromptOptions = {
        model: 'claude-sonnet-4-6',
        resumeSession: true,
        sessionKey: 'discord:channel-1',
      };
      expect(empty.model).toBeUndefined();
      expect(full.resumeSession).toBe(true);
      expect(full.sessionKey).toBe('discord:channel-1');
    });

    it('should accept a run-local host-tool bridge', async () => {
      const tools: HostToolDefinition[] = [
        {
          type: 'function',
          name: 'mama_search',
          description: 'Search decisions',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
      ];
      const execute = async (call: HostToolCall): Promise<HostToolCallResult> => ({
        content: JSON.stringify({ name: call.name, input: call.input }),
        isError: false,
        stop: true,
      });
      const bridge: HostToolBridge = { tools, execute };
      const options: PromptOptions = { hostToolBridge: bridge };

      expect(options.hostToolBridge?.tools).toEqual(tools);
      await expect(
        options.hostToolBridge?.execute({
          callId: 'call-1',
          name: 'mama_search',
          input: { query: 'decision' },
        })
      ).resolves.toEqual({
        content: JSON.stringify({ name: 'mama_search', input: { query: 'decision' } }),
        isError: false,
        stop: true,
      });
    });

    it('should expose readonly host-tool definitions and schemas', () => {
      expectTypeOf<HostToolBridge['tools']>().toEqualTypeOf<readonly HostToolDefinition[]>();
      expectTypeOf<HostToolDefinition['inputSchema']>().toEqualTypeOf<HostToolInputSchema>();
      expectTypeOf<HostToolInputSchema>().toEqualTypeOf<{
        readonly type: 'object';
        readonly properties: Readonly<Record<string, HostToolJsonValue>>;
        readonly required?: readonly string[];
        readonly additionalProperties: boolean;
      }>();
    });
  });
});
