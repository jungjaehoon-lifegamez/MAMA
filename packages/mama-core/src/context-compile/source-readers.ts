import type { DatabaseAdapter } from '../db-manager.js';
import { listVisibleTwinEdgesForRefs } from '../edges/ref-validation.js';
import type { ListVisibleTwinEdgesOptions, TwinEdgeRecord, TwinRef } from '../edges/types.js';
import { getLexicalQueryTokens, recallMemory as defaultRecallMemory } from '../memory/api.js';
import type {
  MemoryKind,
  MemoryRecord,
  MemoryScopeKind,
  RecallBundle,
  RecallMemoryOptions,
} from '../memory/types.js';
import type { SearchHitDiagnostics, SearchStrictness } from '../search/search-quality.js';
import type { ContextBoundary, ContextProjectRef, ContextRange, ContextRef } from './types.js';
import { serializeContextRefForProvenance, toTwinRef } from './ref.js';
import { assertContextBoundaryAllowsInput } from './visibility.js';
import { applyContextBoundaryReadDefaults } from './boundary-defaults.js';
import type { MemoryScopeRef } from '../memory/types.js';

type ContextSourceAdapter = Pick<DatabaseAdapter, 'prepare'>;

export type ContextCandidateSource = 'memory' | 'raw' | 'graph';
export type ContextCandidateKind = ContextRef['kind'];

export interface ContextCandidateSupport {
  retrieval_source?: string;
  lexical_support?: boolean;
  entity_support?: boolean;
  scope_support?: boolean;
  graph_source?: 'primary' | 'expanded' | null;
  graph_expanded?: boolean;
  is_vector_only?: boolean;
  vector_similarity?: number | null;
  confirmation_signals: string[];
  metadata_signals: string[];
}

export interface ContextCandidate {
  ref: ContextRef;
  title: string;
  excerpt: string;
  score: number;
  timestamp_ms: number | null;
  source: ContextCandidateSource;
  visible: boolean;
  hidden_reason?: string;
  support: ContextCandidateSupport;
  retrieval_diagnostics?: SearchHitDiagnostics;
  edge_id?: string;
  edge_type?: string;
}

export interface HiddenCandidateAggregate {
  total: number;
  by_kind: Partial<Record<ContextCandidateKind, number>>;
  by_reason: Record<string, number>;
}

export interface ContextSourceReadResult {
  candidates: ContextCandidate[];
  hidden: HiddenCandidateAggregate;
  source_refs: ContextRef[];
}

export interface ContextSourceReadInput {
  task: string;
  scopes?: MemoryScopeRef[];
  connectors?: string[];
  project_refs?: ContextProjectRef[];
  tenant_id?: string | null;
  boundary?: ContextBoundary;
  range?: ContextRange;
  as_of?: string | number | null;
  limit?: number;
  threshold?: number;
  strictness?: SearchStrictness;
}

export interface ContextSourceReaderDeps {
  adapter?: ContextSourceAdapter;
  recallMemory?: (query: string, options?: RecallMemoryOptions) => Promise<RecallBundle>;
  listVisibleTwinEdgesForRefs?: (
    adapter: ContextSourceAdapter,
    refs: readonly TwinRef[],
    options?: ListVisibleTwinEdgesOptions
  ) => TwinEdgeRecord[];
}

function hiddenAggregate(): HiddenCandidateAggregate {
  return { total: 0, by_kind: {}, by_reason: {} };
}

function incrementHidden(
  aggregate: HiddenCandidateAggregate,
  ref: ContextRef,
  reason: string
): void {
  aggregate.total += 1;
  aggregate.by_kind[ref.kind] = (aggregate.by_kind[ref.kind] ?? 0) + 1;
  aggregate.by_reason[reason] = (aggregate.by_reason[reason] ?? 0) + 1;
}

