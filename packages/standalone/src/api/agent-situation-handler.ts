import express, { type Request, type Response, type Router } from 'express';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  AGENT_SITUATION_V0_POLICY_VERSION,
  beginModelRunInAdapter,
  buildAgentSituationCacheKey,
  buildAgentSituationPacketRecord,
  commitModelRunInAdapter,
  failModelRunInAdapter,
  getFreshAgentSituationPacket,
  getModelRunInAdapter,
  getOrRefreshAgentSituationPacket,
  type AgentSituationInput,
  type AgentSituationPacket,
  type AgentSituationPacketRecord,
  type SituationFocus,
} from '@jungjaehoon/mama-core';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

import type { EnvelopeAuthority } from '../envelope/authority.js';
import type { Envelope } from '../envelope/types.js';
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

const situationApiLogger = new DebugLogger('AgentSituationAPI');

export type AgentSituationAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

export type AgentSituationBuildPacket = (
  adapter: AgentSituationAdapter,
  input: AgentSituationInput
) => AgentSituationPacketRecord | Promise<AgentSituationPacketRecord>;

export interface AgentSituationRouterOptions {
  memoryAdapter: AgentSituationAdapter;
  envelopeAuthority?: EnvelopeAuthority;
  buildPacket?: AgentSituationBuildPacket;
  now?: () => number;
}

interface SituationQuery {
  rangeStartMs: number;
  rangeEndMs: number;
  rangeLabel: string;
  focus: SituationFocus[];
  limit: number;
  refresh: boolean;
}

const NUMERIC_QUERY_PATTERN = /^\d+$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '180d': 180,
};
const RANGE_TTL_MS: Record<string, number> = {
  '7d': 120 * 1000,
  '30d': 300 * 1000,
  '180d': 900 * 1000,
};
const DEFAULT_FOCUS: SituationFocus[] = ['decisions', 'risks', 'open_questions'];
const FOCUS_VALUES = new Set<SituationFocus>([
  'decisions',
  'risks',
  'open_questions',
  'cases',
  'raw',
]);

export function createAgentSituationRouter(options: AgentSituationRouterOptions): Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    await handleSituationRequest(req, res, options);
  });

  return router;
}

async function handleSituationRequest(
  req: Request,
  res: Response,
  options: AgentSituationRouterOptions
): Promise<void> {
  try {
    const nowMs = Math.floor(options.now?.() ?? Date.now());
    const envelope = loadWorkerEnvelope(req, options.envelopeAuthority);
    validateEnvelopeAsOf(envelope.scope.as_of);
    const visibility = deriveWorkerEnvelopeVisibility(envelope, {
      connectors: parseRequestedConnectors(req),
      scopes: parseRequestedScopes(req),
    });
    if (visibility.projectRefs.length === 0) {
      throw new WorkerEnvelopeError(
        403,
        'worker_envelope_project_required',
        'agent.situation requires at least one project ref in the worker envelope.'
      );
    }

    const query = parseSituationQuery(req, nowMs);
    const rankingPolicyVersion = AGENT_SITUATION_V0_POLICY_VERSION;
    const effectiveFilters = {
      scopes: visibility.scopes,
      connectors: visibility.connectors,
      project_refs: visibility.projectRefs,
      tenant_id: visibility.tenantId,
      as_of: envelope.scope.as_of ?? null,
    };
    const key = buildAgentSituationCacheKey({
      ...effectiveFilters,
      range_start_ms: query.rangeStartMs,
      range_end_ms: query.rangeEndMs,
      focus: query.focus,
      limit: query.limit,
      ranking_policy_version: rankingPolicyVersion,
    });
    const canonicalEffectiveFilters: AgentSituationInput['effective_filters'] = {
      scopes: key.canonicalInput.scopes,
      connectors: key.canonicalInput.connectors,
      project_refs: key.canonicalInput.project_refs,
      tenant_id: key.canonicalInput.tenant_id,
      as_of: key.canonicalInput.as_of,
    };
    const suppliedModelRunId = firstString(req.header('x-mama-model-run-id'))?.trim();
    const suppliedModelRun = suppliedModelRunId
      ? requireMatchingModelRun(options.memoryAdapter, suppliedModelRunId, envelope, key.cacheKey)
      : null;

    if (!query.refresh) {
      const fresh = getFreshAgentSituationPacket(
        options.memoryAdapter,
        key.cacheKey,
        rankingPolicyVersion,
        nowMs
      );
      if (fresh) {
        res.json(toPacket(fresh, true));
        return;
      }
    }

    const builder = options.buildPacket ?? buildAgentSituationPacketRecord;
    let builtPacket = false;
    let ownedModelRunId: string | null = null;
    try {
      const packet = await getOrRefreshAgentSituationPacket(
        options.memoryAdapter,
        {
          cacheKey: key.cacheKey,
          rankingPolicyVersion,
          nowMs,
          leaseOwner: `${envelope.agent_id}:${envelope.instance_id}:${key.cacheKey}`,
          refresh: query.refresh,
        },
        async () => {
          builtPacket = true;
          const modelRun =
            suppliedModelRun ??
            beginModelRunInAdapter(options.memoryAdapter, {
              agent_id: envelope.agent_id,
              instance_id: envelope.instance_id,
              envelope_hash: envelope.envelope_hash,
              input_snapshot_ref: `situation:${key.cacheKey}`,
              input_refs: {
                tool: 'agent.situation',
                cache_key: key.cacheKey,
                range: query.rangeLabel,
                range_start: new Date(query.rangeStartMs).toISOString(),
                range_end: new Date(query.rangeEndMs).toISOString(),
                focus: key.canonicalInput.focus,
                limit: key.canonicalInput.limit,
                scopes: canonicalEffectiveFilters.scopes,
                connectors: canonicalEffectiveFilters.connectors,
                project_refs: canonicalEffectiveFilters.project_refs,
                tenant_id: canonicalEffectiveFilters.tenant_id,
              },
            });
          if (!suppliedModelRun) {
            ownedModelRunId = modelRun.model_run_id;
          }

          return builder(options.memoryAdapter, {
            scope: canonicalEffectiveFilters.scopes,
            range_start_ms: key.canonicalInput.range_start_ms,
            range_end_ms: key.canonicalInput.range_end_ms,
            focus: key.canonicalInput.focus,
            limit: key.canonicalInput.limit,
            effective_filters: canonicalEffectiveFilters,
            envelope_hash: envelope.envelope_hash,
            agent_id: envelope.agent_id,
            model_run_id: modelRun.model_run_id,
            ranking_policy_version: rankingPolicyVersion,
            refresh: query.refresh,
            now_ms: nowMs,
          });
        }
      );
      if (ownedModelRunId) {
        try {
          commitModelRunInAdapter(
            options.memoryAdapter,
            ownedModelRunId,
            `agent.situation packet ${packet.packet_id}`
          );
        } catch (error) {
          removeOwnedPacket(options.memoryAdapter, packet.packet_id, ownedModelRunId);
          throw error;
        }
      }

      res.json(toPacket(packet, !builtPacket));
    } catch (error) {
      if (ownedModelRunId) {
        failModelRunQuietly(options.memoryAdapter, ownedModelRunId, getErrorMessage(error));
      }
      throw error;
    }
  } catch (error) {
    sendSituationError(res, error);
  }
}

