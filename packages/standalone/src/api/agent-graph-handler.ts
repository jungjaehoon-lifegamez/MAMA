import express, { type Request, type Response, type Router } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  AgentGraphValidationError,
  getGraphNeighborhood,
  getGraphPaths,
  getGraphTimeline,
  TWIN_EDGE_TYPES,
  TWIN_REF_KINDS,
  type AgentGraphAdapter,
  type TwinEdgeType,
  type TwinRef,
  type TwinRefKind,
} from '@jungjaehoon/mama-core';

import type { EnvelopeAuthority } from '../envelope/authority.js';
import { narrowGrantToEnvelope } from '../evidence/read.js';
import {
  deriveWorkerEnvelopeVisibility,
  firstString,
  loadWorkerEnvelope,
  parseRequestedConnectors,
  parseRequestedScopes,
  WorkerEnvelopeError,
} from './worker-envelope.js';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    error: (...args: unknown[]) => void;
  };
};

const graphApiLogger = new DebugLogger('AgentGraphAPI');

export interface AgentGraphRouterOptions {
  memoryAdapter: AgentGraphAdapter;
  envelopeAuthority?: EnvelopeAuthority;
  /**
   * Which channels of each connector the owner has configured.
   *
   * Injected, not read here, for the same reason the compile service injects it: reading
   * the running machine's config inside a request handler makes every test depend on
   * whatever that machine happens to have configured. Absent means no grant is carried and
   * raw refs fall back to the pre-grant rule, which is what callers holding no grant get.
   */
  channelGrant?: () => Record<string, readonly string[]>;
}

const NUMERIC_QUERY_PATTERN = /^\d+$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EDGE_TYPES = new Set<string>(TWIN_EDGE_TYPES);
const REF_KINDS = new Set<string>(TWIN_REF_KINDS);
const MAX_GRAPH_DEPTH = 5;
const MAX_GRAPH_LIMIT = 100;

export function createAgentGraphRouter(options: AgentGraphRouterOptions): Router {
  const router = express.Router();

  router.get('/graph/neighborhood', async (req, res) => {
    await handleGraphRequest(req, res, options, (visibility, envelope) =>
      getGraphNeighborhood(options.memoryAdapter, {
        ref: parseRequiredRef(req.query.ref, 'ref'),
        depth: parseBoundedInteger(req.query.depth, 'depth', 0, MAX_GRAPH_DEPTH),
        scopes: visibility.scopes,
        connectors: visibility.connectors,
        project_refs: visibility.projectRefs,
        tenant_id: visibility.tenantId,
        channels: visibility.channels,
        principal_id: envelope.scope.principal_id,
        agent_id: envelope.agent_id,
        edge_filters: { edge_types: parseEdgeTypes(req) },
        as_of_ms: parseAsOf(req, envelope.scope.as_of),
        limit: parseBoundedInteger(req.query.limit, 'limit', 1, MAX_GRAPH_LIMIT),
      })
    );
  });

  router.get('/graph/paths', async (req, res) => {
    await handleGraphRequest(req, res, options, (visibility, envelope) =>
      getGraphPaths(options.memoryAdapter, {
        from_ref: parseRequiredRef(req.query.from, 'from'),
        to_ref: parseRequiredRef(req.query.to, 'to'),
        max_depth: parseBoundedInteger(req.query.max_depth, 'max_depth', 0, MAX_GRAPH_DEPTH),
        scopes: visibility.scopes,
        connectors: visibility.connectors,
        project_refs: visibility.projectRefs,
        tenant_id: visibility.tenantId,
        channels: visibility.channels,
        principal_id: envelope.scope.principal_id,
        agent_id: envelope.agent_id,
        edge_filters: { edge_types: parseEdgeTypes(req) },
        as_of_ms: parseAsOf(req, envelope.scope.as_of),
        limit: parseBoundedInteger(req.query.limit, 'limit', 1, MAX_GRAPH_LIMIT),
      })
    );
  });

  router.get('/graph/timeline', async (req, res) => {
    await handleGraphRequest(req, res, options, (visibility, envelope) =>
      getGraphTimeline(options.memoryAdapter, {
        ref: parseRequiredRef(req.query.ref, 'ref'),
        scopes: visibility.scopes,
        connectors: visibility.connectors,
        project_refs: visibility.projectRefs,
        tenant_id: visibility.tenantId,
        channels: visibility.channels,
        principal_id: envelope.scope.principal_id,
        agent_id: envelope.agent_id,
        edge_filters: { edge_types: parseEdgeTypes(req) },
        from_ms: parseOptionalIsoMs(req.query.from, 'from'),
        to_ms: parseOptionalIsoMs(req.query.to, 'to'),
        as_of_ms: parseAsOf(req, envelope.scope.as_of),
        limit: parseBoundedInteger(req.query.limit, 'limit', 1, MAX_GRAPH_LIMIT),
      })
    );
  });

  return router;
}

/**
 * The channel grant for this request, narrowed by the ENVELOPE's scopes.
 *
 * Not by the requested ones. `parseRequestedScopes` lets a caller ask with any subset the
 * envelope allows, and the grant narrows per connector only when a channel scope is
 * present - so narrowing by the request would let a caller widen its own grant by simply
 * leaving the channel scope out. That is the same defect that was found in the citation
 * path; this is the second place with the shape, which is why it is derived here once
 * rather than at each route.
 */
type VisibilityWithGrant = ReturnType<typeof deriveWorkerEnvelopeVisibility> & {
  channels?: Record<string, readonly string[]>;
};

