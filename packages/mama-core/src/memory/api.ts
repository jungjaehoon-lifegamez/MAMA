import crypto from 'node:crypto';
import {
  initDB,
  getAdapter,
  insertDecisionWithEmbedding,
  ensureMemoryScope,
  vectorSearch,
  fts5Search,
} from '../db-manager.js';
import { generateEmbedding } from '../embeddings.js';
import {
  ftsSearchWikiPages,
  vectorSearchWikiPages,
  type WikiPageIndexRecord,
} from '../cases/wiki-page-index.js';
import { classifyProfileEntries } from './profile-builder.js';
import { buildMemoryAgentBootstrap } from './bootstrap-builder.js';
import { resolveMemoryEvolution } from './evolution-engine.js';
import { recordChannelAudit } from './channel-summary-state-store.js';
import { warn } from '../debug-logger.js';
import { projectMemoryTruth } from './truth-store.js';
import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';
import { createEmptyRecallBundle, createMemoryAuditAck } from './types.js';
import { getChannelSummary, upsertChannelSummary } from './channel-summary-store.js';
import { queryCanonicalEntities } from '../entities/recall-bridge.js';
import { loadDecisionReadIdentityIndex, resolveReadIdentity } from '../entities/read-identity.js';
import type {
  MemoryKind,
  MemoryAgentBootstrap,
  MemoryAuditAck,
  MemoryEdge,
  MemoryRecord,
  MemoryScopeKind,
  MemoryScopeRef,
  MemoryStatus,
  MemoryTruthRow,
  ProfileSnapshot,
  PublicIngestMemoryInput,
  PublicSaveMemoryInput,
  RecallBundle,
  IngestConversationInput,
  ExtractedMemoryUnit,
  IngestConversationResult,
} from './types.js';
import { insertMemoryEventInTransaction } from './event-store.js';
import {
  appendProvenanceSourceRefs,
  normalizeMemoryWriteProvenance,
  sanitizePublicIngestConversationInput,
  sanitizePublicIngestMemoryInput,
  sanitizePublicSaveMemoryInput,
  type TrustedMemoryWriteOptions,
} from './provenance.js';

type SaveMemoryInput = PublicSaveMemoryInput;
type IngestMemoryInput = PublicIngestMemoryInput;

interface RecallMemoryOptions {
  scopes?: MemoryScopeRef[];
  includeProfile?: boolean;
  includeHistory?: boolean;
  skipGraphExpansion?: boolean;
  topicPrefix?: string;
  limit?: number;
}

export interface FusedHit {
  source_type: 'decision' | 'wiki_page';
  source_id: string;
  record: MemoryRecord | WikiPageIndexRecord;
  fused_rank_score: number;
}

interface SaveMemoryRollbackError extends Error {
  memoryId?: string;
}

function buildDecisionId(topic: string): string {
  const safeTopic = topic.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  return `decision_${safeTopic}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function buildSaveEventReason(toolName: string | null, gatewayCallId: string | null): string {
  const parts = ['saved'];
  if (toolName) {
    parts.push(`via ${toolName}`);
  }
  if (gatewayCallId) {
    parts.push(`gateway_call_id=${gatewayCallId}`);
  }
  return parts.join(' ');
}

function toMemoryRecord(
  row: Record<string, unknown>,
  scopes: MemoryScopeRef[],
  fallbackSource: SaveMemoryInput['source']
): MemoryRecord {
  let trustContext = null;
  if (typeof row.trust_context === 'string') {
    try {
      trustContext = JSON.parse(row.trust_context);
    } catch {
      /* malformed */
    }
  }
  const savedSource = trustContext?.source;

  return {
    id: String(row.id),
    topic: String(row.topic),
    kind: (row.kind as MemoryKind) ?? 'decision',
    summary: String(row.summary ?? row.decision ?? ''),
    details: String(row.reasoning ?? row.decision ?? ''),
    confidence: Number(row.confidence ?? 0.5),
    status: (row.status as MemoryStatus) ?? 'active',
    scopes,
    source: savedSource ?? fallbackSource,
    created_at: row.created_at as number | string,
    updated_at: (row.updated_at as number | string) ?? (row.created_at as number | string),
    event_date: (row.event_date as string) ?? null,
    event_datetime:
      typeof row.event_datetime === 'number' && Number.isFinite(row.event_datetime)
        ? row.event_datetime
        : null,
  };
}

function loadEventDateTimeForObservations(
  adapter: ReturnType<typeof getAdapter>,
  observationIds: string[]
): number | null {
  const uniqueIds = Array.from(new Set(observationIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return null;
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const row = adapter
    .prepare(
      `
        SELECT MAX(COALESCE(timestamp_observed, created_at)) AS event_datetime
        FROM entity_observations
        WHERE id IN (${placeholders})
      `
    )
    .get(...uniqueIds) as { event_datetime?: number | null } | undefined;

  return typeof row?.event_datetime === 'number' && Number.isFinite(row.event_datetime)
    ? row.event_datetime
    : null;
}

function getTimelineEntityKindPriority(kind: string): number {
  switch (kind) {
    case 'work_item':
      return 0;
    case 'project':
      return 1;
    case 'organization':
      return 2;
    case 'person':
      return 3;
    default:
      return 99;
  }
}

function resolveTimelineTargetEntityIdFromObservations(
  adapter: ReturnType<typeof getAdapter>,
  observationIds: string[]
): string | null {
  const uniqueIds = Array.from(new Set(observationIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return null;
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `
        SELECT
          n.id AS entity_id,
          n.kind AS entity_kind,
          COUNT(*) AS matched_observations
        FROM entity_lineage_links l
        JOIN entity_nodes n
          ON n.id = l.canonical_entity_id
        WHERE l.entity_observation_id IN (${placeholders})
          AND l.status = 'active'
          AND n.status = 'active'
          AND n.merged_into IS NULL
        GROUP BY n.id, n.kind
      `
    )
    .all(...uniqueIds) as Array<{
    entity_id: string;
    entity_kind: string;
    matched_observations: number;
  }>;

  rows.sort((left, right) => {
    const kindDelta =
      getTimelineEntityKindPriority(left.entity_kind) -
      getTimelineEntityKindPriority(right.entity_kind);
    if (kindDelta !== 0) {
      return kindDelta;
    }
    if (right.matched_observations !== left.matched_observations) {
      return right.matched_observations - left.matched_observations;
    }
    return left.entity_id.localeCompare(right.entity_id);
  });

  return rows[0]?.entity_id ?? null;
}

function buildTimelineEventForSave(
  adapter: ReturnType<typeof getAdapter>,
  memoryId: string,
  topic: string,
  entityObservationIds: string[],
  timelineEvent:
    | {
        id?: string;
        entity_id?: string;
        event_type: string;
        role?: string | null;
        valid_from?: number | null;
        valid_to?: number | null;
        observed_at?: number | null;
        source_ref?: string | null;
        summary: string;
        details?: string | null;
      }
    | undefined
): {
  id: string;
  entity_id: string;
  event_type: string;
  role: string | null;
  valid_from: number | null;
  valid_to: number | null;
  observed_at: number | null;
  source_ref: string | null;
  summary: string;
  details: string | null;
} | null {
  if (!timelineEvent) {
    return null;
  }

  const resolvedEntityId =
    timelineEvent.entity_id ??
    resolveTimelineTargetEntityIdFromObservations(adapter, entityObservationIds);
  if (!resolvedEntityId) {
    return null;
  }

  return {
    id: timelineEvent.id ?? `et_${crypto.randomUUID()}`,
    entity_id: resolvedEntityId,
    event_type: timelineEvent.event_type,
    role: timelineEvent.role ?? null,
    valid_from: timelineEvent.valid_from ?? null,
    valid_to: timelineEvent.valid_to ?? null,
    observed_at: timelineEvent.observed_at ?? null,
    source_ref: timelineEvent.source_ref ?? `decision:${memoryId}`,
    summary: timelineEvent.summary,
    details:
      timelineEvent.details ??
      JSON.stringify({
        memory_id: memoryId,
        topic,
      }),
  };
}

function insertTimelineEventForSave(
  adapter: ReturnType<typeof getAdapter>,
  event: {
    id: string;
    entity_id: string;
    event_type: string;
    role: string | null;
    valid_from: number | null;
    valid_to: number | null;
    observed_at: number | null;
    source_ref: string | null;
    summary: string;
    details: string | null;
  },
  createdAt: number
): void {
  adapter
    .prepare(
      `
        INSERT INTO entity_timeline_events (
          id, entity_id, event_type, role, valid_from, valid_to, observed_at,
          source_ref, summary, details, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      event.id,
      event.entity_id,
      event.event_type,
      event.role,
      event.valid_from,
      event.valid_to,
      event.observed_at,
      event.source_ref,
      event.summary,
      event.details,
      createdAt
    );
}

