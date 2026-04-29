import express, { type Router } from 'express';
import {
  getMemoryProvenanceAudit,
  listMemoryProvenanceAudit,
  type MemoryProvenanceAuditListOptions,
} from '@jungjaehoon/mama-core';

const REJECTED_SCOPE_QUERY_PARAMS = new Set(['scope', 'scopes', 'scope_kind', 'scope_id']);

export function createMemoryProvenanceRouter(): Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const rejected = firstRejectedScopeQueryParam(req.query);
      if (rejected) {
        res.status(400).json({
          error: true,
          code: 'scope_query_not_supported',
          message: `Admin provenance reads do not accept caller-supplied scope filters: ${rejected}`,
        });
        return;
      }

      const filters = buildListFilters(req.query);
      const records = await listMemoryProvenanceAudit(filters);
      res.json({ data: records });
    } catch (error) {
      res.status(400).json({
        error: true,
        code: 'invalid_provenance_query',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/:memoryId', async (req, res) => {
    const rejected = firstRejectedScopeQueryParam(req.query);
    if (rejected) {
      res.status(400).json({
        error: true,
        code: 'scope_query_not_supported',
        message: `Admin provenance reads do not accept caller-supplied scope filters: ${rejected}`,
      });
      return;
    }

    const record = await getMemoryProvenanceAudit(req.params.memoryId);
    if (!record) {
      res.status(404).json({
        error: true,
        code: 'memory_not_found',
        message: 'Memory provenance was not found.',
      });
      return;
    }
    res.json({ data: record });
  });

  return router;
}

function buildListFilters(query: Record<string, unknown>): MemoryProvenanceAuditListOptions {
  const options: MemoryProvenanceAuditListOptions = {};
  for (const key of ['envelope_hash', 'model_run_id', 'gateway_call_id'] as const) {
    const value = query[key];
    if (typeof value === 'string' && value.length > 0) {
      options[key] = value;
    }
  }

  if (typeof query.limit === 'string') {
    const limit = Number.parseInt(query.limit, 10);
    if (Number.isFinite(limit)) {
      options.limit = limit;
    }
  }

  return options;
}

function firstRejectedScopeQueryParam(query: Record<string, unknown>): string | null {
  for (const key of Object.keys(query)) {
    if (REJECTED_SCOPE_QUERY_PARAMS.has(key)) {
      return key;
    }
  }
  return null;
}
