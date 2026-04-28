import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { AgentError, type GatewayToolInput, type MAMAApiInterface } from '../../src/agent/types.js';
import Database from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import { makeEnvelope } from './fixtures.js';

/*
 * M1R executor inventory before seam extraction:
 *
 * Current execute() phase order:
 * 1. optional executionContext wrapper through withExecutionContext(...)
 * 2. VALID_TOOLS unknown-tool rejection
 * 3. enforceEnvelopeForToolCall(...)
 * 4. disallowedGatewayTools rejection
 * 5. checkToolPermission(...)
 * 6. non-MAMA tool switch
 * 7. lazy MAMA API initialization
 * 8. MAMA/report/wiki/kagemusha/notice switch
 * 9. AgentError passthrough and generic TOOL_ERROR wrapping
 *
 * Current execute call-site classification:
 * - agent/agent-loop.ts model-visible calls: M1R Reactive Main
 * - agent/agent-loop.ts searchContractsForTool/PostTool/PreCompact callbacks: M1R reactive_internal
 * - agent/code-act/host-bridge.ts: M1R Reactive Main Code-Act
 * - multi-agent/multi-agent-base.ts and multi-agent/multi-agent-discord.ts: M7-owned delegated workers
 * - cli/runtime/agent-loop-init.ts wrapper must preserve full AgentLoopOptions in Task 5B
 *
 * codex/provenance-drawer-mainbase overlaps gateway-tool-executor.ts, message-router.ts,
 * standalone API/viewer modules, and mama-core case/entity migrations. M1R treats it as
 * reference only and does not import those migrations or UI/API modules.
 */

function makeMAMAApi(): MAMAApiInterface {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'decision_1', type: 'decision' }),
    saveCheckpoint: vi.fn().mockResolvedValue({
      success: true,
      id: 'checkpoint_1',
      type: 'checkpoint',
    }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true, message: 'updated' }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    recallMemory: vi.fn().mockResolvedValue({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: 'test', scope_order: [], retrieval_sources: [] },
    }),
    ingestMemory: vi.fn().mockResolvedValue({ success: true, id: 'ingested_1' }),
  };
}

function makeTelegramGateway() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue(true),
  };
}

function readActivityRows(db: Database): Array<{
  type: string;
  input_summary: string | null;
  output_summary: string | null;
  error_message: string | null;
  execution_status: string | null;
  trigger_reason: string | null;
}> {
  return db
    .prepare(
      `
      SELECT type, input_summary, output_summary, error_message, execution_status, trigger_reason
      FROM agent_activity
      ORDER BY id ASC
    `
    )
    .all() as Array<{
    type: string;
    input_summary: string | null;
    output_summary: string | null;
    error_message: string | null;
    execution_status: string | null;
    trigger_reason: string | null;
  }>;
}

