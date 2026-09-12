import express, { type Request, type Response, type Router } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

import type { EnvelopeAuthority } from '../envelope/authority.js';
import type { MemoryScope } from '../envelope/types.js';
import type { RawStore } from '@jungjaehoon/mama-core/storage/source-archive';
import {
  deriveWorkerEnvelopeVisibility,
  loadWorkerEnvelope,
  WorkerEnvelopeError,
} from './worker-envelope.js';
import { narrowGrantToEnvelope } from '../evidence/read.js';

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
  ) => RawDocument | null;
  getRawWindow: (
    adapter: RawQueryAdapter,
    rawId: string,
    input: Pick<RawSearchInput, 'connectors' | 'scopes'> & { before?: number; after?: number }
  ) => { target: RawSearchHit; items: RawSearchHit[] } | null;
  getRawHistory: (adapter: RawQueryAdapter, input: RawHistoryInput) => RawSearchResult;
}

interface RawHistoryInput {
  entityId?: string;
  rawId?: string;
  connectors?: string[];
  scopes?: MemoryScope[];
  fromMs?: number;
  toMs?: number;
  limit?: number;
  cursor?: string;
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
  source_at: string | null;
  observed_at: string | null;
  content_preview: string;
  score: number;
  source_ref: string | null;
  metadata: Record<string, unknown>;
  observation_ref: string | null;
}

interface RawDocument extends RawSearchHit {
  content: string;
}

interface RawSearchResult {
  hits: RawSearchHit[];
  next_cursor: string | null;
}

export interface AgentRawRouterOptions {
  memoryDb: RawQueryAdapter;
  envelopeAuthority?: EnvelopeAuthority;
  rawQuery?: RawQueryModule;
  rawStore?: RawStore;
  channelGrant?: () => Record<string, readonly string[]>;
}

interface ObservationModule {
  isObservationVersionVisible: (
    adapter: RawQueryAdapter,
    id: string,
    authority: {
      principalId?: string;
      agentId?: string;
      scopes?: readonly MemoryScope[];
      connectors?: readonly string[];
      channels?: Readonly<Record<string, readonly string[]>>;
    }
  ) => boolean;
  searchOwnerObservationVersions: (
    adapter: RawQueryAdapter,
    input: {
      query: string;
      principalId: string;
      agentId: string;
      connectors?: string[];
      connectorChannels?: Readonly<Record<string, readonly string[]>>;
      fromMs?: number;
      toMs?: number;
      cursor?: string;
      limit?: number;
    }
  ) => unknown;
  readObservationVersion: (
    adapter: RawQueryAdapter,
    id: string,
    reader?: {
      readVersion(input: {
        connectorName: string;
        revisionSourceId: string;
        expectedContentHash: string;
      }): unknown;
    }
  ) =>
    | { status: 'not_found' }
    | {
        status: 'version_unavailable';
        reason: string;
        observation: { sourceConnector: string; scope: Record<string, unknown> };
      }
    | {
        status: 'available';
        body: string;
        observation: { sourceConnector: string; scope: Record<string, unknown> };
      };
}

