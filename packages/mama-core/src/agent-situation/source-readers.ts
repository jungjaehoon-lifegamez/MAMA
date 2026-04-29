import type { DatabaseAdapter } from '../db-manager.js';
import type { MemoryScopeRef } from '../memory/types.js';
import type {
  AgentSituationCandidate,
  AgentSituationEffectiveFilters,
  SituationRef,
} from './types.js';

type SituationReaderAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface AgentSituationSourceReadInput {
  effective_filters: AgentSituationEffectiveFilters;
  range_start_ms: number;
  range_end_ms: number;
  limit: number;
}

export interface VisibleRawCandidate extends AgentSituationCandidate {
  ref: { kind: 'raw'; id: string };
  connector: string;
  channel_id: string | null;
  content: string;
}

export interface VisibleMemoryCandidate extends AgentSituationCandidate {
  ref: { kind: 'memory'; id: string };
  topic: string;
}

export interface VisibleCaseCandidate extends AgentSituationCandidate {
  ref: { kind: 'case'; id: string };
}

export interface VisibleEdgeCandidate extends AgentSituationCandidate {
  ref: { kind: 'edge'; id: string };
  subject_ref: SituationRef;
  object_ref: SituationRef;
}

export interface VisibleAgentSituationSources {
  raw: VisibleRawCandidate[];
  memories: VisibleMemoryCandidate[];
  cases: VisibleCaseCandidate[];
  edges: VisibleEdgeCandidate[];
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function scopeKey(scope: MemoryScopeRef): string {
  return `${scope.kind}:${scope.id}`;
}

function refKey(ref: SituationRef): string {
  return `${ref.kind}:${ref.id}`;
}

function tableExists(adapter: SituationReaderAdapter, table: string): boolean {
  const row = adapter
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function normalizeLimit(limit: number): number {
  return Math.max(0, Math.min(100, Math.floor(limit)));
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isScopeVisible(scope: MemoryScopeRef, effective: AgentSituationEffectiveFilters): boolean {
  const visible = new Set(effective.scopes.map(scopeKey));
  return visible.has(scopeKey(scope));
}

function caseTimestampMs(row: {
  last_activity_at?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
}): number {
  for (const value of [row.last_activity_at, row.updated_at, row.created_at]) {
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

function caseScopes(row: { scope_refs?: unknown }): MemoryScopeRef[] {
  return parseJsonArray(row.scope_refs)
    .map((scope) => {
      if (
        scope &&
        typeof scope === 'object' &&
        'kind' in scope &&
        'id' in scope &&
        typeof scope.kind === 'string' &&
        typeof scope.id === 'string'
      ) {
        return { kind: scope.kind as MemoryScopeRef['kind'], id: scope.id };
      }
      return null;
    })
    .filter((scope): scope is MemoryScopeRef => Boolean(scope));
}

function isOpenQuestion(row: {
  kind?: unknown;
  topic?: unknown;
  decision?: unknown;
  summary?: unknown;
}): boolean {
  const text = `${String(row.topic ?? '')} ${String(row.decision ?? '')} ${String(row.summary ?? '')}`;
  return row.kind === 'task' || text.includes('?') || /\b(question|decide|answer)\b/i.test(text);
}

export function listVisibleRawCandidates(
  adapter: SituationReaderAdapter,
  input: AgentSituationSourceReadInput
): VisibleRawCandidate[] {
  if (!tableExists(adapter, 'connector_event_index')) {
    return [];
  }
  const connectors = input.effective_filters.connectors;
  const scopes = input.effective_filters.scopes;
  const projectIds = input.effective_filters.project_refs.map((project) => project.id);
  if (connectors.length === 0 || scopes.length === 0 || projectIds.length === 0) {
    return [];
  }

  const scopeClauses = scopes
    .map(() => '(memory_scope_kind = ? AND memory_scope_id = ?)')
    .join(' OR ');
  const params: unknown[] = [input.effective_filters.tenant_id, ...projectIds, ...connectors];
  for (const scope of scopes) {
    params.push(scope.kind, scope.id);
  }
  params.push(input.range_start_ms, input.range_end_ms, normalizeLimit(input.limit));

  const rows = adapter
    .prepare(
      `
        SELECT event_index_id, source_connector, channel, title, content, source_timestamp_ms,
               memory_scope_kind, memory_scope_id
        FROM connector_event_index
        WHERE tenant_id = ?
          AND project_id IN (${placeholders(projectIds)})
          AND source_connector IN (${placeholders(connectors)})
          AND (${scopeClauses})
          AND source_timestamp_ms BETWEEN ? AND ?
        ORDER BY source_timestamp_ms DESC, event_index_id ASC
        LIMIT ?
      `
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ref: { kind: 'raw', id: String(row.event_index_id) },
    kind: 'raw',
    title: String(row.title ?? 'Untitled raw event'),
    summary: String(row.content ?? '').slice(0, 240),
    content: String(row.content ?? ''),
    timestamp_ms: Number(row.source_timestamp_ms),
    connector: String(row.source_connector),
    channel_id: typeof row.channel === 'string' ? row.channel : null,
    scope:
      typeof row.memory_scope_kind === 'string' && typeof row.memory_scope_id === 'string'
        ? { kind: row.memory_scope_kind as MemoryScopeRef['kind'], id: row.memory_scope_id }
        : null,
  }));
}

export function listVisibleMemoryCandidates(
  adapter: SituationReaderAdapter,
  input: AgentSituationSourceReadInput
): VisibleMemoryCandidate[] {
  if (!tableExists(adapter, 'decisions')) {
    return [];
  }
  const scopes = input.effective_filters.scopes;
  if (scopes.length === 0) {
    return [];
  }

  const scopeClauses = scopes.map(() => '(ms.kind = ? AND ms.external_id = ?)').join(' OR ');
  const params: unknown[] = [];
  for (const scope of scopes) {
    params.push(scope.kind, scope.id);
  }
  params.push(input.range_start_ms, input.range_end_ms, normalizeLimit(input.limit));

  const rows = adapter
    .prepare(
      `
        SELECT DISTINCT d.id, d.topic, d.decision, d.reasoning, d.kind, d.status, d.summary,
               d.confidence, d.event_datetime, d.created_at, ms.kind AS scope_kind,
               ms.external_id AS scope_id
        FROM decisions d
        JOIN memory_scope_bindings msb ON msb.memory_id = d.id
        JOIN memory_scopes ms ON ms.id = msb.scope_id
        WHERE (${scopeClauses})
          AND COALESCE(d.event_datetime, d.created_at) BETWEEN ? AND ?
        ORDER BY COALESCE(d.event_datetime, d.created_at) DESC, d.id ASC
        LIMIT ?
      `
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ref: { kind: 'memory', id: String(row.id) },
    kind: 'memory',
    title: String(row.topic ?? row.decision ?? 'Memory'),
    summary: String(row.summary ?? row.decision ?? row.reasoning ?? ''),
    topic: String(row.topic ?? ''),
    timestamp_ms: Number(row.event_datetime ?? row.created_at ?? 0),
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence ?? 1),
    status: typeof row.status === 'string' ? row.status : null,
    is_open_question: isOpenQuestion(row),
    has_debate_edge: false,
    scope:
      typeof row.scope_kind === 'string' && typeof row.scope_id === 'string'
        ? { kind: row.scope_kind as MemoryScopeRef['kind'], id: row.scope_id }
        : null,
  }));
}

