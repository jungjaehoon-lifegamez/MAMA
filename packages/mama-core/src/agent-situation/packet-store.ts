import type { DatabaseAdapter } from '../db-manager.js';
import type {
  AgentSituationEffectiveFilters,
  AgentSituationLease,
  AgentSituationPacketRecord,
  SituationBriefing,
  SituationFocus,
  SituationRankedItem,
  SituationRecommendedTool,
  SituationSourceCoverage,
  SituationPendingHumanQuestion,
  SituationEntityCluster,
  SituationRef,
} from './types.js';

type PacketStoreAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

export interface AcquireAgentSituationLeaseInput {
  cacheKey: string;
  rankingPolicyVersion: string;
  leaseOwner: string;
  nowMs: number;
  leaseSeconds: number;
}

export interface AgentSituationRefreshInput {
  cacheKey: string;
  rankingPolicyVersion: string;
  nowMs: number;
  leaseOwner: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  maxPollMs?: number;
  refresh?: boolean;
}

const inProcessRefreshes = new Map<string, Promise<AgentSituationPacketRecord>>();

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapPacketRow(row: Record<string, unknown>): AgentSituationPacketRecord {
  return {
    packet_id: String(row.packet_id),
    cache_key: String(row.cache_key),
    scope_json: String(row.scope_json),
    scope: parseJson(String(row.scope_json), []),
    scope_hash: String(row.scope_hash),
    range_start_ms: Number(row.range_start_ms),
    range_end_ms: Number(row.range_end_ms),
    focus_json: String(row.focus_json),
    focus: parseJson<SituationFocus[]>(String(row.focus_json), []),
    envelope_hash: String(row.envelope_hash),
    envelope_effective_filters_json: String(row.envelope_effective_filters_json),
    envelope_effective_filters: parseJson<AgentSituationEffectiveFilters>(
      String(row.envelope_effective_filters_json),
      { scopes: [], connectors: [], project_refs: [], tenant_id: 'default', as_of: null }
    ),
    envelope_effective_filters_hash: String(row.envelope_effective_filters_hash),
    ranking_policy_version: String(row.ranking_policy_version),
    generated_at: Number(row.generated_at),
    expires_at: Number(row.expires_at),
    ttl_seconds: Number(row.ttl_seconds),
    freshness_json: String(row.freshness_json),
    freshness: parseJson<Record<string, unknown>>(String(row.freshness_json), {}),
    source_coverage_json: String(row.source_coverage_json),
    source_coverage: parseJson<SituationSourceCoverage[]>(String(row.source_coverage_json), []),
    briefing_json: String(row.briefing_json),
    briefing: parseJson<SituationBriefing>(String(row.briefing_json), {
      decisions: [],
      facts: [],
      open_questions: [],
      risks: [],
    }),
    ranked_items_json: String(row.ranked_items_json),
    ranked_items: parseJson<SituationRankedItem[]>(String(row.ranked_items_json), []),
    top_memory_refs_json: String(row.top_memory_refs_json),
    top_memory_refs: parseJson<string[]>(String(row.top_memory_refs_json), []),
    pending_human_questions_json: String(row.pending_human_questions_json),
    pending_human_questions: parseJson<SituationPendingHumanQuestion[]>(
      String(row.pending_human_questions_json),
      []
    ),
    entity_clusters_json: String(row.entity_clusters_json),
    entity_clusters: parseJson<SituationEntityCluster[]>(String(row.entity_clusters_json), []),
    recommended_next_tools_json: String(row.recommended_next_tools_json),
    recommended_next_tools: parseJson<SituationRecommendedTool[]>(
      String(row.recommended_next_tools_json),
      []
    ),
    generated_from_slice_ids_json: String(row.generated_from_slice_ids_json),
    generated_from_slice_ids: parseJson<string[]>(String(row.generated_from_slice_ids_json), []),
    caveats_json: String(row.caveats_json),
    caveats: parseJson<string[]>(String(row.caveats_json), []),
    agent_id: String(row.agent_id),
    model_run_id: String(row.model_run_id),
    input_snapshot_ref: String(row.input_snapshot_ref),
    source_refs_json: String(row.source_refs_json),
    source_refs: parseJson<SituationRef[]>(String(row.source_refs_json), []),
    tenant_id: String(row.tenant_id),
    project_id: String(row.project_id),
    memory_scope_kind: String(
      row.memory_scope_kind
    ) as AgentSituationPacketRecord['memory_scope_kind'],
    memory_scope_id: String(row.memory_scope_id),
    created_at: Number(row.created_at),
  };
}

function mapLeaseRow(row: Record<string, unknown>): AgentSituationLease {
  return {
    cache_key: String(row.cache_key),
    ranking_policy_version: String(row.ranking_policy_version),
    lease_owner: String(row.lease_owner),
    lease_expires_at: Number(row.lease_expires_at),
    created_at: Number(row.created_at),
  };
}

export function getFreshAgentSituationPacket(
  adapter: PacketStoreAdapter,
  cacheKey: string,
  rankingPolicyVersion: string,
  nowMs: number
): AgentSituationPacketRecord | null {
  const row = adapter
    .prepare(
      `
        SELECT *
        FROM agent_situation_packets
        WHERE cache_key = ?
          AND ranking_policy_version = ?
          AND expires_at > ?
        ORDER BY expires_at DESC, generated_at DESC
        LIMIT 1
      `
    )
    .get(cacheKey, rankingPolicyVersion, nowMs) as Record<string, unknown> | undefined;
  return row ? mapPacketRow(row) : null;
}