export function createAgentObservationRouter(options: AgentRawRouterOptions): Router {
  const router = express.Router();
  router.get('/search', async (req, res) => {
    try {
      const envelope = loadWorkerEnvelope(req, options.envelopeAuthority);
      const principalId = envelope.scope.principal_id?.trim();
      if (!principalId) {
        throw new WorkerEnvelopeError(
          403,
          'owner_principal_required',
          'Owner observation search requires a signed principal.'
        );
      }
      deriveWorkerEnvelopeVisibility(envelope, {
        connectors: parseConnectors(req),
        scopes: parseScopes(req),
      });
      const observationModule =
        (await import('@jungjaehoon/mama-core')) as unknown as ObservationModule;
      const ownerVisibility = signedOwnerObservationVisibility(envelope);
      res.json(
        observationModule.searchOwnerObservationVersions(options.memoryDb, {
          query: firstString(req.query.query) ?? '',
          principalId,
          agentId: envelope.agent_id,
          connectors: [
            `owner-message:${ownerVisibility.connector}`,
            `owner-result:${ownerVisibility.connector}`,
          ],
          connectorChannels: ownerVisibility.channels,
          fromMs: parseOptionalTime(req.query.from, 'from'),
          toMs: parseOptionalTime(req.query.to, 'to'),
          cursor: firstString(req.query.cursor),
          limit: parseBoundedInteger(req.query.limit, 'limit'),
        })
      );
    } catch (err) {
      sendRawError(res, err);
    }
  });
  router.get('/:observationId', async (req, res) => {
    try {
      const envelope = loadWorkerEnvelope(req, options.envelopeAuthority);
      const visibility = deriveWorkerEnvelopeVisibility(envelope, {
        connectors: parseConnectors(req),
        scopes: parseScopes(req),
      });
      const observationModule =
        (await import('@jungjaehoon/mama-core')) as unknown as ObservationModule;
      const header = options.memoryDb
        .prepare('SELECT source_connector FROM observation_versions WHERE observation_id = ?')
        .get(req.params.observationId) as { source_connector?: unknown } | undefined;
      if (!header) {
        res.status(404).json({ error: true, code: 'observation_not_found' });
        return;
      }
      if (typeof header.source_connector !== 'string' || !header.source_connector.trim()) {
        throw new Error('observation_versions.source_connector must be nonblank text');
      }
      const ownerObservation = header.source_connector.startsWith('owner-');
      const ownerVisibility = ownerObservation
        ? signedOwnerObservationVisibility(envelope)
        : undefined;
      const channels = ownerVisibility
        ? ownerVisibility.channels
        : options.channelGrant
          ? narrowGrantToEnvelope(options.channelGrant(), {
              connectors: envelope.scope.raw_connectors,
              scopes: envelope.scope.memory_scopes,
            })
          : undefined;
      if (
        !observationModule.isObservationVersionVisible(options.memoryDb, req.params.observationId, {
          principalId: envelope.scope.principal_id,
          agentId: envelope.agent_id,
          scopes: visibility.scopes,
          connectors: ownerVisibility ? [ownerVisibility.connector] : visibility.connectors,
          channels,
        })
      ) {
        res.status(404).json({ error: true, code: 'observation_not_found' });
        return;
      }
      const result = observationModule.readObservationVersion(
        options.memoryDb,
        req.params.observationId,
        options.rawStore
          ? {
              readVersion: ({ connectorName, revisionSourceId, expectedContentHash }) =>
                options.rawStore!.readVersion(connectorName, revisionSourceId, expectedContentHash),
            }
          : undefined
      );
      if (result.status === 'not_found') {
        res.status(404).json({ error: true, code: 'observation_not_found' });
        return;
      }
      if (result.status === 'version_unavailable') {
        res.status(409).json({ error: true, code: result.reason });
        return;
      }
      res.json(result);
    } catch (err) {
      sendRawError(res, err);
    }
  });
  return router;
}

function signedOwnerObservationVisibility(envelope: ReturnType<typeof loadWorkerEnvelope>): {
  connector: string;
  channels: Record<string, readonly string[]>;
} {
  const principalId = envelope.scope.principal_id?.trim();
  const channelId = envelope.channel_id?.trim();
  if (!principalId || !channelId || !envelope.agent_id.trim()) {
    throw new WorkerEnvelopeError(
      403,
      'owner_observation_authority_required',
      'Owner observation access requires signed source, channel, principal, and agent authority.'
    );
  }
  const connector = envelope.source;
  const stripped = channelId.startsWith(`${connector}:`)
    ? channelId.slice(connector.length + 1)
    : channelId;
  return { connector, channels: { [connector]: [...new Set([channelId, stripped])] } };
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

  router.get('/:rawId/revisions', async (req, res) => {
    await handleRawRequest(req, res, options, async (rawQuery, visibility) => {
      // The change history of the anchor's upstream entity, oldest first, bounded by the SAME
      // envelope visibility as detail/window. An anchor the envelope cannot see resolves to no
      // entity, so this route can never surface revisions the reader would refuse.
      return rawQuery.getRawHistory(options.memoryDb, {
        rawId: req.params.rawId,
        connectors: visibility.connectors,
        scopes: visibility.scopes,
        limit: parseBoundedInteger(req.query.limit, 'limit'),
        cursor: firstString(req.query.cursor),
      });
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

function parseOptionalTime(value: unknown, name: string): number | undefined {
  const input = firstString(value)?.trim();
  if (!input) {
    return undefined;
  }
  const numeric = Number(input);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(input);
  if (!Number.isFinite(parsed)) {
    throw new WorkerEnvelopeError(400, 'raw_time_invalid', `${name} must be a timestamp.`);
  }
  return Math.floor(parsed);
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