function cleanupFailedMemorySave(adapter: ReturnType<typeof getAdapter>, memoryId: string): void {
  const row = adapter.prepare(`SELECT rowid FROM decisions WHERE id = ?`).get(memoryId) as
    | { rowid: number }
    | undefined;
  if (!row) {
    return;
  }

  const cleanup = () => {
    adapter.prepare(`DELETE FROM embeddings WHERE rowid = ?`).run(row.rowid);
    adapter.prepare(`DELETE FROM decisions WHERE id = ?`).run(memoryId);
  };

  const txResult = adapter.transaction(cleanup) as unknown;
  if (typeof txResult === 'function') {
    txResult();
  }
}

function batchLoadScopes(
  adapter: ReturnType<typeof getAdapter>,
  memoryIds: string[]
): Map<string, MemoryScopeRef[]> {
  const scopeMap = new Map<string, MemoryScopeRef[]>();
  if (memoryIds.length === 0) return scopeMap;

  const placeholders = memoryIds.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `
        SELECT msb.memory_id, ms.kind, ms.external_id
        FROM memory_scope_bindings msb
        JOIN memory_scopes ms ON ms.id = msb.scope_id
        WHERE msb.memory_id IN (${placeholders})
        ORDER BY msb.is_primary DESC
      `
    )
    .all(...memoryIds) as Array<{ memory_id: string; kind: string; external_id: string }>;

  for (const row of rows) {
    const existing = scopeMap.get(row.memory_id) ?? [];
    existing.push({ kind: row.kind as MemoryScopeKind, id: row.external_id });
    scopeMap.set(row.memory_id, existing);
  }
  return scopeMap;
}

async function loadScopedMemories(scopes: MemoryScopeRef[]): Promise<MemoryRecord[]> {
  await initDB();
  const adapter = getAdapter();
  const fallbackSource: SaveMemoryInput['source'] = { package: 'mama-core', source_type: 'db' };

  let rows: Record<string, unknown>[];

  if (scopes.length === 0) {
    rows = adapter
      .prepare(
        `
          SELECT id, topic, decision, reasoning, confidence, created_at, updated_at, trust_context,
                 kind, status, summary, event_date, event_datetime
          FROM decisions
          ORDER BY COALESCE(event_datetime, created_at) DESC, created_at DESC
        `
      )
      .all() as Record<string, unknown>[];
  } else {
    const scopeIds = await Promise.all(
      scopes.map((scope) => ensureMemoryScope(scope.kind, scope.id))
    );
    const placeholders = scopeIds.map(() => '?').join(', ');
    rows = adapter
      .prepare(
        `
          SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.confidence, d.created_at,
                 d.updated_at, d.trust_context, d.kind, d.status, d.summary, d.event_date, d.event_datetime
          FROM decisions d
          JOIN memory_scope_bindings msb ON msb.memory_id = d.id
          WHERE msb.scope_id IN (${placeholders})
          ORDER BY COALESCE(d.event_datetime, d.created_at) DESC, d.created_at DESC
        `
      )
      .all(...scopeIds) as Record<string, unknown>[];
  }

  const memoryIds = rows.map((row) => String(row.id));
  const scopeMap = batchLoadScopes(adapter, memoryIds);

  return rows.map((row) => toMemoryRecord(row, scopeMap.get(String(row.id)) ?? [], fallbackSource));
}

export const LEXICAL_STOPWORDS: Set<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

/**
 * Intentionally minimal English suffix stemmer for fuzzy lexical matching.
 * Not a full Porter/Snowball implementation — imperfect stems (e.g., "running" → "runn")
 * are acceptable for scoring/recall. Avoids pulling in a heavier stemming dependency.
 */
function stemToken(token: string): string {
  if (token.length <= 4) return token;
  // Order matters: try longest suffix first
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function getLexicalQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,.!?;:()[\]{}"']+/)
    .filter((token) => token.length > 2 && !LEXICAL_STOPWORDS.has(token));
}

