import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import {
  buildConnectorIdempotencyKey,
  buildCursorScopedIdempotencyKey,
  commitOperatorCursor,
  commitOperatorCursorWithChangedWrite,
  recoverExistingOperatorCursorChangedWrite,
  recoverExistingOperatorCursorCommit,
} from './operator-cursor-commit.js';
import type { OperatorCursorCommitResult } from './operator-commit-result.js';
import { nonNegativeInteger, requiredString } from './validation.js';

export interface PrimaryOperatorEvent {
  seq: number;
  sourceRef: SourceRef;
  payload?: unknown;
}

export type PrimaryOperatorDecision =
  | {
      status: 'changed';
      changedRefs: readonly SourceRef[];
    }
  | {
      status: 'no_update';
      reason: string;
      scopeKey?: string;
    };

export type PrimaryOperatorChangedCommitDecision = {
  status: 'changed';
  changedRefs?: readonly SourceRef[];
};

export type PrimaryOperatorTrustedChangedCommitDecision = {
  status: 'changed';
};

type ParsedPrimaryOperatorDecision =
  | PrimaryOperatorChangedCommitDecision
  | {
      status: 'no_update';
      reason: string;
      scopeKey?: string;
    };

interface ParsedPrimaryOperatorCommitContext {
  event: PrimaryOperatorEvent;
  sourceRefs: readonly SourceRef[];
  idempotencyKey: string;
  fallbackIdempotencyKeys: readonly string[];
  seq: number;
  nowMs: number;
  commitChanged?: PrimaryOperatorChangedCommitter;
}

export interface PrimaryOperatorChangedCommitInput {
  event: PrimaryOperatorEvent;
  decision: PrimaryOperatorTrustedChangedCommitDecision;
  sourceRefs: readonly SourceRef[];
  idempotencyKey: string;
  nowMs: number;
}

export type PrimaryOperatorChangedCommitter = (
  input: PrimaryOperatorChangedCommitInput
) => readonly SourceRef[];

export interface PrimaryOperatorRuntimeOptions {
  db: SQLiteDatabase;
  cursorName: string;
  connector: string;
  nowMs?: () => number;
  allowSeqGaps?: boolean;
}

export type PrimaryOperatorBatchResult =
  | {
      status: 'idle';
      processed: 0;
      advancedThroughSeq: number;
      commits: OperatorCursorCommitResult[];
    }
  | {
      status: 'committed';
      processed: number;
      advancedThroughSeq: number;
      commits: OperatorCursorCommitResult[];
    }
  | {
      status: 'partial_failure';
      processed: number;
      advancedThroughSeq: number;
      failedSeq: number;
      error: Error;
      commits: OperatorCursorCommitResult[];
    };

const cursorLocks = new Map<string, Promise<void>>();

