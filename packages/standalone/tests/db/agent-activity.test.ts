import { describe, it, expect, beforeEach } from 'vitest';
import Database from '../../src/sqlite.js';
import * as agentStore from '../../src/db/agent-store.js';
import {
  createAgentVersion,
  initAgentTables,
  logActivity,
  getActivity,
  updateActivityScore,
} from '../../src/db/agent-store.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { AgentContext, GatewayToolInput, MAMAApiInterface } from '../../src/agent/types.js';

type AgentStoreWithTraceHelpers = typeof agentStore & {
  listGatewayToolCalls?: (
    db: Database,
    input: { envelopeHash?: string; gatewayCallId?: string; limit?: number }
  ) => agentStore.ActivityRow[];
  listScopeMismatches?: (
    db: Database,
    input: { envelopeHash?: string; limit?: number; since?: string }
  ) => agentStore.ActivityRow[];
  countScopeMismatches?: (db: Database, input: { since?: string }) => number;
};

function createMAMAApi(): MAMAApiInterface {
  return {
    save: async () => ({ success: true, id: 'decision_1', type: 'decision' }),
    saveCheckpoint: async () => ({ success: true, id: 'checkpoint_1', type: 'checkpoint' }),
    listDecisions: async () => [],
    suggest: async () => ({ success: true, results: [], count: 0 }),
    updateOutcome: async () => ({ success: true, message: 'updated' }),
    loadCheckpoint: async () => ({ success: true }),
  };
}

function createViewerContext(): AgentContext {
  return {
    source: 'viewer',
    platform: 'viewer',
    roleName: 'os_agent',
    role: {
      allowedTools: ['*'],
      systemControl: true,
      sensitiveAccess: true,
    },
    session: {
      sessionId: 'viewer-session',
      channelId: 'viewer-main',
      startedAt: new Date(),
    },
    capabilities: ['*'],
    limitations: [],
    tier: 1,
    backend: 'claude',
  };
}

