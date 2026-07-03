import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import {
  buildConnectorIdempotencyKey,
  buildCursorScopedIdempotencyKey,
  commitOperatorCursor,
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

function parseDecision(value: unknown): PrimaryOperatorDecision {
  if (!isRecord(value)) {
    throw new Error('Primary operator decision must be an object');
  }
  if (value.status === 'changed') {
    if (!Array.isArray(value.changedRefs)) {
      throw new Error('Changed primary operator decisions require changedRefs');
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
    decide: (event: PrimaryOperatorEvent) => Promise<unknown> | unknown
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
        const existingCommit = recoverExistingOperatorCursorCommit(this.db, {
          cursorName: this.cursorName,
          idempotencyKey,
          fallbackIdempotencyKeys:
            legacyIdempotencyKey === idempotencyKey ? [] : [legacyIdempotencyKey],
          sourceRefs,
          nowMs: this.nowMs(),
          allowSeqGaps: this.allowSeqGaps,
        });
        if (existingCommit) {
          commits.push(existingCommit);
          advancedThroughSeq = Math.max(advancedThroughSeq, existingCommit.lastChangeSeq);
          continue;
        }
        if (this.allowSeqGaps ? seq <= advancedThroughSeq : seq !== advancedThroughSeq + 1) {
          throw new Error(
            this.allowSeqGaps
              ? `Operator events must advance cursor; current seq ${advancedThroughSeq}, got ${seq}`
              : `Operator events must be contiguous; expected seq ${advancedThroughSeq + 1}, got ${seq}`
          );
        }
        const decision = parseDecision(await decide(event));
        const commit =
          decision.status === 'changed'
            ? commitOperatorCursor(this.db, {
                cursorName: this.cursorName,
                firstChangeSeq: seq,
                lastChangeSeq: seq,
                idempotencyKey,
                status: 'changed',
                changedRefs: decision.changedRefs,
                sourceRefs,
                nowMs: this.nowMs(),
                allowSeqGaps: this.allowSeqGaps,
              })
            : commitOperatorCursor(this.db, {
                cursorName: this.cursorName,
                firstChangeSeq: seq,
                lastChangeSeq: seq,
                idempotencyKey,
                status: 'no_update',
                sourceRefs,
                noUpdate: {
                  scopeKey: this.resolveNoUpdateScope(decision.scopeKey),
                  reason: decision.reason,
                },
                nowMs: this.nowMs(),
                allowSeqGaps: this.allowSeqGaps,
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

  private resolveNoUpdateScope(candidateScopeKey: string | undefined): string {
    if (candidateScopeKey !== undefined && candidateScopeKey !== this.cursorName) {
      throw new Error(
        `No-update scopeKey must match primary operator cursor ${this.cursorName}; got ${candidateScopeKey}`
      );
    }
    return this.cursorName;
  }
}
