import crypto from 'node:crypto';
import {
  initDB,
  getAdapter,
  insertDecisionWithEmbedding,
  ensureMemoryScope,
  vectorSearch,
} from '../db-manager.js';
import { generateEmbedding } from '../embeddings.js';
import { classifyProfileEntries } from './profile-builder.js';
import { buildMemoryAgentBootstrap } from './bootstrap-builder.js';
import { resolveMemoryEvolution } from './evolution-engine.js';
import { recordChannelAudit } from './channel-summary-state-store.js';
import { warn } from '../debug-logger.js';
import { projectMemoryTruth } from './truth-store.js';
import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';
import { createEmptyRecallBundle, createMemoryAuditAck } from './types.js';
import { getChannelSummary, upsertChannelSummary } from './channel-summary-store.js';
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
  RecallBundle,
  IngestConversationInput,
  ExtractedMemoryUnit,
  IngestConversationResult,
} from './types.js';

interface SaveMemoryInput {
  topic: string;
  kind: MemoryKind;
  summary: string;
  details: string;
  confidence?: number;
  status?: MemoryStatus;
  scopes: MemoryScopeRef[];
  source: {
    package: 'mama-core' | 'mcp-server' | 'standalone' | 'claude-code-plugin';
    source_type: string;
    user_id?: string;
    channel_id?: string;
    project_id?: string;
  };
}

interface RecallMemoryOptions {
  scopes?: MemoryScopeRef[];
  includeProfile?: boolean;
  includeHistory?: boolean;
  skipGraphExpansion?: boolean;
  topicPrefix?: string;
}

interface IngestMemoryInput {
  content: string;
  scopes?: MemoryScopeRef[];
  source: SaveMemoryInput['source'];
}