export function insertAgentSituationPacket(
  adapter: PacketStoreAdapter,
  packet: AgentSituationPacketRecord
): AgentSituationPacketRecord {
  adapter
    .prepare(
      `
        INSERT INTO agent_situation_packets (
          packet_id, cache_key, scope_json, scope_hash, range_start_ms, range_end_ms,
          focus_json, envelope_hash, envelope_effective_filters_json,
          envelope_effective_filters_hash, ranking_policy_version, generated_at, expires_at,
          ttl_seconds, freshness_json, source_coverage_json, briefing_json, ranked_items_json,
          top_memory_refs_json, pending_human_questions_json, entity_clusters_json,
          recommended_next_tools_json, generated_from_slice_ids_json, caveats_json,
          agent_id, model_run_id, input_snapshot_ref, source_refs_json, tenant_id, project_id,
          memory_scope_kind, memory_scope_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      packet.packet_id,
      packet.cache_key,
      packet.scope_json,
      packet.scope_hash,
      packet.range_start_ms,
      packet.range_end_ms,
      packet.focus_json,
      packet.envelope_hash,
      packet.envelope_effective_filters_json,
      packet.envelope_effective_filters_hash,
      packet.ranking_policy_version,
      packet.generated_at,
      packet.expires_at,
      packet.ttl_seconds,
      packet.freshness_json,
      packet.source_coverage_json,
      packet.briefing_json,
      packet.ranked_items_json,
      packet.top_memory_refs_json,
      packet.pending_human_questions_json,
      packet.entity_clusters_json,
      packet.recommended_next_tools_json,
      packet.generated_from_slice_ids_json,
      packet.caveats_json,
      packet.agent_id,
      packet.model_run_id,
      packet.input_snapshot_ref,
      packet.source_refs_json,
      packet.tenant_id,
      packet.project_id,
      packet.memory_scope_kind,
      packet.memory_scope_id,
      packet.created_at
    );
  const inserted = adapter
    .prepare('SELECT * FROM agent_situation_packets WHERE packet_id = ?')
    .get(packet.packet_id) as Record<string, unknown> | undefined;
  if (!inserted) {
    throw new Error(`Agent situation packet insert failed: ${packet.packet_id}`);
  }
  return mapPacketRow(inserted);
}

export function acquireAgentSituationLease(
  adapter: PacketStoreAdapter,
  input: AcquireAgentSituationLeaseInput
): AgentSituationLease | null {
  adapter
    .prepare('DELETE FROM agent_situation_refresh_leases WHERE lease_expires_at <= ?')
    .run(input.nowMs);
  try {
    adapter
      .prepare(
        `
          INSERT INTO agent_situation_refresh_leases (
            cache_key, ranking_policy_version, lease_owner, lease_expires_at, created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(
        input.cacheKey,
        input.rankingPolicyVersion,
        input.leaseOwner,
        input.nowMs + input.leaseSeconds * 1000,
        input.nowMs
      );
  } catch {
    return null;
  }
  const row = adapter
    .prepare('SELECT * FROM agent_situation_refresh_leases WHERE cache_key = ?')
    .get(input.cacheKey) as Record<string, unknown> | undefined;
  return row ? mapLeaseRow(row) : null;
}

export function releaseAgentSituationLease(
  adapter: PacketStoreAdapter,
  cacheKey: string,
  leaseOwner: string
): void {
  adapter
    .prepare('DELETE FROM agent_situation_refresh_leases WHERE cache_key = ? AND lease_owner = ?')
    .run(cacheKey, leaseOwner);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFreshPacket(
  adapter: PacketStoreAdapter,
  input: AgentSituationRefreshInput
): Promise<AgentSituationPacketRecord | null> {
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  const maxPollMs = input.maxPollMs ?? 30_000;
  const started = Date.now();
  while (Date.now() - started < maxPollMs) {
    const fresh = getFreshAgentSituationPacket(
      adapter,
      input.cacheKey,
      input.rankingPolicyVersion,
      Date.now()
    );
    if (fresh) {
      return fresh;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

export async function getOrRefreshAgentSituationPacket(
  adapter: PacketStoreAdapter,
  input: AgentSituationRefreshInput,
  builder: () => Promise<AgentSituationPacketRecord> | AgentSituationPacketRecord
): Promise<AgentSituationPacketRecord> {
  if (!input.refresh) {
    const fresh = getFreshAgentSituationPacket(
      adapter,
      input.cacheKey,
      input.rankingPolicyVersion,
      input.nowMs
    );
    if (fresh) {
      return fresh;
    }
  }

  const key = `${input.cacheKey}:${input.rankingPolicyVersion}`;
  const existing = inProcessRefreshes.get(key);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const lease = acquireAgentSituationLease(adapter, {
      cacheKey: input.cacheKey,
      rankingPolicyVersion: input.rankingPolicyVersion,
      leaseOwner: input.leaseOwner,
      nowMs: input.nowMs,
      leaseSeconds: input.leaseSeconds ?? 30,
    });
    if (!lease) {
      const fresh = await waitForFreshPacket(adapter, input);
      if (fresh) {
        return fresh;
      }
      throw new Error('Timed out waiting for agent situation refresh lease');
    }

    try {
      const built = await builder();
      return insertAgentSituationPacket(adapter, built);
    } finally {
      releaseAgentSituationLease(adapter, input.cacheKey, input.leaseOwner);
    }
  })();

  inProcessRefreshes.set(key, task);
  try {
    return await task;
  } finally {
    inProcessRefreshes.delete(key);
  }
}
