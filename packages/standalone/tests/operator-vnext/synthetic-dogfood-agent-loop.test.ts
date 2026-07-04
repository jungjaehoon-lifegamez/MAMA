import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecallBundle } from '@jungjaehoon/mama-core';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { createAgentContext } from '../../src/agent/context-prompt-builder.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';
import type { OAuthManager } from '../../src/auth/index.js';
import {
  SYNTHETIC_DOGFOOD_RAW_CANARIES,
  SYNTHETIC_DOGFOOD_CHANNEL,
} from '../../src/operator-vnext/synthetic-dogfood-harness.js';

process.env.MAMA_FORCE_TIER_3 = 'true';

const { persistentPromptMock, persistentAdapterOptionsMock } = vi.hoisted(() => ({
  persistentPromptMock: vi.fn(),
  persistentAdapterOptionsMock: vi.fn(),
}));

vi.mock('../../src/agent/persistent-cli-adapter.js', () => ({
  PersistentCLIAdapter: vi.fn().mockImplementation((options) => {
    persistentAdapterOptionsMock(options);
    return {
      prompt: persistentPromptMock,
      setSystemPrompt: vi.fn(),
      setSessionId: vi.fn(),
      stop: vi.fn(),
      isHealthy: vi.fn(() => true),
      getMetrics: vi.fn(() => ({
        requestCount: 0,
        failureCount: 0,
        avgLatencyMs: 0,
        lastRequestAt: null,
      })),
    };
  }),
}));

function createMockOAuthManager(): OAuthManager {
  return {
    getToken: vi.fn().mockResolvedValue('synthetic-oauth-token'),
  } as unknown as OAuthManager;
}

interface SyntheticRecallOptions {
  scopes?: Array<{ kind: string; id: string }>;
  includeProfile?: boolean;
}

const SYNTHETIC_ALLOWED_CHANNEL_SCOPE = {
  kind: 'channel' as const,
  id: `discord:${SYNTHETIC_DOGFOOD_CHANNEL}`,
};
const SYNTHETIC_RETURNED_FIELD_CANARY = 'MAMA_SYNTHETIC_RETURNED_FIELD_CANARY_DO_NOT_LEAK';
const PRODUCTION_REDACTION_QUERY = 'operator/production-redaction';
const PRODUCTION_REDACTION_LEAKS = [
  'alice@example.com',
  ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'abcdef'].join('/'),
  ['ghp_', 'abcdefghijklmnopqrstuvwx'].join(''),
  ['/', 'home', 'alice', 'private.txt'].join('/'),
  '123456789012345678',
] as const;

function hasAuthorizedSyntheticScope(options?: SyntheticRecallOptions): boolean {
  return (
    options?.scopes?.some(
      (scope) =>
        scope.kind === SYNTHETIC_ALLOWED_CHANNEL_SCOPE.kind &&
        scope.id === SYNTHETIC_ALLOWED_CHANNEL_SCOPE.id
    ) ?? false
  );
}

function createSyntheticRecallBundle(query: string): RecallBundle {
  const includeReturnedFieldCanary = query.includes(SYNTHETIC_RETURNED_FIELD_CANARY);
  const includeProductionRedaction = query.includes(PRODUCTION_REDACTION_QUERY);
  const memory = {
    id: 'memory_real_agent_loop_synthetic',
    topic: includeProductionRedaction
      ? `operator/private ${PRODUCTION_REDACTION_LEAKS[0]} ${PRODUCTION_REDACTION_LEAKS[1]}`
      : includeReturnedFieldCanary
        ? `operator/${SYNTHETIC_RETURNED_FIELD_CANARY}`
        : 'operator/manual-memory',
    kind: 'decision' as const,
    summary: includeProductionRedaction
      ? `Synthetic private token ${PRODUCTION_REDACTION_LEAKS[2]} at ${PRODUCTION_REDACTION_LEAKS[3]} for ${PRODUCTION_REDACTION_LEAKS[4]}`
      : includeReturnedFieldCanary
        ? `Synthetic ${SYNTHETIC_RETURNED_FIELD_CANARY} /tmp/mama-synthetic-returned-field`
        : 'Synthetic reviewed memory is available after explicit recall.',
    details:
      'Synthetic operator-approved detail derived from a reviewed fixture at /tmp/mama-synthetic-private-source.txt.',
    confidence: 0.88,
    status: 'active' as const,
    scopes: [SYNTHETIC_ALLOWED_CHANNEL_SCOPE],
    source: {
      package: 'standalone' as const,
      source_type: 'synthetic-agent-loop',
      channel_id: SYNTHETIC_DOGFOOD_CHANNEL,
      project_id: 'project_public_synthetic',
    },
    created_at: '2026-07-03T00:00:00.000Z',
    updated_at: '2026-07-03T00:00:00.000Z',
    source_refs: ['raw:synthetic:private-source-ref'],
    local_path: '/tmp/mama-synthetic-private-source.txt',
  };
  return {
    profile: {
      static: [],
      dynamic: [],
      evidence: [
        {
          memory_id: memory.id,
          topic: memory.topic,
          why_included:
            'Synthetic gateway tool call matched the requested project scope from /tmp/mama-synthetic-private-source.txt.',
        },
      ],
    },
    memories: [memory],
    graph_context: {
      primary: [memory],
      expanded: [],
      edges: [],
    },
    search_meta: {
      query,
      scope_order: ['project'],
      retrieval_sources: ['synthetic'],
    },
  };
}

