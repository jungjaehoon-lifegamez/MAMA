import express, { type Router } from 'express';
import {
  getMemoryProvenanceAudit,
  listMemoryProvenanceAudit,
  type MemoryProvenanceAuditListOptions,
} from '@jungjaehoon/mama-core';

const REJECTED_SCOPE_QUERY_PARAMS = new Set(['scope', 'scopes', 'scope_kind', 'scope_id']);
const NUMERIC_QUERY_PATTERN = /^\d+$/;

class ProvenanceQueryValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

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
      const isValidationError = isProvenanceQueryValidationError(error);
      res.status(isValidationError ? 400 : 500).json({
        error: true,
        code: isValidationError ? 'invalid_provenance_query' : 'internal_server_error',
        message: isValidationError ? getErrorMessage(error) : 'Failed to list memory provenance.',
      });
    }
  });

  router.get('/:memoryId', async (req, res) => {
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
    } catch {
      res.status(500).json({
        error: true,
        code: 'memory_provenance_error',
        message: 'Failed to load memory provenance.',
      });
    }
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

  const filterCount = [options.envelope_hash, options.model_run_id, options.gateway_call_id].filter(
    (value) => value !== undefined
  ).length;
  if (filterCount !== 1) {
    throw new ProvenanceQueryValidationError('Exactly one provenance audit filter is required.');
  }

  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !NUMERIC_QUERY_PATTERN.test(query.limit)) {
      throw new ProvenanceQueryValidationError('Provenance audit limit must be a numeric string.');
    }
    const limit = Number.parseInt(query.limit, 10);
    options.limit = limit;
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProvenanceQueryValidationError(error: unknown): boolean {
  if (error instanceof ProvenanceQueryValidationError) {
    return true;
  }
  if (error instanceof Error && error.name === 'ValidationError') {
    return true;
  }
  if (error && typeof error === 'object') {
    return (error as { statusCode?: unknown }).statusCode === 400;
  }
  return false;
}