function withChannelGrant(
  visibility: ReturnType<typeof deriveWorkerEnvelopeVisibility>,
  envelope: ReturnType<typeof loadWorkerEnvelope>,
  channelGrant: AgentGraphRouterOptions['channelGrant']
): VisibilityWithGrant {
  const configured = channelGrant?.();
  if (!configured) return visibility;
  return {
    ...visibility,
    channels: narrowGrantToEnvelope(configured, {
      // The ENVELOPE's connectors, not the request-narrowed ones. A request filter must
      // not become a permission: `visibility.connectors` already applies the request's
      // narrowing at the connector check, and folding it in here as well would make
      // "you filtered it out" and "you may not see it" the same answer - the distinction
      // the reader builds a whole counting query to preserve.
      connectors: envelope.scope.raw_connectors ?? [],
      scopes: envelope.scope.memory_scopes ?? [],
    }),
  };
}

async function handleGraphRequest(
  req: Request,
  res: Response,
  options: AgentGraphRouterOptions,
  handler: (
    visibility: VisibilityWithGrant,
    envelope: ReturnType<typeof loadWorkerEnvelope>
  ) => unknown
): Promise<void> {
  try {
    const envelope = loadWorkerEnvelope(req, options.envelopeAuthority);
    const visibility = deriveWorkerEnvelopeVisibility(envelope, {
      connectors: parseRequestedConnectors(req),
      scopes: parseRequestedScopes(req),
    });
    res.json(handler(withChannelGrant(visibility, envelope, options.channelGrant), envelope));
  } catch (error) {
    sendGraphError(res, error);
  }
}

function parseRequiredRef(value: unknown, name: string): TwinRef {
  const raw = firstString(value)?.trim();
  if (!raw) {
    throw invalidQuery(`${name} is required.`);
  }
  return parseRef(raw, name);
}

function parseRef(raw: string, name: string): TwinRef {
  if (raw.startsWith('{')) {
    return parseJsonRef(raw, name);
  }
  const [kind, ...idParts] = raw.split(':');
  const id = idParts.join(':');
  if (!kind || !id || !REF_KINDS.has(kind)) {
    throw invalidQuery(`${name} must use kind:id syntax or JSON {kind,id}.`);
  }
  return { kind: kind as TwinRefKind, id } as TwinRef;
}

function parseJsonRef(raw: string, name: string): TwinRef {
  const parsed = parseJsonValue(raw, name);
  return parseJsonRefValue(parsed, name);
}

function parseJsonRefValue(parsed: unknown, name: string): TwinRef {
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).kind !== 'string' ||
    typeof (parsed as Record<string, unknown>).id !== 'string'
  ) {
    throw invalidQuery(`${name} JSON must be an object with string kind and id.`);
  }
  const kind = (parsed as { kind: string }).kind;
  const id = (parsed as { id: string }).id;
  if (!REF_KINDS.has(kind) || id.trim().length === 0) {
    throw invalidQuery(`${name} JSON must contain a supported kind and non-empty id.`);
  }
  return { kind: kind as TwinRefKind, id: id.trim() } as TwinRef;
}

function parseJsonValue(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalidQuery(`${name} must be valid JSON: ${message}`);
  }
}

function parseEdgeTypes(req: Request): TwinEdgeType[] | undefined {
  const values = stringValues(req.query.edge_type)
    .concat(stringValues(req.query.edge_types))
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) {
    return undefined;
  }
  for (const value of values) {
    if (!EDGE_TYPES.has(value)) {
      throw invalidQuery(`Unsupported edge type: ${value}`);
    }
  }
  return [...new Set(values)] as TwinEdgeType[];
}

function parseAsOf(req: Request, envelopeAsOf: string | undefined): number | null {
  const requestRaw = firstString(req.query.as_of)?.trim();
  const requestMs = requestRaw ? parseIsoMs(requestRaw, 'as_of') : null;
  const envelopeMs = envelopeAsOf ? parseIsoMs(envelopeAsOf, 'as_of') : null;
  if (requestMs === null) {
    return envelopeMs;
  }
  if (envelopeMs === null) {
    return requestMs;
  }
  return Math.min(requestMs, envelopeMs);
}

function parseOptionalIsoMs(value: unknown, name: string): number | undefined {
  const raw = firstString(value)?.trim();
  if (!raw) {
    return undefined;
  }
  return parseIsoMs(raw, name);
}

function parseIsoMs(raw: string, name: string): number {
  if (!ISO_UTC_PATTERN.test(raw)) {
    throw invalidQuery(`${name} must be an ISO UTC timestamp.`);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw invalidQuery(`${name} must be a valid timestamp.`);
  }
  return ms;
}

function parseInteger(value: unknown, name: string): number | undefined {
  const raw = firstString(value)?.trim();
  if (!raw) {
    return undefined;
  }
  if (!NUMERIC_QUERY_PATTERN.test(raw)) {
    throw invalidQuery(`${name} must be an integer.`);
  }
  return Number.parseInt(raw, 10);
}

function parseBoundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number
): number | undefined {
  const parsed = parseInteger(value, name);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed < min || parsed > max) {
    throw invalidQuery(`${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function invalidQuery(message: string): WorkerEnvelopeError {
  return new WorkerEnvelopeError(400, 'agent_graph_query_invalid', message);
}

function sendGraphError(res: Response, error: unknown): void {
  if (error instanceof WorkerEnvelopeError) {
    res.status(error.status).json({ error: true, code: error.code, message: error.message });
    return;
  }

  const message = getErrorMessage(error);
  if (error instanceof AgentGraphValidationError) {
    res.status(400).json({
      error: true,
      code: 'agent_graph_invalid',
      message,
    });
    return;
  }

  graphApiLogger.error('Agent graph API error:', message);
  res.status(500).json({
    error: true,
    code: 'internal_server_error',
    message: 'An internal error occurred.',
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}
