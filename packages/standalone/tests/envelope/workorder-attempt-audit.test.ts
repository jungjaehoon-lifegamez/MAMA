import { describe, expect, it } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolExecutionContext, GatewayToolInput } from '../../src/agent/types.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';

function readLatestAuditDetails(db: SQLiteDatabase): {
  gatewayCallId: string | null;
  details: Record<string, unknown>;
} {
  const row = db
    .prepare(
      `SELECT gateway_call_id, details
       FROM agent_activity
       WHERE type = 'gateway_tool_call'
       ORDER BY id DESC
       LIMIT 1`
    )
    .get() as { gateway_call_id: string | null; details: string };
  return {
    gatewayCallId: row.gateway_call_id,
    details: JSON.parse(row.details) as Record<string, unknown>,
  };
}

describe('Story A1: workorder attempt gateway audit', () => {
  it('records only the trusted attempt id and excludes model input content', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const executor = new GatewayToolExecutor();
    executor.setSessionsDb(db);
    const context: GatewayToolExecutionContext = {
      agentId: 'workorder-board',
      source: 'operator',
      channelId: 'worker:board',
      executionSurface: 'model_tool',
      workorderAttemptId: 148,
    };
    const sensitiveSentinel = 'PRIVATE_TOOL_PAYLOAD_MUST_NOT_REACH_AUDIT_DETAILS';

    await executor.execute(
      'agent_notices',
      {
        limit: 1,
        sensitive_note: sensitiveSentinel,
        workorderAttemptId: 999,
        workorder_attempt_id: 999,
      } as GatewayToolInput,
      context
    );

    const audit = readLatestAuditDetails(db);
    expect(audit.details.workorder_attempt_id).toBe(148);
    expect(audit.details.workorder_attempt_id).not.toBe(999);
    expect(audit.gatewayCallId).toMatch(/^gw_/);
    expect(JSON.stringify(audit.details)).not.toContain(sensitiveSentinel);
    db.close();
  });

  it('does not invent an attempt id from spoofed model input or fallback context', async () => {
    const db = new Database(':memory:');
    initAgentTables(db);
    const executor = new GatewayToolExecutor();
    executor.setSessionsDb(db);
    executor.setCurrentAgentContext('chat-bot', 'telegram', 'chat-1');

    await executor.execute(
      'agent_notices',
      {
        limit: 1,
        workorderAttemptId: 999,
        workorder_attempt_id: 999,
      } as GatewayToolInput,
      {
        source: 'telegram',
        channelId: 'chat-1',
        executionSurface: 'model_tool',
      }
    );

    const audit = readLatestAuditDetails(db);
    expect(audit.details).not.toHaveProperty('workorder_attempt_id');
    db.close();
  });
});
