import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import { recordNoUpdate, serializeRequiredSourceRefs } from './no-update-ledger.js';
import type {
  OperatorCommitStatus,
  OperatorCursorCommitInput,
  OperatorCursorCommitResult,
} from './operator-commit-result.js';
import { nonNegativeInteger, requiredString } from './validation.js';

interface CursorRow {
  cursor_name: string;
  last_change_seq: number;
  last_idempotency_key: string | null;
}

interface CommitRow {
  commit_id: string;
  cursor_name: string;
  idempotency_key: string;
  first_change_seq: number;
  last_change_seq: number;
  status: OperatorCommitStatus;
  changed_refs_json: string;
  source_refs_json: string;
}

interface NoUpdateRow {
  no_update_id: string;
  scope_key: string;
  reason: string;
  source_refs_json: string;
}

interface NormalizedNoUpdateCommit {
  noUpdateId: string;
  scopeKey: string;
  reason: string;
}

export interface ExistingOperatorCursorCommitInput {
  cursorName: string;
  idempotencyKey: string;
  sourceRefs: readonly SourceRef[];
  nowMs?: number;
}

function assertOperatorCommitStatus(status: unknown): asserts status is OperatorCommitStatus {
  if (status !== 'changed' && status !== 'no_update') {
    throw new Error('Operator commit status must be changed or no_update');
  }
}

export function buildConnectorIdempotencyKey(
  sourceConnector: string,
  firstChangeSeq: number,
  lastChangeSeq: number
): string {
  const connector = requiredString(sourceConnector, 'sourceConnector');
  const first = nonNegativeInteger(firstChangeSeq, 'firstChangeSeq');
  const last = nonNegativeInteger(lastChangeSeq, 'lastChangeSeq');
  if (last < first) {
    throw new Error('lastChangeSeq must be greater than or equal to firstChangeSeq');
  }
  return `connector:${connector}:seq:${first}-${last}`;
}

