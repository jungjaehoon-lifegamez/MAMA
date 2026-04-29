import { createHash } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  AgentGraphValidationError,
  attachEntityAliasWithEdge,
  beginModelRunInAdapter,
  commitModelRunInAdapter,
  failModelRunInAdapter,
  getGraphNeighborhood,
  getGraphPaths,
  getGraphTimeline,
  getModelRunInAdapter,
  resolveEntity,
  ENTITY_ALIAS_LABEL_TYPES,
  TWIN_EDGE_TYPES,
  TWIN_REF_KINDS,
  type AgentGraphAdapter,
  type EntityAliasLabelType,
  type TwinEdgeType,
  type TwinRef,
  type TwinRefKind,
} from '@jungjaehoon/mama-core';

import type { EnvelopeAuthority } from '../envelope/authority.js';
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
}

const NUMERIC_QUERY_PATTERN = /^\d+$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EDGE_TYPES = new Set<string>(TWIN_EDGE_TYPES);
const REF_KINDS = new Set<string>(TWIN_REF_KINDS);
const LABEL_TYPES = new Set<string>(ENTITY_ALIAS_LABEL_TYPES);
const MAX_GRAPH_DEPTH = 5;
const MAX_GRAPH_LIMIT = 100;

export function createAgentGraphRouter(options: AgentGraphRouterOptions): Router {
  const router = express.Router();

  router.get('/entities/resolve', async (req, res) => {
    await handleGraphRequest(req, res, options, (visibility, envelope) => {
      const label = firstString(req.query.label)?.trim();
      if (!label) {
        throw invalidQuery('label is required.');
      }
      const contextRefs = parseRefs(req.query.context_ref ?? req.query.context_refs);
      return resolveEntity(options.memoryAdapter, {
        label,
        context_refs: contextRefs,
        scopes: visibility.scopes,
        connectors: visibility.connectors,
        project_refs: visibility.projectRefs,
        tenant_id: visibility.tenantId,
        as_of_ms: parseAsOf(req, envelope.scope.as_of),
      });
    });
  });

  router.get('/graph/neighborhood', async (req, res) => {
    await handleGraphRequest(req, res, options, (visibility, envelope) =>
      getGraphNeighborhood(options.memoryAdapter, {
        ref: parseRequiredRef(req.query.ref, 'ref'),
        depth: parseBoundedInteger(req.query.depth, 'depth', 0, MAX_GRAPH_DEPTH),
        scopes: visibility.scopes,
        connectors: visibility.connectors,
        project_refs: visibility.projectRefs,
        tenant_id: visibility.tenantId,
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
        edge_filters: { edge_types: parseEdgeTypes(req) },
        from_ms: parseOptionalIsoMs(req.query.from, 'from'),
        to_ms: parseOptionalIsoMs(req.query.to, 'to'),
        as_of_ms: parseAsOf(req, envelope.scope.as_of),
        limit: parseBoundedInteger(req.query.limit, 'limit', 1, MAX_GRAPH_LIMIT),
      })
    );
  });

  router.post('/entities/:entityId/aliases', async (req, res) => {
    await handleAliasWrite(req, res, options);
  });

  return router;
}

async function handleGraphRequest(
  req: Request,
  res: Response,
  options: AgentGraphRouterOptions,
  handler: (
    visibility: ReturnType<typeof deriveWorkerEnvelopeVisibility>,
    envelope: ReturnType<typeof loadWorkerEnvelope>
  ) => unknown
): Promise<void> {
  try {
    const envelope = loadWorkerEnvelope(req, options.envelopeAuthority);
    const visibility = deriveWorkerEnvelopeVisibility(envelope, {
      connectors: parseRequestedConnectors(req),
      scopes: parseRequestedScopes(req),
    });
    res.json(handler(visibility, envelope));
  } catch (error) {
    sendGraphError(res, error);
  }
}

async function handleAliasWrite(
  req: Request,
  res: Response,
  options: AgentGraphRouterOptions
): Promise<void> {
  let ownedModelRunId: string | null = null;
  try {
    const envelope = loadWorkerEnvelope(req, options.envelopeAuthority);
    const visibility = deriveWorkerEnvelopeVisibility(envelope, {
      connectors: parseRequestedConnectors(req),
      scopes: parseRequestedScopes(req),
    });
    const body = bodyObject(req.body);
    const entityId = paramString(req.params.entityId, 'entityId');
    const label = stringBody(body, 'label');
    const requestIdempotencyKey = stringBody(body, 'request_idempotency_key');
    const suppliedModelRunId = firstString(req.header('x-mama-model-run-id'))?.trim();
    const modelRun = suppliedModelRunId
      ? requireMatchingModelRun(options.memoryAdapter, suppliedModelRunId, envelope.envelope_hash)
      : beginDirectAliasModelRun(options.memoryAdapter, {
          model_run_id: directAliasModelRunId(
            envelope.envelope_hash,
            entityId,
            requestIdempotencyKey
          ),
          agent_id: envelope.agent_id,
          instance_id: envelope.instance_id,
          envelope_hash: envelope.envelope_hash,
          input_snapshot_ref: `entity-alias:${entityId}:${requestIdempotencyKey}`,
          input_refs: {
            tool: 'entity.alias',
            entity_id: entityId,
            request_idempotency_key: requestIdempotencyKey,
            scopes: visibility.scopes,
            connectors: visibility.connectors,
            project_refs: visibility.projectRefs,
            tenant_id: visibility.tenantId,
          },
        });
    if (!suppliedModelRunId) {
      ownedModelRunId = modelRun.model_run_id;
    }

    const result = attachEntityAliasWithEdge(options.memoryAdapter, {
      entity_id: entityId,
      label,
      label_type: optionalLabelTypeBody(body, 'label_type'),
      lang: optionalStringBody(body, 'lang'),
      script: optionalStringBody(body, 'script'),
      confidence: optionalNumberBody(body, 'confidence'),
      source_type: 'agent',
      source_ref: `model_run:${modelRun.model_run_id}`,
      agent_id: envelope.agent_id,
      model_run_id: modelRun.model_run_id,
      envelope_hash: envelope.envelope_hash,
      request_idempotency_key: requestIdempotencyKey,
      scopes: visibility.scopes,
      connectors: visibility.connectors,
      project_refs: visibility.projectRefs,
      tenant_id: visibility.tenantId,
    });

    if (ownedModelRunId) {
      commitModelRunInAdapter(
        options.memoryAdapter,
        ownedModelRunId,
        `entity alias ${result.alias.id}`
      );
    }
    res.json(result);
  } catch (error) {
    if (ownedModelRunId) {
      try {
        failModelRunInAdapter(options.memoryAdapter, ownedModelRunId, getErrorMessage(error));
      } catch {
        // Preserve the original API error.
      }
    }
    sendGraphError(res, error);
  }
}

