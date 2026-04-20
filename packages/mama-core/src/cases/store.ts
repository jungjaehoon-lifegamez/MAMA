import { randomUUID } from 'node:crypto';

import { canonicalizeJSON, targetRefHashCanonicalJSON } from '../canonicalize.js';
import { getAdapter, type DatabaseAdapter } from '../db-manager.js';
import { CaseMergeChainCycleError } from '../entities/errors.js';
import type {
  CanonicalCaseResolution,
  CaseAssembly,
  CaseAssemblyDecision,
  CaseAssemblyLinkedCase,
  CaseAssemblyMembership,
  CaseAssemblyObservation,
  CaseAssemblyTimelineEvent,
  CaseBlocker,
  CaseConfidence,
  CaseCorrectionRecord,
  CaseMembershipRecord,
  CaseMembershipSourceType,
  CaseMembershipStatus,
  CasePrimaryActor,
  CaseProposalKind,
  CaseProposalQueueRecord,
  CaseProposalResolution,
  CaseTruthRecord,
  CaseTruthStatus,
} from './types.js';

type CaseStoreAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'>;

export interface UpsertCaseTruthSlowFieldsInput {
  case_id: string;
  current_wiki_path?: string | null;
  title: string;
  status_reason?: string | null;
  primary_actors?: CasePrimaryActor[] | string | null;
  blockers?: CaseBlocker[] | string | null;
  confidence?: CaseConfidence | null;
  scope_refs?: Array<{ kind: string; id: string }> | string | null;
  wiki_path_history?:
    | Array<{ path: string; valid_from: string; valid_to: string | null }>
    | string
    | null;
  compiled_at: string;
}

export interface UpsertExplicitCaseMembershipsInput {
  case_id: string;
  // wiki-compiler memberships are always written with status='active' and
  // added_by='wiki-compiler' per spec §5.3 L251-253. Non-active statuses
  // (candidate, removed, excluded, stale) belong to memory-agent /
  // user-correction / sweeper flows — those are Phase 2 write paths and
  // MUST NOT be reachable through this wiki-compiler helper.
  rows: Array<{
    source_type: CaseMembershipSourceType;
    source_id: string;
    role?: string | null;
    confidence?: number | null;
    reason?: string | null;
  }>;
}

export interface EnqueueCaseProposalInput {
  project: string;
  proposal_kind: CaseProposalKind;
  proposed_payload: string;
  stable_fingerprint_input: unknown;
  conflicting_case_id?: string | null;
}

export interface AssembleCaseOptions {
  since?: string;
  limit?: number;
}

interface SortableDecision extends CaseAssemblyDecision {
  sort_time: number | null;
}

interface SortableTimelineEvent extends CaseAssemblyTimelineEvent {
  sort_time: number | null;
}

interface SortableObservation extends CaseAssemblyObservation {
  sort_time: number | null;
}

function isAdapter(value: unknown): value is CaseStoreAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === 'function' &&
    typeof (value as { transaction?: unknown }).transaction === 'function'
  );
}

function resolveWriteArgs<T>(
  adapterOrInput: CaseStoreAdapter | T,
  input?: T
): { adapter: CaseStoreAdapter; input: T } {
  if (input !== undefined) {
    if (!isAdapter(adapterOrInput)) {
      throw new Error('First argument must be a database adapter when input is provided.');
    }
    return { adapter: adapterOrInput, input };
  }

  if (isAdapter(adapterOrInput)) {
    throw new Error('Input is required when first argument is a database adapter.');
  }

  return { adapter: getAdapter(), input: adapterOrInput };
}

