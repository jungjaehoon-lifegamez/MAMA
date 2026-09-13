import crypto from 'node:crypto';
import { canonicalizeJSON } from '../canonicalize.js';
import { initDB, getAdapter, ensureMemoryScope, vectorSearch, fts5Search } from '../db-manager.js';
import type { DecisionInput } from '../db-manager.js';
import { generateEmbedding } from '../embeddings.js';
import { appendJudgment, judgmentRecordId, ingestSource } from '../knowledge/index.js';
import type { JudgmentCommand, JudgmentReceipt, JsonValue } from './judgment-types.js';
import {
  assertRelationshipTargetsVisible,
  commandEmbedder,
  relationshipsToCommandFields,
  unsignedWriteAccess,
  writeAccessForProvenance,
} from './write-adapters.js';
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
import { createEmptyRecallBundle, createMemoryAuditAck } from './types.js';
import { getChannelSummary, upsertChannelSummary } from './channel-summary-store.js';
import { queryCanonicalEntities } from '../entities/recall-bridge.js';
import { loadDecisionReadIdentityIndex, resolveReadIdentity } from '../entities/read-identity.js';
import {
  normalizeSearchQualityOptions,
  type SearchHitDiagnostics,
} from '../search/search-quality.js';
import type {
  MemoryKind,
  MemoryAgentBootstrap,
  MemoryAuditAck,
  MemoryEdge,
  MemoryRecord,
  MemoryScopeKind,
  MemoryScopeRef,
  MemoryStatus,
  ProfileSnapshot,
  PublicIngestMemoryInput,
  PublicSaveMemoryInput,
  RecallBundle,
  IngestConversationInput,
  IngestConversationResult,
  RecallMemoryOptions,
  RecallSearchDiagnostics,
} from './types.js';
import {
  normalizeMemoryWriteProvenance,
  sanitizePublicIngestConversationInput,
  sanitizePublicIngestMemoryInput,
  sanitizePublicSaveMemoryInput,
  type TrustedMemoryWriteOptions,
} from './provenance.js';
import { validateRecordIdentityReferences } from '../registry/record-identity.js';

type SaveMemoryInput = PublicSaveMemoryInput;
type IngestMemoryInput = PublicIngestMemoryInput;

export interface LegacyMemoryPersistence {
  userInvolvement?: string | null;
  outcome?: string | null;
  failureReason?: string | null;
  limitation?: string | null;
  isStatic?: number;
  relationships?: Array<{ type: string; targetIds: string[] }>;
}

export interface FusedHit {
  source_type: 'decision' | 'wiki_page';
  source_id: string;
  record: MemoryRecord | WikiPageIndexRecord;
  fused_rank_score: number;
  page_type?: WikiPageIndexRecord['page_type'];
  case_id?: string | null;
  retrieval_diagnostics?: SearchHitDiagnostics;
}

interface WikiScoreEntry {
  record: WikiPageIndexRecord;
  score: number;
  lexicalSupport: boolean;
  vectorSimilarity: number | null;
}