function requireMatchingModelRun(
  adapter: AgentGraphAdapter,
  modelRunId: string,
  envelopeHash: string
) {
  const modelRun = getModelRunInAdapter(adapter, modelRunId);
  if (!modelRun) {
    throw new WorkerEnvelopeError(
      404,
      'agent_graph_model_run_not_found',
      'The supplied model run was not found.'
    );
  }
  if (modelRun.envelope_hash !== envelopeHash) {
    throw new WorkerEnvelopeError(
      403,
      'agent_graph_model_run_denied',
      'The supplied model run is outside the worker envelope.'
    );
  }
  return modelRun;
}

function beginDirectAliasModelRun(
  adapter: AgentGraphAdapter,
  input: Parameters<typeof beginModelRunInAdapter>[1]
) {
  try {
    return beginModelRunInAdapter(adapter, input);
  } catch (error) {
    const message = getErrorMessage(error);
    if (message.startsWith('Model run already exists')) {
      throw new WorkerEnvelopeError(409, 'agent_graph_idempotency_conflict', message);
    }
    throw error;
  }
}

function parseRequiredRef(value: unknown, name: string): TwinRef {
  const raw = firstString(value)?.trim();
  if (!raw) {
    throw invalidQuery(`${name} is required.`);
  }
  return parseRef(raw, name);
}

function parseRefs(value: unknown): TwinRef[] {
  const refs: TwinRef[] = [];
  for (const rawValue of stringValues(value)) {
    const raw = rawValue.trim();
    if (!raw) {
      continue;
    }
    if (raw.startsWith('[')) {
      const parsed = parseJsonValue(raw, 'context_refs');
      if (!Array.isArray(parsed)) {
        throw invalidQuery('context_refs JSON must be an array.');
      }
      for (const item of parsed) {
        refs.push(parseJsonRefValue(item, `context_refs[${refs.length}]`));
      }
      continue;
    }
    if (raw.startsWith('{')) {
      refs.push(parseJsonRef(raw, `context_refs[${refs.length}]`));
      continue;
    }
    for (const item of raw
      .split(',')
      .map((piece) => piece.trim())
      .filter(Boolean)) {
      refs.push(parseRef(item, `context_refs[${refs.length}]`));
    }
  }
  return refs;
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
  const raw = firstString(req.query.as_of)?.trim() ?? envelopeAsOf;
  if (!raw) {
    return null;
  }
  return parseIsoMs(raw, 'as_of');
}

function parseOptionalIsoMs(value: unknown, name: string): number | undefined {
  const raw = firstString(value)?.trim();
  return raw ? parseIsoMs(raw, name) : undefined;
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

function directAliasModelRunId(
  envelopeHash: string,
  entityId: string,
  requestIdempotencyKey: string
): string {
  const hash = createHash('sha256')
    .update(`${envelopeHash}\0${entityId}\0${requestIdempotencyKey}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `mr_direct_alias_${hash}`;
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerEnvelopeError(
      400,
      'agent_graph_body_invalid',
      'Request body must be a JSON object.'
    );
  }
  return value as Record<string, unknown>;
}

function stringBody(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkerEnvelopeError(
      400,
      'agent_graph_body_invalid',
      `${field} must be a non-empty string.`
    );
  }
  return value.trim();
}

function paramString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkerEnvelopeError(
      400,
      'agent_graph_body_invalid',
      `${field} must be a non-empty string.`
    );
  }
  return value.trim();
}

function optionalStringBody(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new WorkerEnvelopeError(400, 'agent_graph_body_invalid', `${field} must be a string.`);
  }
  return value.trim().length > 0 ? value.trim() : null;
}

function optionalLabelTypeBody(
  body: Record<string, unknown>,
  field: string
): EntityAliasLabelType | undefined {
  const value = optionalStringBody(body, field);
  if (value === null) {
    return undefined;
  }
  if (!LABEL_TYPES.has(value)) {
    throw new WorkerEnvelopeError(
      400,
      'agent_graph_body_invalid',
      `${field} must be one of: ${ENTITY_ALIAS_LABEL_TYPES.join(', ')}.`
    );
  }
  return value as EntityAliasLabelType;
}

function optionalNumberBody(body: Record<string, unknown>, field: string): number | null {
  const value = body[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorkerEnvelopeError(400, 'agent_graph_body_invalid', `${field} must be a number.`);
  }
  return value;
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
    message,
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