function createEmptyRecallBundle(query: string): RecallBundle {
  return {
    profile: {
      static: [],
      dynamic: [],
      evidence: [],
    },
    memories: [],
    graph_context: {
      primary: [],
      expanded: [],
      edges: [],
    },
    search_meta: {
      query,
      scope_order: [],
      retrieval_sources: [],
    },
  };
}

function createToolRecallApi(): MAMAApiInterface {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'unused' }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    recallMemory: vi.fn(async (query: string, options?: SyntheticRecallOptions) =>
      hasAuthorizedSyntheticScope(options)
        ? createSyntheticRecallBundle(query)
        : createEmptyRecallBundle(query)
    ),
    ingestMemory: vi.fn().mockResolvedValue({ success: false }),
    updateOutcome: vi.fn().mockResolvedValue({ success: false }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: false }),
    appendToolTrace: vi.fn().mockResolvedValue({
      trace_id: 'trace_synthetic_recall',
      model_run_id: 'mr_synthetic_tool_call',
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractToolResultContent(history: unknown): string {
  if (!Array.isArray(history)) {
    throw new Error('AgentLoop history must be an array');
  }

  for (const message of history) {
    const messageRecord = asRecord(message);
    const content = messageRecord?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const blockRecord = asRecord(block);
      if (blockRecord?.type === 'tool_result' && typeof blockRecord.content === 'string') {
        return blockRecord.content;
      }
    }
  }

  throw new Error('AgentLoop history did not include a tool_result block');
}

async function runSyntheticRecallTool(input: Record<string, unknown>) {
  const mamaApi = createToolRecallApi();
  const toolCall = {
    name: 'mama_recall',
    input,
  };
  persistentPromptMock.mockResolvedValueOnce({
    response: `\`\`\`tool_call\n${JSON.stringify(toolCall)}\n\`\`\``,
    usage: { input_tokens: 12, output_tokens: 4 },
    session_id: 'synthetic-agent-loop-session',
  });
  persistentPromptMock.mockResolvedValueOnce({
    response: 'Synthetic final response after tool denial.',
    usage: { input_tokens: 4, output_tokens: 4 },
    session_id: 'synthetic-agent-loop-session',
  });

  let gatewayResult: unknown;
  const agentLoop = new AgentLoop(
    createMockOAuthManager(),
    {
      model: 'claude-sonnet-4-6',
      maxTurns: 3,
      toolsConfig: { gateway: ['*'], mcp: [], mcp_config: '~/.mama/mama-mcp-config.json' },
      onToolUse: (toolName, _input, result) => {
        if (toolName === 'mama_recall') {
          gatewayResult = result;
        }
      },
    },
    {},
    { mamaApi, envelopeIssuanceMode: 'off' }
  );

  const role = DEFAULT_ROLES.definitions.chat_bot;
  const agentContext = createAgentContext(
    'discord',
    'chat_bot',
    role,
    {
      sessionId: 'synthetic-router-session',
      channelId: SYNTHETIC_DOGFOOD_CHANNEL,
      userId: 'synthetic-agent-loop-user',
    },
    [],
    []
  );
  const result = await agentLoop.run('Recall the reviewed synthetic memory.', {
    source: 'discord',
    channelId: SYNTHETIC_DOGFOOD_CHANNEL,
    agentContext,
    modelRunId: 'mr_synthetic_tool_call',
    stopAfterSuccessfulTools: ['mama_recall'],
  });

  return { mamaApi, gatewayResult, result };
}

describe('STORY-VNEXT-PR16-SYNTHETIC-DOGFOOD: production gateway tool-call path', () => {
  beforeEach(() => {
    persistentPromptMock.mockReset();
    persistentAdapterOptionsMock.mockClear();
  });

  describe('AC: scoped production recall is explicit and redacted', () => {
    it('exposes, authorizes, and executes mama_recall through AgentLoop tool_use routing', async () => {
      const { mamaApi, gatewayResult, result } = await runSyntheticRecallTool({
        query: 'operator/manual-memory',
        scopes: [SYNTHETIC_ALLOWED_CHANNEL_SCOPE],
      });

      expect(mamaApi.recallMemory).toHaveBeenCalledWith('operator/manual-memory', {
        scopes: [SYNTHETIC_ALLOWED_CHANNEL_SCOPE],
        includeProfile: true,
      });
      expect(gatewayResult).toMatchObject({
        success: true,
        bundle: {
          memories: [
            {
              topic: 'operator/manual-memory',
              summary: 'Synthetic reviewed memory is available after explicit recall.',
            },
          ],
        },
      });
      const toolResultContent = extractToolResultContent(result.history);
      expect(toolResultContent).toContain(
        'Synthetic reviewed memory is available after explicit recall.'
      );
      for (const canary of SYNTHETIC_DOGFOOD_RAW_CANARIES) {
        expect(toolResultContent).not.toContain(canary);
      }
      const serializedGatewayResult = JSON.stringify(gatewayResult);
      for (const internal of [
        'memory_real_agent_loop_synthetic',
        'memory_id',
        'source_type',
        'synthetic-agent-loop',
        'channel_id',
        'project_id',
        'source_refs',
        'raw:synthetic:private-source-ref',
        '/tmp/mama-synthetic-private-source.txt',
        'created_at',
        'updated_at',
        'search_meta',
        'scope_order',
        'retrieval_sources',
      ]) {
        expect(serializedGatewayResult).not.toContain(internal);
        expect(toolResultContent).not.toContain(internal);
      }
    });

    it('does not echo raw recall query canaries into model-visible tool output', async () => {
      const queryCanary =
        'MAMA_SYNTHETIC_RECALL_QUERY_CANARY_DO_NOT_LEAK /tmp/mama-synthetic-query-canary';
      const { gatewayResult, result } = await runSyntheticRecallTool({
        query: queryCanary,
        scopes: [SYNTHETIC_ALLOWED_CHANNEL_SCOPE],
      });

      const serializedGatewayResult = JSON.stringify(gatewayResult);
      const toolResultContent = extractToolResultContent(result.history);
      expect(serializedGatewayResult).not.toContain(queryCanary);
      expect(toolResultContent).not.toContain(queryCanary);
      expect(serializedGatewayResult).not.toContain(
        'MAMA_SYNTHETIC_RECALL_QUERY_CANARY_DO_NOT_LEAK'
      );
      expect(toolResultContent).not.toContain('MAMA_SYNTHETIC_RECALL_QUERY_CANARY_DO_NOT_LEAK');
    });

    it('redacts raw canaries from returned recall topic and summary fields', async () => {
      const { gatewayResult, result } = await runSyntheticRecallTool({
        query: `operator/manual-memory ${SYNTHETIC_RETURNED_FIELD_CANARY}`,
        scopes: [SYNTHETIC_ALLOWED_CHANNEL_SCOPE],
      });

      const serializedGatewayResult = JSON.stringify(gatewayResult);
      const toolResultContent = extractToolResultContent(result.history);
      expect(serializedGatewayResult).not.toContain(SYNTHETIC_RETURNED_FIELD_CANARY);
      expect(toolResultContent).not.toContain(SYNTHETIC_RETURNED_FIELD_CANARY);
      expect(serializedGatewayResult).not.toContain('/tmp/mama-synthetic-returned-field');
      expect(toolResultContent).not.toContain('/tmp/mama-synthetic-returned-field');
      expect(serializedGatewayResult).toContain('[redacted]');
      expect(toolResultContent).toContain('[redacted]');
    });

    it('redacts production-shaped private strings from returned recall fields', async () => {
      const { gatewayResult, result } = await runSyntheticRecallTool({
        query: PRODUCTION_REDACTION_QUERY,
        scopes: [SYNTHETIC_ALLOWED_CHANNEL_SCOPE],
      });

      const serializedGatewayResult = JSON.stringify(gatewayResult);
      const toolResultContent = extractToolResultContent(result.history);
      for (const leak of PRODUCTION_REDACTION_LEAKS) {
        expect(serializedGatewayResult).not.toContain(leak);
        expect(toolResultContent).not.toContain(leak);
      }
      expect(serializedGatewayResult).toContain('[redacted]');
      expect(toolResultContent).toContain('[redacted]');
    });

    it('does not return memory for wrong project, wrong channel, or broad scopes', async () => {
      const cases: Array<{ label: string; input: Record<string, unknown> }> = [
        {
          label: 'wrong project scope',
          input: {
            query: 'operator/manual-memory',
            scopes: [{ kind: 'project', id: 'project_other_synthetic' }],
          },
        },
        {
          label: 'wrong channel scope',
          input: {
            query: 'operator/manual-memory',
            scopes: [{ kind: 'channel', id: 'discord:C_OTHER_SYNTHETIC' }],
          },
        },
        {
          label: 'broad global scope',
          input: {
            query: 'operator/manual-memory',
            scopes: [{ kind: 'global', id: '*' }],
          },
        },
      ];

      for (const testCase of cases) {
        const { mamaApi, gatewayResult, result } = await runSyntheticRecallTool(testCase.input);

        expect(gatewayResult, testCase.label).toMatchObject({
          success: false,
          code: 'memory_scope_denied',
        });
        expect(mamaApi.recallMemory, testCase.label).not.toHaveBeenCalled();
        expect(extractToolResultContent(result.history), testCase.label).toContain(
          'memory_scope_denied'
        );
      }
    });
  });
});