export function listVisibleCaseCandidates(
  adapter: SituationReaderAdapter,
  input: AgentSituationSourceReadInput
): VisibleCaseCandidate[] {
  if (!tableExists(adapter, 'case_truth')) {
    return [];
  }

  const rows = adapter
    .prepare(
      `
        SELECT case_id, title, status, confidence, scope_refs, last_activity_at, updated_at, created_at
        FROM case_truth
        ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC, case_id ASC
        LIMIT ?
      `
    )
    .all(normalizeLimit(input.limit) * 3 + 10) as Array<Record<string, unknown>>;

  return rows
    .map((row): VisibleCaseCandidate | null => {
      const timestamp = caseTimestampMs(row);
      const scopes = caseScopes(row);
      if (
        timestamp < input.range_start_ms ||
        timestamp > input.range_end_ms ||
        !scopes.some((scope) => isScopeVisible(scope, input.effective_filters))
      ) {
        return null;
      }
      return {
        ref: { kind: 'case', id: String(row.case_id) },
        kind: 'case',
        title: String(row.title ?? 'Case'),
        summary: String(row.status ?? ''),
        timestamp_ms: timestamp,
        confidence: row.confidence === 'low' ? 0.4 : row.confidence === 'medium' ? 0.7 : 1,
        status: typeof row.status === 'string' ? row.status : null,
        scope: scopes[0] ?? null,
      } satisfies VisibleCaseCandidate;
    })
    .filter((row): row is VisibleCaseCandidate => Boolean(row))
    .slice(0, normalizeLimit(input.limit));
}

export function listVisibleEdgeCandidates(
  adapter: SituationReaderAdapter,
  input: AgentSituationSourceReadInput,
  visibleRefs: SituationRef[]
): VisibleEdgeCandidate[] {
  if (!tableExists(adapter, 'twin_edges')) {
    return [];
  }
  const visible = new Set(visibleRefs.map(refKey));
  if (visible.size === 0) {
    return [];
  }

  const rows = adapter
    .prepare(
      `
        SELECT edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
               confidence, reason_text, created_at
        FROM twin_edges
        WHERE created_at BETWEEN ? AND ?
        ORDER BY created_at DESC, edge_id ASC
        LIMIT ?
      `
    )
    .all(input.range_start_ms, input.range_end_ms, normalizeLimit(input.limit) * 3 + 10) as Array<
    Record<string, unknown>
  >;

  return rows
    .map((row): VisibleEdgeCandidate | null => {
      const subject = {
        kind: String(row.subject_kind) as SituationRef['kind'],
        id: String(row.subject_id),
      };
      const object = {
        kind: String(row.object_kind) as SituationRef['kind'],
        id: String(row.object_id),
      };
      if (!visible.has(refKey(subject)) || !visible.has(refKey(object))) {
        return null;
      }
      return {
        ref: { kind: 'edge', id: String(row.edge_id) },
        kind: String(row.edge_type),
        title: String(row.edge_type),
        summary: String(row.reason_text ?? ''),
        timestamp_ms: Number(row.created_at),
        confidence:
          typeof row.confidence === 'number' ? row.confidence : Number(row.confidence ?? 1),
        status: null,
        subject_ref: subject,
        object_ref: object,
      } satisfies VisibleEdgeCandidate;
    })
    .filter((row): row is VisibleEdgeCandidate => Boolean(row))
    .slice(0, normalizeLimit(input.limit));
}

export function listVisibleAgentSituationSources(
  adapter: SituationReaderAdapter,
  input: AgentSituationSourceReadInput
): VisibleAgentSituationSources {
  const raw = listVisibleRawCandidates(adapter, input);
  const memories = listVisibleMemoryCandidates(adapter, input);
  const cases = listVisibleCaseCandidates(adapter, input);
  const visibleRefs: SituationRef[] = [
    ...raw.map((item) => item.ref),
    ...memories.map((item) => item.ref),
    ...cases.map((item) => item.ref),
  ];
  const edges = listVisibleEdgeCandidates(adapter, input, visibleRefs);
  return { raw, memories, cases, edges };
}