function buildDecisionId(topic: string): string {
  const safeTopic = topic.replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  return `decision_${safeTopic}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
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
                 kind, status, summary
          FROM decisions
          ORDER BY created_at DESC
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
                 d.updated_at, d.trust_context, d.kind, d.status, d.summary
          FROM decisions d
          JOIN memory_scope_bindings msb ON msb.memory_id = d.id
          WHERE msb.scope_id IN (${placeholders})
          ORDER BY d.created_at DESC
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
        if (!haystack.includes(token)) {
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
       WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`
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

export async function saveMemory(
  input: SaveMemoryInput
): Promise<{ success: boolean; id: string }> {
  await initDB();
  const adapter = getAdapter();

  const id = buildDecisionId(input.topic);
  const now = Date.now();
  // Find evolution candidates: exact topic match first, then semantic search fallback
  const primaryScope = input.scopes.length > 0 ? input.scopes[0] : null;
  let existingCandidates: Array<{ id: string; topic: string; summary: string }>;
  if (primaryScope) {
    const scopeId = await ensureMemoryScope(primaryScope.kind, primaryScope.id);
    existingCandidates = adapter
      .prepare(
        `
          SELECT d.id, d.topic, d.summary
          FROM decisions d
          JOIN memory_scope_bindings msb ON msb.memory_id = d.id
          WHERE d.topic = ? AND msb.scope_id = ?
            AND (d.status = 'active' OR d.status IS NULL)
            AND d.superseded_by IS NULL
          ORDER BY d.created_at DESC
          LIMIT 5
        `
      )
      .all(input.topic, scopeId) as Array<{ id: string; topic: string; summary: string }>;
  } else {
    existingCandidates = adapter
      .prepare(
        `
          SELECT id, topic, summary
          FROM decisions
          WHERE topic = ?
            AND (status = 'active' OR status IS NULL)
            AND superseded_by IS NULL
          ORDER BY created_at DESC
          LIMIT 5
        `
      )
      .all(input.topic) as Array<{ id: string; topic: string; summary: string }>;
  }

  // Semantic fallback: if no exact topic match, find similar memories via vector search
  if (existingCandidates.length === 0) {
    try {
      const queryText = `${input.topic} ${input.summary}`;
      const embedding = await generateEmbedding(queryText);
      const semanticResults = await vectorSearch(embedding, 3, 0.82);
      existingCandidates = semanticResults
        .filter((r) => {
          const outcome = String((r as { outcome?: unknown }).outcome || '');
          return !outcome || outcome === 'active' || outcome === '';
        })
        .map((r) => ({
          id: String(r.id),
          topic: String(r.topic || ''),
          summary: String(r.decision || ''),
          _semanticMatch: true,
        }));
    } catch {
      // Semantic search unavailable — proceed with empty candidates
    }
  }

  const evolution = resolveMemoryEvolution({
    incoming: { topic: input.topic, summary: input.summary },
    existing: existingCandidates,
  });
  const supersedesTarget =
    evolution.edges.find((edge) => edge.type === 'supersedes')?.to_id ?? null;

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
  });

  // Pre-resolve scope IDs before the synchronous transaction
  const resolvedScopeIds: Array<{ scopeId: string; isPrimary: boolean }> = [];
  for (const [index, scope] of input.scopes.entries()) {
    const scopeId = await ensureMemoryScope(scope.kind, scope.id);
    resolvedScopeIds.push({ scopeId, isPrimary: index === 0 });
  }

  // Wrap all post-insert mutations in a transaction for atomicity
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

  return { success: true, id };
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
  let retrievalSource = 'none';
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
  try {
    for (const sq of subQueries) {
      const queryEmbedding = await generateEmbedding(sq);
      const vectorResults = await vectorSearch(
        queryEmbedding,
        vectorLimit,
        0.5,
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

  // Channel 2: BM25/lexical search (keyword matching) — always run in parallel
  // For aggregation queries, run lexical on all sub-queries too
  let lexicalRecords = await loadLexical();

  // Enforce scope boundaries: filter out memories without matching scopes
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

  const allLexicalCandidates = buildLexicalCandidates(lexicalRecords, query);
  if (subQueries.length > 1) {
    for (const sq of subQueries.slice(1)) {
      const subCandidates = buildLexicalCandidates(lexicalRecords, sq);
      for (const c of subCandidates) {
        if (!allLexicalCandidates.some((existing) => existing.memory.id === c.memory.id)) {
          allLexicalCandidates.push(c);
        }
      }
    }
    allLexicalCandidates.sort((a, b) => b.score - a.score);
  }
  const lexicalCandidates = allLexicalCandidates;

  // RRF Fusion: combine vector and lexical results by reciprocal rank
  const RRF_K = 60;
  const rrfScores = new Map<string, { record: MemoryRecord; score: number }>();

  for (let i = 0; i < vectorMatched.length; i++) {
    const r = vectorMatched[i];
    const rrfScore = 1 / (RRF_K + i + 1);
    rrfScores.set(r.id, { record: r, score: rrfScore });
  }

  for (let i = 0; i < lexicalCandidates.length; i++) {
    const r = lexicalCandidates[i];
    if (!options.includeHistory && EXCLUDED_STATUSES.has(r.memory.status)) continue;
    const rrfScore = 1 / (RRF_K + i + 1);
    const existing = rrfScores.get(r.memory.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      rrfScores.set(r.memory.id, { record: r.memory, score: rrfScore });
    }
  }

  matched = Array.from(rrfScores.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      ...entry.record,
      confidence: entry.score,
    }));

  if (vectorMatched.length > 0 && lexicalCandidates.length > 0) {
    retrievalSource = 'hybrid_rrf';
  } else if (vectorMatched.length > 0) {
    retrievalSource = 'vector_search';
  } else if (lexicalCandidates.length > 0) {
    retrievalSource = 'lexical_search';
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
      const mamaApiModule = await import('../mama-api.js');
      const mamaDefault = mamaApiModule.default as unknown as {
        expandWithGraph: (
          candidates: GraphExpandedCandidate[]
        ) => Promise<GraphExpandedCandidate[]>;
      };
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
      const edgesToCheck = allEdges.filter((e) => !activeIds.has(e.to_id));
      if (edgesToCheck.length > 0) {
        const adapter = getAdapter();
        const checkIds = [...new Set(edgesToCheck.map((e) => e.to_id))];
        const placeholders = checkIds.map(() => '?').join(', ');
        const statusRows = adapter
          .prepare(
            `SELECT id, status FROM decisions WHERE id IN (${placeholders})`
          )
          .all(...checkIds) as Array<{ id: string; status: string | null }>;
        const excludedIds = new Set(
          statusRows
            .filter((r) => r.status && EXCLUDED_STATUSES.has(r.status))
            .map((r) => r.id)
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

  bundle.search_meta.scope_order = (options.scopes ?? []).map((scope) => scope.kind);
  bundle.search_meta.retrieval_sources = [retrievalSource];

  if (options.includeProfile) {
    bundle.profile = await buildProfile(options.scopes ?? []);
  }

  return bundle;
}

export async function ingestMemory(
  input: IngestMemoryInput
): Promise<{ success: boolean; id: string }> {
  const normalized = input.content.trim();
  return saveMemory({
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
  });
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
  const model = options.model ?? 'claude-sonnet-4-5-20250514';
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

export async function ingestConversation(
  input: IngestConversationInput
): Promise<IngestConversationResult> {
  if (!input.messages || input.messages.length === 0) {
    throw new Error('messages array must not be empty');
  }

  const conversationText = input.messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  const rawResult = await ingestMemory({
    content: conversationText,
    scopes: input.scopes,
    source: input.source,
  });

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

  for (const unit of units) {
    try {
      const saved = await saveMemory({
        topic: unit.topic,
        kind: unit.kind,
        summary: unit.summary,
        details: unit.details,
        confidence: unit.confidence,
        scopes: input.scopes,
        source: input.source,
      });

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

export { upsertChannelSummary, getChannelSummary };