function tableExists(adapter: ContextSourceAdapter, table: string): boolean {
  const row = adapter
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function normalizeLimit(limit: number | undefined): number {
  return Math.max(0, Math.min(100, Math.floor(limit ?? 10)));
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.floor(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asOfMs(input: ContextSourceReadInput): number | null {
  if (input.as_of === null || input.as_of === undefined) {
    return null;
  }
  const parsed = parseTimestampMs(input.as_of);
  if (parsed === null) {
    throw new Error(`Invalid context source as_of: ${String(input.as_of)}`);
  }
  return parsed;
}

function timeFilterRequired(input: ContextSourceReadInput): boolean {
  return Boolean(
    input.range?.start_ms !== undefined ||
    input.range?.end_ms !== undefined ||
    (input.as_of !== undefined && input.as_of !== null)
  );
}

function rangeBoundaryMs(value: unknown, field: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  throw new Error(`Invalid context source ${field}: ${String(value)}`);
}

function maxVisibleTimeMs(input: ContextSourceReadInput): number | null {
  const ends = [rangeBoundaryMs(input.range?.end_ms, 'range.end_ms'), asOfMs(input)].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  return ends.length > 0 ? Math.min(...ends) : null;
}

function minVisibleTimeMs(input: ContextSourceReadInput): number | null {
  return rangeBoundaryMs(input.range?.start_ms, 'range.start_ms');
}

function isWithinTimeBoundary(timestampMs: number, input: ContextSourceReadInput): boolean {
  const min = minVisibleTimeMs(input);
  const max = maxVisibleTimeMs(input);
  return (min === null || timestampMs >= min) && (max === null || timestampMs <= max);
}

function hasExplicitEmptyProjectWindow(input: ContextSourceReadInput): boolean {
  return (
    Array.isArray(input.project_refs) &&
    input.project_refs.length === 0 &&
    (input.boundary?.project_refs?.length ?? 0) > 0
  );
}

function applyBoundaryDefaults(input: ContextSourceReadInput): ContextSourceReadInput {
  return applyContextBoundaryReadDefaults(input, input.boundary);
}

function memoryTimestampMs(memory: MemoryRecord): number | null {
  return (
    parseTimestampMs(memory.event_datetime) ??
    parseTimestampMs(memory.updated_at) ??
    parseTimestampMs(memory.created_at)
  );
}

function diagnosticsFromUnknown(value: unknown): SearchHitDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<SearchHitDiagnostics>;
  if (typeof record.retrieval_source !== 'string') {
    return undefined;
  }
  return {
    retrieval_source: record.retrieval_source,
    vector_similarity:
      typeof record.vector_similarity === 'number' ? record.vector_similarity : null,
    lexical_support: record.lexical_support === true,
    entity_support: record.entity_support === true,
    scope_support: record.scope_support === true,
    graph_source:
      record.graph_source === 'primary' || record.graph_source === 'expanded'
        ? record.graph_source
        : null,
    is_vector_only: record.is_vector_only === true,
    confirmation_signals: Array.isArray(record.confirmation_signals)
      ? record.confirmation_signals.filter((signal): signal is string => typeof signal === 'string')
      : [],
    metadata_signals: Array.isArray(record.metadata_signals)
      ? record.metadata_signals.filter((signal): signal is string => typeof signal === 'string')
      : [],
    candidate_threshold_used:
      typeof record.candidate_threshold_used === 'number' ? record.candidate_threshold_used : 0,
  };
}

function supportFromDiagnostics(
  diagnostics: SearchHitDiagnostics | undefined
): ContextCandidateSupport {
  return {
    retrieval_source: diagnostics?.retrieval_source,
    lexical_support: diagnostics?.lexical_support,
    entity_support: diagnostics?.entity_support,
    scope_support: diagnostics?.scope_support,
    graph_source: diagnostics?.graph_source,
    graph_expanded: diagnostics?.graph_source === 'expanded',
    is_vector_only: diagnostics?.is_vector_only,
    vector_similarity: diagnostics?.vector_similarity,
    confirmation_signals: diagnostics?.confirmation_signals ?? [],
    metadata_signals: diagnostics?.metadata_signals ?? [],
  };
}

function emptySupport(retrievalSource?: string): ContextCandidateSupport {
  return {
    retrieval_source: retrievalSource,
    confirmation_signals: [],
    metadata_signals: [],
  };
}

const EXCLUDED_MEMORY_STATUSES = new Set(['superseded', 'quarantined', 'contradicted', 'stale']);

function loadScopesForMemoryIds(
  adapter: ContextSourceAdapter,
  memoryIds: readonly string[]
): Map<string, MemoryScopeRef[]> {
  const scopeMap = new Map<string, MemoryScopeRef[]>();
  if (memoryIds.length === 0 || !tableExists(adapter, 'memory_scope_bindings')) {
    return scopeMap;
  }

  const rows = adapter
    .prepare(
      `
        SELECT msb.memory_id, ms.kind, ms.external_id
        FROM memory_scope_bindings msb
        JOIN memory_scopes ms ON ms.id = msb.scope_id
        WHERE msb.memory_id IN (${placeholders(memoryIds)})
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

function sourceFromTrustContext(value: unknown): MemoryRecord['source'] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as { source?: MemoryRecord['source'] };
      if (parsed.source) {
        return parsed.source;
      }
    } catch {
      // malformed trust_context falls back to local adapter source
    }
  }
  return { package: 'mama-core', source_type: 'context_compile_adapter' };
}

function memoryRecordFromRow(row: Record<string, unknown>, scopes: MemoryScopeRef[]): MemoryRecord {
  return {
    id: String(row.id),
    topic: String(row.topic ?? ''),
    kind: ((row.kind as MemoryKind | undefined) ?? 'decision') as MemoryKind,
    summary: String(row.summary ?? row.decision ?? ''),
    details: String(row.reasoning ?? row.decision ?? ''),
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
    status: (typeof row.status === 'string' ? row.status : 'active') as MemoryRecord['status'],
    scopes,
    source: sourceFromTrustContext(row.trust_context),
    created_at: (row.created_at as number | string | undefined) ?? 0,
    updated_at:
      (row.updated_at as number | string | undefined) ??
      (row.created_at as number | string | undefined) ??
      0,
    event_date: typeof row.event_date === 'string' ? row.event_date : null,
    event_datetime:
      typeof row.event_datetime === 'number' && Number.isFinite(row.event_datetime)
        ? row.event_datetime
        : null,
  };
}

function memoryLexicalScore(memory: MemoryRecord, query: string): number {
  const tokens = getLexicalQueryTokens(query);
  if (tokens.length === 0) {
    return 1;
  }
  const haystack = [memory.topic, memory.summary, memory.details].join(' ').toLowerCase();
  const phraseBoost = haystack.includes(query.toLowerCase()) ? 2 : 0;
  return tokens.reduce(
    (score, token) => (haystack.includes(token) ? score + 1 : score),
    phraseBoost
  );
}

function memoryLexicalWhereClause(tokens: readonly string[]): string | null {
  if (tokens.length === 0) {
    return null;
  }
  const fields = [
    "LOWER(COALESCE(d.topic, ''))",
    "LOWER(COALESCE(d.summary, ''))",
    "LOWER(COALESCE(d.decision, ''))",
    "LOWER(COALESCE(d.reasoning, ''))",
  ];
  return `(${tokens
    .map(() => `(${fields.map((field) => `instr(${field}, ?) > 0`).join(' OR ')})`)
    .join(' OR ')})`;
}

function pushMemoryLexicalParams(params: unknown[], tokens: readonly string[]): void {
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    params.push(normalized, normalized, normalized, normalized);
  }
}

function memoryTimestampSql(): string {
  return 'COALESCE(d.event_datetime, d.updated_at, d.created_at)';
}

function adapterScopedRecallMemory(
  adapter: ContextSourceAdapter,
  input: ContextSourceReadInput
): RecallBundle {
  if (!tableExists(adapter, 'decisions')) {
    return {
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: {
        query: input.task,
        scope_order: [],
        retrieval_sources: ['context_compile_adapter'],
      },
    };
  }

  const scopes = input.scopes ?? [];
  const params: unknown[] = [];
  const joins: string[] = [];
  const where = [
    `(d.status IS NULL OR d.status NOT IN (${[...EXCLUDED_MEMORY_STATUSES].map(() => '?').join(', ')}))`,
  ];
  const lexicalTokens = getLexicalQueryTokens(input.task);
  params.push(...EXCLUDED_MEMORY_STATUSES);

  if (scopes.length > 0) {
    joins.push('JOIN memory_scope_bindings msb ON msb.memory_id = d.id');
    joins.push('JOIN memory_scopes ms ON ms.id = msb.scope_id');
    where.push(`(${scopes.map(() => '(ms.kind = ? AND ms.external_id = ?)').join(' OR ')})`);
    for (const scope of scopes) {
      params.push(scope.kind, scope.id);
    }
  }
  const lexicalWhere = memoryLexicalWhereClause(lexicalTokens);
  if (lexicalWhere) {
    where.push(lexicalWhere);
    pushMemoryLexicalParams(params, lexicalTokens);
  }
  const min = minVisibleTimeMs(input);
  const max = maxVisibleTimeMs(input);
  const timestampSql = memoryTimestampSql();
  if (min !== null) {
    where.push(`${timestampSql} >= ?`);
    params.push(min);
  }
  if (max !== null) {
    where.push(`${timestampSql} <= ?`);
    params.push(max);
  }

  const rows = adapter
    .prepare(
      `
        SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.confidence, d.created_at,
               d.updated_at, d.trust_context, d.kind, d.status, d.summary, d.event_date,
               d.event_datetime
        FROM decisions d
        ${joins.join('\n        ')}
        WHERE ${where.join('\n          AND ')}
        ORDER BY ${timestampSql} DESC, d.created_at DESC
        LIMIT ?
      `
    )
    .all(
      ...params,
      Math.max(normalizeLimit(input.limit) * 5, normalizeLimit(input.limit))
    ) as Array<Record<string, unknown>>;

  const scopeMap = loadScopesForMemoryIds(
    adapter,
    rows.map((row) => String(row.id))
  );
  const memories = rows
    .map((row) => memoryRecordFromRow(row, scopeMap.get(String(row.id)) ?? []))
    .map((memory) => ({ memory, score: memoryLexicalScore(memory, input.task) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return (memoryTimestampMs(right.memory) ?? 0) - (memoryTimestampMs(left.memory) ?? 0);
    })
    .slice(0, normalizeLimit(input.limit))
    .map(({ memory, score }) => ({
      ...memory,
      confidence: Math.max(memory.confidence, Math.min(0.95, 0.45 + score * 0.05)),
      retrieval_diagnostics: {
        retrieval_source: 'context_compile_adapter',
        vector_similarity: null,
        lexical_support: true,
        entity_support: false,
        scope_support: scopes.length > 0,
        graph_source: null,
        is_vector_only: false,
        confirmation_signals: ['lexical'],
        metadata_signals: ['adapter_scoped'],
        candidate_threshold_used: 0,
      },
    }));

  return {
    profile: { static: [], dynamic: [], evidence: [] },
    memories,
    graph_context: { primary: memories, expanded: [], edges: [] },
    search_meta: {
      query: input.task,
      scope_order: scopes.map((scope) => scope.kind),
      retrieval_sources: ['context_compile_adapter'],
    },
  };
}

function resultFromCandidates(
  candidates: readonly ContextCandidate[],
  hidden: HiddenCandidateAggregate
): ContextSourceReadResult {
  const visible = candidates.filter((candidate) => candidate.visible);
  for (const candidate of candidates) {
    if (!candidate.visible) {
      incrementHidden(hidden, candidate.ref, candidate.hidden_reason ?? 'hidden');
    }
  }
  return {
    candidates: visible,
    hidden,
    source_refs: sourceRefsFromCandidates(visible),
  };
}

export function sourceRefsFromCandidates(candidates: readonly ContextCandidate[]): ContextRef[] {
  const refs = new Map<string, ContextRef>();
  for (const candidate of candidates) {
    if (!candidate.visible) {
      continue;
    }
    refs.set(serializeContextRefForProvenance(candidate.ref), candidate.ref);
  }
  return [...refs.values()];
}

export async function readMemoryCandidates(
  input: ContextSourceReadInput,
  deps: ContextSourceReaderDeps = {}
): Promise<ContextSourceReadResult> {
  const effectiveInput = applyBoundaryDefaults(input);
  if (effectiveInput.boundary) {
    assertContextBoundaryAllowsInput({
      boundary: effectiveInput.boundary,
      requestedScopes: effectiveInput.scopes,
      requestedConnectors: effectiveInput.connectors,
      requestedProjectRefs: effectiveInput.project_refs,
      requestedTenantId: effectiveInput.tenant_id,
    });
  }
  if (Array.isArray(effectiveInput.scopes) && effectiveInput.scopes.length === 0) {
    return resultFromCandidates([], hiddenAggregate());
  }

  const bundle = deps.recallMemory
    ? await deps.recallMemory(effectiveInput.task, {
        scopes: effectiveInput.scopes,
        limit: normalizeLimit(effectiveInput.limit),
        diagnostics: true,
        strictness: effectiveInput.strictness,
        threshold: effectiveInput.threshold,
      })
    : deps.adapter
      ? adapterScopedRecallMemory(deps.adapter, effectiveInput)
      : await defaultRecallMemory(effectiveInput.task, {
          scopes: effectiveInput.scopes,
          limit: normalizeLimit(effectiveInput.limit),
          diagnostics: true,
          strictness: effectiveInput.strictness,
          threshold: effectiveInput.threshold,
        });

  const candidates: ContextCandidate[] = [];
  const hidden = hiddenAggregate();
  const requiresTime = timeFilterRequired(effectiveInput);
  for (const memory of bundle.memories) {
    const ref: ContextRef = { kind: 'memory', id: memory.id };
    const timestampMs = memoryTimestampMs(memory);
    if (timestampMs === null && requiresTime) {
      candidates.push(hiddenCandidate(ref, 'memory', 'timestamp_missing'));
      continue;
    }
    if (timestampMs !== null && !isWithinTimeBoundary(timestampMs, effectiveInput)) {
      candidates.push(hiddenCandidate(ref, 'memory', 'time_boundary'));
      continue;
    }

    const diagnostics = diagnosticsFromUnknown(memory.retrieval_diagnostics);
    candidates.push({
      ref,
      title: memory.topic || memory.summary || memory.id,
      excerpt: memory.summary || memory.details || '',
      score: typeof memory.confidence === 'number' ? memory.confidence : 0,
      timestamp_ms: timestampMs,
      source: 'memory',
      visible: true,
      support: supportFromDiagnostics(diagnostics),
      ...(diagnostics ? { retrieval_diagnostics: diagnostics } : {}),
    });
  }

  return resultFromCandidates(candidates, hidden);
}

function hiddenCandidate(
  ref: ContextRef,
  source: ContextCandidateSource,
  hiddenReason: string
): ContextCandidate {
  return {
    ref,
    title: '',
    excerpt: '',
    score: 0,
    timestamp_ms: null,
    source,
    visible: false,
    hidden_reason: hiddenReason,
    support: emptySupport(),
  };
}

export function readRawCandidates(
  adapter: ContextSourceAdapter,
  input: ContextSourceReadInput
): ContextSourceReadResult {
  const effectiveInput = applyBoundaryDefaults(input);
  if (effectiveInput.boundary) {
    assertContextBoundaryAllowsInput({
      boundary: effectiveInput.boundary,
      requestedScopes: effectiveInput.scopes,
      requestedConnectors: effectiveInput.connectors,
      requestedProjectRefs: effectiveInput.project_refs,
      requestedTenantId: effectiveInput.tenant_id,
    });
  }

  if (!tableExists(adapter, 'connector_event_index')) {
    return resultFromCandidates([], hiddenAggregate());
  }

  const connectors = effectiveInput.connectors ?? [];
  const scopes = effectiveInput.scopes ?? [];
  const projectIds = (effectiveInput.project_refs ?? []).map((project) => project.id);
  if (
    connectors.length === 0 ||
    scopes.length === 0 ||
    hasExplicitEmptyProjectWindow(effectiveInput)
  ) {
    return resultFromCandidates([], hiddenAggregate());
  }

  const clauses = [`source_connector IN (${placeholders(connectors)})`];
  const params: unknown[] = [...connectors];
  if (projectIds.length > 0) {
    clauses.push(`project_id IN (${placeholders(projectIds)})`);
    params.push(...projectIds);
  }
  if (effectiveInput.tenant_id) {
    clauses.push('tenant_id = ?');
    params.push(effectiveInput.tenant_id);
  }
  clauses.push(
    `(${scopes.map(() => '(memory_scope_kind = ? AND memory_scope_id = ?)').join(' OR ')})`
  );
  for (const scope of scopes) {
    params.push(scope.kind, scope.id);
  }
  const min = minVisibleTimeMs(effectiveInput);
  const max = maxVisibleTimeMs(effectiveInput);
  if (min !== null) {
    clauses.push('COALESCE(event_datetime, source_timestamp_ms) >= ?');
    params.push(min);
  }
  if (max !== null) {
    clauses.push('COALESCE(event_datetime, source_timestamp_ms) <= ?');
    params.push(max);
  }
  params.push(normalizeLimit(effectiveInput.limit));

  const rows = adapter
    .prepare(
      `
        SELECT event_index_id, source_connector, source_id, channel, title, content,
               event_datetime, source_timestamp_ms
        FROM connector_event_index
        WHERE ${clauses.join('\n          AND ')}
        ORDER BY COALESCE(event_datetime, source_timestamp_ms) DESC, event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params) as Array<Record<string, unknown>>;

  const candidates = rows.map((row): ContextCandidate => {
    const ref: ContextRef = {
      kind: 'raw',
      connector: String(row.source_connector),
      raw_id: String(row.event_index_id),
      source_id: String(row.source_id),
      channel_id: typeof row.channel === 'string' ? row.channel : null,
    };
    return {
      ref,
      title: String(row.title ?? 'Raw event'),
      excerpt: String(row.content ?? '').slice(0, 500),
      score: 0.7,
      timestamp_ms: parseTimestampMs(row.event_datetime ?? row.source_timestamp_ms),
      source: 'raw',
      visible: true,
      support: emptySupport('connector_event_index'),
    };
  });

  return resultFromCandidates(candidates, hiddenAggregate());
}

export function readGraphCandidates(
  adapter: ContextSourceAdapter,
  input: ContextSourceReadInput,
  visibleRefs: readonly ContextRef[],
  deps: ContextSourceReaderDeps = {}
): ContextSourceReadResult {
  const effectiveInput = applyBoundaryDefaults(input);
  if (effectiveInput.boundary) {
    assertContextBoundaryAllowsInput({
      boundary: effectiveInput.boundary,
      requestedScopes: effectiveInput.scopes,
      requestedConnectors: effectiveInput.connectors,
      requestedProjectRefs: effectiveInput.project_refs,
      requestedTenantId: effectiveInput.tenant_id,
    });
  }
  if (Array.isArray(effectiveInput.scopes) && effectiveInput.scopes.length === 0) {
    return resultFromCandidates([], hiddenAggregate());
  }
  if (hasExplicitEmptyProjectWindow(effectiveInput)) {
    return resultFromCandidates([], hiddenAggregate());
  }
  if (visibleRefs.length === 0) {
    return resultFromCandidates([], hiddenAggregate());
  }

  const refs = visibleRefs.map((ref) => toTwinRef(ref));
  const visibleRefKeys = new Set(visibleRefs.map(serializeContextRefForProvenance));
  const listEdges = deps.listVisibleTwinEdgesForRefs ?? listVisibleTwinEdgesForRefs;
  const min = minVisibleTimeMs(effectiveInput);
  const max = maxVisibleTimeMs(effectiveInput);
  const edges = listEdges(adapter, refs, {
    scopes: effectiveInput.scopes,
    connectors: effectiveInput.connectors,
    projectRefs: effectiveInput.project_refs,
    tenantId: effectiveInput.tenant_id,
    startMs: min,
    asOfMs: max,
    limit: normalizeLimit(effectiveInput.limit),
  }).filter(
    (edge) => (min === null || edge.created_at >= min) && (max === null || edge.created_at <= max)
  );

  const candidates: ContextCandidate[] = [];
  const emitted = new Set<string>();
  for (const edge of edges) {
    for (const ref of edgeNeighborRefs(adapter, edge)) {
      const key = serializeContextRefForProvenance(ref);
      if (visibleRefKeys.has(key) || emitted.has(key)) {
        continue;
      }
      emitted.add(key);
      candidates.push({
        ref,
        title: edge.edge_type,
        excerpt: edge.reason_text ?? '',
        score: edge.confidence,
        timestamp_ms: edge.created_at,
        source: 'graph',
        visible: true,
        edge_id: edge.edge_id,
        edge_type: edge.edge_type,
        support: {
          retrieval_source: 'twin_edges',
          graph_source: 'expanded',
          graph_expanded: true,
          confirmation_signals: [],
          metadata_signals: ['graph_edge'],
        },
      });
    }
  }

  return resultFromCandidates(candidates, hiddenAggregate());
}

function edgeNeighborRefs(adapter: ContextSourceAdapter, edge: TwinEdgeRecord): ContextRef[] {
  return [edge.subject_ref, edge.object_ref].flatMap((ref) => {
    const contextRef = contextRefFromTwinRef(adapter, ref);
    return contextRef ? [contextRef] : [];
  });
}

function contextRefFromTwinRef(adapter: ContextSourceAdapter, ref: TwinRef): ContextRef | null {
  switch (ref.kind) {
    case 'memory':
    case 'entity':
    case 'case':
      return { kind: ref.kind, id: ref.id };
    case 'raw': {
      const row = adapter
        .prepare(
          `
            SELECT source_connector, source_id, channel
            FROM connector_event_index
            WHERE event_index_id = ?
            LIMIT 1
          `
        )
        .get(ref.id) as
        | {
            source_connector: unknown;
            source_id: unknown;
            channel: unknown;
          }
        | undefined;
      if (!row || typeof row.source_connector !== 'string') {
        return null;
      }
      const contextRef: ContextRef = {
        kind: 'raw',
        connector: row.source_connector,
        raw_id: ref.id,
      };
      if (typeof row.source_id === 'string' && row.source_id.length > 0) {
        contextRef.source_id = row.source_id;
      }
      contextRef.channel_id = typeof row.channel === 'string' ? row.channel : null;
      return contextRef;
    }
    default:
      return null;
  }
}
