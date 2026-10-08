import { erasedReference, type ErasedRecord } from '../identity/erased-record.js';
/**
 * Reading owner work back out of the commitment log.
 *
 * `appendJudgment` has written `commitments` and `commitment_assignments` since
 * migration 075: a commitment row carries identity, the current revision and the
 * head record, and one assignment row per revision carries the patch that
 * revision applied. Nothing read them back. The only SELECT against either table
 * was the writer's own CAS check, so the substrate could be written and never
 * answered from - the shape this refactor exists to close.
 *
 * Current values are a fold, not a column. Each assignment states `set` and
 * `clear` for that revision only, and the view is those applied in revision
 * order. That is what keeps a correction from erasing what it corrected: the
 * revision that changed a title is still readable next to the one that set it,
 * and `history: 'all'` returns them.
 *
 * @module knowledge/commitments
 */

import type { DatabaseAdapter } from '../db-manager.js';
import type { JudgmentAccess, JudgmentKnowledgeOptions } from './judgments.js';
import { JudgmentError, readableScopeIds, referenceExists, appendJudgment } from './judgments.js';
import { isCommitmentRevisionReadable } from './access.js';
import type {
  JudgmentEventMeta,
  JudgmentReceipt,
  OwnerWorkPatch,
  RecordLink,
  WorkReference,
} from '../memory/judgment-types.js';
import type { MemoryScopeRef } from '../memory/types.js';
import { assertWorkPatchValues } from './work-dates.js';

/** One revision of a commitment, as the assignment row recorded it. */
export interface CommitmentRevision {
  revision: number;
  operation: 'create' | 'revise' | 'withdraw';
  recordRef: WorkReference;
  set: OwnerWorkPatch;
  clear: Array<keyof OwnerWorkPatch>;
  /** Source event time; null means this legacy revision had no event time. */
  eventDatetime: number | null;
  /** When this revision stops applying; null while it holds until a later revision. */
  appliesUntil: number | null;
  createdAt: number;
}

/** The compact lifecycle entry returned for a progress-oriented chain read. */
export interface CommitmentChainEntry {
  revision: number;
  operation: CommitmentRevision['operation'];
  eventDatetime: number | null;
  appliesUntil: number | null;
  /** When the revision was written; the day of a revision with no event time. */
  createdAt: number;
  status: string | null;
  stage: string | null;
  summary: string | null;
}

export interface CommitmentView {
  erasedCitations?: ErasedRecord[];
  commitmentId: string;
  rowId: number;
  revision: number;
  latestJudgmentRef: WorkReference;
  /** The fold of every assignment up to `revision`. */
  values: OwnerWorkPatch;
  withdrawn: boolean;
  /** The judgment record each surviving revision was written by, oldest first. */
  basis: WorkReference[];
  createdAt: number;
  updatedAt: number;
  /** Present only when the caller asked for `history: 'all'`. */
  history?: CommitmentRevision[];
  /** Present only when the caller asked for the internal `history: 'chain'`. */
  chain?: CommitmentChainEntry[];
}

export interface CommitmentPage {
  items: CommitmentView[];
  nextCursor: string | null;
  coverage: {
    returned: number;
    total: number | null;
    complete: boolean;
    /**
     * Why the page is not the whole answer. Empty when it is. A caller that
     * cannot tell a complete page from a truncated one will read the first page
     * as the board, which is the failure this field exists to prevent.
     */
    reasons: string[];
  };
}