function requireMatchingModelRun(
  adapter: AgentSituationAdapter,
  modelRunId: string,
  envelope: Envelope,
  cacheKey: string
) {
  const modelRun = getModelRunInAdapter(adapter, modelRunId);
  if (!modelRun) {
    throw new WorkerEnvelopeError(
      404,
      'agent_situation_model_run_not_found',
      'The supplied model run was not found.'
    );
  }
  if (modelRun.envelope_hash !== envelope.envelope_hash) {
    throw new WorkerEnvelopeError(
      403,
      'agent_situation_model_run_denied',
      'The supplied model run is outside the worker envelope.'
    );
  }
  if (modelRun.status !== 'running') {
    throw new WorkerEnvelopeError(
      409,
      'agent_situation_model_run_not_running',
      'The supplied model run is no longer running.'
    );
  }
  if (modelRun.agent_id !== envelope.agent_id || modelRun.instance_id !== envelope.instance_id) {
    throw new WorkerEnvelopeError(
      403,
      'agent_situation_model_run_denied',
      'The supplied model run belongs to a different worker instance.'
    );
  }
  const expectedSnapshotRef = `situation:${cacheKey}`;
  if (modelRun.input_snapshot_ref !== expectedSnapshotRef) {
    throw new WorkerEnvelopeError(
      403,
      'agent_situation_model_run_denied',
      'The supplied model run is not for this agent.situation packet.'
    );
  }
  const inputRefs = modelRun.input_refs;
  if (inputRefs?.tool !== 'agent.situation' || inputRefs.cache_key !== cacheKey) {
    throw new WorkerEnvelopeError(
      403,
      'agent_situation_model_run_denied',
      'The supplied model run does not match this agent.situation cache key.'
    );
  }
  return modelRun;
}

