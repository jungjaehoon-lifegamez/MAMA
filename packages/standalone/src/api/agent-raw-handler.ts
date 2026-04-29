import express, { type Request, type Response, type Router } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

import type { EnvelopeAuthority } from '../envelope/authority.js';
import type { MemoryScope } from '../envelope/types.js';
import {
  deriveWorkerEnvelopeVisibility,
  loadWorkerEnvelope,
  WorkerEnvelopeError,
} from './worker-envelope.js';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    error: (...args: unknown[]) => void;
  };
};
const rawApiLogger = new DebugLogger('AgentRawAPI');

interface RawQueryStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface RawQueryAdapter {
  prepare: (sql: string) => RawQueryStatement;
}

interface RawQueryModule {
  searchRaw: (adapter: RawQueryAdapter, input: RawSearchInput) => RawSearchResult;
  searchAllRaw: (adapter: RawQueryAdapter, input: RawSearchInput) => RawSearchResult;
  getRawById: (
    adapter: RawQueryAdapter,
    rawId: string,
    visibility: Pick<RawSearchInput, 'connectors' | 'scopes'>
  ) => RawSearchHit | null;
  getRawWindow: (
    adapter: RawQueryAdapter,
    rawId: string,
    input: Pick<RawSearchInput, 'connectors' | 'scopes'> & { before?: number; after?: number }
  ) => { target: RawSearchHit; items: RawSearchHit[] } | null;
}

interface RawSearchInput {
  query: string;
  connectors?: string[];
  scopes?: MemoryScope[];
  fromMs?: number;
  toMs?: number;
  cursor?: string;
  limit?: number;
}

interface RawSearchHit {
  raw_id: string;
  connector: string;
  source_id: string;
  channel_id: string | null;
  author_label: string | null;
  created_at: string | null;
  content_preview: string;
  score: number;
  source_ref: string | null;
  metadata: Record<string, unknown>;
}

interface RawSearchResult {
  hits: RawSearchHit[];
  next_cursor: string | null;
}

export interface AgentRawRouterOptions {
  memoryDb: RawQueryAdapter;
  envelopeAuthority?: EnvelopeAuthority;
  rawQuery?: RawQueryModule;
}

export function createAgentRawRouter(options: AgentRawRouterOptions): Router {
  const router = express.Router();

  router.get('/search', async (req, res) => {
    await handleRawRequest(req, res, options, async (rawQuery, visibility) => {
      const input = parseSearchInput(req, visibility);
      if (!input.connectors || input.connectors.length !== 1) {
        throw new WorkerEnvelopeError(
          400,
          'raw_connector_required',
          'raw.search requires exactly one connector.'
        );
      }
      return rawQuery.searchRaw(options.memoryDb, input);
    });
  });

  router.get('/search-all', async (req, res) => {
    await handleRawRequest(req, res, options, async (rawQuery, visibility) => {
      const input = parseSearchInput(req, visibility);
      return rawQuery.searchAllRaw(options.memoryDb, input);
    });
  });

  router.get('/:rawId/window', async (req, res) => {
    await handleRawRequest(req, res, options, async (rawQuery, visibility) => {
      const before = parseBoundedInteger(req.query.before, 'before');
      const after = parseBoundedInteger(req.query.after, 'after');
      const result = rawQuery.getRawWindow(options.memoryDb, req.params.rawId, {
        connectors: visibility.connectors,
        scopes: visibility.scopes,
        before,
        after,
      });
      if (!result) {
        res.status(404).json({
          error: true,
          code: 'raw_not_found',
          message: 'Raw event is not visible to this worker envelope.',
        });
        return undefined;
      }
      return result;
    });
  });

  router.get('/:rawId', async (req, res) => {
    await handleRawRequest(req, res, options, async (rawQuery, visibility) => {
      const hit = rawQuery.getRawById(options.memoryDb, req.params.rawId, {
        connectors: visibility.connectors,
        scopes: visibility.scopes,
      });
      if (!hit) {
        res.status(404).json({
          error: true,
          code: 'raw_not_found',
          message: 'Raw event is not visible to this worker envelope.',
        });
        return undefined;
      }
      return hit;
    });
  });

  return router;
}