export function buildDecisionId(topic: string): string {
  // Non-ASCII topics (Korean etc.) used to collapse into bare underscore runs
  // ("decision_______<ts>") - unreadable and near-colliding. Collapse the runs
  // and fall back to a stable topic hash when nothing ASCII survives; the
  // human-readable topic itself is stored verbatim in the topic column.
  const safeTopic = topic
    .replace(/[^a-z0-9_]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  // sha256 (not sha1) purely to keep SAST scanners quiet - this is an id slug, not crypto.
  const slug =
    safeTopic || `t${crypto.createHash('sha256').update(topic).digest('hex').slice(0, 8)}`;
  return `decision_${slug}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
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

function queryTokenCount(query: string): number {
  const lexicalTokens = getLexicalQueryTokens(query);
  if (lexicalTokens.length > 0) {
    return lexicalTokens.length;
  }
  return query.trim().split(/\s+/).filter(Boolean).length;
}

function looksMixedKoreanEnglish(query: string): boolean {
  return /[\uac00-\ud7a3]/.test(query) && /[a-z]/i.test(query);
}

function looksEntityLike(query: string): boolean {
  return /\b[A-Z][A-Za-z0-9_-]{2,}\b/.test(query) || /[#/][A-Za-z0-9_-]{2,}/.test(query);
}

/**
 * Boost for how strongly a query matches a record's TOPIC (identity field).
 * Scaled to dominate normalized BM25 scores (0-1 range): a query whose every
 * token hits the topic is topic-anchored and must outrank body-text matches
 * (delta-bench: before this, a topic string failed to surface its own rows in
 * top-5 for 42.5% of chains - present in the candidate pool, buried by rank).
 */
export function topicAffinityBoost(
  topic: string,
  tokens: string[],
  normalizedQuery: string
): number {
  if (tokens.length === 0) {
    return 0;
  }
  const topicText = topic.toLowerCase().replace(/_/g, ' ');
  // Word-boundary matching (exact word or stem-prefix), not raw substring:
  // "sent" must not match inside "consent" - a spurious all-tokens match would
  // vault an unrelated topic over the whole BM25 range.
  const topicWords = topicText.split(' ');
  let topicMatches = 0;
  for (const token of tokens) {
    const stem = stemToken(token);
    if (topicWords.some((word) => word === token || word.startsWith(stem))) {
      topicMatches += 1;
    }
  }
  const allTokensInTopic = topicMatches === tokens.length;
  const exact = topicText === normalizedQuery;
  return (exact ? 1 : 0) + (allTokensInTopic ? 2 : 0) + (topicMatches / tokens.length) * 0.5;
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
      // Topic is the identity field: a hit there must outweigh a hit buried in
      // a long decision text. Scale the shared 0-1 affinity boost up to this
      // scorer's integer range so a full topic match dominates.
      const topicBoost = topicAffinityBoost(record.topic, tokens, normalizedQuery) * 5;
      const score = tokenMatches + phraseBoost + topicBoost;
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
  options?: TrustedMemoryWriteOptions,
  legacy?: LegacyMemoryPersistence
): Promise<SaveMemoryResult> {
  await initDB();
  const adapter = getAdapter();

  const provenance = normalizeMemoryWriteProvenance(options);
  const targetStatus = input.status ?? 'active';
  const requestedScopes = input.scopes ?? [];
  const trustedEnvelope = options?.authoritativeScopes !== undefined;
  const access = writeAccessForProvenance(
    provenance,
    requestedScopes,
    options?.authoritativeScopes
  );

  const entityObservationIds = Array.from(new Set(input.entityObservationIds ?? []));
  const eventDateTime =
    typeof input.eventDateTime === 'number'
      ? input.eventDateTime
      : loadEventDateTimeForObservations(adapter, entityObservationIds);

  // Fail before any write: identity references and relationship targets are
  // checked against the same admitted scopes the command will carry.
  validateRecordIdentityReferences({
    itemId: input.itemId,
    actors: input.actors,
    scopes: input.scopes,
  });

  const commandId = `save:${buildDecisionId(input.topic)}`;
  const recordId = judgmentRecordId(commandId);
  const timelineEvent = buildTimelineEventForSave(
    adapter,
    recordId,
    input.topic,
    entityObservationIds,
    input.timelineEvent
  );

  // Relationships are persisted only when the caller names their target ids
  // explicitly. Matching topic text or vector similarity is evidence for
  // retrieval, not identity.
  const explicitRelationships = Array.from(
    new Map(
      (legacy?.relationships ?? []).flatMap((relationship) =>
        relationship.targetIds.map((targetId) => [
          `${relationship.type}:${targetId}`,
          { type: relationship.type, targetId },
        ])
      )
    ).values()
  );
  assertRelationshipTargetsVisible(
    adapter,
    explicitRelationships.map((relationship) => relationship.targetId),
    access.scopes,
    trustedEnvelope
  );
  const { links, replaces, decisionEdges, supersedeTargets } = relationshipsToCommandFields(
    explicitRelationships,
    { trusted: trustedEnvelope }
  );

  const embeddingDecision: DecisionInput = {
    id: recordId,
    topic: input.topic,
    decision: input.summary,
    reasoning: input.details,
    confidence: input.confidence ?? 0.5,
    event_date: input.eventDate ?? null,
    event_datetime: eventDateTime,
  };

  const command: JudgmentCommand = {
    commandId,
    topic: input.topic,
    summary: input.summary,
    reasoning: input.details,
    recordKind: 'judgment',
    confidence: input.confidence ?? 0.5,
    eventDate: input.eventDate ?? null,
    eventDatetime: eventDateTime,
    outcome: legacy?.outcome ?? null,
    failureReason: legacy?.failureReason ?? null,
    limitation: legacy?.limitation ?? null,
    sourceRefs: provenance.source_refs,
    provenance: provenance.provenance as Record<string, JsonValue>,
    agentId: provenance.agent_id,
    modelRunId: provenance.model_run_id,
    envelopeHash: provenance.envelope_hash,
    gatewayCallId: provenance.gateway_call_id,
    scopes: [...requestedScopes],
    links,
    replaces,
    record: {
      kind: input.kind,
      status: targetStatus,
      summary: input.summary,
      isStatic:
        legacy?.isStatic ?? (input.kind === 'preference' || input.kind === 'constraint' ? 1 : 0),
      userInvolvement: legacy?.userInvolvement ?? null,
      trustContext: JSON.stringify({ source: input.source }),
    },
    event: {
      actor: provenance.actor,
      ...(provenance.source_turn_id ? { sourceTurnId: provenance.source_turn_id } : {}),
      evidenceRefs: provenance.source_refs,
      reason: buildSaveEventReason(provenance.tool_name, provenance.gateway_call_id),
    },
    projections: {
      decisionEdges,
      ...(supersedeTargets.length > 0 ? { supersedeTargets } : {}),
      ...(entityObservationIds.length > 0 ? { entitySources: entityObservationIds } : {}),
      ...(timelineEvent
        ? {
            timelineEvent: {
              id: timelineEvent.id,
              entityId: timelineEvent.entity_id,
              eventType: timelineEvent.event_type,
              role: timelineEvent.role,
              validFrom: timelineEvent.valid_from,
              validTo: timelineEvent.valid_to,
              observedAt: timelineEvent.observed_at,
              sourceRef: timelineEvent.source_ref,
              summary: timelineEvent.summary,
              details: timelineEvent.details,
            },
          }
        : {}),
      ...(input.itemId !== undefined || input.actors !== undefined
        ? {
            recordIdentity: { itemId: input.itemId ?? null, actors: input.actors ?? [] },
          }
        : {}),
    },
  };

  let receipt: JudgmentReceipt;
  try {
    receipt = await appendJudgment(command, access, {
      adapter,
      embedder: commandEmbedder(adapter, embeddingDecision),
    });
  } catch (error) {
    const rollbackError = (error instanceof Error ? error : new Error(String(error))) as Error & {
      memoryId?: string;
    };
    rollbackError.memoryId = recordId;
    throw rollbackError;
  }

  return {
    success: true,
    id: receipt.recordId,
    saved_decision_id: receipt.recordId,
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

export async function saveLegacyMemory(
  input: SaveMemoryInput,
  legacy: LegacyMemoryPersistence,
  options?: TrustedMemoryWriteOptions
): Promise<SaveMemoryResult> {
  return saveMemoryInternal(sanitizePublicSaveMemoryInput(input), options, legacy);
}

export async function promoteMemoryStatus(input: {
  memoryId: string;
  status: MemoryStatus;
  nowMs?: number;
}): Promise<void> {
  await initDB();
  const adapter = getAdapter();
  const memoryId = input.memoryId;
  const now = input.nowMs ?? Date.now();
  const targetStatus = input.status;
  const row = adapter
    .prepare(
      `
        SELECT id, topic, decision, confidence, kind, summary, supersedes
        FROM decisions
        WHERE id = ?
      `
    )
    .get(memoryId) as
    | {
        id: string;
        topic: string;
        decision: string;
        confidence: number | null;
        kind: string | null;
        summary: string | null;
        supersedes: string | null;
      }
    | undefined;

  if (!row) {
    throw new Error(`Cannot promote missing memory ${memoryId}`);
  }

  const topic = String(row.topic);
  const summary = String(row.summary ?? row.decision ?? '');
  const kind = ((row.kind ?? 'fact') as MemoryKind) || 'fact';
  const scopes = batchLoadScopes(adapter, [memoryId]).get(memoryId) ?? [];
  let evolution: ReturnType<typeof resolveMemoryEvolution> = { edges: [] };

  if (targetStatus === 'active') {
    const primaryScope = scopes[0] ?? null;
    let existingCandidates: Array<{ id: string; topic: string; summary: string; kind: string }>;
    if (primaryScope) {
      const scopeId = await ensureMemoryScope(primaryScope.kind, primaryScope.id);
      existingCandidates = adapter
        .prepare(
          `
            SELECT d.id, d.topic, d.summary, d.kind
            FROM decisions d
            JOIN memory_scope_bindings msb ON msb.memory_id = d.id
            WHERE d.topic = ? AND msb.scope_id = ? AND d.id <> ?
              AND (d.status = 'active' OR d.status IS NULL)
              AND d.superseded_by IS NULL
            ORDER BY d.created_at DESC
            LIMIT 5
          `
        )
        .all(topic, scopeId, memoryId) as Array<{
        id: string;
        topic: string;
        summary: string;
        kind: string;
      }>;
    } else {
      existingCandidates = adapter
        .prepare(
          `
            SELECT id, topic, summary, kind
            FROM decisions
            WHERE topic = ? AND id <> ?
              AND (status = 'active' OR status IS NULL)
              AND superseded_by IS NULL
            ORDER BY created_at DESC
            LIMIT 5
          `
        )
        .all(topic, memoryId) as Array<{
        id: string;
        topic: string;
        summary: string;
        kind: string;
      }>;
    }

    if (existingCandidates.length === 0) {
      try {
        const queryText = `${topic} ${summary}`;
        const embedding = await generateEmbedding(queryText, 'query');
        // Same exclusion as saveMemoryInternal's fallback: superseded history must
        // not crowd out the prior ACTIVE decision from the 3 candidate slots.
        const semanticResults = await vectorSearch(
          embedding,
          3,
          0.82,
          undefined,
          Array.from(EXCLUDED_STATUSES)
        );

        let scopeFiltered = semanticResults;
        if (primaryScope) {
          const semIds = semanticResults.map((result) => String(result.id));
          const semScopeMap = batchLoadScopes(adapter, semIds);
          const scopeKey = `${primaryScope.kind}:${primaryScope.id}`;
          scopeFiltered = semanticResults.filter((result) => {
            const resultScopes = semScopeMap.get(String(result.id)) ?? [];
            return (
              resultScopes.length === 0 ||
              resultScopes.some((scope) => `${scope.kind}:${scope.id}` === scopeKey)
            );
          });
        }

        existingCandidates = scopeFiltered
          .filter((result) => String(result.id) !== memoryId)
          .filter((result) => {
            const status = String((result as { status?: unknown }).status || '');
            return !status || status === 'active' || status === '';
          })
          .map((result) => ({
            id: String(result.id),
            topic: String(result.topic || ''),
            summary: String(result.decision || ''),
            kind: 'fact' as const,
            _semanticMatch: true,
          }));
      } catch {
        // Semantic search unavailable — proceed with exact-match candidates only.
      }
    }

    evolution = resolveMemoryEvolution({
      incoming: { topic, summary, kind },
      existing: existingCandidates.map((candidate) => ({
        ...candidate,
        kind: (candidate.kind || 'fact') as MemoryRecord['kind'],
      })),
    });
  }
  const existingSupersedesTarget =
    typeof row.supersedes === 'string' && row.supersedes.length > 0 ? row.supersedes : null;
  const supersedesTarget =
    evolution.edges.find((edge) => edge.type === 'supersedes')?.to_id ??
    (targetStatus === 'active' ? existingSupersedesTarget : null);

  // The status change is an authored amendment: one append-only judgment record
  // carries it, and the target row's projection columns move in the same
  // transaction. A replayed command (same id, same payload) returns the stored
  // receipt instead of rewriting.
  const commandId = `promote:${memoryId}:${crypto
    .createHash('sha256')
    .update(
      canonicalizeJSON({
        status: targetStatus,
        supersedes: supersedesTarget,
        edges: evolution.edges.map((edge) => `${edge.type}:${edge.to_id}`),
        now,
      })
    )
    .digest('hex')
    .slice(0, 16)}`;

  const supersedesEdges = evolution.edges.filter((edge) => edge.type === 'supersedes');
  const command: JudgmentCommand = {
    commandId,
    // Audit records link to the amended memory instead of sharing its topic,
    // keeping them out of the topic's evolution candidate pool.
    topic: `judgment/${memoryId}`,
    summary: `Status '${targetStatus}' applied to ${memoryId}`,
    recordKind: 'judgment',
    payload: {
      amended: memoryId,
      status: targetStatus,
      supersedes: supersedesTarget,
      edges: evolution.edges.map((edge) => ({ type: edge.type, to_id: edge.to_id })),
    },
    scopes,
    agentId: null,
    links: [{ relation: 'amends', target: { kind: 'memory', id: memoryId } }],
    amends: [
      // supersedes is included only when a target resolved: applyAmendment
      // writes a column for every key present, so a null here would clear the
      // target's predecessor pointer on non-active promotions.
      {
        target: { kind: 'memory', id: memoryId },
        status: targetStatus,
        ...(supersedesTarget !== null ? { supersedes: supersedesTarget } : {}),
      },
      ...supersedesEdges.map((edge) => ({
        target: { kind: 'memory' as const, id: edge.to_id },
        supersededBy: memoryId,
        status: 'superseded',
      })),
    ],
    projections: {
      decisionEdges: evolution.edges.map((edge) => ({
        fromId: memoryId,
        targetId: edge.to_id,
        relationship: edge.type,
        reason: edge.reason ?? null,
        weight: 1,
      })),
    },
    record: {
      kind: 'fact',
      status: 'active',
      summary: `Status '${targetStatus}' applied to ${memoryId}`,
    },
    recordedAt: now,
    event: { reason: `promote ${memoryId} to '${targetStatus}'` },
  };
  await appendJudgment(command, unsignedWriteAccess(scopes), { adapter });
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
  const searchOptions = normalizeSearchQualityOptions(options);
  const diagnostics: RecallSearchDiagnostics = {
    candidate_counts: {
      vector: 0,
      lexical: 0,
      entity: 0,
      graph_expanded: 0,
      vector_only: 0,
      rejected_by_strictness: 0,
    },
    threshold: searchOptions.threshold,
    strictness: searchOptions.strictness,
  };

  let matched: MemoryRecord[] = [];
  let fusedHits: FusedHit[] = [];
  let retrievalSource = 'none';
  const projectionMode = process.env.MAMA_ENTITY_PROJECTION_MODE ?? 'shadow';
  const vectorSimilarityById = new Map<string, number>();
  const lexicalScoreById = new Map<string, number>();
  const entitySupportIds = new Set<string>();
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
      const queryEmbedding = await generateEmbedding(sq, 'query');
      if (sq === query && primaryQueryEmbedding === null) {
        primaryQueryEmbedding = queryEmbedding;
      }
      const vectorResults = await vectorSearch(
        queryEmbedding,
        vectorLimit,
        searchOptions.threshold,
        searchOptions.topicPrefix,
        // Keep superseded history out of the candidate top-K at search time; the
        // post-filter below stays the authority (and includeHistory restores it).
        options.includeHistory ? undefined : Array.from(EXCLUDED_STATUSES)
      );

      let filtered = vectorResults;
      let vectorScopeMap = new Map<string, MemoryScopeRef[]>();
      if (options.scopes && options.scopes.length > 0) {
        const vectorIds = vectorResults.map((r) => String(r.id));
        vectorScopeMap = batchLoadScopes(getAdapter(), vectorIds);
        const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
        filtered = vectorResults.filter((r) => {
          const scopes = vectorScopeMap.get(String(r.id)) ?? [];
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
          scopes: vectorScopeMap.get(String(result.id)) ?? [],
          source: { package: 'mama-core', source_type: 'vector_search' },
          created_at: result.created_at ?? Date.now(),
          updated_at: result.created_at ?? Date.now(),
          event_date: result.event_date ?? null,
          event_datetime: result.event_datetime ?? null,
        });
        diagnostics.candidate_counts.vector += 1;
        if (typeof result.similarity === 'number' && Number.isFinite(result.similarity)) {
          vectorSimilarityById.set(String(result.id), result.similarity);
        }
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
  const shouldForceLexicalConfirmation =
    searchOptions.strictness !== 'recall' ||
    searchOptions.minLexicalSupport ||
    queryTokenCount(query) <= 3 ||
    looksMixedKoreanEnglish(query) ||
    looksEntityLike(query);
  const needsLexical =
    isAggregation ||
    vectorMatched.length < VECTOR_SUFFICIENT_THRESHOLD ||
    shouldForceLexicalConfirmation;
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
          if (searchOptions.topicPrefix && !record.topic.startsWith(searchOptions.topicPrefix))
            continue;

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

    // Topic-affinity rescore for FTS5 candidates: the OR-joined FTS query
    // floods the pool with body-text matches and plain BM25 buries rows whose
    // TOPIC matches the query (observed: target row present at rank 26/50 in
    // the pool, cut by the limit-5 slice). RRF consumes this array's ORDER,
    // so rescoring must happen before fusion.
    if (lexicalCandidates.length > 0) {
      const boostTokens = getLexicalQueryTokens(query);
      const boostQuery = query.toLowerCase();
      for (const candidate of lexicalCandidates) {
        candidate.score += topicAffinityBoost(candidate.memory.topic, boostTokens, boostQuery);
      }
      lexicalCandidates.sort((left, right) => right.score - left.score);
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
      if (searchOptions.topicPrefix) {
        lexicalRecords = lexicalRecords.filter((r) =>
          r.topic.startsWith(searchOptions.topicPrefix!)
        );
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

  diagnostics.candidate_counts.lexical = lexicalCandidates.length;
  for (const candidate of lexicalCandidates) {
    lexicalScoreById.set(candidate.memory.id, candidate.score);
  }

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
  const wikiScores = new Map<number, WikiScoreEntry>();
  const wikiVectorRankMap = new Map<number, number>();
  const wikiVectorScoreById = new Map<number, number>();

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
      wikiVectorScoreById.set(wikiVectorHits[i].record.id, wikiVectorHits[i].raw_score);
    }
    diagnostics.candidate_counts.lexical += wikiFtsHits.length;
    diagnostics.candidate_counts.vector += wikiVectorHits.length;

    for (let i = 0; i < wikiFtsHits.length; i++) {
      const hit = wikiFtsHits[i];
      const lexScore = 1 / (RRF_K + i + 1);
      const vecRank = wikiVectorRankMap.get(hit.record.id);
      const vecBoost = vecRank !== undefined ? 0.2 * (1 / (RRF_K + vecRank + 1)) : 0;
      wikiScores.set(hit.record.id, {
        record: hit.record,
        score: lexScore + vecBoost,
        lexicalSupport: true,
        vectorSimilarity: wikiVectorScoreById.get(hit.record.id) ?? null,
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
        lexicalSupport: false,
        vectorSimilarity: hit.raw_score,
      });
    }
  } catch (wikiFtsErr) {
    warn(
      `[recallMemory] Wiki FTS search failed: ${wikiFtsErr instanceof Error ? wikiFtsErr.message : String(wikiFtsErr)}`
    );
  }
  fusedHits = decisionFusedHits;

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

  let canonicalMatched: MemoryRecord[] = [];
  if (projectionMode !== 'off') {
    try {
      canonicalMatched = await queryCanonicalEntities(query, options.scopes ?? [], { limit: 10 });
      diagnostics.candidate_counts.entity = canonicalMatched.length;
      for (const canonical of canonicalMatched) {
        entitySupportIds.add(canonical.id);
      }
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

  const requestedScopeKeys = new Set(
    (options.scopes ?? []).map((scope) => `${scope.kind}:${scope.id}`)
  );
  const hasRequestedScopeSupport = (record: MemoryRecord): boolean => {
    if (requestedScopeKeys.size === 0) {
      return true;
    }
    return record.scopes.some((scope) => requestedScopeKeys.has(`${scope.kind}:${scope.id}`));
  };
  // exact_topic confirmation is intentionally narrow: short substring matches
  // would let two-letter queries like "ai" trip on words like "email" and
  // promote vector-only hits past strict/balanced rejection. Require either
  // exact equality or whole-token containment, and ignore tiny queries.
  const EXACT_TOPIC_MIN_QUERY_LENGTH = 3;
  const tokenizeForExactTopic = (input: string): string[] =>
    input.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  const hasExactTopicSupport = (record: MemoryRecord): boolean => {
    const normalizedQuery = query.trim().toLowerCase();
    const normalizedTopic = record.topic.trim().toLowerCase();
    if (!normalizedQuery || !normalizedTopic) {
      return false;
    }
    if (normalizedQuery.length < EXACT_TOPIC_MIN_QUERY_LENGTH) {
      return false;
    }
    if (normalizedQuery === normalizedTopic) {
      return true;
    }
    const queryTokens = tokenizeForExactTopic(normalizedQuery);
    const topicTokens = tokenizeForExactTopic(normalizedTopic);
    // Whole-token match: a topic word equals the entire query, OR the topic
    // (when itself a single token) appears as a complete word in the query.
    return topicTokens.includes(normalizedQuery) || queryTokens.includes(normalizedTopic);
  };
  const hasExactWikiSupport = (record: WikiPageIndexRecord): boolean => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery || normalizedQuery.length < EXACT_TOPIC_MIN_QUERY_LENGTH) {
      return false;
    }
    const normalizedTitle = record.title.trim().toLowerCase();
    if (!normalizedTitle) {
      return false;
    }
    if (normalizedQuery === normalizedTitle) {
      return true;
    }
    const queryTokens = tokenizeForExactTopic(normalizedQuery);
    const titleTokens = tokenizeForExactTopic(normalizedTitle);
    // Wiki exact_topic uses TITLE only — page body matches are too lenient
    // for an "exact" signal and remain available through other diagnostics.
    return titleTokens.includes(normalizedQuery) || queryTokens.includes(normalizedTitle);
  };
  const wikiDecisionIdCache = new Map<number, string[]>();
  const normalizeWikiDecisionSourceId = (sourceId: string): string | null => {
    const trimmed = sourceId.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith('decision://')) {
      const id = trimmed.slice('decision://'.length).trim();
      return id || null;
    }
    if (trimmed.startsWith('decision:')) {
      const id = trimmed.slice('decision:'.length).trim();
      return id || null;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(trimmed)) {
      return null;
    }
    return trimmed;
  };
  const loadWikiDecisionIds = (record: WikiPageIndexRecord): string[] => {
    const cached = wikiDecisionIdCache.get(record.id);
    if (cached) {
      return cached;
    }

    const ids = new Set<string>();
    for (const sourceId of record.source_ids) {
      const decisionId = normalizeWikiDecisionSourceId(sourceId);
      if (decisionId) {
        ids.add(decisionId);
      }
    }
    if (record.case_id) {
      const rows = getAdapter()
        .prepare(
          `
            SELECT source_id
            FROM case_memberships
            WHERE case_id = ?
              AND source_type = 'decision'
              AND status = 'active'
          `
        )
        .all(record.case_id) as Array<{ source_id?: string }>;
      for (const row of rows) {
        if (row.source_id) {
          ids.add(row.source_id);
        }
      }
    }

    const decisionIds = Array.from(ids);
    wikiDecisionIdCache.set(record.id, decisionIds);
    return decisionIds;
  };
  const wikiScopeSupportCache = new Map<number, boolean>();
  const hasRequestedWikiScopeSupport = (record: WikiPageIndexRecord): boolean => {
    if (requestedScopeKeys.size === 0) {
      return true;
    }
    const cached = wikiScopeSupportCache.get(record.id);
    if (cached !== undefined) {
      return cached;
    }

    const decisionIds = loadWikiDecisionIds(record);
    if (decisionIds.length === 0) {
      wikiScopeSupportCache.set(record.id, false);
      return false;
    }

    const scopeMap = batchLoadScopes(getAdapter(), decisionIds);
    const supported = decisionIds.some((id) =>
      (scopeMap.get(id) ?? []).some((scope) => requestedScopeKeys.has(`${scope.kind}:${scope.id}`))
    );
    wikiScopeSupportCache.set(record.id, supported);
    return supported;
  };
  // Combined check used for the wiki *filter* path: a wiki entry must have at
  // least one linked decision that matches BOTH the requested scope AND the
  // requested topicPrefix. Without this, the page passes when scope matches
  // decision A and topic matches decision B — i.e., neither single decision
  // satisfies the caller's filter. Diagnostics reporting (which only signals
  // scope confirmation) keeps using hasRequestedWikiScopeSupport.
  const wikiCombinedSupportCache = new Map<number, boolean>();
  const hasWikiDecisionWithScopeAndTopic = (record: WikiPageIndexRecord): boolean => {
    const requiresScope = requestedScopeKeys.size > 0;
    const requiresTopic = !!searchOptions.topicPrefix;
    if (!requiresScope && !requiresTopic) {
      return true;
    }
    const cached = wikiCombinedSupportCache.get(record.id);
    if (cached !== undefined) {
      return cached;
    }
    const decisionIds = loadWikiDecisionIds(record);
    if (decisionIds.length === 0) {
      wikiCombinedSupportCache.set(record.id, false);
      return false;
    }
    const adapter = getAdapter();
    const scopeMap = requiresScope ? batchLoadScopes(adapter, decisionIds) : null;
    const topicByDecisionId = new Map<string, string>();
    if (requiresTopic) {
      const IN_CHUNK_SIZE = 900;
      for (let i = 0; i < decisionIds.length; i += IN_CHUNK_SIZE) {
        const chunk = decisionIds.slice(i, i + IN_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = adapter
          .prepare(`SELECT id, topic FROM decisions WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; topic?: string }>;
        for (const row of rows) {
          topicByDecisionId.set(row.id, String(row.topic ?? ''));
        }
      }
    }
    const supported = decisionIds.some((id) => {
      if (requiresScope) {
        const scopes = scopeMap?.get(id) ?? [];
        const scopeOk = scopes.some((scope) => requestedScopeKeys.has(`${scope.kind}:${scope.id}`));
        if (!scopeOk) {
          return false;
        }
      }
      if (requiresTopic) {
        const topic = topicByDecisionId.get(id) ?? '';
        if (!topic.startsWith(searchOptions.topicPrefix!)) {
          return false;
        }
      }
      return true;
    });
    wikiCombinedSupportCache.set(record.id, supported);
    return supported;
  };
  const buildDiagnostics = (
    record: MemoryRecord,
    graphSource: SearchHitDiagnostics['graph_source']
  ): SearchHitDiagnostics => {
    const vectorSimilarity = vectorSimilarityById.get(record.id) ?? null;
    const lexicalSupport = lexicalScoreById.has(record.id);
    const entitySupport = entitySupportIds.has(record.id);
    const exactTopicSupport = hasExactTopicSupport(record);
    const scopeSupport = hasRequestedScopeSupport(record);
    const confirmationSignals = [
      lexicalSupport ? 'lexical' : null,
      entitySupport ? 'entity' : null,
      exactTopicSupport ? 'exact_topic' : null,
    ].filter((signal): signal is string => signal !== null);
    const metadataSignals = [
      requestedScopeKeys.size > 0 && scopeSupport ? 'scope' : null,
      graphSource === 'primary' ? 'graph_primary' : null,
      graphSource === 'expanded' ? 'graph_expanded' : null,
    ].filter((signal): signal is string => signal !== null);
    const retrievalSourceForRecord =
      vectorSimilarity !== null && lexicalSupport
        ? 'hybrid_rrf'
        : vectorSimilarity !== null
          ? 'vector_search'
          : lexicalSupport
            ? 'lexical_search'
            : entitySupport
              ? 'entity_canonical'
              : String(record.source.source_type || 'unknown');

    return {
      retrieval_source: retrievalSourceForRecord,
      vector_similarity: vectorSimilarity,
      lexical_support: lexicalSupport,
      entity_support: entitySupport,
      scope_support: scopeSupport,
      graph_source: graphSource,
      is_vector_only: vectorSimilarity !== null && confirmationSignals.length === 0,
      confirmation_signals: confirmationSignals,
      metadata_signals: metadataSignals,
      candidate_threshold_used: searchOptions.threshold,
    };
  };
  const buildWikiDiagnostics = (entry: WikiScoreEntry): SearchHitDiagnostics => {
    const lexicalSupport = entry.lexicalSupport;
    const exactTopicSupport = hasExactWikiSupport(entry.record);
    const scopeSupport = hasRequestedWikiScopeSupport(entry.record);
    const confirmationSignals = [
      lexicalSupport ? 'lexical' : null,
      exactTopicSupport ? 'exact_topic' : null,
    ].filter((signal): signal is string => signal !== null);
    // Only attribute 'scope' when the caller actually requested a scope filter.
    // hasRequestedWikiScopeSupport() returns true by default for unscoped searches,
    // so without this guard the diagnostics would overstate why the wiki hit passed.
    const metadataSignals = [
      requestedScopeKeys.size > 0 && scopeSupport ? 'scope' : null,
      'graph_primary',
    ].filter((signal): signal is string => signal !== null);
    const retrievalSourceForRecord =
      entry.vectorSimilarity !== null && lexicalSupport
        ? 'wiki_hybrid_rrf'
        : entry.vectorSimilarity !== null
          ? 'wiki_vector_search'
          : lexicalSupport
            ? 'wiki_lexical_search'
            : 'wiki_page';

    return {
      retrieval_source: retrievalSourceForRecord,
      vector_similarity: entry.vectorSimilarity,
      lexical_support: lexicalSupport,
      entity_support: false,
      scope_support: scopeSupport,
      graph_source: 'primary',
      is_vector_only: entry.vectorSimilarity !== null && confirmationSignals.length === 0,
      confirmation_signals: confirmationSignals,
      metadata_signals: metadataSignals,
      candidate_threshold_used: searchOptions.threshold,
    };
  };
  const passesStrictness = (hitDiagnostics: SearchHitDiagnostics): boolean => {
    if (searchOptions.strictness === 'recall') {
      return true;
    }
    if (hitDiagnostics.confirmation_signals.length === 0) {
      return false;
    }
    if (!searchOptions.minLexicalSupport) {
      return true;
    }
    return (
      hitDiagnostics.lexical_support ||
      hitDiagnostics.entity_support ||
      hitDiagnostics.confirmation_signals.includes('exact_topic')
    );
  };

  const acceptedPrimaryIds = new Set<string>();
  matched = matched.flatMap((record) => {
    const recordDiagnostics = buildDiagnostics(record, 'primary');
    if (recordDiagnostics.is_vector_only) {
      diagnostics.candidate_counts.vector_only += 1;
    }
    if (!passesStrictness(recordDiagnostics)) {
      diagnostics.candidate_counts.rejected_by_strictness += 1;
      return [];
    }
    acceptedPrimaryIds.add(record.id);
    return [
      searchOptions.diagnostics ? { ...record, retrieval_diagnostics: recordDiagnostics } : record,
    ];
  });
  fusedHits = fusedHits.filter(
    (hit) => hit.source_type !== 'decision' || acceptedPrimaryIds.has(hit.source_id)
  );
  // Honor options.limit on the final memories (matched is RRF-rank-sorted, canonical
  // dual-write appends last). Without this cap the full fusion set (hundreds of records)
  // flowed into bundle.memories AND the per-record enrichment SQL loops below.
  if (matched.length > requestedLimit) {
    matched = matched.slice(0, requestedLimit);
    // Keep bundle.fused_hits consistent with the capped memories: drop decision hits
    // whose record no longer appears in `matched` (wiki hits are added below and are
    // not keyed to memories).
    const cappedIds = new Set(matched.map((record) => record.id));
    fusedHits = fusedHits.filter(
      (hit) => hit.source_type !== 'decision' || cappedIds.has(hit.source_id)
    );
  }
  const acceptedWikiFusedHits: FusedHit[] = Array.from(wikiScores.values())
    .sort((a, b) => b.score - a.score)
    .flatMap((entry) => {
      if (!hasWikiDecisionWithScopeAndTopic(entry.record)) {
        return [];
      }

      const wikiDiagnostics = buildWikiDiagnostics(entry);
      if (wikiDiagnostics.is_vector_only) {
        diagnostics.candidate_counts.vector_only += 1;
      }
      if (!passesStrictness(wikiDiagnostics)) {
        diagnostics.candidate_counts.rejected_by_strictness += 1;
        return [];
      }

      return [
        {
          source_type: 'wiki_page' as const,
          source_id: entry.record.source_locator,
          record: searchOptions.diagnostics
            ? { ...entry.record, retrieval_diagnostics: wikiDiagnostics }
            : entry.record,
          fused_rank_score: entry.score,
          ...(searchOptions.diagnostics ? { retrieval_diagnostics: wikiDiagnostics } : {}),
          ...(entry.record.page_type === 'case' ? { page_type: 'case' as const } : {}),
          ...(entry.record.case_id ? { case_id: entry.record.case_id } : {}),
        },
      ];
    });
  hasWikiHits = acceptedWikiFusedHits.length > 0;
  fusedHits = [...fusedHits, ...acceptedWikiFusedHits].sort(
    (left, right) => right.fused_rank_score - left.fused_rank_score
  );

  if (hasWikiHits) {
    retrievalSource = retrievalSource === 'none' ? 'wiki_page' : `${retrievalSource}+wiki_page`;
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

  if (matched.length > 0 && !options.skipGraphExpansion && searchOptions.includeRelated) {
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
      let expandedScopeMap = new Map<string, MemoryScopeRef[]>();

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
        expandedScopeMap = batchLoadScopes(getAdapter(), expandedIds);
        const requestedScopes = new Set(options.scopes.map((s) => `${s.kind}:${s.id}`));
        expandedOnly = expandedOnly.filter((e) => {
          const scopes = expandedScopeMap.get(e.id) ?? [];
          if (scopes.length === 0) return false;
          return scopes.some((s) => requestedScopes.has(`${s.kind}:${s.id}`));
        });
      }

      bundle.graph_context.expanded = expandedOnly.flatMap((e) => {
        const expandedRecord: MemoryRecord = {
          id: String(e.id),
          topic: String(e.topic || ''),
          kind: 'decision' as const,
          summary: String(e.decision || ''),
          details: '',
          confidence: (e.graph_rank as number) ?? 0.5,
          status: 'active' as const,
          scopes: expandedScopeMap.get(e.id) ?? [],
          source: {
            package: 'mama-core' as const,
            source_type: String(e.graph_source || 'graph_expansion'),
          },
          created_at: (e.created_at as number) ?? Date.now(),
          updated_at: (e.created_at as number) ?? Date.now(),
        };
        const expandedDiagnostics = buildDiagnostics(expandedRecord, 'expanded');
        if (!passesStrictness(expandedDiagnostics)) {
          diagnostics.candidate_counts.rejected_by_strictness += 1;
          return [];
        }
        return [
          searchOptions.diagnostics
            ? {
                ...expandedRecord,
                retrieval_diagnostics: expandedDiagnostics,
              }
            : expandedRecord,
        ];
      });
      diagnostics.candidate_counts.graph_expanded = bundle.graph_context.expanded.length;
      // Graph-expanded hits are supporting context for the primary matches -
      // they must never OUTRANK them. The previous score ((graph_rank)*0.1,
      // typically 0.05-0.095) sat far above the entire RRF range (<=~0.018),
      // so expansion hits displaced every primary hit from the fused top-N
      // (delta-bench root cause: top-5 filled with related-but-wrong topics
      // while the queried topic's own rows were cut). Scale them into a band
      // strictly below the weakest primary hit, ordered by graph rank.
      const minPrimaryScore =
        fusedHits.length > 0 ? Math.min(...fusedHits.map((hit) => hit.fused_rank_score)) : 0.002;
      fusedHits = [
        ...fusedHits,
        ...bundle.graph_context.expanded.map((record) => ({
          source_type: 'decision' as const,
          source_id: record.id,
          record,
          fused_rank_score:
            minPrimaryScore * 0.9 * Math.min(1, Math.max(0.1, record.confidence ?? 0.5)),
          retrieval_diagnostics: record.retrieval_diagnostics,
        })),
      ].sort((left, right) => right.fused_rank_score - left.fused_rank_score);

      // bundle.graph_context.expanded is the strictness-filtered set of
      // expanded nodes that will actually be returned. Use those IDs (not
      // expandedOnly, which still contains rejected candidates) so edges
      // never point at nodes that never made it into the graph payload.
      const acceptedExpandedIds = bundle.graph_context.expanded.map((record) => record.id);
      const allIds = [...matched.map((m) => m.id), ...acceptedExpandedIds];
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
  if (searchOptions.diagnostics) {
    bundle.search_meta.diagnostics = diagnostics;
  }

  if (options.includeProfile) {
    bundle.profile = await buildProfile(options.scopes ?? []);
  }

  return bundle;
}

