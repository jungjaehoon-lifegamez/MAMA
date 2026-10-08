import crypto from 'node:crypto';

import { ensureMemoryScope, insertPreparedDecision } from '../db-manager.js';
import type { DatabaseAdapter, DatabaseInstance } from '../db-manager.js';
import { canonicalizeJSON } from '../canonicalize.js';
import { judgmentEdgeContentHash, judgmentEdgeId } from './judgment-edge.js';
import {
  TWIN_EDGE_SOURCES,
  TWIN_EDGE_TYPES,
  TWIN_REF_KINDS,
  type TwinEdgeInsert,
  type TwinEdgeRecord,
  type TwinEdgeSource,
  type TwinEdgeType,
  type TwinProjectRef,
  type TwinRef,
  type TwinRefKind,
} from './twin-edge-types.js';
import { insertMemoryEventInTransaction } from '../memory/event-store.js';
import { writeRecordIdentity } from '../registry/record-identity.js';
import type {
  JudgmentAmendment,
  JudgmentCommand,
  JudgmentReceipt,
  OwnerWorkPatch,
  RecordLink,
  WorkReference,
  WorkAssignment,
} from '../memory/judgment-types.js';
import type { MemoryEmbedder, MemoryScopeRef } from '../memory/types.js';

export interface JudgmentAccess {
  principalId: string;
  agentId: string;
  /** Host-stated origin of authored links; a mechanical import is code, not an agent turn. */
  edgeSource?: TwinEdgeSource;
  scopes: readonly MemoryScopeRef[];
  /** Scopes bound to a new write when the command omits scopes. */
  defaultScopes?: readonly MemoryScopeRef[];
  /**
   * Scopes admitted for READS only, beside `scopes`.
   *
   * A run allowed to read a channel's raw events may recall what was extracted
   * from it, which is not permission to write there. Stating that as a second
   * field on the principal is what lets a read bound itself more widely than a
   * write without anyone consulting the name of the tool being called.
   */
  readScopes?: readonly MemoryScopeRef[];
  /**
   * Connectors the caller's grant resolver admits. Carried on the boundary for the
   * same reason it is carried on reader inputs: a cited observation or graph ref must
   * satisfy the same visibility rule as a row the reader would have returned. The
   * caller supplies the projection; input JSON never grants it.
   */
  connectors?: readonly string[];
  /** Connector-wide stored observation reads granted by the host, never query input. */
  connectorWideRead?: readonly string[];
  /** Channels of each granted connector that may be read. */
  channels?: Readonly<Record<string, readonly string[]>>;
  /** Project partitions the caller's authority admits; query input never grants it. */
  projectRefs?: readonly TwinProjectRef[];
  tenantId?: string | null;
  /**
   * The newest observation time this caller may see, as epoch milliseconds.
   * An as-of question asked of the grant: absent means no clamp. It sits beside
   * the other three window fields because a citation answers the same question
   * a read does -- a clamp that reached only one of them would let a citation
   * out-read reading in time.
   */
  maxObservedMs?: number | null;
  /** Inclusive source/event-time ceiling for replay raw and observation reads. */
  maxSourceMs?: number | null;
  /**
   * Actions this principal may call. Dispatch compares `call.action` against
   * this list before exec, so an ungranted action is `denied` and the action
   * body never runs. The list is configuration the product states per
   * principal — it is never derived from the call, the channel, or the turn.
   * Exact names only: a wildcard would make the grant depend on what the
   * catalog happens to hold later.
   */
  actions: readonly string[];
  /**
   * Destinations this principal may send to. An irreversible send compares its
   * target against this list inside the adapter that performs it. Empty means
   * this principal sends nowhere, which is the honest default for a principal
   * that only reads.
   */
  destinations?: readonly DestinationRef[];
}

/** One place a send can land. `kind` names the transport, `id` the address. */
export interface DestinationRef {
  kind: string;
  id: string;
}

export interface JudgmentKnowledgeOptions {
  adapter: DatabaseInstance;
  /** The caller's embedder, or null to write text-only records without a vector. */
  embedder: MemoryEmbedder | null;
}

export class JudgmentError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'JudgmentError';
  }
}

function commandHash(command: JudgmentCommand): string {
  return crypto.createHash('sha256').update(canonicalizeJSON(command)).digest('hex');
}

function recordIdForCommand(command: JudgmentCommand): string {
  return judgmentRecordId(command.commandId);
}

/** Deterministic record id a command will be bound to — lets adapters build
 * projections (timeline events, identity bindings) before the write commits. */
export function judgmentRecordId(commandId: string): string {
  return `judgment_${crypto.createHash('sha256').update(commandId).digest('hex').slice(0, 24)}`;
}

function commitmentIdForCommand(command: JudgmentCommand): string {
  return `commitment_${crypto
    .createHash('sha256')
    .update(command.commandId)
    .digest('hex')
    .slice(0, 24)}`;
}

function requireText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JudgmentError('INVALID_COMMAND', `${field} must be nonblank`);
  }
}

export function scopeIdFor(scope: MemoryScopeRef): string {
  return `scope_${scope.kind}_${Buffer.from(scope.id).toString('base64url')}`;
}

function scopeKey(scope: MemoryScopeRef): string {
  return `${scope.kind}\0${scope.id}`;
}

/** Write scopes the caller was admitted to; bounds mutation targets.
 * Exported for the sibling source-ingest command path; not part of the public API. */
export function admittedScopeIds(access: JudgmentAccess): string[] {
  const seen = new Set<string>();
  return access.scopes.map((scope) => {
    requireText(scope.kind, 'scope kind');
    requireText(scope.id, 'scope id');
    const key = scopeKey(scope);
    if (seen.has(key)) {
      throw new JudgmentError('INVALID_SCOPE', 'Access scopes must be unique');
    }
    seen.add(key);
    return scopeIdFor(scope);
  });
}