function buildLexicalCandidates(
  records: MemoryRecord[],
  query: string
): Array<{ memory: MemoryRecord; score: number }> {
  const tokens = getLexicalQueryTokens(query);
  const normalizedQuery = query.toLowerCase();

  return records
    .map((record) => {
      const haystack = [record.topic, record.summary, record.details].join(' ').toLowerCase();
      const tokenMatches = tokens.reduce((count, token) => {
        const stem = stemToken(token);
        if (!haystack.includes(token) && !haystack.includes(stem)) {
          return count;
        }
        if (token.length >= 8) {
          return count + 3;
        }
        if (token.length >= 5) {
          return count + 2;
        }
        return count + 1;
      }, 0);
      const phraseBoost = haystack.includes(normalizedQuery) ? 2 : 0;
      const score = tokenMatches + phraseBoost;
      return { memory: record, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return Number(right.memory.created_at) - Number(left.memory.created_at);
    });
}

function lexicalScoreToConfidence(score: number): number {
  return Math.min(0.95, 0.45 + score * 0.05);
}

// Retained for potential future use in non-RRF recall paths
function _mergeRecallCandidates(
  primary: MemoryRecord[],
  lexical: Array<{ memory: MemoryRecord; score: number }>
): MemoryRecord[] {
  const merged = new Map<
    string,
    { memory: MemoryRecord; sortScore: number; lexicalScore: number }
  >();

  for (const memory of primary) {
    merged.set(memory.id, {
      memory,
      sortScore: memory.confidence ?? 0.5,
      lexicalScore: 0,
    });
  }

  // Determine the lowest vector confidence to cap lexical-only candidates below it
  const minVectorConfidence =
    primary.length > 0 ? Math.min(...primary.map((m) => m.confidence ?? 0.5)) : 1.0;
  const LEXICAL_ONLY_CAP = Math.max(0, minVectorConfidence - 0.01);

  for (const candidate of lexical) {
    const lexicalConfidence = lexicalScoreToConfidence(candidate.score);
    const existing = merged.get(candidate.memory.id);
    if (existing) {
      // Already has a vector hit — safe to boost with lexical score
      existing.sortScore = Math.max(existing.sortScore, lexicalConfidence);
      existing.lexicalScore = Math.max(existing.lexicalScore, candidate.score);
      existing.memory = {
        ...existing.memory,
        confidence: Math.max(existing.memory.confidence ?? 0.5, lexicalConfidence),
      };
      merged.set(candidate.memory.id, existing);
      continue;
    }

    // Lexical-only candidate — cap below the lowest vector hit
    const cappedConfidence = Math.min(lexicalConfidence, LEXICAL_ONLY_CAP);
    merged.set(candidate.memory.id, {
      memory: {
        ...candidate.memory,
        confidence: Math.max(candidate.memory.confidence ?? 0.5, cappedConfidence),
      },
      sortScore: cappedConfidence,
      lexicalScore: candidate.score,
    });
  }

  return Array.from(merged.values())
    .sort((left, right) => {
      if (right.sortScore !== left.sortScore) {
        return right.sortScore - left.sortScore;
      }
      if (right.lexicalScore !== left.lexicalScore) {
        return right.lexicalScore - left.lexicalScore;
      }
      return Number(right.memory.created_at) - Number(left.memory.created_at);
    })
    .map((candidate) => candidate.memory);
}

export async function loadEdgesForIds(ids: string[]): Promise<MemoryEdge[]> {
  if (ids.length === 0) return [];
  await initDB();
  const adapter = getAdapter();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `SELECT from_id, to_id, relationship AS type, reason
       FROM decision_edges
       WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
         AND (approved_by_user != 0 OR approved_by_user IS NULL)`
    )
    .all(...ids, ...ids) as Array<{
    from_id: string;
    to_id: string;
    type: string;
    reason: string | null;
  }>;
  return rows.map((row) => ({
    from_id: row.from_id,
    to_id: row.to_id,
    type: row.type as MemoryEdge['type'],
    reason: row.reason ?? undefined,
  }));
}

type SaveMemoryResult = {
  success: boolean;
  id: string;
  saved_decision_id?: string;
  timeline_event_id?: string | null;
  timeline_event_ids?: string[];
};