export interface WorkRead {
  commitmentId?: string;
  rowId?: number;
  /** Only revisions effective at or before this epoch millisecond are folded. */
  asOf?: number;
  history?: 'current' | 'chain' | 'all';
  limit?: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface CommitmentRow {
  row_id: number;
  commitment_id: string;
  current_revision: number;
  head_record_id: string;
  withdrawn: number;
  created_at: number;
  updated_at: number;
}

interface AssignmentRow {
  commitment_id: string;
  revision: number;
  record_id: string;
  operation: 'create' | 'revise' | 'withdraw';
  set_json: string;
  clear_json: string;
  applies_from: number | null;
  applies_until: number | null;
  judgment_event_datetime: number | null;
  created_at: number;
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new JudgmentError('INVALID_COMMAND', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const afterTaskId = Number(value);
  if (!Number.isSafeInteger(afterTaskId) || afterTaskId < 0) {
    throw new JudgmentError('INVALID_COMMAND', 'cursor is not a commitment page cursor');
  }
  return afterTaskId;
}

function parseAsOf(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JudgmentError('INVALID_COMMAND', 'asOf must be an epoch millisecond integer');
  }
  return value;
}

function parsePatch(json: string, field: string): OwnerWorkPatch {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JudgmentError('INVALID_COMMAND', `${field} is not a work patch object`);
  }
  return parsed as OwnerWorkPatch;
}

function parseClear(json: string): Array<keyof OwnerWorkPatch> {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new JudgmentError('INVALID_COMMAND', 'clear_json is not a field list');
  }
  return parsed as Array<keyof OwnerWorkPatch>;
}

function applyRevision(values: Record<string, unknown>, revision: CommitmentRevision): void {
  for (const [field, value] of Object.entries(revision.set)) {
    values[field] = value;
  }
  for (const field of revision.clear) {
    delete values[field as string];
  }
}

/**
 * Fold the assignments into the values they leave behind.
 *
 * `clear` is applied after `set` within one revision: a revision that sets and
 * clears the same field is stating that the field ends the revision absent,
 * which is what the writer's own ordering already means.
 */
function foldAssignments(revisions: readonly CommitmentRevision[]): OwnerWorkPatch {
  const values: Record<string, unknown> = {};
  for (const revision of revisions) {
    applyRevision(values, revision);
  }
  return values as OwnerWorkPatch;
}

function stringField(values: Record<string, unknown>, field: string): string | null {
  const value = values[field];
  return typeof value === 'string' ? value : null;
}

/** A visible commitment admits its revision summaries, including earlier private bindings. */
function readJudgmentSummary(
  adapter: DatabaseAdapter,
  recordId: string,
  admitted: readonly string[]
): string | null {
  if (!isCommitmentRevisionReadable(adapter, recordId, admitted)) return null;
  const row = adapter.prepare('SELECT summary FROM decisions WHERE id = ?').get(recordId) as
    | { summary: unknown }
    | undefined;
  return row && typeof row.summary === 'string' ? row.summary : null;
}

function buildChain(
  adapter: DatabaseAdapter,
  revisions: readonly CommitmentRevision[],
  admitted: readonly string[]
): CommitmentChainEntry[] {
  const values: Record<string, unknown> = {};
  return revisions.map((revision) => {
    applyRevision(values, revision);
    return {
      revision: revision.revision,
      operation: revision.operation,
      eventDatetime: revision.eventDatetime,
      appliesUntil: revision.appliesUntil,
      createdAt: revision.createdAt,
      status: revision.operation === 'withdraw' ? 'cancelled' : stringField(values, 'status'),
      stage: stringField(values, 'stage'),
      summary: readJudgmentSummary(adapter, revision.recordRef.id, admitted),
    };
  });
}

/**
 * Read owner work: one commitment, or a bounded page of them.
 *
 * `asOf` selects revisions by their source event time when recorded, or by the
 * commit clock for judgments without an event time, and folds them in the order
 * they were written: a later write is later knowledge. A backfill committed today
 * can therefore answer what was current at a historical instant. A commitment
 * whose first revision is later than `asOf` is absent, not empty.
 *
 * A revision with `applies_until` stops applying at that instant: it stays in the
 * history but leaves the fold once the read time reaches it. A backfill that
 * appends an earlier period to work already revised later bounds those revisions
 * by the first later one, so the current state stays the later one.
 */