async function withCursorLock<T>(cursorName: string, operation: () => Promise<T>): Promise<T> {
  const previous = cursorLocks.get(cursorName) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  cursorLocks.set(cursorName, chained);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (cursorLocks.get(cursorName) === chained) {
      cursorLocks.delete(cursorName);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseDecision(
  value: unknown,
  options: { requireChangedRefs: boolean }
): ParsedPrimaryOperatorDecision {
  if (!isRecord(value)) {
    throw new Error('Primary operator decision must be an object');
  }
  if (value.status === 'changed') {
    if (value.changedRefs === undefined) {
      if (options.requireChangedRefs) {
        throw new Error('Changed primary operator decisions require changedRefs');
      }
      return {
        status: 'changed',
      };
    }
    if (!Array.isArray(value.changedRefs)) {
      throw new Error('Changed primary operator decision changedRefs must be an array');
    }
    return {
      status: 'changed',
      changedRefs: value.changedRefs as SourceRef[],
    };
  }
  if (value.status === 'no_update') {
    if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
      throw new Error('No-update primary operator decisions require reason');
    }
    return {
      status: 'no_update',
      reason: value.reason,
      scopeKey:
        value.scopeKey === undefined ? undefined : requiredString(value.scopeKey, 'scopeKey'),
    };
  }
  throw new Error('Primary operator decision must be changed or no_update');
}

function assertRawEventSourceBoundToConnector(sourceRef: SourceRef, connector: string): void {
  if (sourceRef.kind !== 'raw') {
    throw new Error('Primary operator events require a raw source ref');
  }
  if (sourceRef.connector !== connector) {
    throw new Error(
      `Primary operator event source connector mismatch: expected ${connector}, got ${sourceRef.connector}`
    );
  }
}

function readCursorSeq(db: SQLiteDatabase, cursorName: string): number {
  const row = db
    .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
    .get(cursorName) as { last_change_seq: number } | undefined;
  return row?.last_change_seq ?? 0;
}

function assertEventAdvancesCursor(
  seq: number,
  advancedThroughSeq: number,
  allowSeqGaps: boolean
): void {
  if (allowSeqGaps) {
    if (seq <= advancedThroughSeq) {
      throw new Error(
        `Operator events must advance cursor; current seq ${advancedThroughSeq}, got ${seq}`
      );
    }
    return;
  }
  if (seq !== advancedThroughSeq + 1) {
    throw new Error(
      `Operator events must be contiguous; expected seq ${advancedThroughSeq + 1}, got ${seq}`
    );
  }
}

export class PrimaryOperatorRuntime {
  private readonly db: SQLiteDatabase;
  private readonly cursorName: string;
  private readonly connector: string;
  private readonly nowMs: () => number;
  private readonly allowSeqGaps: boolean;

  constructor(options: PrimaryOperatorRuntimeOptions) {
    this.db = options.db;
    this.cursorName = options.cursorName.trim();
    this.connector = options.connector.trim();
    this.nowMs = options.nowMs ?? Date.now;
    this.allowSeqGaps = options.allowSeqGaps === true;
    if (this.cursorName.length === 0) {
      throw new Error('cursorName must not be empty');
    }
    if (this.connector.length === 0) {
      throw new Error('connector must not be empty');
    }
  }

  async processBatch(
    events: readonly PrimaryOperatorEvent[],
    decide: (event: PrimaryOperatorEvent) => Promise<unknown> | unknown
  ): Promise<PrimaryOperatorBatchResult> {
    return withCursorLock(this.cursorName, () => this.processBatchLocked(events, decide));
  }

  async processBatchWithChangedCommit(
    events: readonly PrimaryOperatorEvent[],
    decide: (event: PrimaryOperatorEvent) => Promise<unknown> | unknown,
    commitChanged: PrimaryOperatorChangedCommitter
  ): Promise<PrimaryOperatorBatchResult> {
    return withCursorLock(this.cursorName, () =>
      this.processBatchLocked(events, decide, commitChanged)
    );
  }

  async processBatchWithChangedCommitAfterValidation(
    buildEvents: () => Promise<readonly PrimaryOperatorEvent[]> | readonly PrimaryOperatorEvent[],
    decide: (event: PrimaryOperatorEvent) => Promise<unknown> | unknown,
    commitChanged: PrimaryOperatorChangedCommitter
  ): Promise<PrimaryOperatorBatchResult> {
    return withCursorLock(this.cursorName, async () => {
      const events = await buildEvents();
      return this.processBatchLocked(events, decide, commitChanged);
    });
  }

  async processBatchAfterValidation(
    buildEvents: () => Promise<readonly PrimaryOperatorEvent[]> | readonly PrimaryOperatorEvent[],
    decide: (event: PrimaryOperatorEvent) => Promise<unknown> | unknown
  ): Promise<PrimaryOperatorBatchResult> {
    return withCursorLock(this.cursorName, async () => {
      const events = await buildEvents();
      return this.processBatchLocked(events, decide);
    });
  }

  private async processBatchLocked(
    events: readonly PrimaryOperatorEvent[],
    decide: (event: PrimaryOperatorEvent) => Promise<unknown> | unknown,
    commitChanged?: PrimaryOperatorChangedCommitter
  ): Promise<PrimaryOperatorBatchResult> {
    if (events.length === 0) {
      return {
        status: 'idle',
        processed: 0,
        advancedThroughSeq: readCursorSeq(this.db, this.cursorName),
        commits: [],
      };
    }

    const commits: OperatorCursorCommitResult[] = [];
    let advancedThroughSeq = readCursorSeq(this.db, this.cursorName);

    for (const event of events) {
      try {
        const seq = nonNegativeInteger(event.seq, 'event.seq');
        assertRawEventSourceBoundToConnector(event.sourceRef, this.connector);
        const idempotencyKey = buildCursorScopedIdempotencyKey(this.cursorName, seq, seq);
        const legacyIdempotencyKey = buildConnectorIdempotencyKey(this.connector, seq, seq);
        const sourceRefs = [event.sourceRef];
        const fallbackIdempotencyKeys =
          legacyIdempotencyKey === idempotencyKey ? [] : [legacyIdempotencyKey];
        const existingCommit = recoverExistingOperatorCursorCommit(this.db, {
          cursorName: this.cursorName,
          idempotencyKey,
          fallbackIdempotencyKeys,
          statusFilter: commitChanged === undefined ? undefined : ['no_update'],
          sourceRefs,
          nowMs: this.nowMs(),
          allowSeqGaps: this.allowSeqGaps,
        });
        if (existingCommit) {
          commits.push(existingCommit);
          advancedThroughSeq = Math.max(advancedThroughSeq, existingCommit.lastChangeSeq);
          continue;
        }
        if (commitChanged) {
          const commitNowMs = this.nowMs();
          const existingChangedCommit = recoverExistingOperatorCursorChangedWrite(this.db, {
            cursorName: this.cursorName,
            firstChangeSeq: seq,
            lastChangeSeq: seq,
            idempotencyKey,
            fallbackIdempotencyKeys,
            sourceRefs,
            nowMs: commitNowMs,
            allowSeqGaps: this.allowSeqGaps,
            writeChangedLedger: ({ idempotencyKey: matchedIdempotencyKey }) =>
              commitChanged({
                event,
                decision: { status: 'changed' },
                sourceRefs,
                idempotencyKey: matchedIdempotencyKey,
                nowMs: commitNowMs,
              }),
          });
          if (existingChangedCommit) {
            commits.push(existingChangedCommit);
            advancedThroughSeq = Math.max(advancedThroughSeq, existingChangedCommit.lastChangeSeq);
            continue;
          }
          assertEventAdvancesCursor(seq, advancedThroughSeq, this.allowSeqGaps);
          const decision = parseDecision(await decide(event), {
            requireChangedRefs: false,
          });
          const commit = this.commitParsedDecision(decision, {
            event,
            sourceRefs,
            idempotencyKey,
            fallbackIdempotencyKeys,
            seq,
            nowMs: commitNowMs,
            commitChanged,
          });
          commits.push(commit);
          advancedThroughSeq = Math.max(advancedThroughSeq, commit.lastChangeSeq);
          continue;
        }
        assertEventAdvancesCursor(seq, advancedThroughSeq, this.allowSeqGaps);
        const commitNowMs = this.nowMs();
        const decision = parseDecision(await decide(event), {
          requireChangedRefs: true,
        });
        const commit = this.commitParsedDecision(decision, {
          event,
          sourceRefs,
          idempotencyKey,
          fallbackIdempotencyKeys,
          seq,
          nowMs: commitNowMs,
          commitChanged,
        });
        commits.push(commit);
        advancedThroughSeq = Math.max(advancedThroughSeq, commit.lastChangeSeq);
      } catch (error) {
        return {
          status: 'partial_failure',
          processed: commits.length,
          advancedThroughSeq,
          failedSeq: event.seq,
          error: asError(error),
          commits,
        };
      }
    }

    return {
      status: 'committed',
      processed: commits.length,
      advancedThroughSeq,
      commits,
    };
  }

  private commitParsedDecision(
    decision: ParsedPrimaryOperatorDecision,
    context: ParsedPrimaryOperatorCommitContext
  ): OperatorCursorCommitResult {
    if (decision.status === 'changed') {
      return this.commitChangedDecision({
        ...context,
        decision,
      });
    }
    return commitOperatorCursor(this.db, {
      cursorName: this.cursorName,
      firstChangeSeq: context.seq,
      lastChangeSeq: context.seq,
      idempotencyKey: context.idempotencyKey,
      status: 'no_update',
      sourceRefs: context.sourceRefs,
      noUpdate: {
        scopeKey: this.resolveNoUpdateScope(decision.scopeKey),
        reason: decision.reason,
      },
      nowMs: context.nowMs,
      allowSeqGaps: this.allowSeqGaps,
    });
  }

  private commitChangedDecision(input: {
    event: PrimaryOperatorEvent;
    decision: PrimaryOperatorChangedCommitDecision;
    sourceRefs: readonly SourceRef[];
    idempotencyKey: string;
    fallbackIdempotencyKeys: readonly string[];
    seq: number;
    nowMs: number;
    commitChanged?: PrimaryOperatorChangedCommitter;
  }): OperatorCursorCommitResult {
    const commitChanged = input.commitChanged;
    if (commitChanged) {
      return commitOperatorCursorWithChangedWrite(this.db, {
        cursorName: this.cursorName,
        firstChangeSeq: input.seq,
        lastChangeSeq: input.seq,
        idempotencyKey: input.idempotencyKey,
        fallbackIdempotencyKeys: input.fallbackIdempotencyKeys,
        sourceRefs: input.sourceRefs,
        nowMs: input.nowMs,
        allowSeqGaps: this.allowSeqGaps,
        writeChangedLedger: ({ idempotencyKey }) =>
          commitChanged({
            event: input.event,
            decision: { status: 'changed' },
            sourceRefs: input.sourceRefs,
            idempotencyKey,
            nowMs: input.nowMs,
          }),
      });
    }
    if (!input.decision.changedRefs) {
      throw new Error('Changed primary operator decisions require changedRefs');
    }
    return commitOperatorCursor(this.db, {
      cursorName: this.cursorName,
      firstChangeSeq: input.seq,
      lastChangeSeq: input.seq,
      idempotencyKey: input.idempotencyKey,
      status: 'changed',
      changedRefs: input.decision.changedRefs,
      sourceRefs: input.sourceRefs,
      nowMs: input.nowMs,
      allowSeqGaps: this.allowSeqGaps,
    });
  }

  private resolveNoUpdateScope(candidateScopeKey: string | undefined): string {
    if (candidateScopeKey !== undefined && candidateScopeKey !== this.cursorName) {
      throw new Error(
        `No-update scopeKey must match primary operator cursor ${this.cursorName}; got ${candidateScopeKey}`
      );
    }
    return this.cursorName;
  }
}
