import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import { EntityAuditRunQueue } from '../../src/api/entity-audit-queue.js';
import { createEntityAuditHandler } from '../../src/api/entity-audit-handler.js';

function createMockRequest(input: {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  rawBody?: Buffer;
  remoteAddress?: string;
}): IncomingMessage {
  const stream = new Readable({
    read() {
      if (input.rawBody) {
        this.push(input.rawBody);
        this.push(null);
        return;
      }
      if (input.body !== undefined) {
        this.push(JSON.stringify(input.body));
      }
      this.push(null);
    },
  }) as IncomingMessage;
  Object.assign(stream, {
    method: input.method,
    url: input.url,
    headers: {},
    socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1' },
  });
  return stream;
}

function createMockResponse(): {
  res: ServerResponse;
  getStatus: () => number;
  readJson: () => unknown;
} {
  let statusCode = 200;
  let payload = '';
  const res = {
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: string) {
      payload = chunk ?? '';
      return this;
    },
    setHeader() {},
  } as unknown as ServerResponse;
  return {
    res,
    getStatus: () => statusCode,
    readJson: () => (payload ? JSON.parse(payload) : null),
  };
}

describe('Story E1.11: entity audit handler', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-audit-handler');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM entity_audit_findings').run();
    adapter.prepare('DELETE FROM entity_audit_metrics').run();
    adapter.prepare('DELETE FROM entity_audit_runs').run();
  });

  describe('Acceptance Criteria', () => {
    it('AC #1: POST /audit/run returns 202 with run_id', async () => {
      const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
      const handler = createEntityAuditHandler({ queue });

      const req = createMockRequest({ method: 'POST', url: '/api/entities/audit/run', body: {} });
      const res = createMockResponse();
      await handler.handleStartAuditRun(req, res.res);

      expect(res.getStatus()).toBe(202);
      const body = res.readJson() as { run_id: string };
      expect(body.run_id).toMatch(/^audit_/);
    });

    it('AC #2: POST /audit/run triggers the background audit callback with the new run id', async () => {
      const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
      const runAuditInBackground = vi.fn();
      const handler = createEntityAuditHandler({ queue, runAuditInBackground });

      const req = createMockRequest({ method: 'POST', url: '/api/entities/audit/run', body: {} });
      const res = createMockResponse();
      await handler.handleStartAuditRun(req, res.res);

      expect(res.getStatus()).toBe(202);
      const body = res.readJson() as { run_id: string };
      expect(runAuditInBackground).toHaveBeenCalledWith(body.run_id);
    });

    it('AC #3: POST /audit/run returns 409 when a run is already in progress', async () => {
      const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
      const handler = createEntityAuditHandler({ queue });

      await handler.handleStartAuditRun(
        createMockRequest({ method: 'POST', url: '/api/entities/audit/run', body: {} }),
        createMockResponse().res
      );

      const res = createMockResponse();
      await handler.handleStartAuditRun(
        createMockRequest({ method: 'POST', url: '/api/entities/audit/run', body: {} }),
        res.res
      );
      expect(res.getStatus()).toBe(409);
      const body = res.readJson() as { error: { code: string } };
      expect(body.error.code).toBe('entity.audit_run_in_progress');
    });

    it('AC #4: GET /audit/runs lists runs ordered by created_at DESC', async () => {
      let clock = 1_700_000_000_000;
      const queue = new EntityAuditRunQueue({
        adapter: getAdapter(),
        now: () => clock,
      });
      const handler = createEntityAuditHandler({ queue });
      const first = queue.enqueue({ reason: 'first' });
      clock += 1;
      queue.complete(first.run_id, { classification: 'inconclusive', metric_summary: {} });
      clock += 1;
      const second = queue.enqueue({ reason: 'second' });

      const res = createMockResponse();
      await handler.handleListAuditRuns(
        createMockRequest({ method: 'GET', url: '/api/entities/audit/runs' }),
        res.res
      );
      expect(res.getStatus()).toBe(200);
      const body = res.readJson() as { runs: Array<{ id: string }> };
      expect(body.runs[0]?.id).toBe(second.run_id);
      expect(body.runs[1]?.id).toBe(first.run_id);
    });

    it('AC #5: GET /audit/runs/:id returns 404 for unknown run', async () => {
      const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
      const handler = createEntityAuditHandler({ queue });
      const res = createMockResponse();
      await handler.handleGetAuditRun(
        createMockRequest({
          method: 'GET',
          url: '/api/entities/audit/runs/audit_missing',
        }),
        res.res
      );
      expect(res.getStatus()).toBe(404);
    });

    it('AC #6: GET /audit/runs/:id returns run detail + parsed metrics', async () => {
      const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
      const handler = createEntityAuditHandler({ queue });
      const { run_id } = queue.enqueue();
      queue.complete(run_id, {
        classification: 'stable',
        metric_summary: { false_merge_rate: 0.01 },
      });

      const res = createMockResponse();
      await handler.handleGetAuditRun(
        createMockRequest({
          method: 'GET',
          url: `/api/entities/audit/runs/${run_id}`,
        }),
        res.res
      );
      expect(res.getStatus()).toBe(200);
      const body = res.readJson() as {
        id: string;
        status: string;
        classification: string;
        metrics: { false_merge_rate: number };
      };
      expect(body.id).toBe(run_id);
      expect(body.status).toBe('complete');
      expect(body.classification).toBe('stable');
      expect(body.metrics.false_merge_rate).toBe(0.01);
    });

    it('AC #7: GET /audit/runs/:id throws on malformed persisted metrics JSON', async () => {
      const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
      const handler = createEntityAuditHandler({ queue });
      const { run_id } = queue.enqueue();
      getAdapter()
        .prepare(
          `
            UPDATE entity_audit_runs
            SET status = 'complete', metric_summary_json = ?, completed_at = ?
            WHERE id = ?
          `
        )
        .run('{bad-json', Date.now(), run_id);

      await expect(
        handler.handleGetAuditRun(
          createMockRequest({
            method: 'GET',
            url: `/api/entities/audit/runs/${run_id}`,
          }),
          createMockResponse().res
        )
      ).rejects.toThrow(/metric_summary_json/i);
    });

    it('AC #8: rejects oversized multibyte request bodies using the byte limit', async () => {
      const queue = new EntityAuditRunQueue({ adapter: getAdapter() });
      const handler = createEntityAuditHandler({ queue });
      const oversized = Buffer.from(`{"note":"${'\\uAC00'.repeat(400000)}"}`, 'utf8');
      const res = createMockResponse();

      await handler.handleStartAuditRun(
        createMockRequest({
          method: 'POST',
          url: '/api/entities/audit/run',
          rawBody: oversized,
        }),
        res.res
      );

      expect(res.getStatus()).toBe(400);
      const body = res.readJson() as { error: { message: string } };
      expect(body.error.message).toContain('Request body too large');
    });
  });
});