async function saveMemoryInternal(
  input: SaveMemoryInput,
  options?: TrustedMemoryWriteOptions
): Promise<SaveMemoryResult> {
  await initDB();
  const adapter = getAdapter();

  const id = buildDecisionId(input.topic);
  const now = Date.now();
  const provenance = normalizeMemoryWriteProvenance(options);
  // Find evolution candidates: exact topic match first, then semantic search fallback
  const primaryScope = input.scopes.length > 0 ? input.scopes[0] : null;
  const excludeIds = new Set(input.excludeIds ?? []);
  let existingCandidates: Array<{ id: string; topic: string; summary: string; kind: string }>;
  if (primaryScope) {
    const scopeId = await ensureMemoryScope(primaryScope.kind, primaryScope.id);
    existingCandidates = (
      adapter
        .prepare(
          `
          SELECT d.id, d.topic, d.summary, d.kind
          FROM decisions d
          JOIN memory_scope_bindings msb ON msb.memory_id = d.id
          WHERE d.topic = ? AND msb.scope_id = ?
            AND (d.status = 'active' OR d.status IS NULL)
            AND d.superseded_by IS NULL
          ORDER BY d.created_at DESC
          LIMIT 5
        `
        )
        .all(input.topic, scopeId) as Array<{
        id: string;
        topic: string;
        summary: string;
        kind: string;
      }>
    ).filter((c) => !excludeIds.has(c.id));
  } else {
    existingCandidates = (
      adapter
        .prepare(
          `
          SELECT id, topic, summary, kind
          FROM decisions
          WHERE topic = ?
            AND (status = 'active' OR status IS NULL)
            AND superseded_by IS NULL
          ORDER BY created_at DESC
          LIMIT 5
        `
        )
        .all(input.topic) as Array<{ id: string; topic: string; summary: string; kind: string }>
    ).filter((c) => !excludeIds.has(c.id));
  }

  // Semantic fallback: if no exact topic match, find similar memories via vector search
  if (existingCandidates.length === 0) {
    try {
      const queryText = `${input.topic} ${input.summary}`;
      const embedding = await generateEmbedding(queryText);
      const semanticResults = await vectorSearch(embedding, 3, 0.82);

      // Scope-filter semantic candidates when a primary scope is available
      let scopeFiltered = semanticResults;
      if (primaryScope) {
        const semIds = semanticResults.map((r) => String(r.id));
        const semScopeMap = batchLoadScopes(adapter, semIds);
        const scopeKey = `${primaryScope.kind}:${primaryScope.id}`;
        scopeFiltered = semanticResults.filter((r) => {
          const scopes = semScopeMap.get(String(r.id)) ?? [];
          return scopes.length === 0 || scopes.some((s) => `${s.kind}:${s.id}` === scopeKey);
        });
      }

      existingCandidates = scopeFiltered
        .filter((r) => {
          const status = String((r as { status?: unknown }).status || '');
          return !status || status === 'active' || status === '';
        })
        .filter((c) => !excludeIds.has(String(c.id)))
        .map((r) => ({
          id: String(r.id),
          topic: String(r.topic || ''),
          summary: String(r.decision || ''),
          kind: 'fact' as const,
          _semanticMatch: true,
        }));
    } catch {
      // Semantic search unavailable — proceed with empty candidates
    }
  }

  const evolution = resolveMemoryEvolution({
    incoming: { topic: input.topic, summary: input.summary, kind: input.kind },
    existing: existingCandidates.map((c) => ({
      ...c,
      kind: (c.kind || 'fact') as MemoryRecord['kind'],
    })),
  });
  const supersedesTarget =
    evolution.edges.find((edge) => edge.type === 'supersedes')?.to_id ?? null;

  const entityObservationIds = Array.from(new Set(input.entityObservationIds ?? []));
  const eventDateTime =
    typeof input.eventDateTime === 'number'
      ? input.eventDateTime
      : loadEventDateTimeForObservations(adapter, entityObservationIds);
  const timelineEvent = buildTimelineEventForSave(
    adapter,
    id,
    input.topic,
    entityObservationIds,
    input.timelineEvent
  );

  await insertDecisionWithEmbedding({
    id,
    topic: input.topic,
    decision: input.summary,
    reasoning: input.details,
    confidence: input.confidence ?? 0.5,
    supersedes: supersedesTarget,
    created_at: now,
    updated_at: now,
    trust_context: JSON.stringify({ source: input.source }),
    event_date: input.eventDate ?? null,
    event_datetime: eventDateTime,
    agent_id: provenance.agent_id,
    model_run_id: provenance.model_run_id,
    envelope_hash: provenance.envelope_hash,
    gateway_call_id: provenance.gateway_call_id,
    source_refs_json: JSON.stringify(provenance.source_refs),
    provenance_json: JSON.stringify(provenance.provenance),
  });

  // Pre-resolve scope IDs before the synchronous transaction
  const resolvedScopeIds: Array<{ scopeId: string; isPrimary: boolean }> = [];
  for (const [index, scope] of input.scopes.entries()) {
    const scopeId = await ensureMemoryScope(scope.kind, scope.id);
    resolvedScopeIds.push({ scopeId, isPrimary: index === 0 });
  }
  // Wrap all post-insert mutations in a transaction for atomicity
  try {
    adapter.transaction(() => {
      adapter
        .prepare(
          `
            UPDATE decisions
            SET kind = ?, status = ?, summary = ?, is_static = ?, trust_context = ?, updated_at = ?
            WHERE id = ?
          `
        )
        .run(
          input.kind,
          input.status ?? 'active',
          input.summary,
          input.kind === 'preference' || input.kind === 'constraint' ? 1 : 0,
          JSON.stringify({ source: input.source }),
          now,
          id
        );

      for (const { scopeId, isPrimary } of resolvedScopeIds) {
        adapter
          .prepare(
            `
              INSERT OR REPLACE INTO memory_scope_bindings (memory_id, scope_id, is_primary)
              VALUES (?, ?, ?)
            `
          )
          .run(id, scopeId, isPrimary ? 1 : 0);
      }

      insertMemoryEventInTransaction(adapter, {
        event_type: 'save',
        actor: provenance.actor,
        source_turn_id: provenance.source_turn_id ?? undefined,
        memory_id: id,
        topic: input.topic,
        scope_refs: input.scopes,
        evidence_refs: provenance.source_refs,
        reason: buildSaveEventReason(provenance.tool_name, provenance.gateway_call_id),
        created_at: now,
      });

      for (const entityObservationId of entityObservationIds) {
        adapter
          .prepare(
            `
              INSERT OR IGNORE INTO decision_entity_sources (
                decision_id, entity_observation_id, relation_type, created_at
              ) VALUES (?, ?, ?, ?)
            `
          )
          .run(id, entityObservationId, 'support', now);
      }

      if (timelineEvent) {
        insertTimelineEventForSave(adapter, timelineEvent, now);
      }

      for (const edge of evolution.edges) {
        if (edge.type === 'supersedes') {
          adapter
            .prepare(
              `UPDATE decisions SET superseded_by = ?, status = 'superseded', updated_at = ? WHERE id = ?`
            )
            .run(id, now, edge.to_id);
        }

        adapter
          .prepare(
            `
              INSERT OR REPLACE INTO decision_edges (from_id, to_id, relationship, reason, weight, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `
          )
          .run(id, edge.to_id, edge.type, edge.reason ?? null, 1.0, now);
      }
    });
  } catch (error) {
    cleanupFailedMemorySave(adapter, id);
    const rollbackError = (
      error instanceof Error ? error : new Error(String(error))
    ) as SaveMemoryRollbackError;
    rollbackError.memoryId = id;
    throw rollbackError;
  }

  // Project to memory_truth table (best-effort; failure should not break save)
  try {
    await projectMemoryTruth({
      memory_id: id,
      topic: input.topic,
      truth_status: (input.status ?? 'active') as MemoryTruthRow['truth_status'],
      effective_summary: input.summary,
      effective_details: input.details,
      trust_score: input.confidence ?? 0.5,
      scope_refs: input.scopes,
      supporting_event_ids: [],
      superseded_by: undefined,
    });
  } catch {
    // Truth projection is best-effort; do not fail the save
  }

  return {
    success: true,
    id,
    saved_decision_id: id,
    timeline_event_id: timelineEvent?.id ?? null,
    timeline_event_ids: timelineEvent ? [timelineEvent.id] : [],
  };
}

export async function saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult> {
  return saveMemoryInternal(sanitizePublicSaveMemoryInput(input));
}

export async function saveMemoryWithTrustedProvenance(
  input: SaveMemoryInput,
  options: TrustedMemoryWriteOptions
): Promise<SaveMemoryResult> {
  return saveMemoryInternal(sanitizePublicSaveMemoryInput(input), options);
}

export async function buildProfile(scopes: MemoryScopeRef[]): Promise<ProfileSnapshot> {
  const records = await loadScopedMemories(scopes);
  return classifyProfileEntries(records);
}

const EXCLUDED_STATUSES: Set<string> = new Set([
  'superseded',
  'quarantined',
  'contradicted',
  'stale',
]);

