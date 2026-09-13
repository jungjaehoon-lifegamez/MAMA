import crypto from 'node:crypto';

import { getAdapter, initDB, insertPreparedDecision } from '../db-manager.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { canonicalizeJSON } from '../canonicalize.js';
import { insertMemoryEventInTransaction } from '../memory/event-store.js';
import { writeRecordIdentityInAdapter } from '../registry/record-identity.js';
import type {
  JudgmentAmendment,
  JudgmentCommand,
  JudgmentReceipt,
  OwnerWorkPatch,
  RecordLink,
  WorkReference,
  WorkAssignment,
} from '../memory/judgment-types.js';
import type { MemoryScopeRef } from '../memory/types.js';

export interface JudgmentAccess {
  principalId: string;
  agentId: string;
  scopes: readonly MemoryScopeRef[];
}

export interface JudgmentKnowledgeOptions {
  adapter: DatabaseAdapter;
  embedder?: {
    /** A null result is the explicit no-vector mode (Tier 3); a failure must throw. */
    embed(text: string, role: 'query' | 'passage'): Promise<Float32Array | null>;
  };
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

const SCOPE_KINDS = ['global', 'user', 'channel', 'project'] as const;

function scopeIdFor(scope: MemoryScopeRef): string {
  return `scope_${scope.kind}_${Buffer.from(scope.id).toString('base64url')}`;
}

function scopeKey(scope: MemoryScopeRef): string {
  return `${scope.kind}\0${scope.id}`;
}

/** Scopes the caller was admitted to; bounds what the command may reference.
 * Exported for the sibling source-ingest command path; not part of the public API. */
export function admittedScopeIds(access: JudgmentAccess): string[] {
  const seen = new Set<string>();
  return access.scopes.map((scope) => {
    if (!SCOPE_KINDS.includes(scope.kind as (typeof SCOPE_KINDS)[number])) {
      throw new JudgmentError('INVALID_SCOPE', 'scope kind is invalid');
    }
    requireText(scope.id, 'scope id');
    const key = scopeKey(scope);
    if (seen.has(key)) {
      throw new JudgmentError('INVALID_SCOPE', 'Access scopes must be unique');
    }
    seen.add(key);
    return scopeIdFor(scope);
  });
}

/**
 * Scopes bound to the new record. An explicit `scopes: []` declares an
 * unscoped record (legacy parity); an omitted field inherits the access scope.
 * Exported for the sibling source-ingest command path; not part of the public API.
 */
export function boundScopeIdsFor(
  access: JudgmentAccess,
  command: { scopes?: MemoryScopeRef[] }
): string[] {
  const scopes = command.scopes ?? access.scopes;
  if (command.scopes === undefined && scopes.length === 0) {
    throw new JudgmentError('INVALID_SCOPE', 'At least one judgment scope is required');
  }
  const admitted = new Set(access.scopes.map(scopeKey));
  const seen = new Set<string>();
  return scopes.map((scope) => {
    if (!SCOPE_KINDS.includes(scope.kind as (typeof SCOPE_KINDS)[number])) {
      throw new JudgmentError('INVALID_SCOPE', 'scope kind is invalid');
    }
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
  for (const edge of command.projections?.decisionEdges ?? []) {
    if (edge.fromId !== undefined) {
      requireText(edge.fromId, 'projection edge source');
    }
    requireText(edge.targetId, 'projection edge target');
    requireText(edge.relationship, 'projection edge relationship');
  }
  for (const entitySourceId of command.projections?.entitySources ?? []) {
    requireText(entitySourceId, 'projection entity source id');
  }
  if (command.projections?.timelineEvent) {
    const event = command.projections.timelineEvent;
    requireText(event.id, 'timeline event id');
    requireText(event.entityId, 'timeline event entity id');
    requireText(event.eventType, 'timeline event type');
    requireText(event.summary, 'timeline event summary');
  }
}

function referenceExists(
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
    return (
      adapter.prepare('SELECT 1 FROM twin_edges WHERE edge_id = ?').get(reference.id) !== undefined
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
      throw new JudgmentError('REFERENCE_NOT_FOUND', 'A judgment reference is unavailable');
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
  effectiveScopes: readonly MemoryScopeRef[],
  now: number
): void {
  const projections = command.projections;
  if (!projections) return;
  for (const entityObservationId of projections.entitySources ?? []) {
    adapter
      .prepare(
        `INSERT OR IGNORE INTO decision_entity_sources
         (decision_id, entity_observation_id, relation_type, created_at)
         VALUES (?, ?, 'support', ?)`
      )
      .run(recordId, entityObservationId, now);
  }
  if (projections.timelineEvent) {
    const event = projections.timelineEvent;
    adapter
      .prepare(
        `INSERT INTO entity_timeline_events
         (id, entity_id, event_type, role, valid_from, valid_to, observed_at,
          source_ref, summary, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.entityId,
        event.eventType,
        event.role ?? null,
        event.validFrom ?? null,
        event.validTo ?? null,
        event.observedAt ?? null,
        event.sourceRef ?? null,
        event.summary,
        event.details ?? null,
        now
      );
  }
  if (projections.recordIdentity) {
    writeRecordIdentityInAdapter(adapter, {
      recordId,
      itemId: projections.recordIdentity.itemId,
      actors: projections.recordIdentity.actors ?? [],
      scopes: effectiveScopes,
    });
  }
  for (const targetId of projections.supersedeTargets ?? []) {
    adapter
      .prepare(
        "UPDATE decisions SET superseded_by = ?, status = 'superseded', updated_at = ? WHERE id = ?"
      )
      .run(recordId, now, targetId);
  }
  const edgeInsert = adapter.prepare(
    `INSERT INTO decision_edges
     (from_id, to_id, relationship, reason, weight, created_at, created_by, approved_by_user)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const edge of projections.decisionEdges ?? []) {
    edgeInsert.run(
      edge.fromId ?? recordId,
      edge.targetId,
      edge.relationship,
      edge.reason ?? null,
      edge.weight ?? 1,
      now,
      edge.createdBy ?? 'user',
      edge.approvedByUser ?? 1
    );
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
      'SELECT principal_id, action, payload_hash, receipt_key FROM command_bindings WHERE command_id = ?'
    )
    .get(command.commandId) as
    | { principal_id: string; action: string; payload_hash: string; receipt_key: string }
    | undefined;
  if (!binding) return null;
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

function edgeId(commandId: string, index: number, relation: string, target: WorkReference): string {
  return `edge_${crypto
    .createHash('sha256')
    .update(canonicalizeJSON({ commandId, index, relation, target }))
    .digest('hex')
    .slice(0, 24)}`;
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
  const id = edgeId(command.commandId, index, link.relation, link.target);
  const attrs = link.attrs ?? {};
  const contentHash = crypto
    .createHash('sha256')
    .update(canonicalizeJSON({ id, recordId, link }))
    .digest();
  adapter
    .prepare(
      `INSERT INTO twin_edges (
         edge_id, edge_type, subject_kind, subject_id, object_kind, object_id,
         relation_attrs_json, confidence, source, agent_id, evidence_refs_json,
         content_hash, created_at
       ) VALUES (?, ?, 'memory', ?, ?, ?, ?, 1.0, 'agent', ?, ?, ?, ?)`
    )
    .run(
      id,
      link.relation,
      recordId,
      link.target.kind,
      link.target.id,
      canonicalizeJSON(attrs),
      access.agentId,
      command.replaces?.length ? canonicalizeJSON(command.replaces) : null,
      contentHash,
      now
    );
  return id;
}

function workPatch(value: WorkAssignment | undefined): OwnerWorkPatch {
  return value?.set ?? {};
}

async function appendJudgmentOnAdapter(
  adapter: DatabaseAdapter,
  command: JudgmentCommand,
  access: JudgmentAccess,
  embedder?: JudgmentKnowledgeOptions['embedder']
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
  const boundScopeIdList = boundScopeIdsFor(access, command);
  const effectiveScopes = command.scopes ?? [...access.scopes];
  const effectiveCommand = command.scopes ? command : { ...command, scopes: [...access.scopes] };
  const hash = commandHash(effectiveCommand);
  const replay = assertReplay(adapter, command, access, hash);
  if (replay) {
    validateLinks(adapter, command.links ?? [], admittedScopeIdList);
    for (const replacement of command.replaces ?? []) {
      if (!referenceExists(adapter, { kind: 'memory', id: replacement.id }, admittedScopeIdList)) {
        throw new JudgmentError('REFERENCE_NOT_FOUND', 'A replacement target is unavailable');
      }
    }
    validateAmends(adapter, command.amends ?? [], admittedScopeIdList);
    return replay;
  }
  validateLinks(adapter, command.links ?? [], admittedScopeIdList);
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
        canonicalizeJSON(command.payload ?? {}),
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
      adapter
        .prepare('INSERT OR IGNORE INTO memory_scopes (id, kind, external_id) VALUES (?, ?, ?)')
        .run(scopeId, scope.kind, scope.id);
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
          { relation: 'supersedes', target: { kind: 'memory', id: replacement.id } },
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
    applyProjections(adapter, command, recordId, effectiveScopes, domainNow);
    if (command.recordKind === 'commitment' && command.work) {
      const work = command.work;
      if (work.operation === 'create') {
        const commitmentId = commitmentIdForCommand(command);
        adapter
          .prepare(
            `INSERT INTO commitments
             (commitment_id, current_revision, head_record_id, withdrawn, created_at, updated_at)
             VALUES (?, 1, ?, 0, ?, ?)`
          )
          .run(commitmentId, recordId, now, now);
        adapter
          .prepare(
            `INSERT INTO commitment_assignments
             (commitment_id, revision, record_id, operation, set_json, clear_json, created_at)
            VALUES (?, 1, ?, 'create', ?, ?, ?)`
          )
          .run(
            commitmentId,
            recordId,
            canonicalizeJSON(workPatch(work)),
            canonicalizeJSON(work.clear ?? []),
            now
          );
        workReceipt = { commitmentId, revision: 1 };
      } else {
        const current = adapter
          .prepare('SELECT current_revision, withdrawn FROM commitments WHERE commitment_id = ?')
          .get(work.commitmentId) as { current_revision: number; withdrawn: number } | undefined;
        if (!current) {
          throw new JudgmentError('REFERENCE_NOT_FOUND', 'Commitment is unavailable');
        }
        if (current.current_revision !== work.expectedRevision) {
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
             (commitment_id, revision, record_id, operation, set_json, clear_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            work.commitmentId,
            revision,
            recordId,
            work.operation,
            canonicalizeJSON(workPatch(work)),
            canonicalizeJSON(work.clear ?? []),
            now
          );
        adapter
          .prepare(
            'UPDATE commitments SET current_revision = ?, head_record_id = ?, withdrawn = ?, updated_at = ? WHERE commitment_id = ?'
          )
          .run(revision, recordId, work.operation === 'withdraw' ? 1 : 0, now, work.commitmentId);
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
  options?: Partial<JudgmentKnowledgeOptions>
): Promise<JudgmentReceipt> {
  if (options?.adapter) {
    return appendJudgmentOnAdapter(options.adapter, command, access, options.embedder);
  }
  await initDB();
  return appendJudgmentOnAdapter(getAdapter(), command, access, options?.embedder);
}

export function createJudgmentWriter(options: JudgmentKnowledgeOptions) {
  return {
    appendJudgment: (command: JudgmentCommand, access: JudgmentAccess) =>
      appendJudgmentOnAdapter(options.adapter, command, access, options.embedder),
  };
}