export function readWork(
  adapter: DatabaseAdapter,
  query: WorkRead,
  access: JudgmentAccess
): CommitmentPage {
  const admitted = readableScopeIds(access);
  const limit = parseLimit(query.limit);
  const afterTaskId = parseCursor(query.cursor);
  const asOf = parseAsOf(query.asOf);
  const wantsHistory = query.history === 'all';
  const wantsChain = query.history === 'chain';
  if (
    query.history !== undefined &&
    query.history !== 'all' &&
    query.history !== 'current' &&
    query.history !== 'chain'
  ) {
    throw new JudgmentError('INVALID_COMMAND', "history must be 'current', 'chain', or 'all'");
  }
  if (query.commitmentId !== undefined && query.rowId !== undefined) {
    throw new JudgmentError('INVALID_COMMAND', 'Ask by commitmentId or rowId, not both');
  }

  const reasons: string[] = [];
  let rows: CommitmentRow[];
  let total: number | null = null;
  // Visibility follows the current head; unbound heads remain readable by everyone.
  // Apply it before LIMIT so hidden rows neither shorten pages nor enter totals.
  const visible = `(NOT EXISTS (
    SELECT 1 FROM memory_scope_bindings b WHERE b.memory_id = commitments.head_record_id
  )${
    admitted.length === 0
      ? ''
      : ` OR EXISTS (
    SELECT 1 FROM memory_scope_bindings b WHERE b.memory_id = commitments.head_record_id
      AND b.scope_id IN (${admitted.map(() => '?').join(', ')})
  )`
  })`;

  if (query.commitmentId !== undefined) {
    rows = adapter
      .prepare(`SELECT * FROM commitments WHERE commitment_id = ? AND ${visible}`)
      .all(query.commitmentId, ...admitted) as CommitmentRow[];
  } else if (query.rowId !== undefined) {
    rows = adapter
      .prepare(`SELECT * FROM commitments WHERE row_id = ? AND ${visible}`)
      .all(query.rowId, ...admitted) as CommitmentRow[];
  } else {
    // One extra row decides whether another page exists without a second count.
    rows = adapter
      .prepare(
        `SELECT * FROM commitments WHERE row_id > ? AND ${visible} ORDER BY row_id ASC LIMIT ?`
      )
      .all(afterTaskId, ...admitted, limit + 1) as CommitmentRow[];
    total = (
      adapter
        .prepare(`SELECT COUNT(*) AS n FROM commitments WHERE ${visible}`)
        .get(...admitted) as { n: number }
    ).n;
  }

  const hasMore =
    query.commitmentId === undefined && query.rowId === undefined ? rows.length > limit : false;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: CommitmentView[] = [];
  // Bounded revisions leave the fold once the read time reaches their bound.
  const readTime = asOf ?? Date.now();
  for (const row of pageRows) {
    const assignments = adapter
      .prepare(
        asOf === null
          ? `SELECT assignment.*, judgment.event_datetime AS judgment_event_datetime
             FROM commitment_assignments assignment
             JOIN decisions judgment ON judgment.id = assignment.record_id
             WHERE assignment.commitment_id = ? ORDER BY assignment.revision ASC`
          : `SELECT assignment.*, judgment.event_datetime AS judgment_event_datetime FROM commitment_assignments assignment
              JOIN decisions judgment ON judgment.id = assignment.record_id
              WHERE assignment.commitment_id = ?
                AND COALESCE(assignment.applies_from, judgment.event_datetime, assignment.created_at) <= ?
              ORDER BY assignment.revision ASC`
      )
      .all(...(asOf === null ? [row.commitment_id] : [row.commitment_id, asOf])) as AssignmentRow[];
    if (assignments.length === 0) {
      // Bounded away entirely: the commitment had not been created at `asOf`.
      continue;
    }
    const revisions: CommitmentRevision[] = assignments.map((assignment) => ({
      revision: assignment.revision,
      operation: assignment.operation,
      recordRef: { kind: 'memory', id: assignment.record_id },
      set: parsePatch(assignment.set_json, 'set_json'),
      clear: parseClear(assignment.clear_json),
      eventDatetime: assignment.applies_from ?? assignment.judgment_event_datetime ?? null,
      appliesUntil: assignment.applies_until,
      createdAt: assignment.created_at,
    }));
    const applying = revisions.filter(
      (revision) => revision.appliesUntil === null || revision.appliesUntil > readTime
    );
    // The revision a writer names next is the last one written, applying or not.
    const head = revisions[revisions.length - 1];
    const lastApplying = applying[applying.length - 1] ?? head;
    const erasedCitations = new Map<string, ErasedRecord>();
    for (const revision of revisions) {
      const references: WorkReference[] = [revision.recordRef];
      const links = adapter
        .prepare(
          `SELECT object_kind AS kind, object_id AS id FROM twin_edges
        WHERE subject_kind='memory' AND subject_id=? ORDER BY edge_id`
        )
        .all(revision.recordRef.id) as WorkReference[];
      references.push(...links);
      for (const ref of references) {
        if (!referenceExists(adapter, ref, admitted)) continue;
        const erased = erasedReference(adapter, ref);
        if (erased) erasedCitations.set(erased.id, erased);
      }
    }
    items.push({
      ...(erasedCitations.size > 0 ? { erasedCitations: [...erasedCitations.values()] } : {}),
      commitmentId: row.commitment_id,
      rowId: row.row_id,
      revision: head.revision,
      latestJudgmentRef: head.recordRef,
      values: foldAssignments(applying),
      withdrawn: applying.some((revision) => revision.operation === 'withdraw'),
      basis: applying.map((revision) => revision.recordRef),
      createdAt: row.created_at,
      updatedAt:
        asOf === null ? row.updated_at : (lastApplying.eventDatetime ?? lastApplying.createdAt),
      ...(wantsHistory ? { history: revisions } : {}),
      ...(wantsChain ? { chain: buildChain(adapter, revisions, admitted) } : {}),
    });
  }

  if (hasMore) {
    reasons.push('more commitments follow this page');
  }

  return {
    items,
    nextCursor: hasMore ? String(pageRows[pageRows.length - 1].row_id) : null,
    coverage: {
      returned: items.length,
      total,
      complete: !hasMore,
      reasons,
    },
  };
}

