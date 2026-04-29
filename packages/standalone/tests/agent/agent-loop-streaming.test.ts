/**
 * Unit tests for AgentLoop streaming functionality
 *
 * Tests basic AgentLoop behavior with mocked ClaudeCLIWrapper
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import type { OAuthManager } from '../../src/auth/index.js';
import type { MAMAApiInterface, ContentBlock } from '../../src/agent/types.js';

// Mock the ClaudeCLIWrapper
vi.mock('../../src/agent/claude-cli-wrapper.js', () => {
  return {
    ClaudeCLIWrapper: vi.fn().mockImplementation(() => ({
      resetSession: vi.fn(),
      setSystemPrompt: vi.fn(),
      setSessionId: vi.fn(),
      prompt: vi.fn().mockResolvedValue({
        response: 'Mock response',
        usage: { input_tokens: 10, output_tokens: 5 },
        session_id: 'test-session',
      }),
    })),
  };
});

// Mock the PersistentCLIAdapter (used by default for claude backend)
vi.mock('../../src/agent/persistent-cli-adapter.js', () => {
  return {
    PersistentCLIAdapter: vi.fn().mockImplementation(() => ({
      prompt: vi.fn().mockResolvedValue({
        response: 'Mock response',
        usage: { input_tokens: 10, output_tokens: 5 },
        session_id: 'test-session',
      }),
      setSessionId: vi.fn(),
      close: vi.fn(),
    })),
  };
});

// Mock the session pool
vi.mock('../../src/agent/session-pool.js', () => {
  return {
    SessionPool: vi.fn().mockImplementation(() => ({
      getSession: vi.fn().mockReturnValue({ sessionId: 'test-session', isNew: true }),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      updateTokens: vi.fn().mockReturnValue({ totalTokens: 100, nearThreshold: false }),
      releaseSession: vi.fn(),
    })),
    getSessionPool: vi.fn().mockReturnValue({
      getSession: vi.fn().mockReturnValue({ sessionId: 'test-session', isNew: true }),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      updateTokens: vi.fn().mockReturnValue({ totalTokens: 100, nearThreshold: false }),
      releaseSession: vi.fn(),
    }),
    buildChannelKey: vi.fn().mockReturnValue('default:default'),
  };
});

// Mock the lane manager
vi.mock('../../src/concurrency/index.js', () => {
  return {
    LaneManager: vi.fn(),
    getGlobalLaneManager: vi.fn().mockReturnValue({
      enqueueWithSession: vi.fn((_, fn) => fn()),
    }),
  };
});

describe('AgentLoop - Streaming Detection', () => {
  const mockToken = 'sk-ant-oat01-test-token';

  const createMockOAuthManager = (): OAuthManager =>
    ({
      getToken: vi.fn().mockResolvedValue(mockToken),
    }) as unknown as OAuthManager;

  const createMockApi = (): MAMAApiInterface => ({
    save: vi.fn().mockResolvedValue({
      success: true,
      id: 'decision_test123',
      type: 'decision',
    }),
    saveCheckpoint: vi.fn().mockResolvedValue({
      success: true,
      id: 'checkpoint_test123',
      type: 'checkpoint',
    }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    beginModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_streaming_real_executor',
      model_id: null,
      model_provider: null,
      prompt_version: null,
      tool_manifest_version: null,
      output_schema_version: null,
      agent_id: null,
      instance_id: null,
      envelope_hash: null,
      parent_model_run_id: null,
      input_snapshot_ref: null,
      input_refs_json: null,
      input_refs: null,
      completion_summary: null,
      status: 'running',
      error_summary: null,
      token_count: 0,
      cost_estimate: null,
      created_at: 1,
      completed_at: null,
    }),
    commitModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_streaming_real_executor',
      model_id: null,
      model_provider: null,
      prompt_version: null,
      tool_manifest_version: null,
      output_schema_version: null,
      agent_id: null,
      instance_id: null,
      envelope_hash: null,
      parent_model_run_id: null,
      input_snapshot_ref: null,
      input_refs_json: null,
      input_refs: null,
      completion_summary: 'agent_loop completed',
      status: 'committed',
      error_summary: null,
      token_count: 0,
      cost_estimate: null,
      created_at: 1,
      completed_at: 2,
    }),
    failModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_streaming_real_executor',
      model_id: null,
      model_provider: null,
      prompt_version: null,
      tool_manifest_version: null,
      output_schema_version: null,
      agent_id: null,
      instance_id: null,
      envelope_hash: null,
      parent_model_run_id: null,
      input_snapshot_ref: null,
      input_refs_json: null,
      input_refs: null,
      completion_summary: null,
      status: 'failed',
      error_summary: 'failed',
      token_count: 0,
      cost_estimate: null,
      created_at: 1,
      completed_at: 2,
    }),
    appendToolTrace: vi.fn().mockResolvedValue({
      trace_id: 'trace_streaming_real_executor',
      model_run_id: 'mr_streaming_real_executor',
      gateway_call_id: null,
      tool_name: 'noop',
      input_summary: null,
      output_summary: null,
      execution_status: 'completed',
      duration_ms: 0,
      envelope_hash: null,
      created_at: 1,
    }),
  });

  let agentLoop: AgentLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockOAuth = createMockOAuthManager();
    const mockApi = createMockApi();

    agentLoop = new AgentLoop(mockOAuth, {}, {}, { mamaApi: mockApi });
  });

  describe('runWithContent', () => {
    it('should handle content blocks with images', async () => {
      const contentWithImage: ContentBlock[] = [
        { type: 'text', text: 'Check this image:' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: 'base64encodeddata',
          },
        },
      ];

      const result = await agentLoop.runWithContent(contentWithImage);
      expect(result.response).toBe('Mock response');
    });

    it('should handle text-only content blocks', async () => {
      const contentTextOnly: ContentBlock[] = [
        { type: 'text', text: 'Just text here' },
        { type: 'text', text: 'More text' },
      ];

      const result = await agentLoop.runWithContent(contentTextOnly);
      expect(result.response).toBe('Mock response');
    });

    it('should handle empty content blocks', async () => {
      const emptyContent: ContentBlock[] = [];

      // Empty content should still work (falls back to default behavior)
      const result = await agentLoop.runWithContent(emptyContent);
      expect(result.response).toBe('Mock response');
    });

    it('should handle mixed content types', async () => {
      const mixedContent: ContentBlock[] = [
        { type: 'text', text: 'Some text' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'pngdata',
          },
        },
        { type: 'text', text: 'More text' },
      ];

      const result = await agentLoop.runWithContent(mixedContent);
      expect(result.response).toBe('Mock response');
    });

    it('should handle multiple images', async () => {
      const multipleImages: ContentBlock[] = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: 'image1data',
          },
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'image2data',
          },
        },
      ];

      const result = await agentLoop.runWithContent(multipleImages);
      expect(result.response).toBe('Mock response');
    });

    it('should handle document content', async () => {
      const documentContent: ContentBlock[] = [
        { type: 'text', text: 'Analyzing document:' },
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'pdfdata',
          },
        },
      ];

      const result = await agentLoop.runWithContent(documentContent);
      expect(result.response).toBe('Mock response');
    });
  });
});