export async function recallMemory(
  query: string,
  options: RecallMemoryOptions = {}
): Promise<RecallBundle> {
  const bundle = createEmptyRecallBundle(query);

  let matched: MemoryRecord[] = [];
  let fusedHits: FusedHit[] = [];
  let retrievalSource = 'none';
  const projectionMode = process.env.MAMA_ENTITY_PROJECTION_MODE ?? 'shadow';
  let _lexicalRecords: MemoryRecord[] | null = null;
  const loadLexical = async () => {
    if (_lexicalRecords === null) {
      _lexicalRecords = await loadScopedMemories(options.scopes ?? []);
    }
    return _lexicalRecords;
  };

  // Query analysis: detect aggregation patterns and extract sub-queries
  const lowerQuery = query.toLowerCase();
  const isAggregation = /\b(how many|how much|total|all|every|each|count|number of)\b/.test(
    lowerQuery
  );
  const hasMultipleEntities = /\b(and|or|vs|versus|compared|between)\b/.test(lowerQuery);
  const vectorLimit = isAggregation ? 50 : 20;
  const requestedLimit = Math.max(1, Math.floor(options.limit ?? 10));

  // Multi-query decomposition: extract sub-queries for complex questions
  const subQueries: string[] = [query];
  if (hasMultipleEntities) {
    // Split on "or"/"and" to create focused sub-queries
    const parts = query
      .split(/\b(?:or|vs|versus|and|,)\b/i)
      .map((p) => p.trim())
      .filter((p) => p.length > 10);
    if (parts.length > 1) {
      subQueries.push(...parts);
    }
  }

  // Hybrid search: vector + BM25/lexical in parallel, fused with RRF
  await initDB();

  // Channel 1: Vector search (semantic similarity) — run all sub-queries
  const vectorMatched: MemoryRecord[] = [];
  let primaryQueryEmbedding: Float32Array | null = null;
  try {
    for (const sq of subQueries) {
      const queryEmbedding = await generateEmbedding(sq);
      if (sq === query && primaryQueryEmbedding === null) {
        primaryQueryEmbedding = queryEmbedding;
      }
      const vectorResults = await vectorSearch(
        queryEmbedding,
        vectorLimit,
        0.3,
        options.topicPrefix
      );

      let filtered = vectorResults;
      if (options.scopes && options.scopes.length > 0) {
        const vectorIds = vectorResults.map((r) => String(r.id));
        const scopeMap = batchLoadScopes(getAdapter(), vectorIds);
        const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
        filtered = vectorResults.filter((r) => {
          const scopes = scopeMap.get(String(r.id)) ?? [];
          // When scopes are requested, zero-binding results must NOT pass through
          if (scopes.length === 0) return false;
          return scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`));
        });
      }

      for (const result of filtered as Array<
        (typeof vectorResults)[number] & { similarity?: number; status?: string }
      >) {
        const effectiveStatus = (result.status as string) || (result.outcome as string) || '';
        if (!options.includeHistory && effectiveStatus && EXCLUDED_STATUSES.has(effectiveStatus)) {
          continue;
        }
        vectorMatched.push({
          id: String(result.id),
          topic: String(result.topic || ''),
          kind: 'decision' as MemoryKind,
          summary: String(result.decision || ''),
          details: String(result.reasoning || ''),
          confidence: (result as { similarity?: number }).similarity ?? 0.5,
          status: (effectiveStatus as MemoryStatus) || 'active',
          scopes: [],
          source: { package: 'mama-core', source_type: 'vector_search' },
          created_at: result.created_at ?? Date.now(),
          updated_at: result.created_at ?? Date.now(),
          event_date: result.event_date ?? null,
          event_datetime: result.event_datetime ?? null,
        });
      }
    } // end sub-query loop
  } catch (vectorErr) {
    warn(
      `[recallMemory] Vector search failed: ${vectorErr instanceof Error ? vectorErr.message : String(vectorErr)}`
    );
  }

  // Deduplicate vector results from multiple sub-queries
  const seenIds = new Set<string>();
  const dedupedVector: MemoryRecord[] = [];
  for (const r of vectorMatched) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      dedupedVector.push(r);
    }
  }
  vectorMatched.length = 0;
  vectorMatched.push(...dedupedVector);

  // Channel 2: FTS5 BM25 search (preferred) with in-memory lexical fallback
  // Lazy lexical: skip expensive FTS5/lexical when vector already returned enough results,
  // unless this is an aggregation query that benefits from broader coverage.
  const VECTOR_SUFFICIENT_THRESHOLD = 5;
  const needsLexical = isAggregation || vectorMatched.length < VECTOR_SUFFICIENT_THRESHOLD;
  let lexicalCandidates: Array<{ memory: MemoryRecord; score: number }> = [];
  const lexicalLimit = isAggregation ? 100 : 50;

  if (needsLexical) {
    try {
      // Try FTS5 first — proper BM25 ranking, much better than in-memory .includes()
      // FTS5 MATCH treats spaces as AND; convert to OR so partial matches still surface.
      // Use all non-stopword tokens for FTS5 (stopwords already removed by getLexicalQueryTokens).
      // Additional high-frequency words that cause too many FTS5 matches are filtered separately.
      const FTS5_NOISE_WORDS = new Set([
        'this',
        'that',
        'also',
        'just',
        'like',
        'some',
        'many',
        'much',
        'very',
        'more',
        'most',
        'such',
        'each',
        'every',
        'been',
        'being',
        'about',
        'would',
        'could',
        'should',
        'will',
        'year',
        'years',
        'time',
        'know',
        'think',
        'want',
        'need',
        'make',
        'made',
      ]);
      const ftsTokens = getLexicalQueryTokens(query)
        .map((t) => stemToken(t))
        .filter((t) => !FTS5_NOISE_WORDS.has(t));
      const ftsQuery = ftsTokens.length > 0 ? ftsTokens.join(' OR ') : query;
      const ftsResults = await fts5Search(ftsQuery, lexicalLimit);
      if (ftsResults.length > 0) {
        const adapter = getAdapter();
        const fallbackSource: SaveMemoryInput['source'] = {
          package: 'mama-core',
          source_type: 'fts5',
        };

        // Normalize BM25 ranks (negative values, closer to 0 = better match)
        const maxRank = Math.max(...ftsResults.map((r) => Math.abs(r.rank)));

        for (const ftsRow of ftsResults) {
          const row = adapter
            .prepare(
              `SELECT id, topic, decision, reasoning, confidence, created_at, updated_at,
                    trust_context, kind, status, summary, event_date, event_datetime
             FROM decisions WHERE id = ?`
            )
            .get(ftsRow.id) as Record<string, unknown> | undefined;
          if (!row) continue;

          const effectiveStatus = (row.status as string) || '';
          if (
            !options.includeHistory &&
            effectiveStatus &&
            EXCLUDED_STATUSES.has(effectiveStatus)
          ) {
            continue;
          }

          const memoryIds = [String(row.id)];
          const scopeMap = batchLoadScopes(adapter, memoryIds);
          const record = toMemoryRecord(row, scopeMap.get(String(row.id)) ?? [], fallbackSource);

          // Topic prefix filtering (matches vectorSearch behavior)
          if (options.topicPrefix && !record.topic.startsWith(options.topicPrefix)) continue;

          // Scope filtering
          if (options.scopes && options.scopes.length > 0) {
            const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
            const scopes = scopeMap.get(record.id) ?? [];
            if (scopes.length === 0) continue;
            if (!scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`))) continue;
          }

          const bm25Score = maxRank > 0 ? 1 - Math.abs(ftsRow.rank) / maxRank : 0.5;
          lexicalCandidates.push({ memory: record, score: bm25Score });
        }
      }
    } catch {
      // FTS5 not available — fall through to in-memory lexical
    }

    // Fallback: in-memory lexical if FTS5 returned nothing
    if (lexicalCandidates.length === 0) {
      let lexicalRecords = await loadLexical();

      if (options.scopes && options.scopes.length > 0) {
        const lexicalIds = lexicalRecords.map((r) => r.id);
        const scopeMap = batchLoadScopes(getAdapter(), lexicalIds);
        const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
        lexicalRecords = lexicalRecords.filter((r) => {
          const scopes = scopeMap.get(r.id) ?? [];
          if (scopes.length === 0) return false;
          return scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`));
        });
      }

      // Topic prefix filtering for in-memory lexical (matches vectorSearch behavior)
      if (options.topicPrefix) {
        lexicalRecords = lexicalRecords.filter((r) => r.topic.startsWith(options.topicPrefix!));
      }

      lexicalCandidates = buildLexicalCandidates(lexicalRecords, query);
      if (subQueries.length > 1) {
        for (const sq of subQueries.slice(1)) {
          const subCandidates = buildLexicalCandidates(lexicalRecords, sq);
          for (const c of subCandidates) {
            if (!lexicalCandidates.some((existing) => existing.memory.id === c.memory.id)) {
              lexicalCandidates.push(c);
            }
          }
        }
        lexicalCandidates.sort((a, b) => b.score - a.score);
      }
    }
  } // end needsLexical

  // RRF Fusion: combine vector and lexical/FTS5 results by reciprocal rank
  // FTS5 BM25 gets 2x weight — it naturally demotes records where query terms
  // appear only in passing (e.g. "wedding" mentioned once in a dating record),
  // so weighting it higher filters topical noise better than equal weighting.
  // Additionally, vector-only results (no lexical support) are penalized to
  // reduce semantic-but-off-topic noise.
  // Lexical-first fusion: FTS5 BM25 provides the primary ranking (topic relevance),
  // vector similarity acts as a secondary boost (semantic depth).
  // This prevents off-topic records that are semantically similar from ranking high.
  const RRF_K = 60;
  const rrfScores = new Map<string, { record: MemoryRecord; score: number }>();

  // Vector rank map for boosting lexical results
  const vectorRankMap = new Map<string, number>();
  for (let i = 0; i < vectorMatched.length; i++) {
    vectorRankMap.set(vectorMatched[i].id, i);
  }

  // Primary: lexical/FTS5 results with vector boost
  for (let i = 0; i < lexicalCandidates.length; i++) {
    const r = lexicalCandidates[i];
    if (!options.includeHistory && EXCLUDED_STATUSES.has(r.memory.status)) continue;
    const lexScore = 1 / (RRF_K + i + 1);
    const vecRank = vectorRankMap.get(r.memory.id);
    const vecBoost = vecRank !== undefined ? 0.2 * (1 / (RRF_K + vecRank + 1)) : 0;
    rrfScores.set(r.memory.id, { record: r.memory, score: lexScore + vecBoost });
  }

  // Secondary: vector-only results (no lexical backing) get heavily discounted
  for (let i = 0; i < vectorMatched.length; i++) {
    const r = vectorMatched[i];
    if (rrfScores.has(r.id)) continue; // Already included via lexical
    const rrfScore = 0.15 * (1 / (RRF_K + i + 1));
    rrfScores.set(r.id, { record: r, score: rrfScore });
  }

  const sortedRrf = Array.from(rrfScores.values()).sort((a, b) => b.score - a.score);
  const decisionFusedHits: FusedHit[] = sortedRrf.map((entry) => ({
    source_type: 'decision',
    source_id: entry.record.id,
    record: entry.record,
    fused_rank_score: entry.score,
  }));

  let hasWikiHits = false;
  const wikiScores = new Map<number, { record: WikiPageIndexRecord; score: number }>();
  const wikiVectorRankMap = new Map<number, number>();

  try {
    const adapter = getAdapter();
    const wikiFtsHits = ftsSearchWikiPages(adapter, query, requestedLimit * 2);
    let wikiVectorHits: ReturnType<typeof vectorSearchWikiPages> = [];

    if (primaryQueryEmbedding) {
      try {
        wikiVectorHits = vectorSearchWikiPages(adapter, primaryQueryEmbedding, requestedLimit * 2);
      } catch (wikiVectorErr) {
        warn(
          `[recallMemory] Wiki vector search failed: ${wikiVectorErr instanceof Error ? wikiVectorErr.message : String(wikiVectorErr)}`
        );
      }
    }

    for (let i = 0; i < wikiVectorHits.length; i++) {
      wikiVectorRankMap.set(wikiVectorHits[i].record.id, i);
    }

    for (let i = 0; i < wikiFtsHits.length; i++) {
      const hit = wikiFtsHits[i];
      const lexScore = 1 / (RRF_K + i + 1);
      const vecRank = wikiVectorRankMap.get(hit.record.id);
      const vecBoost = vecRank !== undefined ? 0.2 * (1 / (RRF_K + vecRank + 1)) : 0;
      wikiScores.set(hit.record.id, {
        record: hit.record,
        score: lexScore + vecBoost,
      });
    }

    for (let i = 0; i < wikiVectorHits.length; i++) {
      const hit = wikiVectorHits[i];
      if (wikiScores.has(hit.record.id)) {
        continue;
      }
      wikiScores.set(hit.record.id, {
        record: hit.record,
        score: 0.15 * (1 / (RRF_K + i + 1)),
      });
    }

    hasWikiHits = wikiScores.size > 0;
  } catch (wikiFtsErr) {
    warn(
      `[recallMemory] Wiki FTS search failed: ${wikiFtsErr instanceof Error ? wikiFtsErr.message : String(wikiFtsErr)}`
    );
  }

  const wikiFusedHits: FusedHit[] = Array.from(wikiScores.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      source_type: 'wiki_page',
      source_id: entry.record.source_locator,
      record: entry.record,
      fused_rank_score: entry.score,
      ...(entry.record.page_type === 'case' ? { page_type: 'case' as const } : {}),
      ...(entry.record.case_id ? { case_id: entry.record.case_id } : {}),
    }));

  fusedHits = [...decisionFusedHits, ...wikiFusedHits].sort(
    (left, right) => right.fused_rank_score - left.fused_rank_score
  );

  // Normalize RRF scores to 0-1 range so downstream consumers (threshold filters,
  // similarity displays) get meaningful values.  The raw RRF score for K=60 tops out
  // around 0.033, which is misleading when compared against similarity thresholds.
  const maxRrf = sortedRrf.length > 0 ? sortedRrf[0].score : 1;
  matched = sortedRrf.map((entry) => ({
    ...entry.record,
    confidence: maxRrf > 0 ? entry.score / maxRrf : 0,
  }));

  if (vectorMatched.length > 0 && lexicalCandidates.length > 0) {
    retrievalSource = 'hybrid_rrf';
  } else if (vectorMatched.length > 0) {
    retrievalSource = 'vector_search';
  } else if (lexicalCandidates.length > 0) {
    retrievalSource = 'lexical_search';
  }

  if (hasWikiHits) {
    retrievalSource = retrievalSource === 'none' ? 'wiki_page' : `${retrievalSource}+wiki_page`;
  }

  let canonicalMatched: MemoryRecord[] = [];
  if (projectionMode !== 'off') {
    try {
      canonicalMatched = await queryCanonicalEntities(query, options.scopes ?? [], { limit: 10 });
      if (projectionMode === 'dual-write' && canonicalMatched.length > 0) {
        const seenIds = new Set(matched.map((item) => item.id));
        for (const canonical of canonicalMatched) {
          if (!seenIds.has(canonical.id)) {
            matched.push(canonical);
            seenIds.add(canonical.id);
          }
        }
        retrievalSource =
          retrievalSource === 'none' ? 'entity_canonical' : `${retrievalSource}+entity_canonical`;
      } else if (projectionMode === 'shadow' && canonicalMatched.length > 0) {
        retrievalSource =
          retrievalSource === 'none' ? 'shadow_entity_probe' : `${retrievalSource}+shadow_probe`;
      }
    } catch (canonicalErr) {
      warn(
        `[recallMemory] Canonical entity recall failed: ${canonicalErr instanceof Error ? canonicalErr.message : String(canonicalErr)}`
      );
    }
  }

  if (matched.length > 0) {
    const readIdentityIndex = await loadDecisionReadIdentityIndex(
      matched.filter((record) => !record.read_identity).map((record) => record.id)
    );
    for (const record of matched) {
      if (record.read_identity) {
        continue;
      }
      record.read_identity = resolveReadIdentity(record, readIdentityIndex.get(record.id) ?? []);
    }
  }

  // Enrich active records with summaries from their superseded predecessors.
  // When ingestConversation extracts multiple facts under the same topic, only
  // the last survives as "active" — the earlier ones become superseded and are
  // excluded from search.  This recovers their key information so it is not lost.
  if (matched.length > 0) {
    const adapter = getAdapter();
    const stmtChain = adapter.prepare(
      `SELECT id, summary, decision FROM decisions WHERE superseded_by = ?`
    );
    for (const record of matched) {
      const predecessors = stmtChain.all(record.id) as Array<{
        id: string;
        summary?: string;
        decision?: string;
      }>;
      if (predecessors.length > 0) {
        const extra = predecessors
          .map((p) => String(p.summary ?? p.decision ?? ''))
          .filter(Boolean)
          .join(' | ');
        if (extra) {
          record.details = record.details
            ? `${record.details}\n[Prior context] ${extra}`
            : `[Prior context] ${extra}`;
        }
      }
    }
  }

  bundle.memories = matched;
  bundle.graph_context.primary = matched;
  bundle.graph_context.expanded = [];
  bundle.graph_context.edges = [];

  if (matched.length > 0 && !options.skipGraphExpansion) {
    try {
      const candidates = matched.map((m) => ({
        id: m.id,
        topic: m.topic,
        decision: m.summary,
        confidence: m.confidence,
        created_at: m.created_at,
        similarity: m.confidence ?? 0.5,
      }));
      interface GraphExpandedCandidate {
        id: string;
        topic: string;
        decision: string;
        confidence?: number;
        similarity?: number;
        created_at?: number | string;
        graph_source?: string;
        graph_rank?: number;
      }
      interface MamaApiDefault {
        expandWithGraph: (
          candidates: GraphExpandedCandidate[]
        ) => Promise<GraphExpandedCandidate[]>;
      }
      const mamaApiModule = await import('../mama-api.js');
      const mamaDefault: MamaApiDefault = mamaApiModule.default as unknown as MamaApiDefault;
      const expanded = await mamaDefault.expandWithGraph(candidates);
      const primaryIds = new Set(matched.map((m) => m.id));
      let expandedOnly = expanded.filter((e) => !primaryIds.has(e.id));

      // Re-filter expanded results: apply status and scope checks
      if (!options.includeHistory) {
        expandedOnly = expandedOnly.filter((e) => {
          const adapter = getAdapter();
          const row = adapter.prepare(`SELECT status FROM decisions WHERE id = ?`).get(e.id) as
            | { status?: string }
            | undefined;
          const status = row?.status || '';
          return !status || !EXCLUDED_STATUSES.has(status);
        });
      }
      if (options.scopes && options.scopes.length > 0) {
        const expandedIds = expandedOnly.map((e) => e.id);
        const scopeMap = batchLoadScopes(getAdapter(), expandedIds);
        const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
        expandedOnly = expandedOnly.filter((e) => {
          const scopes = scopeMap.get(e.id) ?? [];
          if (scopes.length === 0) return false;
          return scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`));
        });
      }

      bundle.graph_context.expanded = expandedOnly.map((e) => ({
        id: String(e.id),
        topic: String(e.topic || ''),
        kind: 'decision' as const,
        summary: String(e.decision || ''),
        details: '',
        confidence: (e.graph_rank as number) ?? 0.5,
        status: 'active' as const,
        scopes: [],
        source: {
          package: 'mama-core' as const,
          source_type: String(e.graph_source || 'graph_expansion'),
        },
        created_at: (e.created_at as number) ?? Date.now(),
        updated_at: (e.created_at as number) ?? Date.now(),
      }));

      const allIds = [...matched.map((m) => m.id), ...expandedOnly.map((e) => e.id)];
      const allEdges = await loadEdgesForIds(allIds);

      // Filter out edges pointing to decisions with excluded statuses
      const activeIds = new Set(allIds);
      const edgesToCheck = allEdges.filter(
        (e) => !activeIds.has(e.to_id) || !activeIds.has(e.from_id)
      );
      if (edgesToCheck.length > 0) {
        const adapter = getAdapter();
        const checkIds = [
          ...new Set(
            edgesToCheck.flatMap((e) => [e.from_id, e.to_id]).filter((id) => !activeIds.has(id))
          ),
        ];
        const placeholders = checkIds.map(() => '?').join(', ');
        const statusRows = adapter
          .prepare(`SELECT id, status FROM decisions WHERE id IN (${placeholders})`)
          .all(...checkIds) as Array<{ id: string; status: string | null }>;
        const excludedIds = new Set(
          statusRows.filter((r) => r.status && EXCLUDED_STATUSES.has(r.status)).map((r) => r.id)
        );
        bundle.graph_context.edges = allEdges.filter(
          (e) => !excludedIds.has(e.from_id) && !excludedIds.has(e.to_id)
        );
      } else {
        bundle.graph_context.edges = allEdges;
      }
    } catch {
      // Graph expansion is best-effort; do not fail recall
    }
  }

  (bundle as RecallBundle & { fused_hits?: FusedHit[] }).fused_hits = fusedHits;
  bundle.search_meta.scope_order = (options.scopes ?? []).map((scope) => scope.kind);
  bundle.search_meta.retrieval_sources = [retrievalSource];

  if (options.includeProfile) {
    bundle.profile = await buildProfile(options.scopes ?? []);
  }

  return bundle;
}