/** Read authority for sibling knowledge readers and citations. */
export function readableScopes(access: JudgmentAccess): MemoryScopeRef[] {
  return [
    ...new Map(
      [...access.scopes, ...(access.readScopes ?? [])].map((scope) => [scopeKey(scope), scope])
    ).values(),
  ];
}

export function readableScopeIds(access: JudgmentAccess): string[] {
  admittedScopeIds(access);
  return admittedScopeIds({ ...access, scopes: readableScopes(access) });
}

/**
 * Scopes bound to the new record. An explicit `scopes: []` declares an
 * unscoped record (legacy parity); callers resolve judgment defaults before this check.
 * Exported for the sibling source-ingest command path; not part of the public API.
 */
export function boundScopeIdsFor(
  access: JudgmentAccess,
  command: { scopes?: MemoryScopeRef[] }
): string[] {
  const scopes = command.scopes ?? access.defaultScopes ?? access.scopes;
  if (command.scopes === undefined && scopes.length === 0) {
    throw new JudgmentError('INVALID_SCOPE', 'At least one judgment scope is required');
  }
  // A caller given a default scope writes inside its scopes; an unbound record would be readable
  // by everyone, outside that boundary.
  if (scopes.length === 0 && access.defaultScopes !== undefined) {
    throw new JudgmentError('INVALID_SCOPE', 'This caller binds every record to a scope');
  }
  const admitted = new Set(access.scopes.map(scopeKey));
  const seen = new Set<string>();
  return scopes.map((scope) => {
    // A kind is nonblank text. Which kinds exist is the writer's statement; this
    // compared against a list the core kept, so a consumer whose world had a kind
    // of its own could not append a judgment at all.
    requireText(scope.kind, 'scope kind');
    requireText(scope.id, 'scope id');
    const key = scopeKey(scope);
    if (seen.has(key)) {
      throw new JudgmentError('INVALID_SCOPE', 'Judgment scopes must be unique');
    }
    seen.add(key);
    if (!admitted.has(key)) {
      throw new JudgmentError('SCOPE_DENIED', 'Judgment scope is outside the admitted access');
    }
    return scopeIdFor(scope);
  });
}

function validateBounds(command: JudgmentCommand): void {
  for (const [name, value] of [
    ['appliesFrom', command.appliesFrom],
    ['appliesUntil', command.appliesUntil],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new JudgmentError('INVALID_TIME', `${name} must be a finite nonnegative epoch`);
    }
  }
  if (
    command.appliesFrom !== undefined &&
    command.appliesUntil !== undefined &&
    command.appliesFrom > command.appliesUntil
  ) {
    throw new JudgmentError('INVALID_TIME', 'appliesFrom cannot be after appliesUntil');
  }
}

const AMEND_FIELDS = [
  'outcome',
  'failureReason',
  'limitation',
  'status',
  'confidence',
  'durationDays',
  'supersedes',
  'supersededBy',
] as const;

/** Public-save parity fields carried by the command are validated up front so a
 * malformed command fails before any write or embedder call. */
function validateCommandFields(command: JudgmentCommand): void {
  // A replacement is a stated act: without its own reason the supersedes link would carry the
  // whole record's reasoning instead.
  for (const replacement of command.replaces ?? []) {
    requireText(replacement.id, 'replaces id');
    requireText(replacement.reason, 'replaces reason');
  }
  if (
    command.confidence !== undefined &&
    (!Number.isFinite(command.confidence) || command.confidence < 0 || command.confidence > 1)
  ) {
    throw new JudgmentError('INVALID_COMMAND', 'confidence must be a number between 0 and 1');
  }
  if (command.eventDate !== undefined && command.eventDate !== null) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(command.eventDate) ||
      Number.isNaN(new Date(command.eventDate).getTime())
    ) {
      throw new JudgmentError(
        'INVALID_TIME',
        `eventDate must be ISO 8601 YYYY-MM-DD (got: ${command.eventDate})`
      );
    }
  }
  if (command.eventDatetime !== undefined && command.eventDatetime !== null) {
    if (!Number.isFinite(command.eventDatetime) || command.eventDatetime <= 0) {
      throw new JudgmentError(
        'INVALID_TIME',
        `eventDatetime must be a positive millisecond timestamp (got: ${command.eventDatetime})`
      );
    }
  }
  if (
    command.recordedAt !== undefined &&
    (!Number.isFinite(command.recordedAt) || command.recordedAt < 0)
  ) {
    throw new JudgmentError('INVALID_TIME', 'recordedAt must be a finite nonnegative epoch');
  }
  if (
    command.sourceRefs !== undefined &&
    (!Array.isArray(command.sourceRefs) ||
      command.sourceRefs.some((ref) => typeof ref !== 'string' || ref.length === 0))
  ) {
    throw new JudgmentError('INVALID_COMMAND', 'sourceRefs must be an array of nonblank strings');
  }
  for (const amendment of command.amends ?? []) {
    if (amendment.target?.kind !== 'memory') {
      throw new JudgmentError('INVALID_COMMAND', 'amends targets must be memory references');
    }
    requireText(amendment.target.id, 'amends target id');
    if (!AMEND_FIELDS.some((field) => field in amendment)) {
      throw new JudgmentError(
        'INVALID_COMMAND',
        'amends requires at least one projection field to set'
      );
    }
  }
}

