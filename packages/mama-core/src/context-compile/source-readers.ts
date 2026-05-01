import type { DatabaseAdapter } from '../db-manager.js';
import { listVisibleTwinEdgesForRefs } from '../edges/ref-validation.js';
import type { ListVisibleTwinEdgesOptions, TwinEdgeRecord, TwinRef } from '../edges/types.js';
import { recallMemory as defaultRecallMemory } from '../memory/api.js';
import type { MemoryRecord, RecallBundle, RecallMemoryOptions } from '../memory/types.js';
import type { SearchHitDiagnostics, SearchStrictness } from '../search/search-quality.js';
import type { ContextBoundary, ContextProjectRef, ContextRange, ContextRef } from './types.js';
import { serializeContextRefForProvenance, toTwinRef } from './ref.js';
import { assertContextBoundaryAllowsInput } from './visibility.js';
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

function maxVisibleTimeMs(input: ContextSourceReadInput): number | null {
  const ends = [input.range?.end_ms, asOfMs(input)].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  return ends.length > 0 ? Math.min(...ends) : null;
}

function minVisibleTimeMs(input: ContextSourceReadInput): number | null {
  return typeof input.range?.start_ms === 'number' && Number.isFinite(input.range.start_ms)
    ? Math.floor(input.range.start_ms)
    : null;
}

function isWithinTimeBoundary(timestampMs: number, input: ContextSourceReadInput): boolean {
  const min = minVisibleTimeMs(input);
  const max = maxVisibleTimeMs(input);
  return (min === null || timestampMs >= min) && (max === null || timestampMs <= max);
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
  if (input.boundary) {
    assertContextBoundaryAllowsInput({
      boundary: input.boundary,
      requestedScopes: input.scopes,
      requestedConnectors: input.connectors,
    });
  }

  const recall = deps.recallMemory ?? defaultRecallMemory;
  const bundle = await recall(input.task, {
    scopes: input.scopes,
    limit: normalizeLimit(input.limit),
    diagnostics: true,
    strictness: input.strictness,
    threshold: input.threshold,
  });

  const candidates: ContextCandidate[] = [];
  const hidden = hiddenAggregate();
  const requiresTime = timeFilterRequired(input);
  for (const memory of bundle.memories) {
    const ref: ContextRef = { kind: 'memory', id: memory.id };
    const timestampMs = memoryTimestampMs(memory);
    if (timestampMs === null && requiresTime) {
      candidates.push(hiddenCandidate(ref, 'memory', 'timestamp_missing'));
      continue;
    }
    if (timestampMs !== null && !isWithinTimeBoundary(timestampMs, input)) {
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
  if (input.boundary) {
    assertContextBoundaryAllowsInput({
      boundary: input.boundary,
      requestedScopes: input.scopes,
      requestedConnectors: input.connectors,
    });
  }

  if (!tableExists(adapter, 'connector_event_index')) {
    return resultFromCandidates([], hiddenAggregate());
  }

  const connectors = input.connectors ?? [];
  const scopes = input.scopes ?? [];
  const projectIds = (input.project_refs ?? []).map((project) => project.id);
  if (connectors.length === 0 || scopes.length === 0 || projectIds.length === 0) {
    return resultFromCandidates([], hiddenAggregate());
  }

  const clauses = [
    `source_connector IN (${placeholders(connectors)})`,
    `project_id IN (${placeholders(projectIds)})`,
  ];
  const params: unknown[] = [...connectors, ...projectIds];
  if (input.tenant_id) {
    clauses.push('tenant_id = ?');
    params.push(input.tenant_id);
  }
  clauses.push(
    `(${scopes.map(() => '(memory_scope_kind = ? AND memory_scope_id = ?)').join(' OR ')})`
  );
  for (const scope of scopes) {
    params.push(scope.kind, scope.id);
  }
  const min = minVisibleTimeMs(input);
  const max = maxVisibleTimeMs(input);
  if (min !== null) {
    clauses.push('event_datetime >= ?');
    params.push(min);
  }
  if (max !== null) {
    clauses.push('event_datetime <= ?');
    params.push(max);
  }
  params.push(normalizeLimit(input.limit));

  const rows = adapter
    .prepare(
      `
        SELECT event_index_id, source_connector, source_id, channel, title, content,
               event_datetime
        FROM connector_event_index
        WHERE ${clauses.join('\n          AND ')}
        ORDER BY event_datetime DESC, event_index_id ASC
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
      timestamp_ms: parseTimestampMs(row.event_datetime),
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
  if (visibleRefs.length === 0) {
    return resultFromCandidates([], hiddenAggregate());
  }

  const refs = visibleRefs.map((ref) => toTwinRef(ref));
  const visibleRefKeys = new Set(visibleRefs.map(serializeContextRefForProvenance));
  const listEdges = deps.listVisibleTwinEdgesForRefs ?? listVisibleTwinEdgesForRefs;
  const edges = listEdges(adapter, refs, {
    scopes: input.scopes,
    connectors: input.connectors,
    projectRefs: input.project_refs,
    tenantId: input.tenant_id,
    asOfMs: asOfMs(input),
    limit: normalizeLimit(input.limit),
  });

  const candidates: ContextCandidate[] = [];
  const emitted = new Set<string>();
  for (const edge of edges) {
    for (const ref of edgeNeighborRefs(edge)) {
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

function edgeNeighborRefs(edge: TwinEdgeRecord): ContextRef[] {
  return [edge.subject_ref, edge.object_ref].flatMap((ref) => {
    const contextRef = contextRefFromTwinRef(ref);
    return contextRef ? [contextRef] : [];
  });
}

function contextRefFromTwinRef(ref: TwinRef): ContextRef | null {
  switch (ref.kind) {
    case 'memory':
    case 'entity':
    case 'case':
      return { kind: ref.kind, id: ref.id };
    case 'raw': {
      const delimiter = ref.id.indexOf(':');
      if (delimiter <= 0 || delimiter === ref.id.length - 1) {
        return null;
      }
      return {
        kind: 'raw',
        connector: ref.id.slice(0, delimiter),
        raw_id: ref.id.slice(delimiter + 1),
      };
    }
    default:
      return null;
  }
}
