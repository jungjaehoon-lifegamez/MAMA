import crypto from 'node:crypto';

import type { DatabaseAdapter } from '../db-manager.js';
import { assertTwinRefsVisible } from '../edges/ref-validation.js';
import type { ContextBoundary, ContextCompileInput, ContextPacket, ContextRef } from './types.js';
import { serializeContextRefForProvenance, toTwinRef } from './ref.js';
import { normalizeSeedRefs } from './visibility.js';
import { canonicalizeContextScopes, assertContextBoundaryAllowsInput } from './visibility.js';
import { applyContextBoundaryReadDefaults } from './boundary-defaults.js';
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
const COMPILER_VERSION = 'context-compile-v0';

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

function assertNotAborted(deps: ContextCompilerDeps): void {
  if (deps.signal?.aborted) {
    throw new Error('Context compile aborted');
  }
}

function isBudgetDeadlineExceeded(deps: ContextCompilerDeps, now: () => number): boolean {
  if (typeof deps.deadlineMs === 'number' && now() >= deps.deadlineMs) {
    return true;
  }
  return false;
}

function maxToolCalls(input: ContextCompileInput): number {
  if (typeof input.max_tool_calls !== 'number' || !Number.isFinite(input.max_tool_calls)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor(input.max_tool_calls));
}

function parseTimeMs(value: string | number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`Invalid context compile ${field}: ${String(value)}`);
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return Math.floor(numeric);
    }
    const parsed = Date.parse(trimmed);
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

function rawCanonicalRefForRef(adapter: ContextCompilerAdapter, rawId: string): ContextRef | null {
  const row = adapter
    .prepare(
      `
        SELECT source_connector, source_id, channel
        FROM connector_event_index
        WHERE event_index_id = ?
        LIMIT 1
      `
    )
    .get(rawId) as { source_connector: unknown; source_id: unknown; channel: unknown } | undefined;
  if (typeof row?.source_connector !== 'string') {
    return null;
  }
  const ref: ContextRef = {
    kind: 'raw',
    connector: row.source_connector,
    raw_id: rawId,
  };
  if (typeof row.source_id === 'string' && row.source_id.length > 0) {
    ref.source_id = row.source_id;
  }
  ref.channel_id = typeof row.channel === 'string' ? row.channel : null;
  return ref;
}

function canonicalizeRawSeedRefs(
  adapter: ContextCompilerAdapter | undefined,
  seedRefs: readonly ContextRef[]
): ContextRef[] {
  if (!adapter) {
    return [...seedRefs];
  }
  return seedRefs.map((ref) => {
    if (ref.kind !== 'raw') {
      return ref;
    }
    return rawCanonicalRefForRef(adapter, ref.raw_id) ?? ref;
  });
}

function assertSeedRefsVisibleToBoundary(
  adapter: ContextCompilerAdapter | undefined,
  input: ContextCompileInput,
  seedRefs: readonly ContextRef[],
  boundary: ContextBoundary
): ContextRef[] {
  if (seedRefs.length === 0) {
    return [];
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
    const actualRef = rawCanonicalRefForRef(adapter, ref.raw_id);
    if (actualRef?.kind !== 'raw' || actualRef.connector !== ref.connector) {
      throw new Error(`Seed raw ref connector does not match visible raw record: ${ref.raw_id}`);
    }
  }
  return canonicalizeRawSeedRefs(adapter, seedRefs);
}

function canReadMore(state: SourceReadState, input: ContextCompileInput): boolean {
  return state.usedToolCalls < maxToolCalls(input);
}

function sourceInput(
  input: ContextCompileInput,
  boundary: ContextBoundary | undefined
): ContextSourceReadInput {
  const strictness = normalizeStrictness(input.strictness);
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
    strictness,
  };
}