/** Whether a reference is available under the supplied read or write authority. */
export function referenceExists(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  reference: WorkReference,
  admittedScopeIds: readonly string[]
): boolean {
  if (reference.kind === 'memory') {
    const row = adapter
      .prepare(
        `SELECT (SELECT COUNT(*) FROM memory_scope_bindings b WHERE b.memory_id = d.id) AS bindings
         FROM decisions d WHERE d.id = ?`
      )
      .get(reference.id) as { bindings: number } | undefined;
    if (!row) return false;
    // A record with no scope bindings has no partition boundary to violate.
    if (row.bindings === 0) return true;
    if (admittedScopeIds.length === 0) return false;
    const placeholders = admittedScopeIds.map(() => '?').join(', ');
    return (
      adapter
        .prepare(
          `SELECT 1 FROM decisions d
           JOIN memory_scope_bindings b ON b.memory_id = d.id
           WHERE d.id = ? AND b.scope_id IN (${placeholders}) LIMIT 1`
        )
        .get(reference.id, ...admittedScopeIds) !== undefined
    );
  }
  if (reference.kind === 'registry') {
    const node =
      adapter.prepare('SELECT 1 FROM registry_nodes WHERE id = ?').get(reference.id) !== undefined;
    if (!node) return false;
    const bindings = adapter
      .prepare('SELECT scope_kind, scope_id FROM registry_scope_bindings WHERE node_id = ?')
      .all(reference.id) as Array<{ scope_kind: string; scope_id: string }>;
    return (
      bindings.length === 0 ||
      bindings.some((binding) =>
        admittedScopeIds.includes(
          `scope_${binding.scope_kind}_${Buffer.from(binding.scope_id).toString('base64url')}`
        )
      )
    );
  }
  if (reference.kind === 'observation') {
    return (
      adapter
        .prepare('SELECT 1 FROM observation_versions WHERE observation_id = ?')
        .get(reference.id) !== undefined
    );
  }
  if (reference.kind === 'edge') {
    // A correction reads the link it corrects, so both of that link's ends must be reachable.
    const edge = adapter
      .prepare(
        'SELECT subject_kind, subject_id, object_kind, object_id FROM twin_edges WHERE edge_id = ?'
      )
      .get(reference.id) as
      | { subject_kind: string; subject_id: string; object_kind: string; object_id: string }
      | undefined;
    return (
      edge !== undefined &&
      referenceExists(
        adapter,
        { kind: edge.subject_kind, id: edge.subject_id } as WorkReference,
        admittedScopeIds
      ) &&
      referenceExists(
        adapter,
        { kind: edge.object_kind, id: edge.object_id } as WorkReference,
        admittedScopeIds
      )
    );
  }
  return false;
}

function validateLinks(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  links: readonly RecordLink[],
  admittedScopeIds: readonly string[]
): void {
  const keys = new Set<string>();
  for (const link of links) {
    requireText(link.relation, 'link relation');
    requireText(link.target.id, 'link target id');
    const attrs = link.attrs ?? {};
    const key = canonicalizeJSON({
      relation: link.relation,
      target: link.target,
      role: attrs.role ?? null,
      slot: attrs.slot ?? null,
    });
    if (keys.has(key)) {
      throw new JudgmentError(
        'DUPLICATE_LINK',
        'A judgment cannot repeat the same relation target slot'
      );
    }
    keys.add(key);
    if (!referenceExists(adapter, link.target, admittedScopeIds)) {
      // Echo only the caller's own input: an unavailable id reads the same whether wrong or outside scope.
      throw new JudgmentError(
        'REFERENCE_NOT_FOUND',
        `A judgment reference is unavailable: ${link.target.kind} ${link.target.id}`
      );
    }
  }
}

function validateAmends(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  amends: readonly JudgmentAmendment[],
  admittedScopeIds: readonly string[]
): void {
  for (const amendment of amends) {
    if (!referenceExists(adapter, amendment.target, admittedScopeIds)) {
      throw new JudgmentError('REFERENCE_NOT_FOUND', 'An amendment target is unavailable');
    }
  }
}

function toColumnText(value: string | string[] | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

const AMEND_COLUMN_MAP = {
  outcome: 'outcome',
  failureReason: 'failure_reason',
  limitation: 'limitation',
  status: 'status',
  confidence: 'confidence',
  durationDays: 'duration_days',
  supersedes: 'supersedes',
  supersededBy: 'superseded_by',
} as const;

/** The column values an amendment or a replacement is about to overwrite, per target. */
function priorValuesFor(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  command: JudgmentCommand
): Array<{ target: string; values: Record<string, unknown> }> {
  const read = (id: string, columns: readonly string[]) =>
    adapter.prepare(`SELECT ${columns.join(', ')} FROM decisions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
  const replaced = (command.replaces ?? []).map((replacement) => {
    const prior = read(replacement.id, ['status', 'superseded_by']);
    return {
      target: replacement.id,
      values: { status: prior?.status ?? null, supersededBy: prior?.superseded_by ?? null },
    };
  });
  const amended = (command.amends ?? []).map((amendment) => {
    const fields = AMEND_FIELDS.filter((field) => field in amendment);
    const prior = read(
      amendment.target.id,
      fields.map((field) => AMEND_COLUMN_MAP[field])
    );
    return {
      target: amendment.target.id,
      values: Object.fromEntries(
        fields.map((field) => [field, prior?.[AMEND_COLUMN_MAP[field]] ?? null])
      ),
    };
  });
  return [...replaced, ...amended];
}

function applyAmendment(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  amendment: JudgmentAmendment,
  now: number
): void {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];
  for (const field of AMEND_FIELDS) {
    if (field in amendment) {
      sets.push(`${AMEND_COLUMN_MAP[field]} = ?`);
      params.push(amendment[field] ?? null);
    }
  }
  adapter
    .prepare(`UPDATE decisions SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params, amendment.target.id);
}

function applyProjections(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  command: JudgmentCommand,
  recordId: string,
  effectiveScopes: readonly MemoryScopeRef[]
): void {
  const projections = command.projections;
  if (!projections) return;
  if (projections.recordIdentity) {
    writeRecordIdentity(adapter, {
      recordId,
      itemId: projections.recordIdentity.itemId,
      actors: projections.recordIdentity.actors ?? [],
      scopes: effectiveScopes,
    });
  }
}

function parseReceipt(value: string): JudgmentReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('judgment_commands.receipt_json is malformed', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('judgment_commands.receipt_json must contain an object');
  }
  return parsed as JudgmentReceipt;
}