async function ingestMemoryInternal(
  input: IngestMemoryInput,
  options?: TrustedMemoryWriteOptions
): Promise<{ success: boolean; id: string }> {
  // Raw evidence goes through source.ingest: exactly one immutable observation
  // per request, no judgment row, no extraction.
  const normalized = input.content;
  const provenance = normalizeMemoryWriteProvenance(options);
  const requestedScopes = input.scopes ?? [];
  const access = writeAccessForProvenance(
    provenance,
    requestedScopes,
    options?.authoritativeScopes
  );
  const commandId = `source:${crypto
    .createHash('sha256')
    .update(
      canonicalizeJSON({
        content: normalized,
        scopes: requestedScopes,
        source: input.source,
        eventDate: input.eventDate ?? null,
        eventDateTime: input.eventDateTime ?? null,
        provenance: provenance.provenance,
      })
    )
    .digest('hex')
    .slice(0, 24)}`;
  const receipt = await ingestSource(
    {
      commandId,
      source: {
        connector: input.source.source_type ?? 'ingest',
        id: commandId,
      },
      body: normalized,
      sourceAt:
        typeof input.eventDateTime === 'number'
          ? input.eventDateTime
          : input.eventDate
            ? Date.parse(input.eventDate)
            : null,
      metadata: {
        source: input.source as unknown as JsonValue,
        eventDate: input.eventDate ?? null,
        eventDateTime: input.eventDateTime ?? null,
      },
      scopes: [...requestedScopes],
      event: {
        actor: provenance.actor,
        ...(provenance.source_turn_id ? { sourceTurnId: provenance.source_turn_id } : {}),
        ...(provenance.source_refs.length > 0 ? { evidenceRefs: provenance.source_refs } : {}),
        reason: 'ingest memory',
      },
    },
    access
  );
  return { success: true, id: receipt.observationId };
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

async function ingestConversationInternal(
  input: IngestConversationInput,
  options?: TrustedMemoryWriteOptions
): Promise<IngestConversationResult> {
  if (!input.messages || input.messages.length === 0) {
    throw new Error('messages array must not be empty');
  }
  // Extraction was removed from the write boundary: conversations are stored as
  // raw evidence only. The option is rejected before any write so a caller can
  // never mistake a raw observation for an extracted judgment.
  if (input.extract !== undefined) {
    throw new Error(
      'ingestConversation() no longer supports the extract option; ' +
        'conversations are stored as raw source observations without judgment writes'
    );
  }

  const conversationText = input.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const topicPrefix = input.topicPrefix || '';
  const body = topicPrefix ? `${topicPrefix}${conversationText}` : conversationText;

  const provenance = normalizeMemoryWriteProvenance(options);
  const requestedScopes = input.scopes ?? [];
  const access = writeAccessForProvenance(
    provenance,
    requestedScopes,
    options?.authoritativeScopes
  );
  // No observedAt in the command: it must hash identically on a retry so the
  // same commandId replays its stored receipt instead of conflicting.
  const commandId = `source-conv:${crypto
    .createHash('sha256')
    .update(
      canonicalizeJSON({
        body,
        scopes: requestedScopes,
        source: input.source,
        sessionDate: input.sessionDate ?? null,
        provenance: provenance.provenance,
      })
    )
    .digest('hex')
    .slice(0, 24)}`;
  const receipt = await ingestSource(
    {
      commandId,
      source: {
        connector: `conversation:${input.source.source_type ?? 'unknown'}`,
        id: commandId,
      },
      body,
      sourceAt: input.sessionDate ? Date.parse(input.sessionDate) : null,
      metadata: {
        message_count: input.messages.length,
        roles: input.messages.map((m) => m.role),
        session_date: input.sessionDate ?? null,
        topic_prefix: topicPrefix || null,
        source: input.source as unknown as JsonValue,
      },
      scopes: [...requestedScopes],
      event: {
        actor: provenance.actor,
        ...(provenance.source_turn_id ? { sourceTurnId: provenance.source_turn_id } : {}),
        ...(provenance.source_refs.length > 0 ? { evidenceRefs: provenance.source_refs } : {}),
        reason: 'ingest conversation',
      },
    },
    access
  );

  return { rawId: receipt.observationId, extractedMemories: [] };
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