async function ingestMemoryInternal(
  input: IngestMemoryInput,
  options?: TrustedMemoryWriteOptions
): Promise<{ success: boolean; id: string }> {
  const normalized = input.content.trim();
  return saveMemoryInternal(
    {
      topic:
        normalized
          .slice(0, 40)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '') || 'ingested_memory',
      kind: 'fact',
      summary: normalized.slice(0, 200),
      details: normalized,
      scopes: input.scopes ?? [],
      source: input.source,
      eventDate: input.eventDate,
      eventDateTime: input.eventDateTime,
    },
    options
  );
}

export async function ingestMemory(
  input: IngestMemoryInput
): Promise<{ success: boolean; id: string }> {
  return ingestMemoryInternal(sanitizePublicIngestMemoryInput(input));
}

export async function ingestWithTrustedProvenance(
  input: IngestMemoryInput,
  options: TrustedMemoryWriteOptions
): Promise<{ success: boolean; id: string }> {
  return ingestMemoryInternal(sanitizePublicIngestMemoryInput(input), options);
}

export async function evolveMemory(input: Parameters<typeof resolveMemoryEvolution>[0]) {
  return resolveMemoryEvolution(input);
}

export async function buildMemoryBootstrap(params: {
  scopes: MemoryScopeRef[];
  channelKey?: string;
  currentGoal?: string;
  mainAgentState?: MemoryAgentBootstrap['main_agent_state'];
}): Promise<MemoryAgentBootstrap> {
  return buildMemoryAgentBootstrap(params);
}