describe('Story V19.6 - Agent Activity Logging', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  describe('Acceptance Criteria - schema bootstrap', () => {
    it('AC #1: creates agent_activity table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_activity'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it('AC #2: initAgentTables is idempotent with agent_activity', () => {
      initAgentTables(db);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_versions','agent_metrics','agent_activity')"
        )
        .all();
      expect(tables).toHaveLength(3);
    });

    it('AC #3: creates agent_activity with validation linkage columns', () => {
      const columns = db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === 'run_id')).toBe(true);
      expect(columns.some((column) => column.name === 'execution_status')).toBe(true);
      expect(columns.some((column) => column.name === 'trigger_reason')).toBe(true);
    });

    it('AC #3b: creates envelope audit columns and trace indexes', () => {
      const columns = db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === 'envelope_hash')).toBe(true);
      expect(columns.some((column) => column.name === 'gateway_call_id')).toBe(true);
      expect(columns.some((column) => column.name === 'requested_scopes')).toBe(true);
      expect(columns.some((column) => column.name === 'envelope_scopes_snapshot')).toBe(true);
      expect(columns.some((column) => column.name === 'scope_mismatch')).toBe(true);

      const indexes = db.prepare('PRAGMA index_list(agent_activity)').all() as Array<{
        name: string;
      }>;
      expect(indexes.some((index) => index.name === 'idx_agent_activity_envelope_hash')).toBe(true);
      expect(indexes.some((index) => index.name === 'idx_agent_activity_gateway_call_id')).toBe(
        true
      );
      expect(indexes.some((index) => index.name === 'idx_agent_activity_scope_mismatch')).toBe(
        true
      );

      const table = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_activity'")
        .get() as { sql: string };
      expect(table.sql).toContain('CHECK (scope_mismatch IN (0, 1))');
    });

    it('AC #3c: migrates old agent_activity rows without data loss', () => {
      const legacyDb = new Database(':memory:');
      legacyDb.exec(`
        CREATE TABLE agent_activity (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id         TEXT NOT NULL,
          agent_version    INTEGER NOT NULL,
          type             TEXT NOT NULL,
          input_summary    TEXT,
          output_summary   TEXT,
          tokens_used      INTEGER DEFAULT 0,
          tools_called     TEXT,
          duration_ms      INTEGER DEFAULT 0,
          score            REAL,
          details          TEXT,
          error_message    TEXT,
          run_id           TEXT,
          execution_status TEXT,
          trigger_reason   TEXT,
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      legacyDb
        .prepare(
          `INSERT INTO agent_activity (
             agent_id, agent_version, type, input_summary, execution_status
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run('legacy-agent', 1, 'task_complete', 'before migration', 'completed');

      initAgentTables(legacyDb);

      const row = legacyDb
        .prepare(
          `SELECT input_summary, envelope_hash, gateway_call_id, requested_scopes,
                  envelope_scopes_snapshot, scope_mismatch
           FROM agent_activity
           WHERE agent_id = ?`
        )
        .get('legacy-agent') as {
        input_summary: string;
        envelope_hash: string | null;
        gateway_call_id: string | null;
        requested_scopes: string | null;
        envelope_scopes_snapshot: string | null;
        scope_mismatch: number;
      };
      expect(row).toEqual({
        input_summary: 'before migration',
        envelope_hash: null,
        gateway_call_id: null,
        requested_scopes: null,
        envelope_scopes_snapshot: null,
        scope_mismatch: 0,
      });
      legacyDb.close();
    });
  });

  describe('Acceptance Criteria - activity CRUD', () => {
    it('AC #4: logs activity with details JSON', () => {
      const row = logActivity(db, {
        agent_id: 'test-agent',
        agent_version: 1,
        type: 'task_complete',
        input_summary: 'Process file X',
        output_summary: 'Matched to project A',
        tokens_used: 150,
        tools_called: ['Read', 'Bash'],
        duration_ms: 2300,
        details: { items: [{ input: 'file.mov', result: 'pass' }] },
        run_id: 'vs-123',
        execution_status: 'completed',
        trigger_reason: 'delegate_run',
      });
      expect(row.id).toBeGreaterThan(0);
      expect(row.type).toBe('task_complete');
      expect(JSON.parse(row.details!).items).toHaveLength(1);
      expect(JSON.parse(row.tools_called!)).toEqual(['Read', 'Bash']);
      expect(row.run_id).toBe('vs-123');
      expect(row.execution_status).toBe('completed');
      expect(row.trigger_reason).toBe('delegate_run');
    });

    it('AC #5: retrieves activity by agent_id newest first', () => {
      logActivity(db, { agent_id: 'a1', agent_version: 1, type: 'task_complete' });
      logActivity(db, {
        agent_id: 'a1',
        agent_version: 1,
        type: 'task_error',
        error_message: 'timeout',
      });
      logActivity(db, { agent_id: 'a2', agent_version: 1, type: 'task_complete' });

      const a1 = getActivity(db, 'a1', 10);
      expect(a1).toHaveLength(2);
      expect(a1[0].type).toBe('task_error');
    });

    it('AC #6: logs test_run with score and details', () => {
      const row = logActivity(db, {
        agent_id: 'test-agent',
        agent_version: 2,
        type: 'test_run',
        input_summary: '3 files tested',
        output_summary: '3/3 passed',
        score: 95,
        details: { total: 3, passed: 3, failed: 0, suggestion: null },
      });
      expect(row.score).toBe(95);
    });

    it('AC #7: respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        logActivity(db, { agent_id: 'dev', agent_version: 1, type: 'task_complete' });
      }
      const rows = getActivity(db, 'dev', 3);
      expect(rows).toHaveLength(3);
    });

    it('AC #7b: normalizes invalid activity limits before querying', () => {
      logActivity(db, { agent_id: 'dev', agent_version: 1, type: 'task_complete' });

      const rows = getActivity(db, 'dev', 0);

      expect(rows).toHaveLength(1);
    });

    it('AC #8: defaults tokens_used and duration_ms to 0', () => {
      const row = logActivity(db, {
        agent_id: 'dev',
        agent_version: 1,
        type: 'task_start',
      });
      expect(row.tokens_used).toBe(0);
      expect(row.duration_ms).toBe(0);
    });

    it('AC #9: updates activity score and details', () => {
      const row = logActivity(db, {
        agent_id: 'test-agent',
        agent_version: 1,
        type: 'test_run',
        input_summary: '3 items tested',
      });
      const updated = updateActivityScore(db, row.id, 85, {
        total: 3,
        passed: 2,
        failed: 1,
        items: [
          { input: 'a', result: 'pass' },
          { input: 'b', result: 'pass' },
          { input: 'c', result: 'fail' },
        ],
      });
      expect(updated.score).toBe(85);
      expect(JSON.parse(updated.details!).passed).toBe(2);
      expect(JSON.parse(updated.details!).items).toHaveLength(3);
    });

    it('AC #9b: logs and retrieves envelope audit fields', () => {
      const row = logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'gateway_tool_call',
        input_summary: 'mama_save',
        execution_status: 'completed',
        envelopeHash: 'env_hash_1',
        requestedScopes: [{ kind: 'global', id: 'system' }],
        envelopeScopesSnapshot: [{ kind: 'channel', id: 'telegram:abc' }],
        scopeMismatch: true,
      });
      expect(row).toMatchObject({
        envelope_hash: 'env_hash_1',
        scope_mismatch: 1,
      });
      expect(JSON.parse(row.requested_scopes!)).toEqual([{ kind: 'global', id: 'system' }]);

      const rowWithNumericAudit = logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'gateway_tool_call',
        scopeMismatch: 2,
      });
      expect(rowWithNumericAudit.scope_mismatch).toBe(1);

      const rowWithoutAudit = logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'task_complete',
      });
      expect(rowWithoutAudit).toMatchObject({
        envelope_hash: null,
        requested_scopes: null,
        envelope_scopes_snapshot: null,
        scope_mismatch: 0,
      });

      const [retrieved] = getActivity(db, 'trace-agent', 10, { includeTrace: true });
      expect(retrieved).toMatchObject({
        input_summary: null,
        envelope_hash: null,
        scope_mismatch: 0,
      });
    });
  });

  describe('Acceptance Criteria - envelope trace visibility', () => {
    it('AC #10: getActivity hides gateway_tool_call rows unless includeTrace is explicit', () => {
      logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'task_complete',
        input_summary: 'Visible activity',
      });
      logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'gateway_tool_call',
        input_summary: 'mama_search',
        execution_status: 'completed',
      });

      const defaultRows = getActivity(db, 'trace-agent', 10);
      expect(defaultRows.map((row) => row.type)).toEqual(['task_complete']);

      const rowsWithTrace = (
        getActivity as unknown as (
          db: Database,
          agentId: string,
          limit: number,
          options: { includeTrace: boolean }
        ) => agentStore.ActivityRow[]
      )(db, 'trace-agent', 10, { includeTrace: true });
      expect(rowsWithTrace.map((row) => row.type)).toEqual(['gateway_tool_call', 'task_complete']);
    });

    it('AC #11: agent_activity tool hides trace rows by default and returns them with include_trace', async () => {
      createAgentVersion(db, {
        agent_id: 'trace-agent',
        snapshot: { name: 'Trace Agent', tier: 2 },
      });
      logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'task_complete',
        input_summary: 'Visible activity',
      });
      logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'gateway_tool_call',
        input_summary: 'mama_search',
        execution_status: 'completed',
      });
      const executor = new GatewayToolExecutor({
        mamaApi: createMAMAApi(),
        envelopeIssuanceMode: 'off',
      });
      executor.setSessionsDb(db);
      executor.setAgentContext(createViewerContext());

      const defaultResult = (await executor.execute('agent_activity', {
        agent_id: 'trace-agent',
        limit: 10,
      } as unknown as GatewayToolInput)) as {
        success: boolean;
        activity: Array<{ type: string }>;
      };
      expect(defaultResult.activity.map((row) => row.type)).toEqual(['task_complete']);

      const traceResult = (await executor.execute('agent_activity', {
        agent_id: 'trace-agent',
        limit: 10,
        include_trace: true,
      } as unknown as GatewayToolInput)) as {
        success: boolean;
        activity: Array<{ type: string }>;
      };
      expect(traceResult.activity.map((row) => row.type)).toEqual([
        'gateway_tool_call',
        'task_complete',
      ]);
    });

    it('AC #12: exposes dedicated trace and mismatch query helpers', () => {
      const helpers = agentStore as AgentStoreWithTraceHelpers;
      expect(typeof helpers.listGatewayToolCalls).toBe('function');
      expect(typeof helpers.listScopeMismatches).toBe('function');

      logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'gateway_tool_call',
        input_summary: 'mama_save',
        execution_status: 'completed',
        envelopeHash: 'env_hash_1',
        gatewayCallId: 'gw_trace_1',
        scopeMismatch: 1,
      } as Parameters<typeof logActivity>[1] & {
        envelopeHash: string;
        scopeMismatch: number;
      });
      logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'gateway_tool_call',
        input_summary: 'mama_search',
        execution_status: 'completed',
        envelopeHash: 'env_hash_2',
        gatewayCallId: 'gw_trace_2',
        scopeMismatch: 0,
      } as Parameters<typeof logActivity>[1] & {
        envelopeHash: string;
        scopeMismatch: number;
      });

      expect(helpers.listGatewayToolCalls!(db, { envelopeHash: 'env_hash_1' })).toEqual([
        expect.objectContaining({
          input_summary: 'mama_save',
          envelope_hash: 'env_hash_1',
          gateway_call_id: 'gw_trace_1',
        }),
      ]);
      expect(helpers.listGatewayToolCalls!(db, { gatewayCallId: 'gw_trace_2' })).toEqual([
        expect.objectContaining({
          input_summary: 'mama_search',
          gateway_call_id: 'gw_trace_2',
        }),
      ]);
      expect(helpers.listScopeMismatches!(db, { envelopeHash: 'env_hash_1' })).toEqual([
        expect.objectContaining({
          input_summary: 'mama_save',
          scope_mismatch: 1,
        }),
      ]);
      expect(helpers.listScopeMismatches!(db, { gatewayCallId: 'gw_trace_1' })).toEqual([
        expect.objectContaining({
          input_summary: 'mama_save',
          gateway_call_id: 'gw_trace_1',
          scope_mismatch: 1,
        }),
      ]);
      expect(helpers.listScopeMismatches!(db, { gatewayCallId: 'gw_trace_2' })).toEqual([]);
    });

    it('AC #13: normalizes ISO since filters for scope mismatch queries', () => {
      const helpers = agentStore as AgentStoreWithTraceHelpers;
      expect(typeof helpers.listScopeMismatches).toBe('function');
      expect(typeof helpers.countScopeMismatches).toBe('function');

      logActivity(db, {
        agent_id: 'trace-agent',
        agent_version: 1,
        type: 'gateway_tool_call',
        input_summary: 'mama_save',
        execution_status: 'completed',
        envelopeHash: 'env_hash_recent',
        scopeMismatch: 1,
      } as Parameters<typeof logActivity>[1] & {
        envelopeHash: string;
        scopeMismatch: number;
      });

      const sinceIso = new Date(Date.now() - 60_000).toISOString();

      expect(helpers.listScopeMismatches!(db, { since: sinceIso })).toEqual([
        expect.objectContaining({
          input_summary: 'mama_save',
          scope_mismatch: 1,
        }),
      ]);
      expect(helpers.countScopeMismatches!(db, { since: sinceIso })).toBe(1);
    });
  });
});