function ensureCursor(db: SQLiteDatabase, cursorName: string, nowMs: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO vnext_operator_cursors (
      cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
    ) VALUES (?, ?, ?, ?)`
  ).run(cursorName, 0, null, nowMs);
}

function getCursor(db: SQLiteDatabase, cursorName: string): CursorRow {
  const row = db
    .prepare(
      `SELECT cursor_name, last_change_seq, last_idempotency_key
       FROM vnext_operator_cursors
       WHERE cursor_name = ?`
    )
    .get(cursorName) as CursorRow | undefined;
  if (!row) {
    throw new Error(`Operator cursor not found: ${cursorName}`);
  }
  return row;
}

function getExistingCommit(db: SQLiteDatabase, idempotencyKey: string): CommitRow | null {
  return (
    (db
      .prepare(
        `SELECT
          commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
          status, changed_refs_json, source_refs_json
         FROM vnext_operator_commits
         WHERE idempotency_key = ?`
      )
      .get(idempotencyKey) as CommitRow | undefined) ?? null
  );
}

function getExistingNoUpdate(db: SQLiteDatabase, idempotencyKey: string): NoUpdateRow | null {
  return (
    (db
      .prepare(
        `SELECT no_update_id, scope_key, reason, source_refs_json
         FROM operator_no_updates
         WHERE idempotency_key = ?`
      )
      .get(idempotencyKey) as NoUpdateRow | undefined) ?? null
  );
}

function assertContiguous(cursor: CursorRow, firstChangeSeq: number): void {
  const expected = cursor.last_change_seq + 1;
  if (firstChangeSeq !== expected) {
    throw new Error(
      `Operator commit must be contiguous: expected first_change_seq ${expected}, got ${firstChangeSeq}`
    );
  }
}

function updateCursor(
  db: SQLiteDatabase,
  cursorName: string,
  lastChangeSeq: number,
  idempotencyKey: string,
  nowMs: number
): void {
  db.prepare(
    `UPDATE vnext_operator_cursors
     SET last_change_seq = ?, last_idempotency_key = ?, updated_at_ms = ?
     WHERE cursor_name = ?`
  ).run(lastChangeSeq, idempotencyKey, nowMs, cursorName);
}

function resultFromStoredCommit(
  db: SQLiteDatabase,
  cursor: CursorRow,
  existing: CommitRow,
  nowMs: number
): OperatorCursorCommitResult {
  if (existing.status === 'no_update' && !getExistingNoUpdate(db, existing.idempotency_key)) {
    throw new Error('Idempotent no-update replay is missing no-update commit details');
  }
  if (cursor.last_change_seq >= existing.last_change_seq) {
    return {
      outcome: 'already_committed',
      commitId: existing.commit_id,
      cursorName: existing.cursor_name,
      firstChangeSeq: existing.first_change_seq,
      lastChangeSeq: existing.last_change_seq,
      idempotencyKey: existing.idempotency_key,
      status: existing.status,
      cursorAdvanced: false,
    };
  }

  assertContiguous(cursor, existing.first_change_seq);
  updateCursor(db, existing.cursor_name, existing.last_change_seq, existing.idempotency_key, nowMs);
  return {
    outcome: 'recovered',
    commitId: existing.commit_id,
    cursorName: existing.cursor_name,
    firstChangeSeq: existing.first_change_seq,
    lastChangeSeq: existing.last_change_seq,
    idempotencyKey: existing.idempotency_key,
    status: existing.status,
    cursorAdvanced: true,
  };
}

function resultFromExistingCommit(
  db: SQLiteDatabase,
  cursor: CursorRow,
  existing: CommitRow,
  expected: {
    status: OperatorCommitStatus;
    firstChangeSeq: number;
    lastChangeSeq: number;
    changedRefsJson: string;
    sourceRefsJson: string;
    noUpdate?: NormalizedNoUpdateCommit;
  },
  nowMs: number
): OperatorCursorCommitResult {
  if (existing.cursor_name !== cursor.cursor_name) {
    throw new Error(`Idempotency key belongs to a different cursor: ${existing.cursor_name}`);
  }
  if (
    existing.status !== expected.status ||
    existing.first_change_seq !== expected.firstChangeSeq ||
    existing.last_change_seq !== expected.lastChangeSeq ||
    existing.changed_refs_json !== expected.changedRefsJson ||
    existing.source_refs_json !== expected.sourceRefsJson
  ) {
    throw new Error('Idempotency key replay does not match the original operator commit');
  }
  if (existing.status === 'no_update') {
    const existingNoUpdate = getExistingNoUpdate(db, existing.idempotency_key);
    if (!existingNoUpdate || !expected.noUpdate) {
      throw new Error('Idempotent no-update replay is missing no-update commit details');
    }
    if (
      existingNoUpdate.no_update_id !== expected.noUpdate.noUpdateId ||
      existingNoUpdate.scope_key !== expected.noUpdate.scopeKey ||
      existingNoUpdate.reason !== expected.noUpdate.reason ||
      existingNoUpdate.source_refs_json !== expected.sourceRefsJson
    ) {
      throw new Error('Idempotency key replay does not match the original no-update commit');
    }
  }

  return resultFromStoredCommit(db, cursor, existing, nowMs);
}

export function recoverExistingOperatorCursorCommit(
  db: SQLiteDatabase,
  input: ExistingOperatorCursorCommitInput
): OperatorCursorCommitResult | null {
  const nowMs = input.nowMs ?? Date.now();
  const cursorName = requiredString(input.cursorName, 'cursorName');
  const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
  const expectedSourceRefsJson = JSON.stringify(serializeRequiredSourceRefs(input.sourceRefs));

  const tx = db.transaction(() => {
    const existing = getExistingCommit(db, idempotencyKey);
    if (!existing) {
      return null;
    }
    if (existing.cursor_name !== cursorName) {
      throw new Error(`Idempotency key belongs to a different cursor: ${existing.cursor_name}`);
    }
    if (existing.source_refs_json !== expectedSourceRefsJson) {
      throw new Error('Idempotent replay source refs do not match the original operator commit');
    }
    const cursor = getCursor(db, cursorName);
    return resultFromStoredCommit(db, cursor, existing, nowMs);
  });
  return tx();
}

export function commitOperatorCursor(
  db: SQLiteDatabase,
  input: OperatorCursorCommitInput
): OperatorCursorCommitResult {
  const nowMs = input.nowMs ?? Date.now();
  const cursorName = requiredString(input.cursorName, 'cursorName');
  const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
  const firstChangeSeq = nonNegativeInteger(input.firstChangeSeq, 'firstChangeSeq');
  const lastChangeSeq = nonNegativeInteger(input.lastChangeSeq, 'lastChangeSeq');
  assertOperatorCommitStatus(input.status);
  if (lastChangeSeq < firstChangeSeq) {
    throw new Error('lastChangeSeq must be greater than or equal to firstChangeSeq');
  }

  const sourceRefs = serializeRequiredSourceRefs(input.sourceRefs);
  const changedInputRefs = input.status === 'changed' ? input.changedRefs : undefined;
  if (input.status === 'changed' && (!changedInputRefs || changedInputRefs.length === 0)) {
    throw new Error('changedRefs must not be empty for changed commits');
  }
  const changedRefs = changedInputRefs ? serializeRequiredSourceRefs(changedInputRefs) : [];
  if (input.status === 'no_update' && !input.noUpdate) {
    throw new Error('noUpdate details are required for no_update commits');
  }

  const commitId = requiredString(input.commitId ?? `commit:${idempotencyKey}`, 'commitId');
  const noUpdate: NormalizedNoUpdateCommit | undefined =
    input.status === 'no_update' && input.noUpdate
      ? {
          noUpdateId: requiredString(
            input.noUpdate.noUpdateId ?? `no-update:${idempotencyKey}`,
            'noUpdateId'
          ),
          scopeKey: requiredString(input.noUpdate.scopeKey, 'scopeKey'),
          reason: requiredString(input.noUpdate.reason, 'reason'),
        }
      : undefined;
  if (noUpdate && noUpdate.scopeKey !== cursorName) {
    throw new Error(
      `noUpdate scopeKey must match cursorName ${cursorName}; got ${noUpdate.scopeKey}`
    );
  }
  const changedRefsJson = JSON.stringify(changedRefs);
  const sourceRefsJson = JSON.stringify(sourceRefs);

  const tx = db.transaction(() => {
    ensureCursor(db, cursorName, nowMs);
    const cursor = getCursor(db, cursorName);
    const existing = getExistingCommit(db, idempotencyKey);
    if (existing) {
      return resultFromExistingCommit(
        db,
        cursor,
        existing,
        {
          status: input.status,
          firstChangeSeq,
          lastChangeSeq,
          changedRefsJson,
          sourceRefsJson,
          noUpdate,
        },
        nowMs
      );
    }

    assertContiguous(cursor, firstChangeSeq);

    db.prepare(
      `INSERT INTO vnext_operator_commits (
        commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
        status, changed_refs_json, source_refs_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      commitId,
      cursorName,
      idempotencyKey,
      firstChangeSeq,
      lastChangeSeq,
      input.status,
      changedRefsJson,
      sourceRefsJson,
      nowMs
    );

    if (input.status === 'no_update' && noUpdate) {
      recordNoUpdate(db, {
        noUpdateId: noUpdate.noUpdateId,
        scopeKey: noUpdate.scopeKey,
        reason: noUpdate.reason,
        sourceRefs: input.sourceRefs,
        idempotencyKey,
        nowMs,
      });
    }

    updateCursor(db, cursorName, lastChangeSeq, idempotencyKey, nowMs);

    return {
      outcome: 'committed',
      commitId,
      cursorName,
      firstChangeSeq,
      lastChangeSeq,
      idempotencyKey,
      status: input.status,
      cursorAdvanced: true,
    } satisfies OperatorCursorCommitResult;
  });
  return tx();
}