/**
 * What the caller states when it commits owner work.
 *
 * `commandId` is the caller's idempotency key and `summary` is what the record
 * says; both are required because a commitment is a judgment first. Everything
 * else about the work lives in the patch, which is the only vocabulary this
 * module knows - no product's task shape reaches here.
 */
export interface WorkCommand {
  commandId: string;
  /** Native run that authored this work, when it was written during a model turn. */
  modelRunId?: string | null;
  /** What the caller is committing to, in its own words. */
  summary: string;
  reasoning?: string;
  /** Omitted on create: access defaults; omitted on revision: the item's current bindings. */
  scopes?: MemoryScopeRef[];
  /** Carried onto the record so a commitment names what caused it. */
  sourceRefs?: string[];
  /**
   * Relations this command records as edges in the same transaction as the
   * work. A commitment is a judgment first: a revision that only states how
   * this work relates to other records is still a revision.
   */
  links?: RecordLink[];
  eventDatetime?: number | null;
  /**
   * When this revision stops applying. A backfill that appends an earlier period
   * to work already revised later sets it to the first later revision's event
   * time, so the later state stays current. It must follow `eventDatetime`.
   */
  appliesUntil?: number;
  /**
   * When this command happened, if the caller keeps its own clock. It stamps
   * the record and the commitment row alike, so a board that filters on
   * `updatedAt` reads the time the caller states rather than the wall clock.
   */
  recordedAt?: number;
  /**
   * Provenance carried onto the record's memory_events row. An importer names
   * itself here so an imported row's history says who wrote it - not the agent
   * that merely ran the migration.
   */
  event?: JudgmentEventMeta;
}