export function createAuditAck(input: MemoryAuditAck): MemoryAuditAck {
  return createMemoryAuditAck(input);
}

export async function recordMemoryAudit(input: {
  channelKey: string;
  turnId: string;
  topic: string;
  scopeRefs: MemoryScopeRef[];
  ack: MemoryAuditAck;
  savedMemories?: Array<{ id: string; topic: string; summary: string }>;
}) {
  return recordChannelAudit(input);
}

async function callExtractionLLM(
  prompt: string,
  options: NonNullable<IngestConversationInput['extract']>
): Promise<ExtractedMemoryUnit[]> {
  const model = options.model ?? 'claude-sonnet-4-6';
  const baseUrl = options.baseUrl ?? 'https://api.anthropic.com';

  // Security: only send ANTHROPIC_API_KEY to Anthropic's own domain
  const isAnthropicDomain = /^https?:\/\/([^/]*\.)?anthropic\.com(\/|$)/i.test(baseUrl);
  const apiKey = isAnthropicDomain
    ? (options.apiKey ?? process.env.ANTHROPIC_API_KEY)
    : options.apiKey; // custom baseUrl must supply its own key explicitly

  if (!apiKey) {
    throw new Error(
      isAnthropicDomain
        ? 'ANTHROPIC_API_KEY is required for extraction'
        : 'apiKey must be provided explicitly when using a custom baseUrl'
    );
  }

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => 'unknown');
    throw new Error(`Anthropic API error ${res.status}: ${errorBody}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return parseExtractionResponse(text);
}

let extractionFn: typeof callExtractionLLM = callExtractionLLM;
export function setExtractionFn(fn: typeof callExtractionLLM | null): void {
  extractionFn = fn ?? callExtractionLLM;
}

async function ingestConversationInternal(
  input: IngestConversationInput,
  options?: TrustedMemoryWriteOptions
): Promise<IngestConversationResult> {
  if (!input.messages || input.messages.length === 0) {
    throw new Error('messages array must not be empty');
  }

  const conversationText = input.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const topicPrefix = input.topicPrefix || '';

  const rawResult = await ingestMemoryInternal(
    {
      content: topicPrefix ? `${topicPrefix}${conversationText}` : conversationText,
      scopes: input.scopes,
      source: input.source,
      eventDate: input.sessionDate,
    },
    options
  );

  const result: IngestConversationResult = {
    rawId: rawResult.id,
    extractedMemories: [],
  };

  if (!input.extract?.enabled) {
    return result;
  }

  let units: ExtractedMemoryUnit[];
  try {
    // Fetch existing topics so LLM can reuse them (enables supersedes edges)
    await initDB();
    const adapter = getAdapter();
    let existingTopics: Array<{ topic: string }>;
    if (input.scopes && input.scopes.length > 0) {
      const scopeIds = await Promise.all(
        input.scopes.map((scope) => ensureMemoryScope(scope.kind, scope.id))
      );
      const placeholders = scopeIds.map(() => '?').join(', ');
      existingTopics = adapter
        .prepare(
          `SELECT DISTINCT d.topic FROM decisions d
           JOIN memory_scope_bindings msb ON msb.memory_id = d.id
           WHERE msb.scope_id IN (${placeholders})
             AND (d.status = 'active' OR d.status IS NULL)
           ORDER BY d.created_at DESC LIMIT 200`
        )
        .all(...scopeIds) as Array<{ topic: string }>;
    } else {
      existingTopics = adapter
        .prepare(
          `SELECT DISTINCT topic FROM decisions
           WHERE (status = 'active' OR status IS NULL)
           ORDER BY created_at DESC LIMIT 200`
        )
        .all() as Array<{ topic: string }>;
    }
    const topicList = existingTopics.map((r) => r.topic);

    const prompt = buildExtractionPrompt(input.messages, topicList);
    units = await extractionFn(prompt, input.extract);
  } catch (err) {
    warn(`[memory] extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const adapter = getAdapter();
  const EXTRACTION_EDGE_RELATIONSHIP = 'builds_on';
  const EXTRACTION_EDGE_REASON = 'Extracted from conversation';

  // Track IDs saved in this batch so sibling facts don't supersede each other.
  // Without this, when ingestConversation extracts multiple facts under the same topic,
  // each subsequent save supersedes the previous one, losing independent information.
  const batchSavedIds: string[] = [];

  for (const unit of units) {
    try {
      const saved = await saveMemoryInternal(
        {
          topic: topicPrefix ? `${topicPrefix}${unit.topic}` : unit.topic,
          kind: unit.kind,
          summary: unit.summary,
          details: unit.details,
          confidence: unit.confidence,
          scopes: input.scopes,
          source: input.source,
          excludeIds: batchSavedIds,
          eventDate: input.sessionDate,
        },
        appendProvenanceSourceRefs(options, [`raw_memory:${rawResult.id}`])
      );

      const now = Date.now();
      adapter
        .prepare(
          `INSERT OR REPLACE INTO decision_edges (from_id, to_id, relationship, reason, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          saved.id,
          rawResult.id,
          EXTRACTION_EDGE_RELATIONSHIP,
          EXTRACTION_EDGE_REASON,
          1.0,
          now
        );

      batchSavedIds.push(saved.id);
      result.extractedMemories.push({
        id: saved.id,
        kind: unit.kind,
        topic: unit.topic,
      });
    } catch (err) {
      warn(
        `[memory] failed to save extracted unit topic=${unit.topic} kind=${unit.kind}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

export async function ingestConversation(
  input: IngestConversationInput
): Promise<IngestConversationResult> {
  return ingestConversationInternal(sanitizePublicIngestConversationInput(input));
}

export async function ingestConversationWithTrustedProvenance(
  input: IngestConversationInput,
  options: TrustedMemoryWriteOptions
): Promise<IngestConversationResult> {
  return ingestConversationInternal(sanitizePublicIngestConversationInput(input), options);
}

export { upsertChannelSummary, getChannelSummary };
