import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  AuditRunInProgressError,
  EntityAuditRunQueue,
  type EntityAuditQueueAdapter,
} from './entity-audit-queue.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

function parseRunIdFromPath(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('runs');
  if (idx < 0 || idx + 1 >= parts.length) {
    return null;
  }
  const id = parts[idx + 1];
  return id ?? null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const pre = (req as unknown as { body?: Record<string, unknown> }).body;
  if (pre && typeof pre === 'object') {
    return pre;
  }
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export interface EntityAuditHandlerDeps {
  queue: EntityAuditRunQueue;
  runAuditInBackground?: (runId: string) => void;
}

export function createEntityAuditHandler(deps: EntityAuditHandlerDeps) {
  return {
    async handleStartAuditRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        await readBody(req);
      } catch (err) {
        json(res, 400, {
          error: {
            code: 'entity.invalid_request',
            message: err instanceof Error ? err.message : 'invalid body',
          },
        });
        return;
      }
      try {
        const { run_id } = deps.queue.enqueue();
        if (deps.runAuditInBackground) {
          deps.runAuditInBackground(run_id);
        }
        json(res, 202, { run_id });
      } catch (err) {
        if (err instanceof AuditRunInProgressError) {
          json(res, 409, err.toErrorEnvelope());
          return;
        }
        throw err;
      }
    },

    async handleListAuditRuns(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = parseUrl(req);
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 25) || 25));
      const runs = deps.queue.list(limit);
      json(res, 200, { runs });
    },

    async handleGetAuditRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = parseUrl(req);
      const runId = parseRunIdFromPath(url);
      if (!runId) {
        json(res, 400, {
          error: { code: 'entity.invalid_request', message: 'missing run id' },
        });
        return;
      }
      const run = deps.queue.getStatus(runId);
      if (!run) {
        json(res, 404, {
          error: { code: 'entity.audit_run_not_found', message: `run ${runId} not found` },
        });
        return;
      }
      let metrics: unknown = null;
      if (run.metric_summary_json) {
        try {
          metrics = JSON.parse(run.metric_summary_json);
        } catch {
          metrics = null;
        }
      }
      json(res, 200, { ...run, metrics });
    },
  };
}

export function buildDefaultAuditHandlerDeps(
  adapter: EntityAuditQueueAdapter
): EntityAuditHandlerDeps {
  const queue = new EntityAuditRunQueue({ adapter });
  return { queue };
}