export interface CreateWorkCommand extends WorkCommand {
  /** What this new commitment is about; becomes the record topic. */
  topic: string;
  set: OwnerWorkPatch;
  /**
   * Import vocabulary: the identity this work already had in a predecessor
   * store. A migration that brings existing owner rows into the commitment log
   * names their task id and revision so the log keeps the row's number and CAS
   * history instead of minting a new identity. Absent for work first stated
   * through this command log.
   */
  imported?: { rowId: number; revision?: number; createdAt?: number };
}

export interface ReviseWorkCommand extends WorkCommand {
  commitmentId: string;
  /** The revision record's topic; the work item's topic when omitted. */
  topic?: string;
  expectedRevision?: number;
  set?: OwnerWorkPatch;
  clear?: Array<keyof OwnerWorkPatch>;
}

export interface WithdrawWorkCommand extends WorkCommand {
  commitmentId: string;
  /** The withdrawal record's topic; the work item's topic when omitted. */
  topic?: string;
  expectedRevision: number;
}

export interface WorkWriteResult {
  commitmentId: string;
  revision: number;
  recordRef: WorkReference;
  receipt: JudgmentReceipt;
}

/**
 * The record half of a work command, with absent fields omitted rather than set
 * to `undefined`.
 *
 * The command payload is canonicalized and hashed into `command_bindings`, and
 * the canonicalizer rejects an explicit `undefined` - correctly, since a key
 * present with no value and a key absent are different payloads and must not
 * hash alike.
 */
function recordFields(command: WorkCommand & { topic: string }): {
  commandId: string;
  modelRunId?: string | null;
  topic: string;
  summary: string;
  recordKind: 'commitment';
  reasoning?: string;
  scopes?: MemoryScopeRef[];
  sourceRefs?: string[];
  links?: RecordLink[];
  eventDatetime?: number | null;
  appliesUntil?: number;
  recordedAt?: number;
  event?: JudgmentEventMeta;
} {
  if (command.appliesUntil !== undefined) {
    // A bound before the revision's own event time would never apply; without an event time the
    // revision would fall back to the commit clock, which a backfill bound always precedes.
    if (
      typeof command.eventDatetime !== 'number' ||
      command.eventDatetime >= command.appliesUntil
    ) {
      throw new JudgmentError(
        'INVALID_TIME',
        'appliesUntil must follow the revision eventDatetime'
      );
    }
  }
  return {
    commandId: command.commandId,
    ...(command.modelRunId === undefined ? {} : { modelRunId: command.modelRunId }),
    topic: command.topic,
    summary: command.summary,
    recordKind: 'commitment',
    ...(command.reasoning === undefined ? {} : { reasoning: command.reasoning }),
    ...(command.scopes === undefined ? {} : { scopes: command.scopes }),
    ...(command.sourceRefs === undefined ? {} : { sourceRefs: command.sourceRefs }),
    ...(command.links === undefined ? {} : { links: command.links }),
    ...(command.eventDatetime === undefined ? {} : { eventDatetime: command.eventDatetime }),
    ...(command.appliesUntil === undefined ? {} : { appliesUntil: command.appliesUntil }),
    ...(command.recordedAt === undefined ? {} : { recordedAt: command.recordedAt }),
    ...(command.event === undefined ? {} : { event: command.event }),
  };
}

function requireWorkReceipt(receipt: JudgmentReceipt): WorkWriteResult {
  if (!receipt.work) {
    // appendJudgment writes the commitment inside the same transaction as the
    // record, so a receipt without one means the command was not a commitment.
    throw new JudgmentError('INVALID_COMMAND', 'The judgment carried no commitment receipt');
  }
  return {
    commitmentId: receipt.work.commitmentId,
    revision: receipt.work.revision,
    recordRef: { kind: 'memory', id: receipt.recordId },
    receipt,
  };
}

/**
 * Commit new owner work.
 *
 * The work and the record that states it commit together: `appendJudgment` owns
 * the transaction, and this is the vocabulary in front of it. A caller that
 * wrote a task row here and a record there is the split this replaces.
 */