function assertReplay(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  command: JudgmentCommand,
  access: JudgmentAccess,
  hash: string
): JudgmentReceipt | null {
  const binding = adapter
    .prepare(
      'SELECT principal_id, action, payload_hash, receipt_key, erased_at FROM command_bindings WHERE command_id = ?'
    )
    .get(command.commandId) as
    | {
        principal_id: string;
        action: string;
        payload_hash: string;
        receipt_key: string;
        erased_at: number | null;
      }
    | undefined;
  if (!binding) return null;
  if (binding.erased_at !== null)
    throw new JudgmentError('COMMAND_ERASED', 'The command belongs to an erased record');
  if (
    binding.principal_id !== access.principalId ||
    binding.action !== 'judgment.append' ||
    binding.payload_hash !== hash
  ) {
    throw new JudgmentError(
      'COMMAND_CONFLICT',
      'The command id is already bound to another request'
    );
  }
  const row = adapter
    .prepare('SELECT receipt_json FROM judgment_commands WHERE command_id = ?')
    .get(command.commandId) as { receipt_json: string } | undefined;
  if (!row) {
    throw new Error('Command binding has no judgment receipt');
  }
  return parseReceipt(row.receipt_json);
}

function insertLink(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  command: JudgmentCommand,
  recordId: string,
  link: RecordLink,
  index: number,
  access: JudgmentAccess,
  now: number
): string {
  const id = judgmentEdgeId(command.commandId, index, link.relation, link.target);
  const attrs = link.attrs ?? {};
  const contentHash = judgmentEdgeContentHash(id, recordId, link);
  insertTwinEdge(adapter, {
    edge_id: id,
    edge_type: link.relation,
    subject_ref: { kind: 'memory', id: recordId },
    object_ref: link.target,
    relation_attrs: attrs,
    confidence: 1.0,
    source: access.edgeSource ?? 'agent',
    agent_id: Object.hasOwn(command, 'agentId') ? (command.agentId ?? undefined) : access.agentId,
    model_run_id: command.modelRunId ?? undefined,
    reason_text:
      typeof link.attrs?.reason === 'string' ? link.attrs.reason : (command.reasoning ?? undefined),
    content_hash: contentHash,
    created_at: now,
  });
  return id;
}

function workPatch(value: WorkAssignment | undefined): OwnerWorkPatch {
  return value?.set ?? {};
}

function recordScopes(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  recordId: string
): MemoryScopeRef[] {
  return adapter
    .prepare(
      `SELECT s.kind, s.external_id AS id
    FROM memory_scope_bindings b JOIN memory_scopes s ON s.id = b.scope_id
    WHERE b.memory_id = ? ORDER BY b.is_primary DESC, b.rowid`
    )
    .all(recordId) as MemoryScopeRef[];
}

/** Resolve omitted revision scopes from the item, or the original write on replay. */
function effectiveJudgmentCommand(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  command: JudgmentCommand,
  access: JudgmentAccess
): JudgmentCommand & { scopes: MemoryScopeRef[] } {
  if (command.scopes !== undefined) return { ...command, scopes: command.scopes };
  if (command.work && command.work.operation !== 'create') {
    const binding = adapter
      .prepare(
        "SELECT receipt_key FROM command_bindings WHERE command_id = ? AND action = 'judgment.append'"
      )
      .get(command.commandId) as { receipt_key: string } | undefined;
    if (binding) return { ...command, scopes: recordScopes(adapter, binding.receipt_key) };
    const current = adapter
      .prepare('SELECT head_record_id FROM commitments WHERE commitment_id = ?')
      .get(command.work.commitmentId) as { head_record_id: string } | undefined;
    if (!current)
      throw new JudgmentError(
        'REFERENCE_NOT_FOUND',
        `Commitment is unavailable: ${command.work.commitmentId}`
      );
    return { ...command, scopes: recordScopes(adapter, current.head_record_id) };
  }
  const scopes = access.defaultScopes ?? access.scopes;
  if (scopes.length === 0 && access.defaultScopes === undefined) {
    throw new JudgmentError('INVALID_SCOPE', 'At least one judgment scope is required');
  }
  return { ...command, scopes: [...scopes] };
}