async function handleRawRequest(
  req: Request,
  res: Response,
  options: AgentRawRouterOptions,
  handler: (
    rawQuery: RawQueryModule,
    visibility: { connectors: string[]; scopes: MemoryScope[] }
  ) => Promise<unknown>
): Promise<void> {
  try {
    const envelope = loadWorkerEnvelope(req, options.envelopeAuthority);
    const visibility = deriveWorkerEnvelopeVisibility(envelope, {
      connectors: parseConnectors(req),
      scopes: parseScopes(req),
    });
    const rawQuery = await loadRawQueryModule(options.rawQuery);
    const payload = await handler(rawQuery, visibility);
    if (payload !== undefined) {
      res.json(payload);
    }
  } catch (err) {
    sendRawError(res, err);
  }
}

function parseSearchInput(
  req: Request,
  visibility: { connectors: string[]; scopes: MemoryScope[] }
): RawSearchInput {
  const query = firstString(req.query.query)?.trim();
  if (!query) {
    throw new WorkerEnvelopeError(400, 'raw_query_required', 'query is required.');
  }
  return {
    query,
    connectors: visibility.connectors,
    scopes: visibility.scopes,
    fromMs: parseOptionalNumber(req.query.fromMs, 'fromMs'),
    toMs: parseOptionalNumber(req.query.toMs, 'toMs'),
    cursor: firstString(req.query.cursor),
    limit: parseBoundedInteger(req.query.limit, 'limit'),
  };
}

function parseConnectors(req: Request): string[] | undefined {
  const connectorValues = [
    ...stringValues(req.query.connector),
    ...stringValues(req.query.connectors).flatMap((value) => value.split(',')),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return connectorValues.length > 0 ? [...new Set(connectorValues)] : undefined;
}

function parseScopes(req: Request): MemoryScope[] | undefined {
  const rawValues = stringValues(req.query.scope).concat(stringValues(req.query.scopes));
  if (rawValues.length === 0) {
    const kind = firstString(req.query.scope_kind);
    const id = firstString(req.query.scope_id);
    return kind && id ? [{ kind: parseScopeKind(kind), id }] : undefined;
  }

  const scopes: MemoryScope[] = [];
  for (const rawValue of rawValues) {
    const pieces = rawValue.trim().startsWith('[')
      ? parseJsonScopes(rawValue)
      : rawValue
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
    for (const piece of pieces) {
      const [kind, ...idParts] = piece.split(':');
      const id = idParts.join(':');
      if (kind && id) {
        scopes.push({ kind: parseScopeKind(kind), id });
      }
    }
  }
  return scopes.length > 0 ? scopes : undefined;
}

function parseJsonScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('expected array');
    }
    return parsed.map((scope) => {
      if (
        scope === null ||
        typeof scope !== 'object' ||
        typeof (scope as Record<string, unknown>).kind !== 'string' ||
        typeof (scope as Record<string, unknown>).id !== 'string'
      ) {
        throw new Error('expected {kind,id} objects');
      }
      return `${(scope as { kind: string }).kind}:${(scope as { id: string }).id}`;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkerEnvelopeError(400, 'raw_scope_invalid', `Invalid scopes JSON: ${message}`);
  }
}

function parseScopeKind(value: string): MemoryScope['kind'] {
  if (value === 'global' || value === 'user' || value === 'channel' || value === 'project') {
    return value;
  }
  throw new WorkerEnvelopeError(400, 'raw_scope_invalid', `Invalid scope kind: ${value}`);
}

function parseOptionalNumber(value: unknown, name: string): number | undefined {
  const raw = firstString(value);
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new WorkerEnvelopeError(400, 'raw_query_invalid', `${name} must be numeric.`);
  }
  return parsed;
}

function parseBoundedInteger(value: unknown, name: string): number | undefined {
  const parsed = parseOptionalNumber(value, name);
  if (parsed === undefined) {
    return undefined;
  }
  return Math.max(0, Math.floor(parsed));
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}

async function loadRawQueryModule(rawQuery: RawQueryModule | undefined): Promise<RawQueryModule> {
  if (rawQuery) {
    return rawQuery;
  }
  return (await import('@jungjaehoon/mama-core/connectors/raw-query')) as RawQueryModule;
}

function sendRawError(res: Response, err: unknown): void {
  if (err instanceof WorkerEnvelopeError) {
    res.status(err.status).json({
      error: true,
      code: err.code,
      message: err.message,
    });
    return;
  }

  rawApiLogger.error('Unexpected raw API error:', err);
  res.status(500).json({
    error: true,
    code: 'raw_api_error',
    message: 'Internal server error',
  });
}