export async function createWork(
  command: CreateWorkCommand,
  access: JudgmentAccess,
  options: JudgmentKnowledgeOptions
): Promise<WorkWriteResult> {
  assertWorkPatchValues(command.set);
  const receipt = await appendJudgment(
    {
      ...recordFields(command),
      work: {
        operation: 'create',
        set: command.set,
        ...(command.imported === undefined ? {} : { imported: command.imported }),
      },
    },
    access,
    options
  );
  return requireWorkReceipt(receipt);
}

/**
 * Revise owner work at an expected revision.
 *
 * The revision is the caller's claim about what it read. A concurrent write
 * moves it and this fails loudly rather than overwriting what the caller never
 * saw - the same compare-and-set the ledger it replaces performed.
 */
export async function reviseWork(
  command: ReviseWorkCommand,
  access: JudgmentAccess,
  options: JudgmentKnowledgeOptions
): Promise<WorkWriteResult> {
  const statesNothing =
    command.set === undefined &&
    (command.clear === undefined || command.clear.length === 0) &&
    (command.links === undefined || command.links.length === 0);
  if (statesNothing) {
    throw new JudgmentError(
      'INVALID_COMMAND',
      'A revision must set, clear, or link at least one field'
    );
  }
  if (command.set !== undefined) {
    assertWorkPatchValues(command.set);
  }
  // A revision is the caller's claim about what it read; a commitment it cannot
  // see is one it cannot name. The read gate answers 'unavailable' rather than
  // 'denied' so an outside-scope id probes the same silence as a wrong one.
  if (
    readWork(options.adapter, { commitmentId: command.commitmentId }, access).items.length === 0
  ) {
    throw new JudgmentError(
      'REFERENCE_NOT_FOUND',
      `Commitment is unavailable: ${command.commitmentId}`
    );
  }
  const topic = command.topic ?? workTopic(options.adapter, command.commitmentId);
  const receipt = await appendJudgment(
    {
      ...recordFields({ ...command, topic }),
      work: {
        operation: 'revise',
        commitmentId: command.commitmentId,
        ...(command.expectedRevision === undefined
          ? {}
          : { expectedRevision: command.expectedRevision }),
        ...(command.set === undefined ? {} : { set: command.set }),
        ...(command.clear === undefined ? {} : { clear: command.clear }),
      },
    },
    access,
    options
  );
  return requireWorkReceipt(receipt);
}

/**
 * Withdraw owner work.
 *
 * Withdrawal is a revision like any other: the values stay readable and the
 * commitment is marked. Nothing is deleted, so a withdrawn commitment can still
 * answer what it held and who withdrew it.
 */
export async function withdrawWork(
  command: WithdrawWorkCommand,
  access: JudgmentAccess,
  options: JudgmentKnowledgeOptions
): Promise<WorkWriteResult> {
  // Same gate as a revision: withdrawal is a claim about what the caller read.
  if (
    readWork(options.adapter, { commitmentId: command.commitmentId }, access).items.length === 0
  ) {
    throw new JudgmentError(
      'REFERENCE_NOT_FOUND',
      `Commitment is unavailable: ${command.commitmentId}`
    );
  }
  const topic = command.topic ?? workTopic(options.adapter, command.commitmentId);
  const receipt = await appendJudgment(
    {
      ...recordFields({ ...command, topic }),
      work: {
        operation: 'withdraw',
        commitmentId: command.commitmentId,
        expectedRevision: command.expectedRevision,
      },
    },
    access,
    options
  );
  return requireWorkReceipt(receipt);
}

function workTopic(adapter: DatabaseAdapter, commitmentId: string): string {
  const row = adapter
    .prepare(
      `SELECT decision.topic
       FROM commitment_assignments AS assignment
       JOIN decisions AS decision ON decision.id = assignment.record_id
       WHERE assignment.commitment_id = ? AND assignment.operation = 'create'
       ORDER BY assignment.revision
       LIMIT 1`
    )
    .get(commitmentId) as { topic: string } | undefined;
  if (!row) {
    throw new JudgmentError('REFERENCE_NOT_FOUND', `Commitment is unavailable: ${commitmentId}`);
  }
  return row.topic;
}