describe('Story M1R: GatewayToolExecutor execute pipeline characterization', () => {
  let previousFailLoud: string | undefined;
  let previousAllowLegacyBypass: string | undefined;

  beforeEach(() => {
    previousFailLoud = process.env.MAMA_ENVELOPE_FAIL_LOUD;
    previousAllowLegacyBypass = process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
    delete process.env.MAMA_ENVELOPE_FAIL_LOUD;
    delete process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
  });

  afterEach(() => {
    if (previousFailLoud === undefined) {
      delete process.env.MAMA_ENVELOPE_FAIL_LOUD;
    } else {
      process.env.MAMA_ENVELOPE_FAIL_LOUD = previousFailLoud;
    }
    if (previousAllowLegacyBypass === undefined) {
      delete process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS;
    } else {
      process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS = previousAllowLegacyBypass;
    }
  });

  describe('AC: public execute contract stays stable during seam extraction', () => {
    it('keeps explicit executionContext visible to envelope enforcement', async () => {
      const telegramGateway = makeTelegramGateway();
      const executor = new GatewayToolExecutor({ mamaApi: makeMAMAApi() });
      executor.setTelegramGateway(telegramGateway);
      const envelope = makeEnvelope({
        source: 'telegram',
        channel_id: 'tg:OWN',
        scope: {
          project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
          raw_connectors: ['telegram'],
          memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
          allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
        },
      });

      const result = await executor.execute(
        'telegram_send',
        { chat_id: 'tg:OWN', message: 'safe' } as GatewayToolInput,
        { agentId: 'worker', source: 'telegram', channelId: 'tg:OWN', envelope }
      );

      expect(result).toMatchObject({ success: true });
      expect(telegramGateway.sendMessage).toHaveBeenCalledWith('tg:OWN', 'safe');
    });

    it('denies missing envelopes by default and records the existing incident row', async () => {
      const db = new Database(':memory:');
      initAgentTables(db);
      const mamaApi = makeMAMAApi();
      const executor = new GatewayToolExecutor({ mamaApi });
      executor.setSessionsDb(db);

      const result = await executor.execute(
        'mama_load_checkpoint',
        {},
        {
          agentId: 'worker',
          source: 'telegram',
          channelId: 'tg:1',
        }
      );

      expect(result).toMatchObject({ success: false, code: 'envelope_missing' });
      expect(mamaApi.loadCheckpoint).not.toHaveBeenCalled();
      expect(readActivityRows(db)).toEqual([
        expect.objectContaining({
          type: 'envelope_missing_denied',
          input_summary: 'mama_load_checkpoint',
          execution_status: 'failed',
          trigger_reason: 'envelope_enforcer',
        }),
      ]);
      db.close();
    });

    it('keeps the explicit legacy bypass path and records its incident row', async () => {
      process.env.MAMA_ENVELOPE_ALLOW_LEGACY_BYPASS = 'true';
      const db = new Database(':memory:');
      initAgentTables(db);
      const mamaApi = makeMAMAApi();
      const executor = new GatewayToolExecutor({ mamaApi });
      executor.setSessionsDb(db);

      const result = await executor.execute(
        'mama_load_checkpoint',
        {},
        {
          agentId: 'worker',
          source: 'telegram',
          channelId: 'tg:1',
        }
      );

      expect(result).toEqual({ success: true });
      expect(mamaApi.loadCheckpoint).toHaveBeenCalledOnce();
      expect(readActivityRows(db)).toEqual([
        expect.objectContaining({
          type: 'envelope_missing_legacy',
          input_summary: 'mama_load_checkpoint',
          execution_status: 'completed',
          trigger_reason: 'envelope_enforcer',
        }),
      ]);
      db.close();
    });

    it('throws AgentError with UNKNOWN_TOOL for unknown tools before envelope handling', async () => {
      const executor = new GatewayToolExecutor({ mamaApi: makeMAMAApi() });

      await expect(
        executor.execute('unknown_tool', {}, { agentId: 'worker', source: 'telegram' })
      ).rejects.toMatchObject({
        code: 'UNKNOWN_TOOL',
      } satisfies Partial<AgentError>);
    });

    it('returns destination envelope violations as agent-visible failures and records incident rows', async () => {
      const db = new Database(':memory:');
      initAgentTables(db);
      const telegramGateway = makeTelegramGateway();
      const executor = new GatewayToolExecutor({ mamaApi: makeMAMAApi() });
      executor.setTelegramGateway(telegramGateway);
      executor.setSessionsDb(db);
      const envelope = makeEnvelope({
        envelope_hash: 'envhash_pipeline',
        source: 'telegram',
        channel_id: 'tg:OWN',
        scope: {
          project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
          raw_connectors: ['telegram'],
          memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
          allowed_destinations: [{ kind: 'telegram', id: 'tg:OWN' }],
        },
      });

      const result = await executor.execute(
        'telegram_send',
        { chat_id: 'tg:OTHER', message: 'leak' } as GatewayToolInput,
        { agentId: 'worker', source: 'telegram', channelId: 'tg:OWN', envelope }
      );

      expect(result).toMatchObject({
        success: false,
        code: 'destination_out_of_scope',
        envelope_hash: 'envhash_pipeline',
      });
      expect(telegramGateway.sendMessage).not.toHaveBeenCalled();
      expect(readActivityRows(db)).toEqual([
        expect.objectContaining({
          type: 'envelope_violation',
          input_summary: 'telegram_send',
          output_summary: 'envelope_hash=envhash_pipeline',
          execution_status: 'failed',
          trigger_reason: 'envelope_enforcer',
        }),
      ]);
      db.close();
    });
  });
});
