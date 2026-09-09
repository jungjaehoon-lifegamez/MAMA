import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginModelRun, listToolTraces, closeDB } from '@jungjaehoon/mama-core';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';
import Database from '../../src/sqlite.js';
import { ProcedureStore } from '../../src/operator/procedure-store.js';
import {
  captureExecutionEvidence,
  safeExperienceSummary,
  traceReadScope,
} from '../../src/operator/experience-evidence.js';

describe('TG-03/TG-05 execution experience evidence', () => {
  it('preserves the actual failing argument and error without prescribing a fix', () => {
    const evidence = captureExecutionEvidence(
      { allowedTools: ['tool_search'], code: 'tool_search({limit: 6})' },
      {
        success: false,
        error: 'Unknown Code-Act tool pattern in requestedAllowedTools: tool_search',
      }
    );
    expect(evidence).toMatchObject({
      completeness: 'complete',
      input: { allowedTools: ['tool_search'] },
      result: {
        success: false,
        error: 'Unknown Code-Act tool pattern in requestedAllowedTools: tool_search',
      },
    });
    expect(evidence).not.toHaveProperty('nextAction');
  });

  it('withholds credential-shaped content and marks evidence incomplete', () => {
    const secret = 'sk-' + 'a'.repeat(32);
    const evidence = captureExecutionEvidence({ code: `use('${secret}')` }, { success: false });
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(evidence.completeness).toBe('redacted');
    expect(evidence.input).toBeNull();
  });

  it('withholds secret-bearing object fields and does not silently truncate large evidence', () => {
    expect(
      captureExecutionEvidence({ password: 'private-value' }, { success: true }).completeness
    ).toBe('redacted');
    const result = captureExecutionEvidence({}, { text: 'a'.repeat(70_000) });
    expect(result.completeness).toBe('oversized');
    expect(result.result).toBeNull();
    expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redacts credentials inside code, serialized output, and discoverable summaries', () => {
    for (const text of [
      'login({password:"private-value"})',
      '{"password":"private-value"}',
      'login --password private-value',
    ]) {
      expect(captureExecutionEvidence({ code: text }, {}).completeness).toBe('redacted');
      expect(captureExecutionEvidence({}, { stdout: text }).completeness).toBe('redacted');
      expect(safeExperienceSummary(text)).not.toContain('private-value');
    }
  });

  it('keeps owner evidence shared within its project but member evidence channel-bound', () => {
    expect(
      traceReadScope({ ownerScope: 'owner:runtime', projectId: 'p', channelId: 'chat' })
    ).toEqual({ owner_scope: 'owner:runtime', project_id: 'p' });
    expect(traceReadScope({ ownerScope: 'member:a', projectId: 'p', channelId: 'chat' })).toEqual({
      owner_scope: 'member:a',
      project_id: 'p',
      channel_id: 'chat',
    });
    expect(() => traceReadScope({ ownerScope: 'member:a', projectId: 'p' })).toThrow(/channel/);
  });

  it('TG-03/TG-05 exposes actual failed/successful Code-Act evidence and next-run hints', async () => {
    const home = mkdtempSync(join(tmpdir(), 'experience-gateway-'));
    const oldPath = process.env.MAMA_DB_PATH;
    const oldTier = process.env.MAMA_FORCE_TIER_3;
    await closeDB();
    process.env.MAMA_DB_PATH = join(home, 'memory.db');
    process.env.MAMA_FORCE_TIER_3 = 'true';
    const operatorDb = new Database(':memory:');
    try {
      const run = await beginModelRun({ model_id: 'fixture', agent_id: 'owner:runtime' });
      const executor = new GatewayToolExecutor({
        mamaDbPath: join(home, 'memory.db'),
      });
      executor.setProcedureStore(new ProcedureStore(operatorDb));
      const state: GatewayToolExecutionContext = {
        executionSurface: 'model_tool',
        modelRunId: run.model_run_id,
        source: 'telegram',
        channelId: 'fixture:owner',
        sourceMessageRef: 'fixture:message',
        envelope: makeSignedEnvelope(),
        agentContext: {
          principalId: 'owner:fixture',
          roleName: 'owner_console',
          role: {
            ...DEFAULT_ROLES.definitions.owner_console,
            allowedTools: ['*'],
            blockedTools: [],
          },
          platform: 'telegram',
          source: 'telegram',
          capabilities: [],
          limitations: [],
          session: {
            sessionId: 'owner:runtime',
            channelId: 'fixture:owner',
            startedAt: new Date(),
          },
        },
      };
      const failed = await executor.execute(
        'code_act',
        { allowedTools: ['tool_search'], code: 'tool_search({limit: 1})' },
        state
      );
      expect(failed).toMatchObject({ success: false, experience_ref: expect.any(String) });
      const completed = await executor.execute(
        'code_act',
        { code: 'tool_search({limit: 1})' },
        state
      );
      expect(completed).toMatchObject({ success: true, experience_ref: expect.any(String) });
      const failedRef = (failed as unknown as { experience_ref: string }).experience_ref;
      const detail = await executor.execute('experience_read', { trace_id: failedRef }, state);
      expect(detail).toMatchObject({ success: true, behaviorVerified: false, next_offset: null });
      expect(JSON.parse((detail as unknown as { content: string }).content)).toMatchObject({
        input: { allowedTools: ['tool_search'] },
        result: { success: false },
        completeness: 'complete',
      });
      await closeDB();
      const replacement = new GatewayToolExecutor({
        mamaDbPath: join(home, 'memory.db'),
      });
      replacement.setProcedureStore(new ProcedureStore(operatorDb));
      // A new run is not handed a list of recent traces to investigate; evidence stays
      // behind experience_read and the experience_ref each tool result carried.
      const hints = replacement.prepareProcedureContext(
        { ...state, modelRunId: 'next-run' },
        { threadId: 'next-thread', fresh: true }
      );
      expect(hints.text).not.toContain(failedRef);
      expect(hints.text).not.toContain('allowedTools');
      const skills = await replacement.execute(
        'experience_read',
        { kind: 'skills', offset: 0, limit: 1 },
        state
      );
      expect(skills).toMatchObject({
        success: true,
        skills: expect.any(Array),
        total: expect.any(Number),
      });
      const executionPage = await replacement.execute(
        'experience_read',
        { kind: 'executions', limit: 1 },
        state
      );
      expect(executionPage).toMatchObject({ success: true, traces: expect.any(Array) });
      // The list page bound is validated like the trace offset/chars, not cast through.
      for (const limit of [0, 101, 1.5, '5']) {
        await expect(
          replacement.execute('experience_read', { kind: 'executions', limit }, state)
        ).rejects.toThrow('Execution evidence limit invalid');
      }
      const scope = traceReadScope({
        ownerScope: 'owner:runtime',
        projectId: state.envelope!.scope.project_refs[0].id,
      });
      const beforeInspection = await listToolTraces({ ...scope, evidence_only: true });
      const inspected = await replacement.execute(
        'code_act',
        { code: `experience_read({trace_id:${JSON.stringify(failedRef)}})` },
        state
      );
      expect(inspected).toMatchObject({ success: true });
      expect(inspected).not.toHaveProperty('experience_ref');
      expect(
        (await listToolTraces({ ...scope, evidence_only: true })).traces.map((row) => row.trace_id)
      ).toEqual(beforeInspection.traces.map((row) => row.trace_id));
      await expect(
        replacement.execute(
          'experience_read',
          { trace_id: failedRef, owner_scope: 'owner:runtime' },
          state
        )
      ).rejects.toThrow(/scope is host-owned/);
    } finally {
      await closeDB();
      operatorDb.close();
      if (oldPath === undefined) delete process.env.MAMA_DB_PATH;
      else process.env.MAMA_DB_PATH = oldPath;
      if (oldTier === undefined) delete process.env.MAMA_FORCE_TIER_3;
      else process.env.MAMA_FORCE_TIER_3 = oldTier;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