async function appendJudgmentOnAdapter(
  adapter: DatabaseInstance,
  command: JudgmentCommand,
  access: JudgmentAccess,
  embedder: JudgmentKnowledgeOptions['embedder']
): Promise<JudgmentReceipt> {
  requireText(command.commandId, 'commandId');
  requireText(command.topic, 'topic');
  requireText(command.summary, 'summary');
  requireText(access.principalId, 'principalId');
  requireText(access.agentId, 'agentId');
  if (command.recordKind !== 'judgment' && command.recordKind !== 'commitment') {
    throw new JudgmentError('INVALID_COMMAND', 'recordKind is invalid');
  }
  if ((command.recordKind === 'commitment') !== (command.work !== undefined)) {
    throw new JudgmentError('INVALID_COMMAND', 'Commitment records require a work assignment');
  }
  validateBounds(command);
  validateCommandFields(command);
  const admittedScopeIdList = admittedScopeIds(access);
  const readableScopeIdList = readableScopeIds(access);
  let effectiveCommand = effectiveJudgmentCommand(adapter, command, access);
  let boundScopeIdList = boundScopeIdsFor(access, effectiveCommand);
  let effectiveScopes = effectiveCommand.scopes;
  let hash = commandHash(effectiveCommand);
  const replay = assertReplay(adapter, command, access, hash);
  if (replay) {
    validateLinks(adapter, command.links ?? [], readableScopeIdList);
    for (const replacement of command.replaces ?? []) {
      if (!referenceExists(adapter, { kind: 'memory', id: replacement.id }, admittedScopeIdList)) {
        throw new JudgmentError('REFERENCE_NOT_FOUND', 'A replacement target is unavailable');
      }
    }
    validateAmends(adapter, command.amends ?? [], admittedScopeIdList);
    return replay;
  }
  validateLinks(adapter, command.links ?? [], readableScopeIdList);
  validateAmends(adapter, command.amends ?? [], admittedScopeIdList);

  const recordId = recordIdForCommand(command);
  const now = Date.now();
  const domainNow = command.recordedAt ?? now;
  const embedding = embedder
    ? await embedder.embed(`${command.topic}\n${command.summary}`, 'passage')
    : null;
  const edgeIds: string[] = [];
  let workReceipt: JudgmentReceipt['work'];
  let replayedReceipt: JudgmentReceipt | null = null;
  const transaction = adapter.transactionImmediate
    ? adapter.transactionImmediate.bind(adapter)
    : adapter.transaction.bind(adapter);
  transaction(() => {
    // Embedding yielded: use the head under the write transaction, not an earlier snapshot.
    effectiveCommand = effectiveJudgmentCommand(adapter, command, access);
    boundScopeIdList = boundScopeIdsFor(access, effectiveCommand);
    effectiveScopes = effectiveCommand.scopes;
    hash = commandHash(effectiveCommand);
    const bindingResult = adapter
      .prepare(
        `INSERT OR IGNORE INTO command_bindings
         (command_id, principal_id, action, payload_hash, receipt_kind, receipt_key, created_at)
         VALUES (?, ?, 'judgment.append', ?, 'judgment', ?, ?)`
      )
      .run(command.commandId, access.principalId, hash, recordId, now);
    if (bindingResult.changes === 0) {
      replayedReceipt = assertReplay(adapter, command, access, hash);
      if (!replayedReceipt) {
        throw new Error('Command binding was not readable after a conflict-free insert');
      }
      return;
    }
    // What the amendments and replacements will overwrite, kept in this record: the target
    // columns are a projection, and the appended records are the history.
    const replacedValues = priorValuesFor(adapter, command);
    const decisionRowId = insertPreparedDecision(
      adapter,
      {
        id: recordId,
        topic: command.topic,
        decision: command.summary,
        reasoning: command.reasoning ?? null,
        outcome: command.outcome ?? null,
        failure_reason: command.failureReason ?? null,
        limitation: command.limitation ?? null,
        user_involvement: command.record?.userInvolvement ?? null,
        session_id: command.record?.sessionId ?? null,
        supersedes: command.replaces?.[0]?.id ?? command.record?.supersedes ?? null,
        refined_from: command.record?.refinedFrom ?? null,
        confidence: command.confidence ?? 0.5,
        created_at: domainNow,
        updated_at: now,
        needs_validation: command.record?.needsValidation ?? 0,
        trust_context: command.record?.trustContext ?? null,
        evidence: toColumnText(command.evidence),
        alternatives: toColumnText(command.alternatives),
        risks: command.risks ?? null,
        event_date: command.eventDate ?? null,
        event_datetime: command.eventDatetime ?? null,
        agent_id: Object.hasOwn(command, 'agentId') ? (command.agentId ?? null) : access.agentId,
        model_run_id: command.modelRunId ?? null,
        envelope_hash: command.envelopeHash ?? null,
        gateway_call_id: command.gatewayCallId ?? null,
        source_refs_json: command.sourceRefs ? canonicalizeJSON(command.sourceRefs) : null,
        provenance_json: command.provenance ? canonicalizeJSON(command.provenance) : null,
      },
      embedding
    );
    if (!Number.isSafeInteger(decisionRowId) || decisionRowId <= 0) {
      throw new Error('Judgment decision row was not inserted');
    }
    adapter
      .prepare(
        `UPDATE decisions
         SET record_kind = ?, payload_json = ?, applies_from = ?, applies_until = ?,
             kind = COALESCE(?, kind), status = COALESCE(?, status),
             summary = COALESCE(?, summary), is_static = COALESCE(?, is_static)
         WHERE id = ?`
      )
      .run(
        command.recordKind,
        canonicalizeJSON(
          replacedValues.length > 0
            ? { ...(command.payload ?? {}), replacedValues }
            : (command.payload ?? {})
        ),
        command.appliesFrom ?? null,
        command.appliesUntil ?? null,
        command.record?.kind ?? null,
        command.record?.status ?? null,
        // Never leave summary NULL: legacy readers (evolution candidates,
        // recall) assume it is text. The command summary is the authored
        // summary when the record does not carry a distinct one.
        command.record?.summary ?? command.summary,
        command.record?.isStatic ?? null,
        recordId
      );
    for (const [index, scopeId] of boundScopeIdList.entries()) {
      const scope = effectiveScopes[index]!;
      ensureMemoryScope(adapter, scope.kind, scope.id);
      adapter
        .prepare(
          'INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary) VALUES (?, ?, ?)'
        )
        .run(recordId, scopeId, index === 0 ? 1 : 0);
    }
    for (const [index, link] of (command.links ?? []).entries()) {
      edgeIds.push(insertLink(adapter, command, recordId, link, index, access, now));
    }
    for (const replacement of command.replaces ?? []) {
      if (!referenceExists(adapter, { kind: 'memory', id: replacement.id }, admittedScopeIdList)) {
        throw new JudgmentError('REFERENCE_NOT_FOUND', 'A replacement target is unavailable');
      }
      adapter
        .prepare(
          "UPDATE decisions SET superseded_by = ?, status = 'superseded', updated_at = ? WHERE id = ?"
        )
        .run(recordId, domainNow, replacement.id);
      edgeIds.push(
        insertLink(
          adapter,
          { ...command, links: [] },
          recordId,
          {
            relation: 'supersedes',
            target: { kind: 'memory', id: replacement.id },
            attrs: { reason: replacement.reason },
          },
          edgeIds.length,
          access,
          now
        )
      );
    }
    for (const amendment of command.amends ?? []) {
      if (!referenceExists(adapter, amendment.target, admittedScopeIdList)) {
        throw new JudgmentError('REFERENCE_NOT_FOUND', 'An amendment target is unavailable');
      }
      applyAmendment(adapter, amendment, domainNow);
    }
    applyProjections(adapter, command, recordId, effectiveScopes);
    // A commitment's own clock is domain time, like the record's: `updated_at`
    // is what the board sorts and filters on, so a caller that states when a
    // revision happened must see that time on the row, not the wall clock the
    // write happened to land on.
    if (command.recordKind === 'commitment' && command.work) {
      const work = command.work;
      if (work.operation === 'create') {
        const commitmentId = commitmentIdForCommand(command);
        const imported = work.imported;
        if (imported !== undefined) {
          if (!Number.isSafeInteger(imported.rowId) || imported.rowId <= 0) {
            throw new JudgmentError(
              'INVALID_COMMAND',
              `imported.rowId must be a positive integer (got: ${imported.rowId})`
            );
          }
          if (
            imported.revision !== undefined &&
            (!Number.isSafeInteger(imported.revision) || imported.revision <= 0)
          ) {
            throw new JudgmentError(
              'INVALID_COMMAND',
              `imported.revision must be a positive integer (got: ${imported.revision})`
            );
          }
          if (
            imported.createdAt !== undefined &&
            (!Number.isFinite(imported.createdAt) || imported.createdAt < 0)
          ) {
            throw new JudgmentError(
              'INVALID_COMMAND',
              `imported.createdAt must be a finite nonnegative epoch (got: ${imported.createdAt})`
            );
          }
        }
        const revision = imported?.revision ?? 1;
        const createdAt = imported?.createdAt ?? domainNow;
        if (imported !== undefined) {
          // An imported row keeps the task id it already had; sqlite_sequence
          // moves with the explicit insert, so work first stated here still
          // takes the next number after it.
          adapter
            .prepare(
              `INSERT INTO commitments
               (row_id, commitment_id, current_revision, head_record_id, withdrawn, created_at, updated_at, agent_id, model_run_id)
               VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
            )
            .run(
              imported.rowId,
              commitmentId,
              revision,
              recordId,
              createdAt,
              domainNow,
              access.agentId,
              command.modelRunId ?? null
            );
        } else {
          adapter
            .prepare(
              `INSERT INTO commitments
               (commitment_id, current_revision, head_record_id, withdrawn, created_at, updated_at, agent_id, model_run_id)
               VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
            )
            .run(
              commitmentId,
              revision,
              recordId,
              createdAt,
              domainNow,
              access.agentId,
              command.modelRunId ?? null
            );
        }
        adapter
          .prepare(
            `INSERT INTO commitment_assignments
             (commitment_id, revision, record_id, operation, set_json, clear_json, applies_from, applies_until, created_at, agent_id, model_run_id)
            VALUES (?, ?, ?, 'create', ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            commitmentId,
            revision,
            recordId,
            canonicalizeJSON(workPatch(work)),
            canonicalizeJSON(work.clear ?? []),
            command.eventDatetime ?? null,
            command.appliesUntil ?? null,
            domainNow,
            access.agentId,
            command.modelRunId ?? null
          );
        workReceipt = { commitmentId, revision };
      } else {
        const current = adapter
          .prepare(
            'SELECT current_revision, head_record_id, withdrawn FROM commitments WHERE commitment_id = ?'
          )
          .get(work.commitmentId) as
          | { current_revision: number; head_record_id: string; withdrawn: number }
          | undefined;
        if (!current) {
          throw new JudgmentError(
            'REFERENCE_NOT_FOUND',
            `Commitment is unavailable: ${work.commitmentId}`
          );
        }
        if (
          command.scopes !== undefined &&
          !referenceExists(
            adapter,
            { kind: 'memory', id: current.head_record_id },
            admittedScopeIdList
          )
        ) {
          throw new JudgmentError('REFERENCE_NOT_FOUND', 'A revision target is unavailable');
        }
        // Only revise may omit the revision (it appends to the head); withdraw always states it.
        if (
          (work.expectedRevision !== undefined || work.operation === 'withdraw') &&
          current.current_revision !== work.expectedRevision
        ) {
          throw new JudgmentError('STALE_REVISION', 'Commitment revision is stale');
        }
        if (work.operation === 'revise' && current.withdrawn === 1) {
          throw new JudgmentError(
            'COMMITMENT_WITHDRAWN',
            'Withdrawn commitments cannot be revised'
          );
        }
        const revision = current.current_revision + 1;
        adapter
          .prepare(
            `INSERT INTO commitment_assignments
             (commitment_id, revision, record_id, operation, set_json, clear_json, applies_from, applies_until, created_at, agent_id, model_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            work.commitmentId,
            revision,
            recordId,
            work.operation,
            canonicalizeJSON(workPatch(work)),
            canonicalizeJSON(work.clear ?? []),
            command.eventDatetime ?? null,
            command.appliesUntil ?? null,
            domainNow,
            access.agentId,
            command.modelRunId ?? null
          );
        // No host edge to the previous revision: the order lives in commitment_assignments, and
        // how a revision relates to an earlier record is the agent's link to state (owner,
        // 2026-09-30).
        adapter
          .prepare(
            'UPDATE commitments SET current_revision = ?, head_record_id = ?, withdrawn = ?, updated_at = ?, agent_id = ?, model_run_id = ? WHERE commitment_id = ?'
          )
          .run(
            revision,
            recordId,
            work.operation === 'withdraw' ? 1 : 0,
            domainNow,
            access.agentId,
            command.modelRunId ?? null,
            work.commitmentId
          );
        workReceipt = { commitmentId: work.commitmentId, revision };
      }
    }
    insertMemoryEventInTransaction(adapter, {
      event_type: command.event?.eventType ?? 'save',
      actor: command.event?.actor ?? `actor:${access.principalId}`,
      source_turn_id: command.event?.sourceTurnId,
      memory_id: recordId,
      topic: command.topic,
      scope_refs: effectiveScopes,
      evidence_refs: command.event?.evidenceRefs,
      reason: command.event?.reason ?? 'agent judgment command',
      created_at: domainNow,
    });
    const receipt: JudgmentReceipt = {
      status: 'committed',
      recordId,
      commandId: command.commandId,
      edgeIds,
      watermark: now,
      ...(workReceipt ? { work: workReceipt } : {}),
      diagnostics: [],
    };
    adapter
      .prepare(
        `INSERT INTO judgment_commands (command_id, record_id, committed_watermark, receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(command.commandId, recordId, receipt.watermark, canonicalizeJSON(receipt), now);
  });
  if (replayedReceipt) {
    return replayedReceipt;
  }
  // Sync the adapter's status cache for every row whose projection columns were
  // touched: the new record, superseded targets, and amended outcome rows.
  refreshDecisionStatusCaches(adapter, [
    recordId,
    ...(command.replaces ?? []).map((replacement) => replacement.id),
    ...(command.amends ?? []).map((amendment) => amendment.target.id),
  ]);
  return {
    status: 'committed',
    recordId,
    commandId: command.commandId,
    edgeIds,
    watermark: now,
    ...(workReceipt ? { work: workReceipt } : {}),
    diagnostics: [],
  };
}

function refreshDecisionStatusCaches(
  adapter: Pick<DatabaseAdapter, 'prepare'> & {
    refreshDecisionStatusCache?: (rowid: number) => void;
  },
  memoryIds: readonly string[]
): void {
  if (!adapter.refreshDecisionStatusCache) return;
  const stmt = adapter.prepare('SELECT rowid FROM decisions WHERE id = ?');
  for (const memoryId of new Set(memoryIds)) {
    const row = stmt.get(memoryId) as { rowid: number } | undefined;
    if (row) {
      adapter.refreshDecisionStatusCache(row.rowid);
    }
  }
}

export async function appendJudgment(
  command: JudgmentCommand,
  access: JudgmentAccess,
  options: JudgmentKnowledgeOptions
): Promise<JudgmentReceipt> {
  // The command boundary no longer reaches the process-global store: the
  // caller names the database this judgment commits to.
  if (!options?.adapter) {
    throw new JudgmentError(
      'INVALID_COMMAND',
      'appendJudgment requires an explicit adapter; the process-global store is not a write path'
    );
  }
  requireEmbedderChoice(options);
  return appendJudgmentOnAdapter(options.adapter, command, access, options.embedder);
}

// Untyped callers otherwise write records that similarity search can never find.
function requireEmbedderChoice(options: JudgmentKnowledgeOptions): void {
  if (options.embedder === undefined) {
    throw new JudgmentError(
      'INVALID_COMMAND',
      'Writing knowledge requires an embedder, or null for text-only records'
    );
  }
}

export function createJudgmentWriter(options: JudgmentKnowledgeOptions) {
  requireEmbedderChoice(options);
  return {
    appendJudgment: (command: JudgmentCommand, access: JudgmentAccess) =>
      appendJudgmentOnAdapter(options.adapter, command, access, options.embedder),
  };
}

// ── Twin-edge store ────────────────────────────────────────────────────────────
// The single write boundary for twin_edges lives beside the judgment writer:
// a link is part of the same transaction as the judgment it records.

type TwinEdgeReadAdapter = Pick<DatabaseAdapter, 'prepare'>;

const EDGE_TYPE_SET = new Set<string>(TWIN_EDGE_TYPES);
const REF_KIND_SET = new Set<string>(TWIN_REF_KINDS);
const SOURCE_SET = new Set<string>(TWIN_EDGE_SOURCES);

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`twin_edges.${field} must be a non-empty string`);
  }
  return value;
}

function normalizeEdgeType(value: unknown): TwinEdgeType {
  if (typeof value === 'string' && EDGE_TYPE_SET.has(value)) {
    return value as TwinEdgeType;
  }
  throw new Error(`Unsupported twin edge type: ${String(value)}`);
}

function normalizeSource(value: unknown): TwinEdgeSource {
  if (typeof value === 'string' && SOURCE_SET.has(value)) {
    return value as TwinEdgeSource;
  }
  throw new Error(`Unsupported twin edge source: ${String(value)}`);
}

function normalizeRef(ref: TwinRef, field: string): TwinRef {
  if (!ref || typeof ref !== 'object') {
    throw new Error(`${field} must be a TwinRef`);
  }
  if (!REF_KIND_SET.has(ref.kind)) {
    throw new Error(`${field}.kind is unsupported: ${String(ref.kind)}`);
  }
  return {
    kind: ref.kind,
    id: requireNonEmptyString(ref.id, `${field}.id`),
  } as TwinRef;
}

function parseJsonField(value: unknown, field: string, edgeId: string): unknown | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid twin_edges.${field} for ${edgeId}: ${message}`);
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new Error('twin_edges.content_hash must be a 32-byte Buffer');
}

export function mapTwinEdgeRow(row: Record<string, unknown>): TwinEdgeRecord {
  const edgeId = String(row.edge_id);
  return {
    edge_id: edgeId,
    edge_type: normalizeEdgeType(row.edge_type),
    subject_ref: {
      kind: String(row.subject_kind) as TwinRefKind,
      id: String(row.subject_id),
    } as TwinRef,
    object_ref: {
      kind: String(row.object_kind) as TwinRefKind,
      id: String(row.object_id),
    } as TwinRef,
    relation_attrs_json: nullableString(row.relation_attrs_json),
    relation_attrs: parseJsonField(row.relation_attrs_json, 'relation_attrs_json', edgeId),
    confidence: Number(row.confidence),
    source: normalizeSource(row.source),
    agent_id: nullableString(row.agent_id),
    model_run_id: nullableString(row.model_run_id),
    envelope_hash: nullableString(row.envelope_hash),
    human_actor_id: nullableString(row.human_actor_id),
    human_actor_role: nullableString(row.human_actor_role),
    authority_scope_json: nullableString(row.authority_scope_json),
    authority_scope: parseJsonField(row.authority_scope_json, 'authority_scope_json', edgeId),
    reason_classification: nullableString(row.reason_classification),
    reason_text: nullableString(row.reason_text),
    evidence_refs_json: nullableString(row.evidence_refs_json),
    evidence_refs: parseJsonField(row.evidence_refs_json, 'evidence_refs_json', edgeId),
    request_idempotency_key: nullableString(row.request_idempotency_key),
    edge_idempotency_key: nullableString(row.edge_idempotency_key),
    content_hash: toBuffer(row.content_hash),
    created_at: Number(row.created_at),
  };
}

function jsonColumn(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : canonicalizeJSON(value);
}

/**
 * The single write boundary for twin_edges. Both former write sites (the
 * alias_of edge inside the alias write and the judgment-command link insert)
 * now resolve their columns into a TwinEdgeInsert and call here, inside the
 * caller's transaction. The row is read back so callers get the stored record.
 */
export function insertTwinEdge(
  adapter: TwinEdgeReadAdapter,
  input: TwinEdgeInsert
): TwinEdgeRecord {
  adapter
    .prepare(
      `
        INSERT INTO twin_edges (
          edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
          relation_attrs_json, confidence, source, agent_id, model_run_id, envelope_hash,
          human_actor_id, human_actor_role, authority_scope_json, reason_classification,
          reason_text, evidence_refs_json, request_idempotency_key, edge_idempotency_key,
          content_hash, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.edge_id,
      input.edge_type,
      input.subject_ref.kind,
      input.subject_ref.id,
      input.object_ref.kind,
      input.object_ref.id,
      jsonColumn(input.relation_attrs),
      input.confidence ?? 1,
      input.source,
      input.agent_id ?? null,
      input.model_run_id ?? null,
      input.envelope_hash ?? null,
      input.human_actor_id ?? null,
      input.human_actor_role ?? null,
      jsonColumn(input.authority_scope_json),
      input.reason_classification ?? null,
      input.reason_text ?? null,
      jsonColumn(input.evidence_refs),
      input.request_idempotency_key ?? null,
      input.edge_idempotency_key ?? null,
      input.content_hash,
      input.created_at
    );
  const record = getTwinEdge(adapter, input.edge_id);
  if (!record) {
    throw new Error(`Twin edge was not written: ${input.edge_id}`);
  }
  return record;
}

export function getTwinEdge(adapter: TwinEdgeReadAdapter, edgeId: string): TwinEdgeRecord | null {
  const row = adapter.prepare('SELECT * FROM twin_edges WHERE edge_id = ?').get(edgeId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapTwinEdgeRow(row) : null;
}

export function listTwinEdgesForRefs(
  adapter: TwinEdgeReadAdapter,
  refs: readonly TwinRef[],
  page?: {
    /** Newest-first storage scan for a bounded visible page. Omitted keeps the old full scan. */
    newest: true;
    limit: number;
    after?: { createdAt: number; edgeId: string };
    edgeTypes?: readonly TwinEdgeType[];
    startMs?: number | null;
    asOfMs?: number | null;
  }
): TwinEdgeRecord[] {
  const normalizedRefs = refs.map((ref, index) => normalizeRef(ref, `refs[${index}]`));
  if (normalizedRefs.length === 0) {
    return [];
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const ref of normalizedRefs) {
    clauses.push('(subject_kind = ? AND subject_id = ?)');
    params.push(ref.kind, ref.id);
    clauses.push('(object_kind = ? AND object_id = ?)');
    params.push(ref.kind, ref.id);
  }
  const where = [`(${clauses.join(' OR ')})`];
  if (page?.edgeTypes?.length) {
    where.push(`edge_type IN (${page.edgeTypes.map(() => '?').join(', ')})`);
    params.push(...page.edgeTypes);
  }
  if (typeof page?.startMs === 'number') {
    where.push('created_at >= ?');
    params.push(page.startMs);
  }
  if (typeof page?.asOfMs === 'number') {
    where.push('created_at <= ?');
    params.push(page.asOfMs);
  }
  if (page?.after) {
    where.push('(created_at < ? OR (created_at = ? AND edge_id > ?))');
    params.push(page.after.createdAt, page.after.createdAt, page.after.edgeId);
  }
  if (page && (!Number.isSafeInteger(page.limit) || page.limit < 1)) {
    throw new Error('Twin edge scan limit must be a positive safe integer');
  }
  const rows = adapter
    .prepare(
      `
        SELECT *
        FROM twin_edges
        WHERE ${where.join(' AND ')}
        ORDER BY created_at ${page ? 'DESC' : 'ASC'}, edge_id ASC
        ${page ? 'LIMIT ?' : ''}
      `
    )
    .all(...params, ...(page ? [page.limit] : [])) as Array<Record<string, unknown>>;
  return rows.map(mapTwinEdgeRow);
}