function parseSituationQuery(req: Request, nowMs: number): SituationQuery {
  const range = firstString(req.query.range)?.trim() || '7d';
  const focus = parseFocus(firstString(req.query.focus));
  const limit = parseLimit(req.query.limit);
  const refresh = firstString(req.query.refresh)?.trim().toLowerCase() === 'true';
  const from = firstString(req.query.from)?.trim();
  const to = firstString(req.query.to)?.trim();

  if (from !== undefined || to !== undefined) {
    if (!from || !to) {
      throw invalidQuery('from and to must be provided together.');
    }
    const fromMs = parseIsoMs(from, 'from');
    const toMs = parseIsoMs(to, 'to');
    if (fromMs >= toMs) {
      throw invalidQuery('from must be earlier than to.');
    }
    return {
      rangeStartMs: fromMs,
      rangeEndMs: toMs,
      rangeLabel: 'custom',
      focus,
      limit,
      refresh,
    };
  }

  const days = RANGE_DAYS[range];
  if (!days) {
    throw invalidQuery('range must be one of 7d, 30d, or 180d.');
  }
  const rangeEndMs = bucketRangeEndMs(nowMs, range);
  return {
    rangeStartMs: rangeEndMs - days * DAY_MS,
    rangeEndMs,
    rangeLabel: range,
    focus,
    limit,
    refresh,
  };
}

function bucketRangeEndMs(nowMs: number, range: string): number {
  const bucketMs = RANGE_TTL_MS[range];
  if (!bucketMs) {
    return nowMs;
  }
  return Math.floor(nowMs / bucketMs) * bucketMs;
}

function parseFocus(value: string | undefined): SituationFocus[] {
  if (!value || value.trim().length === 0) {
    return DEFAULT_FOCUS.slice();
  }
  const focus = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (focus.length === 0) {
    return DEFAULT_FOCUS.slice();
  }
  const result: SituationFocus[] = [];
  for (const item of focus) {
    if (!FOCUS_VALUES.has(item as SituationFocus)) {
      throw invalidQuery(`Invalid focus value: ${item}`);
    }
    if (!result.includes(item as SituationFocus)) {
      result.push(item as SituationFocus);
    }
  }
  return result;
}

function parseLimit(value: unknown): number {
  const raw = firstString(value);
  if (raw === undefined || raw.length === 0) {
    return 7;
  }
  if (!NUMERIC_QUERY_PATTERN.test(raw)) {
    throw invalidQuery('limit must be a numeric string.');
  }
  return Math.max(3, Math.min(25, Number.parseInt(raw, 10)));
}

function parseIsoMs(value: string, name: string): number {
  if (!ISO_UTC_PATTERN.test(value)) {
    throw invalidQuery(`${name} must be an ISO-8601 UTC timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw invalidQuery(`${name} must be a valid timestamp.`);
  }
  return parsed;
}

function toPacket(record: AgentSituationPacketRecord, cacheHit: boolean): AgentSituationPacket {
  return {
    packet_id: record.packet_id,
    scope: record.scope,
    range_start: new Date(record.range_start_ms).toISOString(),
    range_end: new Date(record.range_end_ms).toISOString(),
    generated_at: new Date(record.generated_at).toISOString(),
    freshness: record.freshness,
    source_coverage: record.source_coverage,
    briefing: record.briefing,
    ranked_items: record.ranked_items,
    top_memory_refs: record.top_memory_refs,
    pending_human_questions: record.pending_human_questions,
    entity_clusters: record.entity_clusters,
    recommended_next_tools: record.recommended_next_tools,
    ranking_policy_version: record.ranking_policy_version,
    ttl_seconds: record.ttl_seconds,
    generated_from_slice_ids: record.generated_from_slice_ids,
    caveats: record.caveats,
    cache: {
      hit: cacheHit,
      cache_key: record.cache_key,
      expires_at: new Date(record.expires_at).toISOString(),
    },
  };
}

function invalidQuery(message: string): WorkerEnvelopeError {
  return new WorkerEnvelopeError(400, 'agent_situation_query_invalid', message);
}

function validateEnvelopeAsOf(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new WorkerEnvelopeError(
      400,
      'worker_envelope_as_of_invalid',
      'Worker envelope as_of must be an ISO-8601 UTC timestamp.'
    );
  }
}

function removeOwnedPacket(
  adapter: AgentSituationAdapter,
  packetId: string,
  modelRunId: string
): void {
  const result = adapter
    .prepare('DELETE FROM agent_situation_packets WHERE packet_id = ? AND model_run_id = ?')
    .run(packetId, modelRunId);
  if (result.changes !== 1) {
    throw new Error(`Failed to remove uncommitted agent.situation packet ${packetId}`);
  }
}

function sendSituationError(res: Response, error: unknown): void {
  if (error instanceof WorkerEnvelopeError) {
    res.status(error.status).json({
      error: true,
      code: error.code,
      message: error.message,
    });
    return;
  }

  situationApiLogger.error('Unexpected agent.situation API error:', error);
  res.status(500).json({
    error: true,
    code: 'agent_situation_api_error',
    message: 'Internal server error',
  });
}

function failModelRunQuietly(
  adapter: AgentSituationAdapter,
  modelRunId: string,
  errorSummary: string
): void {
  try {
    failModelRunInAdapter(adapter, modelRunId, errorSummary);
  } catch (error) {
    situationApiLogger.error('Failed to mark agent.situation model run as failed:', error);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
