import crypto from 'node:crypto';

import type { DatabaseAdapter } from '../db-manager.js';
import { assertTwinRefsVisible } from '../edges/ref-validation.js';
import type {
  ContextBoundary,
  ContextCompileInput,
  ContextPacket,
  ContextRange,
  ContextRef,
} from './types.js';
import { toTwinRef } from './ref.js';
import { normalizeSeedRefs } from './visibility.js';
import { canonicalizeContextScopes, assertContextBoundaryAllowsInput } from './visibility.js';
import {
  readMemoryCandidates as defaultReadMemoryCandidates,
  readRawCandidates as defaultReadRawCandidates,
  readGraphCandidates as defaultReadGraphCandidates,
  type ContextCandidate,
  type ContextSourceReadInput,
  type ContextSourceReadResult,
  type HiddenCandidateAggregate,
} from './source-readers.js';
import { applyContextCompilerPolicy } from './compiler-policy.js';

type ContextCompilerAdapter = Pick<DatabaseAdapter, 'prepare'>;

export interface ContextCompilerDeps {
  adapter?: ContextCompilerAdapter;
  boundary?: ContextBoundary;
  signal?: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
  packetId?: () => string;
  readMemoryCandidates?: (
    input: ContextSourceReadInput
  ) => Promise<ContextSourceReadResult> | ContextSourceReadResult;
  readRawCandidates?: (
    input: ContextSourceReadInput
  ) => Promise<ContextSourceReadResult> | ContextSourceReadResult;
  readGraphCandidates?: (
    input: ContextSourceReadInput,
    visibleRefs: readonly ContextRef[]
  ) => Promise<ContextSourceReadResult> | ContextSourceReadResult;
}

interface SourceReadState {
  candidates: ContextCandidate[];
  sourceRefs: ContextRef[];
  hidden: HiddenCandidateAggregate;
  expansionTrace: unknown[];
  usedToolCalls: number;
}

function packetId(): string {
  return `ctxp_${crypto.randomUUID().replace(/-/g, '')}`;
}

function emptyResult(): ContextSourceReadResult {
  return {
    candidates: [],
    hidden: { total: 0, by_kind: {}, by_reason: {} },
    source_refs: [],
  };
}

function mergeHidden(left: HiddenCandidateAggregate, right: HiddenCandidateAggregate): void {
  left.total += right.total;
  for (const [kind, count] of Object.entries(right.by_kind)) {
    const key = kind as keyof HiddenCandidateAggregate['by_kind'];
    left.by_kind[key] = (left.by_kind[key] ?? 0) + count;
  }
  for (const [reason, count] of Object.entries(right.by_reason)) {
    left.by_reason[reason] = (left.by_reason[reason] ?? 0) + count;
  }
}

function checkCooperativeStop(deps: ContextCompilerDeps, now: () => number): void {
  if (deps.signal?.aborted) {
    throw new Error('Context compile aborted');
  }
  if (typeof deps.deadlineMs === 'number' && now() >= deps.deadlineMs) {
    throw new Error('Context compile deadline exceeded');
  }
}

function maxToolCalls(input: ContextCompileInput): number {
  if (typeof input.max_tool_calls !== 'number' || !Number.isFinite(input.max_tool_calls)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor(input.max_tool_calls));
}

function applyRangeDefaults(
  range: ContextRange | undefined,
  boundaryRange: ContextRange | undefined
): ContextRange | undefined {
  if (!boundaryRange) {
    return range;
  }
  const requestedStartMs = rangeBoundaryMs(range?.start_ms, 'range.start_ms');
  const requestedEndMs = rangeBoundaryMs(range?.end_ms, 'range.end_ms');
  const boundaryStartMs = rangeBoundaryMs(boundaryRange.start_ms, 'boundary.range.start_ms');
  const boundaryEndMs = rangeBoundaryMs(boundaryRange.end_ms, 'boundary.range.end_ms');
  const startMs =
    requestedStartMs === null
      ? boundaryStartMs
      : boundaryStartMs === null
        ? requestedStartMs
        : Math.max(requestedStartMs, boundaryStartMs);
  const endMs =
    requestedEndMs === null
      ? boundaryEndMs
      : boundaryEndMs === null
        ? requestedEndMs
        : Math.min(requestedEndMs, boundaryEndMs);
  if (startMs === null && endMs === null) {
    return undefined;
  }
  return {
    ...(startMs !== null ? { start_ms: startMs } : {}),
    ...(endMs !== null ? { end_ms: endMs } : {}),
  };
}