function normalizeStrictness(
  strictness: ContextCompileInput['strictness']
): 'recall' | 'balanced' | 'strict' {
  switch (strictness) {
    case 'low':
    case 'recall':
      return 'recall';
    case 'high':
    case 'strict':
      return 'strict';
    case 'medium':
    case 'balanced':
    case undefined:
      return 'balanced';
  }
  return 'balanced';
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
    const key = serializeContextRefForProvenance(ref);
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
  assertNotAborted(effectiveDeps);

  const boundary = deps.boundary;
  const seedRefs = normalizeSeedRefs(input.seed_refs);
  let canonicalSeedRefs = canonicalizeRawSeedRefs(deps.adapter, seedRefs);
  const effectiveInput = applyContextBoundaryReadDefaults(input, boundary);
  parseTimeMs(effectiveInput.as_of, 'as_of');
  if (boundary) {
    assertContextBoundaryAllowsInput({
      boundary,
      requestedScopes: effectiveInput.scopes,
      requestedConnectors: effectiveInput.connectors,
      requestedProjectRefs: effectiveInput.project_refs,
      requestedTenantId: effectiveInput.tenant_id,
      seedRefs,
    });
    canonicalSeedRefs = assertSeedRefsVisibleToBoundary(
      deps.adapter,
      effectiveInput,
      seedRefs,
      boundary
    );
  }

  const canonicalScopes = canonicalizeContextScopes(effectiveInput.scopes);
  const readInput = sourceInput(effectiveInput, boundary);
  const state: SourceReadState = {
    candidates: [],
    sourceRefs: [...canonicalSeedRefs],
    hidden: { total: 0, by_kind: {}, by_reason: {} },
    expansionTrace: [{ step: 'seed_refs', source_refs: canonicalSeedRefs.length }],
    usedToolCalls: 0,
  };
  let budgetExhausted = isBudgetDeadlineExceeded(effectiveDeps, now);
  const skippedOperators: string[] = [];

  if (canReadMore(state, effectiveInput)) {
    assertNotAborted(effectiveDeps);
    if (isBudgetDeadlineExceeded(effectiveDeps, now)) {
      budgetExhausted = true;
      skippedOperators.push('memory_recall');
    } else {
      state.usedToolCalls += 1;
      const memoryResult = await (deps.readMemoryCandidates?.(readInput) ??
        defaultReadMemoryCandidates(readInput, deps.adapter ? { adapter: deps.adapter } : {}));
      await appendResult(state, 'memory_recall', memoryResult);
    }
  }

  const shouldReadRaw = (effectiveInput.connectors?.length ?? 0) > 0;
  if (shouldReadRaw && canReadMore(state, effectiveInput)) {
    assertNotAborted(effectiveDeps);
    if (isBudgetDeadlineExceeded(effectiveDeps, now)) {
      budgetExhausted = true;
      skippedOperators.push('raw_window');
    } else {
      state.usedToolCalls += 1;
      const rawResult = await (deps.readRawCandidates?.(readInput) ??
        (deps.adapter ? defaultReadRawCandidates(deps.adapter, readInput) : emptyResult()));
      await appendResult(state, 'raw_window', rawResult);
    }
  }

  const visibleRefsForGraph = uniqueRefs([...state.sourceRefs]);
  if (visibleRefsForGraph.length > 0 && canReadMore(state, effectiveInput)) {
    assertNotAborted(effectiveDeps);
    if (isBudgetDeadlineExceeded(effectiveDeps, now)) {
      budgetExhausted = true;
      skippedOperators.push('graph_neighborhood');
    } else {
      state.usedToolCalls += 1;
      const graphResult = await (deps.readGraphCandidates?.(readInput, visibleRefsForGraph) ??
        (deps.adapter
          ? defaultReadGraphCandidates(deps.adapter, readInput, visibleRefsForGraph)
          : emptyResult()));
      await appendResult(state, 'graph_neighborhood', graphResult);
    }
  }

  assertNotAborted(effectiveDeps);
  if (isBudgetDeadlineExceeded(effectiveDeps, now)) {
    budgetExhausted = true;
  }
  const policy = applyContextCompilerPolicy({
    task: effectiveInput.task,
    candidates: state.candidates,
    hidden: state.hidden,
    limit: effectiveInput.limit,
    strictness: normalizeStrictness(effectiveInput.strictness),
    max_tokens: effectiveInput.max_tokens,
  });
  const caveats = budgetExhausted ? [...policy.caveats, 'budget_exhausted'] : policy.caveats;

  const completedAt = now();
  return {
    packet_id: deps.packetId?.() ?? packetId(),
    mode: 'general',
    task: effectiveInput.task,
    scopes: canonicalScopes.scopes,
    scope_hash: canonicalScopes.scopeHash,
    generated_at: new Date(completedAt).toISOString(),
    range: effectiveInput.range ?? null,
    as_of: effectiveInput.as_of ?? null,
    compiler_version: COMPILER_VERSION,
    source_refs: uniqueRefs([...canonicalSeedRefs, ...policy.source_refs]),
    selected_evidence: policy.selected_evidence,
    evidence_clusters: policy.evidence_clusters,
    related_decisions: policy.related_decisions,
    rejected_refs: policy.rejected_refs,
    rejected_refs_truncated: false,
    rejected_summary: policy.rejected_summary,
    missing_context: policy.missing_context,
    caveats,
    expansion_trace: state.expansionTrace,
    retrieval_diagnostics: policy.retrieval_diagnostics,
    budget: {
      max_tool_calls: effectiveInput.max_tool_calls,
      used_tool_calls: state.usedToolCalls,
      max_ms: effectiveInput.max_ms,
      elapsed_ms: Math.max(0, completedAt - startedAt),
      max_tokens: effectiveInput.max_tokens,
      estimated_tokens: policy.estimated_tokens,
      budget_exhausted: budgetExhausted,
    },
    budget_manifest: {
      budget_exhausted: budgetExhausted,
      skipped_operators: skippedOperators,
    },
  };
}