function resolveAssembleArgs(
  adapterOrCaseId: CaseStoreAdapter | string,
  caseIdOrOptions?: string | AssembleCaseOptions,
  options?: AssembleCaseOptions
): { adapter: CaseStoreAdapter; caseId: string; options?: AssembleCaseOptions } {
  if (isAdapter(adapterOrCaseId)) {
    if (typeof caseIdOrOptions !== 'string') {
      throw new Error('caseId is required when first argument is a database adapter.');
    }
    return { adapter: adapterOrCaseId, caseId: caseIdOrOptions, options };
  }

  return {
    adapter: getAdapter(),
    caseId: adapterOrCaseId,
    options: typeof caseIdOrOptions === 'object' ? caseIdOrOptions : undefined,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function flag01(value: unknown): 0 | 1 {
  return Number(value) === 1 ? 1 : 0;
}

function toJsonText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function parseJsonArray<T>(value: string | null): T[] {
  if (value === null || value === '') {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array in case_truth JSON field.');
  }

  return parsed as T[];
}

function parseTargetRef(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('case_corrections.target_ref_json must decode to a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error('Expected SQLite BLOB value to be a Buffer.');
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL IN clause for an empty value list.');
  }
  return values.map(() => '?').join(', ');
}

function sourceKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

function timestampMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value);
  if (text.length === 0) {
    return null;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && /^\d+$/.test(text)) {
    return numeric;
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatTimestamp(value: unknown): string {
  const ms = timestampMs(value);
  if (ms !== null) {
    return new Date(ms).toISOString();
  }
  return value === null || value === undefined ? '' : String(value);
}

function compareByUpdatedAtDesc(left: string, right: string): number {
  const leftMs = timestampMs(left) ?? 0;
  const rightMs = timestampMs(right) ?? 0;
  return rightMs - leftMs;
}

function compareBySortTimeDesc<T extends { sort_time: number | null }>(left: T, right: T): number {
  return (right.sort_time ?? 0) - (left.sort_time ?? 0);
}

function isMissingSchemaError(error: unknown): boolean {
  return error instanceof Error && /no such (table|column)/i.test(error.message);
}

function rethrowUnlessMissingSchema(error: unknown): void {
  if (isMissingSchemaError(error)) {
    return;
  }
  throw error instanceof Error ? error : new Error(String(error));
}

function withinSince(sortTime: number | null, sinceMs: number | null): boolean {
  return sinceMs === null || sortTime === null || sortTime >= sinceMs;
}

function resultLimit(options?: AssembleCaseOptions): number {
  const limit = options?.limit ?? 30;
  return Math.max(0, Math.floor(limit));
}

function mapCaseTruthRow(row: Record<string, unknown>): CaseTruthRecord {
  return {
    case_id: String(row.case_id),
    current_wiki_path: nullableString(row.current_wiki_path),
    title: String(row.title),
    status: row.status as CaseTruthStatus,
    status_reason: nullableString(row.status_reason),
    primary_actors: nullableString(row.primary_actors),
    blockers: nullableString(row.blockers),
    last_activity_at: nullableString(row.last_activity_at),
    canonical_case_id: nullableString(row.canonical_case_id),
    split_from_case_id: nullableString(row.split_from_case_id),
    wiki_path_history: nullableString(row.wiki_path_history),
    scope_refs: nullableString(row.scope_refs),
    confidence: nullableString(row.confidence) as CaseConfidence | null,
    compiled_at: nullableString(row.compiled_at),
    state_updated_at: nullableString(row.state_updated_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapCaseMembershipRow(row: Record<string, unknown>): CaseMembershipRecord {
  return {
    case_id: String(row.case_id),
    source_type: row.source_type as CaseMembershipSourceType,
    source_id: String(row.source_id),
    role: nullableString(row.role),
    confidence: nullableNumber(row.confidence),
    reason: nullableString(row.reason),
    status: row.status as CaseMembershipStatus,
    added_by: row.added_by as CaseMembershipRecord['added_by'],
    added_at: String(row.added_at),
    updated_at: String(row.updated_at),
    user_locked: flag01(row.user_locked),
  };
}

function mapCaseCorrectionRow(row: Record<string, unknown>): CaseCorrectionRecord {
  return {
    correction_id: String(row.correction_id),
    case_id: String(row.case_id),
    target_kind: row.target_kind as CaseCorrectionRecord['target_kind'],
    target_ref_json: String(row.target_ref_json),
    target_ref_hash: toBuffer(row.target_ref_hash),
    field_name: nullableString(row.field_name),
    old_value_json: nullableString(row.old_value_json),
    new_value_json: String(row.new_value_json),
    reason: String(row.reason),
    is_lock_active: flag01(row.is_lock_active),
    superseded_by: nullableString(row.superseded_by),
    reverted_at: nullableString(row.reverted_at),
    applied_by: String(row.applied_by),
    applied_at: String(row.applied_at),
  };
}

function mapCaseProposalRow(row: Record<string, unknown>): CaseProposalQueueRecord {
  return {
    proposal_id: String(row.proposal_id),
    project: String(row.project),
    proposal_kind: row.proposal_kind as CaseProposalKind,
    proposed_payload: String(row.proposed_payload),
    payload_fingerprint: toBuffer(row.payload_fingerprint),
    conflicting_case_id: nullableString(row.conflicting_case_id),
    detected_at: String(row.detected_at),
    resolved_at: nullableString(row.resolved_at),
    resolution: nullableString(row.resolution) as CaseProposalResolution | null,
    resolution_note: nullableString(row.resolution_note),
  };
}

function loadCaseTruth(adapter: CaseStoreAdapter, caseId: string): CaseTruthRecord | null {
  const row = adapter.prepare('SELECT * FROM case_truth WHERE case_id = ?').get(caseId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapCaseTruthRow(row) : null;
}

function dedupeMembershipRecords(rows: CaseMembershipRecord[]): CaseMembershipRecord[] {
  const sorted = [...rows].sort((left, right) => {
    if (left.user_locked !== right.user_locked) {
      return right.user_locked - left.user_locked;
    }
    return compareByUpdatedAtDesc(left.updated_at, right.updated_at);
  });

  const seen = new Set<string>();
  const deduped: CaseMembershipRecord[] = [];
  for (const row of sorted) {
    const key = sourceKey(row.source_type, row.source_id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

function listActiveMembershipRecordsForCaseChain(
  adapter: CaseStoreAdapter,
  caseIds: string[]
): CaseMembershipRecord[] {
  if (caseIds.length === 0) {
    return [];
  }

  const rows = adapter
    .prepare(
      `
        SELECT *
        FROM case_memberships
        WHERE case_id IN (${placeholders(caseIds)})
          AND status = 'active'
      `
    )
    .all(...caseIds) as Array<Record<string, unknown>>;

  return dedupeMembershipRecords(rows.map(mapCaseMembershipRow));
}

function toAssemblyMembership(row: CaseMembershipRecord): CaseAssemblyMembership {
  return {
    source_type: row.source_type,
    source_id: row.source_id,
    role: row.role,
    confidence: row.confidence,
    reason: row.reason,
    user_locked: row.user_locked === 1,
  };
}

export function resolveCanonicalCaseChain(
  adapter: CaseStoreAdapter,
  caseId: string,
  maxDepth = 64
): CanonicalCaseResolution {
  const visited = new Set<string>();
  const chain: string[] = [];
  let current = caseId;

  for (;;) {
    const detectedAtDepth = chain.length + 1;
    const cycleChain = [...chain, current];

    if (visited.has(current)) {
      throw new CaseMergeChainCycleError({
        case_id: caseId,
        chain: cycleChain,
        detected_at_depth: detectedAtDepth,
      });
    }

    if (detectedAtDepth > maxDepth) {
      throw new CaseMergeChainCycleError({
        case_id: caseId,
        chain: cycleChain,
        detected_at_depth: detectedAtDepth,
      });
    }

    visited.add(current);
    chain.push(current);

    const row = adapter
      .prepare('SELECT canonical_case_id FROM case_truth WHERE case_id = ?')
      .get(current) as { canonical_case_id: string | null } | undefined;

    if (!row) {
      throw new Error(`Case ${current} not found while resolving canonical case_id for ${caseId}.`);
    }

    if (!row.canonical_case_id) {
      return {
        terminal_case_id: current,
        chain,
        resolved_via_case_id: current === caseId ? null : caseId,
      };
    }

    current = row.canonical_case_id;
  }
}

export function expandCaseChainForAssembly(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  terminalCaseId: string,
  resolvedChain: string[]
): string[] {
  const rows = adapter
    .prepare(
      `
        WITH RECURSIVE merged_chain(case_id, depth) AS (
          SELECT case_id, 0
            FROM case_truth
           WHERE case_id = ?

          UNION

          SELECT ct.case_id, merged_chain.depth + 1
            FROM case_truth ct
            JOIN merged_chain ON ct.canonical_case_id = merged_chain.case_id
           WHERE merged_chain.depth < 64
        )
        SELECT case_id
          FROM merged_chain
         ORDER BY depth ASC, case_id ASC
      `
    )
    .all(terminalCaseId) as Array<{ case_id: string }>;

  const chain: string[] = [];
  for (const caseId of [...resolvedChain, ...rows.map((row) => row.case_id)]) {
    if (!chain.includes(caseId)) {
      chain.push(caseId);
    }
  }
  return chain;
}

export function upsertCaseTruthSlowFields(input: UpsertCaseTruthSlowFieldsInput): CaseTruthRecord;
export function upsertCaseTruthSlowFields(
  adapter: CaseStoreAdapter,
  input: UpsertCaseTruthSlowFieldsInput
): CaseTruthRecord;
export function upsertCaseTruthSlowFields(
  adapterOrInput: CaseStoreAdapter | UpsertCaseTruthSlowFieldsInput,
  maybeInput?: UpsertCaseTruthSlowFieldsInput
): CaseTruthRecord {
  const { adapter, input } = resolveWriteArgs(adapterOrInput, maybeInput);
  const createdAt = nowIso();
  const updatedAt = createdAt;

  return adapter.transaction(() => {
    adapter
      .prepare(
        `
          INSERT INTO case_truth (
            case_id, current_wiki_path, title, status_reason, primary_actors, blockers,
            wiki_path_history, scope_refs, confidence, compiled_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(case_id) DO UPDATE SET
            current_wiki_path = excluded.current_wiki_path,
            title = excluded.title,
            status_reason = excluded.status_reason,
            primary_actors = excluded.primary_actors,
            blockers = excluded.blockers,
            wiki_path_history = excluded.wiki_path_history,
            scope_refs = excluded.scope_refs,
            confidence = excluded.confidence,
            compiled_at = excluded.compiled_at,
            updated_at = excluded.updated_at
        `
      )
      .run(
        input.case_id,
        input.current_wiki_path ?? null,
        input.title,
        input.status_reason ?? null,
        toJsonText(input.primary_actors),
        toJsonText(input.blockers),
        toJsonText(input.wiki_path_history),
        toJsonText(input.scope_refs),
        input.confidence ?? null,
        input.compiled_at,
        createdAt,
        updatedAt
      );

    const saved = loadCaseTruth(adapter, input.case_id);
    if (!saved) {
      throw new Error(`Failed to load case_truth row after upsert for case_id=${input.case_id}.`);
    }
    return saved;
  });
}

export function upsertExplicitCaseMemberships(
  input: UpsertExplicitCaseMembershipsInput
): CaseMembershipRecord[];
export function upsertExplicitCaseMemberships(
  adapter: CaseStoreAdapter,
  input: UpsertExplicitCaseMembershipsInput
): CaseMembershipRecord[];
export function upsertExplicitCaseMemberships(
  adapterOrInput: CaseStoreAdapter | UpsertExplicitCaseMembershipsInput,
  maybeInput?: UpsertExplicitCaseMembershipsInput
): CaseMembershipRecord[] {
  const { adapter, input } = resolveWriteArgs(adapterOrInput, maybeInput);
  const updatedAt = nowIso();

  return adapter.transaction(() => {
    // wiki-compiler memberships are hard-coded to status='active' and
    // added_by='wiki-compiler' per spec §5.3 L251-253. Callers cannot
    // override status — non-active statuses are Phase 2 memory-agent /
    // user-correction / sweeper territory.
    const stmt = adapter.prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status,
          added_by, added_at, updated_at, user_locked
        )
        VALUES (?, ?, ?, ?, ?, ?, 'active', 'wiki-compiler', ?, ?, 0)
        ON CONFLICT(case_id, source_type, source_id) DO UPDATE SET
          role = excluded.role,
          confidence = excluded.confidence,
          reason = excluded.reason,
          status = 'active',
          added_by = 'wiki-compiler',
          updated_at = excluded.updated_at
        WHERE case_memberships.user_locked = 0
      `
    );

    for (const row of input.rows) {
      stmt.run(
        input.case_id,
        row.source_type,
        row.source_id,
        row.role ?? null,
        row.confidence ?? null,
        row.reason ?? null,
        updatedAt,
        updatedAt
      );
    }

    const rows = adapter
      .prepare(
        `
          SELECT *
          FROM case_memberships
          WHERE case_id = ?
          ORDER BY updated_at DESC, source_type ASC, source_id ASC
        `
      )
      .all(input.case_id) as Array<Record<string, unknown>>;

    return rows.map(mapCaseMembershipRow);
  });
}

export function listActiveMembershipsForCaseChain(
  adapter: CaseStoreAdapter,
  caseIds: string[],
  limit?: number
): CaseAssemblyMembership[] {
  const deduped = listActiveMembershipRecordsForCaseChain(adapter, caseIds);
  const limited = limit === undefined ? deduped : deduped.slice(0, Math.max(0, limit));
  return limited.map(toAssemblyMembership);
}

export interface ListActiveCorrectionsForCaseResult {
  terminal_case_id: string;
  resolved_via_case_id: string | null;
  chain: string[];
  corrections: CaseCorrectionRecord[];
}

/**
 * Resolves the canonical merge chain for caseId (both up to terminal and
 * down to merged losers) and returns every active, unreverted correction
 * across the entire chain. HITL surfaces must use this rather than a
 * direct `WHERE case_id = ?` query so post-merge corrections on loser
 * cases remain visible and actionable from the survivor's view.
 */
export function listActiveCorrectionsForCase(
  adapter: CaseStoreAdapter,
  caseId: string
): ListActiveCorrectionsForCaseResult {
  const resolution = resolveCanonicalCaseChain(adapter, caseId);
  const chain = expandCaseChainForAssembly(adapter, resolution.terminal_case_id, resolution.chain);
  const corrections = listActiveCorrectionsForCaseChain(adapter, chain);
  return {
    terminal_case_id: resolution.terminal_case_id,
    resolved_via_case_id: resolution.resolved_via_case_id,
    chain,
    corrections,
  };
}

export function listActiveCorrectionsForCaseChain(
  adapter: CaseStoreAdapter,
  caseIds: string[]
): CaseCorrectionRecord[] {
  if (caseIds.length === 0) {
    return [];
  }

  const rows = adapter
    .prepare(
      `
        SELECT *
        FROM case_corrections
        WHERE case_id IN (${placeholders(caseIds)})
          AND is_lock_active = 1
          AND reverted_at IS NULL
        ORDER BY applied_at DESC, correction_id ASC
      `
    )
    .all(...caseIds) as Array<Record<string, unknown>>;

  return rows.map(mapCaseCorrectionRow);
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(error.message);
}

function findExistingProposalId(
  adapter: CaseStoreAdapter,
  input: EnqueueCaseProposalInput,
  payloadFingerprint: Buffer
): string | null {
  const row = adapter
    .prepare(
      `
        SELECT proposal_id
        FROM case_proposal_queue
        WHERE project = ?
          AND proposal_kind = ?
          AND COALESCE(conflicting_case_id, '') = ?
          AND payload_fingerprint = ?
          AND resolved_at IS NULL
        LIMIT 1
      `
    )
    .get(
      input.project,
      input.proposal_kind,
      input.conflicting_case_id ?? '',
      payloadFingerprint
    ) as { proposal_id: string } | undefined;

  return row?.proposal_id ?? null;
}

export function enqueueCaseProposal(
  adapter: CaseStoreAdapter,
  input: EnqueueCaseProposalInput
): { proposal_id: string; inserted: boolean } {
  const canonicalFingerprintInput = canonicalizeJSON(input.stable_fingerprint_input);
  const payloadFingerprint = targetRefHashCanonicalJSON(canonicalFingerprintInput);
  const proposalId = randomUUID();
  const detectedAt = nowIso();

  return adapter.transaction(() => {
    try {
      adapter
        .prepare(
          `
            INSERT INTO case_proposal_queue (
              proposal_id, project, proposal_kind, proposed_payload, payload_fingerprint,
              conflicting_case_id, detected_at, resolved_at, resolution, resolution_note
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
          `
        )
        .run(
          proposalId,
          input.project,
          input.proposal_kind,
          input.proposed_payload,
          payloadFingerprint,
          input.conflicting_case_id ?? null,
          detectedAt
        );

      return { proposal_id: proposalId, inserted: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existingId = findExistingProposalId(adapter, input, payloadFingerprint);
      if (!existingId) {
        throw error;
      }

      // Spec §5.7 L355: re-detection updates detected_at without duplicating.
      // Keeps listUnresolvedCaseProposals ordering (ASC detected_at) honest —
      // recently re-detected rows move to the tail instead of sitting at
      // stale timestamps.
      adapter
        .prepare(
          `
            UPDATE case_proposal_queue
               SET detected_at = ?
             WHERE proposal_id = ?
               AND resolved_at IS NULL
          `
        )
        .run(detectedAt, existingId);

      return { proposal_id: existingId, inserted: false };
    }
  });
}

export function listUnresolvedCaseProposals(
  adapter: CaseStoreAdapter,
  project: string
): CaseProposalQueueRecord[] {
  const rows = adapter
    .prepare(
      `
        SELECT *
        FROM case_proposal_queue
        WHERE project = ?
          AND resolved_at IS NULL
        ORDER BY detected_at ASC
      `
    )
    .all(project) as Array<Record<string, unknown>>;

  return rows.map(mapCaseProposalRow);
}

function resolveDecisionRows(
  adapter: CaseStoreAdapter,
  memberships: CaseAssemblyMembership[],
  options?: AssembleCaseOptions
): CaseAssemblyDecision[] {
  const ids = memberships
    .filter((membership) => membership.source_type === 'decision')
    .map((membership) => membership.source_id);

  if (ids.length === 0) {
    return [];
  }

  const sinceMs = options?.since ? timestampMs(options.since) : null;
  const rows = adapter
    .prepare(
      `
        SELECT id, topic, decision, reasoning, confidence, event_date, event_datetime, created_at
        FROM decisions
        WHERE id IN (${placeholders(ids)})
      `
    )
    .all(...ids) as Array<Record<string, unknown>>;

  return rows
    .map((row): SortableDecision => {
      const sortTime =
        timestampMs(row.event_datetime) ??
        timestampMs(row.event_date) ??
        timestampMs(row.created_at);
      return {
        id: String(row.id),
        topic: String(row.topic),
        decision: String(row.decision),
        reasoning: nullableString(row.reasoning),
        confidence: nullableNumber(row.confidence),
        event_date: nullableString(row.event_date),
        sort_time: sortTime,
      };
    })
    .filter((row) => withinSince(row.sort_time, sinceMs))
    .sort(compareBySortTimeDesc)
    .slice(0, resultLimit(options))
    .map(({ sort_time: _sortTime, ...row }) => row);
}

function resolveTimelineEventRows(
  adapter: CaseStoreAdapter,
  memberships: CaseAssemblyMembership[],
  options?: AssembleCaseOptions
): CaseAssemblyTimelineEvent[] {
  const eventMemberships = memberships.filter((membership) => membership.source_type === 'event');
  const ids = eventMemberships.map((membership) => membership.source_id);

  if (ids.length === 0) {
    return [];
  }

  const membershipById = new Map(
    eventMemberships.map((membership) => [membership.source_id, membership])
  );
  const sinceMs = options?.since ? timestampMs(options.since) : null;
  const rows = adapter
    .prepare(
      `
        SELECT id, event_type, entity_id, role, observed_at, summary, details
        FROM entity_timeline_events
        WHERE id IN (${placeholders(ids)})
      `
    )
    .all(...ids) as Array<Record<string, unknown>>;

  return rows
    .map((row): SortableTimelineEvent => {
      const eventId = String(row.id);
      const sortTime = timestampMs(row.observed_at);
      return {
        event_id: eventId,
        event_type: String(row.event_type),
        entity_id: String(row.entity_id),
        role: membershipById.get(eventId)?.role ?? nullableString(row.role),
        observed_at: formatTimestamp(row.observed_at),
        summary: String(row.summary),
        details: nullableString(row.details),
        sort_time: sortTime,
      };
    })
    .filter((row) => withinSince(row.sort_time, sinceMs))
    .sort(compareBySortTimeDesc)
    .slice(0, resultLimit(options))
    .map(({ sort_time: _sortTime, ...row }) => row);
}

function resolveObservationRows(
  adapter: CaseStoreAdapter,
  memberships: CaseAssemblyMembership[],
  options?: AssembleCaseOptions
): CaseAssemblyObservation[] {
  const ids = memberships
    .filter((membership) => membership.source_type === 'observation')
    .map((membership) => membership.source_id);

  if (ids.length === 0) {
    return [];
  }

  const sinceMs = options?.since ? timestampMs(options.since) : null;
  const rows = adapter
    .prepare(
      `
        SELECT id, surface_form, source_locator, timestamp_observed
        FROM entity_observations
        WHERE id IN (${placeholders(ids)})
      `
    )
    .all(...ids) as Array<Record<string, unknown>>;

  return rows
    .map((row): SortableObservation => {
      const sortTime = timestampMs(row.timestamp_observed);
      return {
        observation_id: String(row.id),
        surface_form: String(row.surface_form),
        source_locator: nullableString(row.source_locator) ?? '',
        timestamp_observed: formatTimestamp(row.timestamp_observed),
        sort_time: sortTime,
      };
    })
    .filter((row) => withinSince(row.sort_time, sinceMs))
    .sort(compareBySortTimeDesc)
    .slice(0, resultLimit(options))
    .map(({ sort_time: _sortTime, ...row }) => row);
}

function buildLinkedCases(
  adapter: CaseStoreAdapter,
  chain: string[],
  terminalCaseId: string
): CaseAssemblyLinkedCase[] {
  const linked: CaseAssemblyLinkedCase[] = chain
    .filter((caseId) => caseId !== terminalCaseId)
    .map((caseId) => ({ case_id: caseId, relation: 'merged_from' }));

  if (chain.length === 0) {
    return linked;
  }

  const rows = adapter
    .prepare(
      `
        SELECT case_id
        FROM case_truth
        WHERE split_from_case_id IN (${placeholders(chain)})
        ORDER BY updated_at DESC
      `
    )
    .all(...chain) as Array<{ case_id: string }>;

  for (const row of rows) {
    linked.push({ case_id: String(row.case_id), relation: 'split_into' });
  }

  return linked;
}

export function assembleCase(caseId: string, options?: AssembleCaseOptions): CaseAssembly;
export function assembleCase(
  adapter: CaseStoreAdapter,
  caseId: string,
  options?: AssembleCaseOptions
): CaseAssembly;
export function assembleCase(
  adapterOrCaseId: CaseStoreAdapter | string,
  caseIdOrOptions?: string | AssembleCaseOptions,
  maybeOptions?: AssembleCaseOptions
): CaseAssembly {
  const { adapter, caseId, options } = resolveAssembleArgs(
    adapterOrCaseId,
    caseIdOrOptions,
    maybeOptions
  );
  const resolution = resolveCanonicalCaseChain(adapter, caseId);
  const assemblyChain = expandCaseChainForAssembly(
    adapter,
    resolution.terminal_case_id,
    resolution.chain
  );
  const caseTruth = loadCaseTruth(adapter, resolution.terminal_case_id);
  const membershipRecords = listActiveMembershipRecordsForCaseChain(adapter, assemblyChain);
  const memberships = membershipRecords.map(toAssemblyMembership);
  const activeCorrections = listActiveCorrectionsForCaseChain(adapter, assemblyChain);

  // Phase 3 additive fields: case_links + promoted_sources + freshness +
  // membership_explanations. Read inline to avoid cross-file import cycles.
  // Each block is try/catch-wrapped so older DBs without migrations
  // 047/048/049 applied still work (returns empty/null).
  let phase3CaseLinks: Array<Record<string, unknown>> = [];
  try {
    if (assemblyChain.length > 0) {
      const rows = adapter
        .prepare(
          `
            SELECT link_id, case_id_from, case_id_to, link_type, created_at, created_by,
                   confidence, reason_json, source_kind, source_ref
            FROM case_links
            WHERE case_id_from IN (${placeholders(assemblyChain)})
              AND revoked_at IS NULL
            ORDER BY created_at DESC, link_id ASC
          `
        )
        .all(...assemblyChain) as Array<Record<string, unknown>>;
      phase3CaseLinks = rows.map((row) => ({
        link_id: String(row.link_id),
        case_id_from: String(row.case_id_from),
        case_id_to: String(row.case_id_to),
        link_type: String(row.link_type),
        created_at: String(row.created_at),
        created_by: String(row.created_by),
        confidence: nullableNumber(row.confidence),
        reason_json: nullableString(row.reason_json),
        source_kind: String(row.source_kind),
        source_ref: nullableString(row.source_ref),
      }));
    }
  } catch (error) {
    rethrowUnlessMissingSchema(error);
    phase3CaseLinks = [];
  }

  let phase3PromotedSources: Record<string, unknown> | null = null;
  let phase3Freshness: Record<string, unknown> | null = null;
  try {
    const row = adapter
      .prepare(
        `
          SELECT canonical_decision_id, canonical_event_id, promoted_at, promoted_by,
                 promotion_reason, freshness_score, freshness_state,
                 freshness_score_is_drifted, freshness_drift_threshold,
                 freshness_checked_at, freshness_reason_json
          FROM case_truth
          WHERE case_id = ?
        `
      )
      .get(resolution.terminal_case_id) as Record<string, unknown> | undefined;
    if (row) {
      phase3PromotedSources = {
        canonical_decision_id: nullableString(row.canonical_decision_id),
        canonical_event_id: nullableString(row.canonical_event_id),
        promoted_at: nullableString(row.promoted_at),
        promoted_by: nullableString(row.promoted_by),
        promotion_reason: nullableString(row.promotion_reason),
      };
      phase3Freshness = {
        freshness_score: nullableNumber(row.freshness_score),
        freshness_state: nullableString(row.freshness_state),
        freshness_score_is_drifted: flag01(row.freshness_score_is_drifted),
        freshness_drift_threshold: nullableNumber(row.freshness_drift_threshold),
        freshness_checked_at: nullableString(row.freshness_checked_at),
        freshness_reason_json: nullableString(row.freshness_reason_json),
      };
    }
  } catch (error) {
    rethrowUnlessMissingSchema(error);
    phase3PromotedSources = null;
    phase3Freshness = null;
  }

  const phase3MembershipExplanations: Record<string, Record<string, unknown>> = {};
  try {
    if (memberships.length > 0) {
      const explanationRows = adapter
        .prepare(
          `
            SELECT source_type, source_id, user_locked, updated_at, score_breakdown_json,
                   source_locator, assignment_strategy, explanation_updated_at
            FROM case_memberships
            WHERE case_id IN (${placeholders(assemblyChain)})
              AND status = 'active'
          `
        )
        .all(...assemblyChain) as Array<Record<string, unknown>>;
      const selectedMemberships = new Map(
        membershipRecords.map((membership) => [
          sourceKey(membership.source_type, membership.source_id),
          membership,
        ])
      );
      const sortedExplanationRows = [...explanationRows].sort((left, right) => {
        const lockDelta = flag01(right.user_locked) - flag01(left.user_locked);
        return lockDelta !== 0
          ? lockDelta
          : compareByUpdatedAtDesc(String(left.updated_at), String(right.updated_at));
      });
      for (const row of sortedExplanationRows) {
        const key = `${String(row.source_type)}:${String(row.source_id)}`;
        const selected = selectedMemberships.get(key);
        if (!selected) {
          continue;
        }
        if (
          flag01(row.user_locked) !== selected.user_locked ||
          String(row.updated_at) !== selected.updated_at
        ) {
          continue;
        }
        phase3MembershipExplanations[key] = {
          source_type: String(row.source_type),
          source_id: String(row.source_id),
          score_breakdown: row.score_breakdown_json
            ? (JSON.parse(String(row.score_breakdown_json)) as unknown)
            : null,
          source_locator: nullableString(row.source_locator),
          assignment_strategy: nullableString(row.assignment_strategy),
          explanation_updated_at: nullableString(row.explanation_updated_at),
        };
      }
    }
  } catch (error) {
    rethrowUnlessMissingSchema(error);
    // Old DB without case_memberships explanation columns — leave empty.
  }

  const assembly: CaseAssembly = {
    case_id: resolution.terminal_case_id,
    current_wiki_path: caseTruth?.current_wiki_path ?? null,
    wiki_page: null,
    case_truth: caseTruth
      ? {
          title: caseTruth.title,
          status: caseTruth.status,
          status_reason: caseTruth.status_reason,
          primary_actors: parseJsonArray<CasePrimaryActor>(caseTruth.primary_actors),
          blockers: parseJsonArray<CaseBlocker>(caseTruth.blockers),
          last_activity_at: caseTruth.last_activity_at,
          confidence: caseTruth.confidence,
          canonical_case_id: caseTruth.canonical_case_id ?? null,
          split_from_case_id: caseTruth.split_from_case_id ?? null,
        }
      : null,
    memberships,
    timeline_events: resolveTimelineEventRows(adapter, memberships, options),
    decisions: resolveDecisionRows(adapter, memberships, options),
    recent_evidence: resolveObservationRows(adapter, memberships, options),
    active_corrections: activeCorrections.map((correction) => ({
      correction_id: correction.correction_id,
      target_kind: correction.target_kind,
      target_ref: parseTargetRef(correction.target_ref_json),
      new_value_json: correction.new_value_json,
      reason: correction.reason,
      applied_at: correction.applied_at,
    })),
    linked_cases: buildLinkedCases(adapter, assemblyChain, resolution.terminal_case_id),
    // Phase 3 additive (Task 30) — cast through unknown since inline
    // query rows are structurally shaped but TS sees Record<string,unknown>.
    case_links: phase3CaseLinks as unknown as CaseAssembly['case_links'],
    promoted_sources: phase3PromotedSources as unknown as CaseAssembly['promoted_sources'],
    freshness: phase3Freshness as unknown as CaseAssembly['freshness'],
    membership_explanations: phase3MembershipExplanations,
  };

  if (resolution.resolved_via_case_id) {
    assembly.resolved_via_case_id = resolution.resolved_via_case_id;
  }

  return assembly;
}