function applyBoundaryReadDefaults(
  input: ContextCompileInput,
  boundary: ContextBoundary | undefined
): ContextCompileInput {
  if (!boundary) {
    return input;
  }
  return {
    ...input,
    scopes: input.scopes === undefined ? boundary.scopes : input.scopes,
    connectors: input.connectors === undefined ? boundary.connectors : input.connectors,
    project_refs: input.project_refs === undefined ? boundary.project_refs : input.project_refs,
    tenant_id: input.tenant_id ?? boundary.tenant_id ?? null,
    range: applyRangeDefaults(input.range, boundary.range),
    as_of: input.as_of ?? boundary.as_of ?? null,
  };
}

function parseTimeMs(value: string | number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return Math.floor(numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Invalid context compile ${field}: ${String(value)}`);
}

function rangeBoundaryMs(value: unknown, field: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  throw new Error(`Invalid context compile ${field}: ${String(value)}`);
}

function minVisibleMs(input: ContextCompileInput): number | null {
  return rangeBoundaryMs(input.range?.start_ms, 'range.start_ms');
}

function maxVisibleMs(input: ContextCompileInput): number | null {
  const ends = [
    rangeBoundaryMs(input.range?.end_ms, 'range.end_ms'),
    parseTimeMs(input.as_of, 'as_of'),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return ends.length > 0 ? Math.min(...ends.map((value) => Math.floor(value))) : null;
}

function rawConnectorForRef(adapter: ContextCompilerAdapter, rawId: string): string | null {
  const row = adapter
    .prepare(
      `
        SELECT source_connector
        FROM connector_event_index
        WHERE event_index_id = ?
        LIMIT 1
      `
    )
    .get(rawId) as { source_connector: unknown } | undefined;
  return typeof row?.source_connector === 'string' ? row.source_connector : null;
}

function assertSeedRefsVisibleToBoundary(
  adapter: ContextCompilerAdapter | undefined,
  input: ContextCompileInput,
  seedRefs: readonly ContextRef[],
  boundary: ContextBoundary
): void {
  if (seedRefs.length === 0) {
    return;
  }
  if (Array.isArray(input.scopes) && input.scopes.length === 0) {
    throw new Error('Seed refs are outside the empty requested context scope set');
  }
  if (
    Array.isArray(input.connectors) &&
    input.connectors.length === 0 &&
    (boundary.connectors?.length ?? 0) > 0 &&
    seedRefs.some((ref) => ref.kind === 'raw')
  ) {
    throw new Error('Seed raw refs are outside the empty requested connector set');
  }
  if (
    Array.isArray(input.project_refs) &&
    input.project_refs.length === 0 &&
    (boundary.project_refs?.length ?? 0) > 0 &&
    seedRefs.some((ref) => ref.kind === 'raw')
  ) {
    throw new Error('Seed raw refs are outside the empty requested project ref set');
  }
  if (!adapter) {
    throw new Error('Context seed refs require adapter-backed visibility validation');
  }

  assertTwinRefsVisible(adapter, seedRefs.map(toTwinRef), {
    scopes: input.scopes,
    connectors: input.connectors,
    projectRefs: input.project_refs,
    tenantId: input.tenant_id,
    startMs: minVisibleMs(input),
    asOfMs: maxVisibleMs(input),
  });

  for (const ref of seedRefs) {
    if (ref.kind !== 'raw') {
      continue;
    }
    const actualConnector = rawConnectorForRef(adapter, ref.raw_id);
    if (actualConnector !== ref.connector) {
      throw new Error(`Seed raw ref connector does not match visible raw record: ${ref.raw_id}`);
    }
  }
}

function canReadMore(state: SourceReadState, input: ContextCompileInput): boolean {
  return state.usedToolCalls < maxToolCalls(input);
}

function sourceInput(
  input: ContextCompileInput,
  boundary: ContextBoundary | undefined
): ContextSourceReadInput {
  return {
    task: input.task,
    scopes: input.scopes,
    connectors: input.connectors,
    project_refs: input.project_refs,
    tenant_id: input.tenant_id ?? null,
    boundary,
    range: input.range,
    as_of: input.as_of,
    limit: input.limit,
    threshold: undefined,
    strictness:
      input.strictness === 'high'
        ? 'strict'
        : input.strictness === 'medium'
          ? 'balanced'
          : 'recall',
  };
}

async function appendResult(
  state: SourceReadState,
  step: string,
  result: ContextSourceReadResult
): Promise<void> {
  state.candidates.push(...result.candidates);
  state.sourceRefs.push(...result.source_refs);
  mergeHidden(state.hidden, result.hidden);
  state.expansionTrace.push({
    step,
    candidates: result.candidates.length,
    source_refs: result.source_refs.length,
    hidden: result.hidden.total,
  });
}

function uniqueRefs(refs: readonly ContextRef[]): ContextRef[] {
  const seen = new Set<string>();
  const unique: ContextRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

export async function compileContext(
  input: ContextCompileInput,
  deps: ContextCompilerDeps = {}
): Promise<ContextPacket> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const effectiveDeadline =
    typeof input.max_ms === 'number' && Number.isFinite(input.max_ms)
      ? Math.min(deps.deadlineMs ?? Number.POSITIVE_INFINITY, startedAt + Math.max(0, input.max_ms))
      : deps.deadlineMs;
  const effectiveDeps = { ...deps, deadlineMs: effectiveDeadline };
  checkCooperativeStop(effectiveDeps, now);

  const boundary = deps.boundary;
  const seedRefs = normalizeSeedRefs(input.seed_refs);
  const effectiveInput = applyBoundaryReadDefaults(input, boundary);
  if (boundary) {
    assertContextBoundaryAllowsInput({
      boundary,
      requestedScopes: effectiveInput.scopes,
      requestedConnectors: effectiveInput.connectors,
      requestedProjectRefs: effectiveInput.project_refs,
      requestedTenantId: effectiveInput.tenant_id,
      seedRefs,
    });
    assertSeedRefsVisibleToBoundary(deps.adapter, effectiveInput, seedRefs, boundary);
  }

  const canonicalScopes = canonicalizeContextScopes(effectiveInput.scopes);
  const readInput = sourceInput(effectiveInput, boundary);
  const state: SourceReadState = {
    candidates: [],
    sourceRefs: [...seedRefs],
    hidden: { total: 0, by_kind: {}, by_reason: {} },
    expansionTrace: [{ step: 'seed_refs', source_refs: seedRefs.length }],
    usedToolCalls: 0,
  };

  if (canReadMore(state, effectiveInput)) {
    checkCooperativeStop(effectiveDeps, now);
    state.usedToolCalls += 1;
    const memoryResult = await (deps.readMemoryCandidates?.(readInput) ??
      defaultReadMemoryCandidates(readInput, deps.adapter ? { adapter: deps.adapter } : {}));
    await appendResult(state, 'memory_recall', memoryResult);
  }

  const shouldReadRaw = (effectiveInput.connectors?.length ?? 0) > 0;
  if (shouldReadRaw && canReadMore(state, effectiveInput)) {
    checkCooperativeStop(effectiveDeps, now);
    state.usedToolCalls += 1;
    const rawResult = await (deps.readRawCandidates?.(readInput) ??
      (deps.adapter ? defaultReadRawCandidates(deps.adapter, readInput) : emptyResult()));
    await appendResult(state, 'raw_window', rawResult);
  }

  const visibleRefsForGraph = uniqueRefs([...state.sourceRefs]);
  if (visibleRefsForGraph.length > 0 && canReadMore(state, effectiveInput)) {
    checkCooperativeStop(effectiveDeps, now);
    state.usedToolCalls += 1;
    const graphResult = await (deps.readGraphCandidates?.(readInput, visibleRefsForGraph) ??
      (deps.adapter
        ? defaultReadGraphCandidates(deps.adapter, readInput, visibleRefsForGraph)
        : emptyResult()));
    await appendResult(state, 'graph_neighborhood', graphResult);
  }

  checkCooperativeStop(effectiveDeps, now);
  const policy = applyContextCompilerPolicy({
    task: effectiveInput.task,
    candidates: state.candidates,
    hidden: state.hidden,
    limit: effectiveInput.limit,
    strictness: effectiveInput.strictness,
    max_tokens: effectiveInput.max_tokens,
  });

  const completedAt = now();
  return {
    packet_id: deps.packetId?.() ?? packetId(),
    task: effectiveInput.task,
    scopes: canonicalScopes.scopes,
    scope_hash: canonicalScopes.scopeHash,
    generated_at: new Date(completedAt).toISOString(),
    source_refs: uniqueRefs([...seedRefs, ...policy.source_refs]),
    selected_evidence: policy.selected_evidence,
    evidence_clusters: policy.evidence_clusters,
    related_decisions: policy.related_decisions,
    rejected_refs: policy.rejected_refs,
    rejected_summary: policy.rejected_summary,
    missing_context: policy.missing_context,
    caveats: policy.caveats,
    expansion_trace: state.expansionTrace,
    retrieval_diagnostics: policy.retrieval_diagnostics,
    budget: {
      max_tool_calls: effectiveInput.max_tool_calls,
      used_tool_calls: state.usedToolCalls,
      max_ms: effectiveInput.max_ms,
      elapsed_ms: Math.max(0, completedAt - startedAt),
      max_tokens: effectiveInput.max_tokens,
      estimated_tokens: policy.estimated_tokens,
    },
  };
}
