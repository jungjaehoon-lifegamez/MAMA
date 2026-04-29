import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { closeDB } from '@jungjaehoon/mama-core/db-manager';

import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';

type TraceAwareApi = MAMAApiInterface & {
  beginModelRun: ReturnType<typeof vi.fn>;
  commitModelRun: ReturnType<typeof vi.fn>;
  failModelRun: ReturnType<typeof vi.fn>;
  appendToolTrace: ReturnType<typeof vi.fn>;
  listToolTracesForRun: ReturnType<typeof vi.fn>;
};

function createApi(): TraceAwareApi {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'save_1' }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true, id: 'checkpoint_1' }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true, summary: 'checkpoint' }),
    beginModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_direct_trace',
      status: 'running',
    }),
    commitModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_direct_trace',
      status: 'committed',
    }),
    failModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_direct_trace',
      status: 'failed',
    }),
    appendToolTrace: vi.fn().mockResolvedValue({
      trace_id: 'trace_1',
      model_run_id: 'mr_parent_trace',
    }),
    listToolTracesForRun: vi.fn().mockResolvedValue([]),
  };
}

describe('Story M2.2: Gateway Tool Trace Runtime', () => {
  describe('Acceptance Criteria', () => {
    describe('AC #1: active model-run trace binding', () => {
      it('appends tool traces to the active model run without creating a direct run', async () => {
        const api = createApi();
        const executor = new GatewayToolExecutor({
          mamaApi: api,
          envelopeIssuanceMode: 'off',
        });

        const result = await executor.execute(
          'mama_search',
          { query: 'model run lineage' },
          {
            agentId: 'agent-main',
            source: 'discord',
            channelId: 'channel-1',
            executionSurface: 'model_tool',
            modelRunId: 'mr_parent_trace',
            gatewayCallId: 'gw_parent_trace',
          }
        );

        expect(result).toMatchObject({ success: true });
        expect(api.beginModelRun).not.toHaveBeenCalled();
        expect(api.commitModelRun).not.toHaveBeenCalled();
        expect(api.appendToolTrace).toHaveBeenCalledOnce();
        expect(api.appendToolTrace.mock.calls[0][0]).toMatchObject({
          model_run_id: 'mr_parent_trace',
          gateway_call_id: 'gw_parent_trace',
          tool_name: 'mama_search',
          input_summary: 'tool:mama_search',
          output_summary: 'success',
          execution_status: 'completed',
          envelope_hash: null,
        });
        expect(api.appendToolTrace.mock.calls[0][0].duration_ms).toEqual(expect.any(Number));
      });
    });

    describe('AC #2: direct model-run trace binding', () => {
      it('creates, traces, and commits a direct model run when no model run is active', async () => {
        const api = createApi();
        const executor = new GatewayToolExecutor({
          mamaApi: api,
          envelopeIssuanceMode: 'enabled',
        });

        const result = await executor.execute(
          'mama_search',
          { query: 'direct lineage' },
          {
            agentId: 'direct-agent',
            source: 'cli',
            channelId: 'local',
            executionSurface: 'direct',
          }
        );

        expect(result).toMatchObject({ success: true });
        expect(api.beginModelRun).toHaveBeenCalledOnce();
        expect(api.beginModelRun.mock.calls[0][0]).toMatchObject({
          agent_id: 'direct',
          status: 'running',
          envelope_hash: null,
          input_refs: {
            executionSurface: 'direct',
            source: 'cli',
            channelId: 'local',
          },
        });
        const gatewayCallId = api.beginModelRun.mock.calls[0][0].input_refs.gateway_call_id;
        expect(gatewayCallId).toMatch(/^gw_/);
        expect(api.appendToolTrace).toHaveBeenCalledWith(
          expect.objectContaining({
            model_run_id: 'mr_direct_trace',
            gateway_call_id: gatewayCallId,
            tool_name: 'mama_search',
            execution_status: 'completed',
          })
        );
        expect(api.commitModelRun).toHaveBeenCalledWith('mr_direct_trace', 'mama_search completed');
        expect(api.failModelRun).not.toHaveBeenCalled();
      });

      it('fails a direct model run when the tool returns success false', async () => {
        const api = createApi();
        const executor = new GatewayToolExecutor({
          mamaApi: api,
          envelopeIssuanceMode: 'enabled',
        });

        const result = await executor.execute(
          'mama_save',
          { type: 'decision', topic: 'missing reasoning', decision: 'Invalid save' },
          {
            source: 'cli',
            channelId: 'local',
            executionSurface: 'direct',
          }
        );

        expect(result.success).toBe(false);
        expect(api.appendToolTrace).toHaveBeenCalledWith(
          expect.objectContaining({
            model_run_id: 'mr_direct_trace',
            tool_name: 'mama_save',
            execution_status: 'failed',
          })
        );
        expect(api.commitModelRun).not.toHaveBeenCalled();
        expect(api.failModelRun).toHaveBeenCalledWith(
          'mr_direct_trace',
          'mama_save failed: Decision requires: topic, decision, reasoning'
        );
      });
    });

    describe('AC #3: real mama-api binding', () => {
      it('binds real mama-api model-run helpers and writes a durable tool trace', async () => {
        const dbPath = join(os.tmpdir(), `mama-tool-trace-real-${randomUUID()}.db`);
        const previousDbPath = process.env.MAMA_DB_PATH;
        const previousForceTier3 = process.env.MAMA_FORCE_TIER_3;
        const cleanup = (): void => {
          for (const file of [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]) {
            try {
              fs.unlinkSync(file);
            } catch {
              // cleanup best effort
            }
          }
        };
        await closeDB();
        cleanup();
        process.env.MAMA_DB_PATH = dbPath;
        process.env.MAMA_FORCE_TIER_3 = 'true';

        try {
          const executor = new GatewayToolExecutor({
            mamaDbPath: dbPath,
            envelopeIssuanceMode: 'enabled',
          });

          const result = await executor.execute(
            'mama_search',
            {},
            {
              source: 'cli',
              channelId: 'local',
              executionSurface: 'direct',
            }
          );

          expect(result).toMatchObject({ success: true });
          await closeDB();
          const db = new Database(dbPath);
          const run = db.prepare('SELECT model_run_id, status FROM model_runs').get() as
            | { model_run_id: string; status: string }
            | undefined;
          const trace = db
            .prepare(
              `
                SELECT model_run_id, tool_name, execution_status, gateway_call_id
                FROM tool_traces
              `
            )
            .get() as
            | {
                model_run_id: string;
                tool_name: string;
                execution_status: string;
                gateway_call_id: string;
              }
            | undefined;

          expect(run).toMatchObject({ status: 'committed' });
          expect(trace).toMatchObject({
            model_run_id: run?.model_run_id,
            tool_name: 'mama_search',
            execution_status: 'completed',
          });
          expect(trace?.gateway_call_id).toMatch(/^gw_/);
          db.close();
        } finally {
          await closeDB();
          if (previousDbPath === undefined) {
            delete process.env.MAMA_DB_PATH;
          } else {
            process.env.MAMA_DB_PATH = previousDbPath;
          }
          if (previousForceTier3 === undefined) {
            delete process.env.MAMA_FORCE_TIER_3;
          } else {
            process.env.MAMA_FORCE_TIER_3 = previousForceTier3;
          }
          cleanup();
        }
      });
    });
  });
});
