import type { SQLiteDatabase } from '../sqlite.js';
import { applyOwnerEventBoardRefreshMigration } from '../db/migrations/owner-event-board-refresh.js';
import { boardFullNoUpdateScope, type FullRepairCapture } from './board-refresh-gate.js';
import { boardBatchKey, boardRepairKey, validateWorkOrderPayload } from './workorder-publishers.js';
import type { EnqueueWorkOrderInput, WorkOrderRecord } from './task-ledger.js';

export interface OwnerEventBoardRefreshAcceptance {
  batchId: number;
  batchKey: string;
  repairGeneration: number;
  workOrderId: number;
  appliedAt: number | null;
}

interface StoredAcceptanceRow {
  batch_id: number;
  batch_key: string;
  repair_generation: number;
  workorder_id: number;
  applied_at: number | null;
}

interface StoredInboxIdentityRow {
  event_ids_json: string;
}

export interface BoardWorkOrderPort {
  enqueueWorkOrder(order: EnqueueWorkOrderInput): WorkOrderRecord;
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function canonicalEventIds(value: readonly string[], field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must contain at least one event id`);
  }
  const normalized = value.map((eventId) => {
    if (typeof eventId !== 'string' || eventId.trim().length === 0) {
      throw new Error(`${field} must contain only non-empty event ids`);
    }
    return eventId;
  });
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) {
    throw new Error(`${field} must not contain duplicate event ids`);
  }
  return unique;
}

function acceptanceFromRow(row: StoredAcceptanceRow): OwnerEventBoardRefreshAcceptance {
  return {
    batchId: row.batch_id,
    batchKey: row.batch_key,
    repairGeneration: row.repair_generation,
    workOrderId: row.workorder_id,
    appliedAt: row.applied_at,
  };
}

export function resolveInitialBoardRepairGeneration(
  now: number,
  pendingGeneration: number | null
): number {
  assertNonNegativeSafeInteger(now, 'board repair wall time');
  if (pendingGeneration === null) return now;
  assertNonNegativeSafeInteger(pendingGeneration, 'pending board repair generation');
  if (pendingGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error('pending board repair generation exhausted');
  }
  return Math.max(now, pendingGeneration + 1);
}

/**
 * Durable many-to-one relation between exact owner-event batches and the
 * shared Board repair workorder (TG-06).
 *
 * SQLite owns acceptance. The in-memory set owns only a best-effort wakeup
 * after the current workorder becomes terminal; unapplied rows recover it on
 * the next boot if the process dies in that narrow window.
 */
export class OwnerEventBoardRefreshLedger {
  private readonly postTerminalFollowups = new Set<number>();

  constructor(
    private readonly db: SQLiteDatabase,
    private readonly taskLedger: BoardWorkOrderPort,
    private readonly clock: () => number = () => Date.now()
  ) {
    applyOwnerEventBoardRefreshMigration(this.db);
  }

  maxPendingGeneration(): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(repair_generation) AS generation
           FROM owner_event_board_refresh_intents
          WHERE applied_at IS NULL`
      )
      .get() as { generation: number | null } | undefined;
    return row?.generation ?? null;
  }

  accept(input: {
    batchId: number;
    eventIds: readonly string[];
    repair: FullRepairCapture;
  }): OwnerEventBoardRefreshAcceptance {
    if (!Number.isSafeInteger(input.batchId) || input.batchId <= 0) {
      throw new Error('owner-event Board batchId must be a positive safe integer');
    }
    assertNonNegativeSafeInteger(input.repair.repairGeneration, 'board repair generation');
    if (input.repair.noUpdateScope !== boardFullNoUpdateScope(input.repair.repairGeneration)) {
      throw new Error('owner-event Board no-update scope does not match its repair generation');
    }
    const requestedEventIds = canonicalEventIds(input.eventIds, 'owner-event Board eventIds');
    const inboxRow = this.db
      .prepare(`SELECT event_ids_json FROM owner_event_inbox WHERE id = ?`)
      .get(input.batchId) as StoredInboxIdentityRow | undefined;
    if (!inboxRow) {
      throw new Error(`owner-event Board batch ${input.batchId} does not exist`);
    }
    const storedEventIds = canonicalEventIds(
      JSON.parse(inboxRow.event_ids_json) as string[],
      'stored owner-event Board eventIds'
    );
    const batchKey = boardBatchKey(requestedEventIds);
    if (boardBatchKey(storedEventIds) !== batchKey) {
      throw new Error(
        `owner-event Board batch ${input.batchId} conflicts with its stored event identity`
      );
    }

    const transaction = this.db.transaction(() => {
      const existing = this.readAcceptance(input.batchId);
      if (existing) {
        if (existing.batchKey !== batchKey) {
          throw new Error(
            `owner-event Board batch ${input.batchId} conflicts with its durable acceptance`
          );
        }
        return existing;
      }
      const payload = {
        mode: 'full' as const,
        force: false,
        repairGeneration: input.repair.repairGeneration,
        noUpdateScope: input.repair.noUpdateScope,
      };
      validateWorkOrderPayload('board', payload);
      const workOrder = this.taskLedger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: boardRepairKey(),
        input: payload,
        priority: 'high',
      });
      const now = this.clock();
      assertNonNegativeSafeInteger(now, 'owner-event Board intent time');
      this.db
        .prepare(
          `INSERT INTO owner_event_board_refresh_intents
             (batch_id, batch_key, repair_generation, workorder_id,
              applied_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(input.batchId, batchKey, input.repair.repairGeneration, workOrder.id, now, now);
      const inserted = this.readAcceptance(input.batchId);
      if (!inserted) {
        throw new Error('owner-event Board acceptance disappeared after insert');
      }
      return inserted;
    });
    return transaction();
  }

  findAcceptance(batchId: number): OwnerEventBoardRefreshAcceptance | null {
    if (!Number.isSafeInteger(batchId) || batchId <= 0) return null;
    return this.readAcceptance(batchId);
  }

  attachPendingToWorkOrder(workOrderId: number): number {
    this.assertBoardWorkOrder(workOrderId);
    const result = this.db
      .prepare(
        `UPDATE owner_event_board_refresh_intents
            SET workorder_id = ?, updated_at = ?
          WHERE applied_at IS NULL AND workorder_id <> ?`
      )
      .run(workOrderId, this.clock(), workOrderId);
    return result.changes;
  }

  markVerified(
    workOrderId: number,
    capturedGeneration: number
  ): { applied: number; followupPending: boolean } {
    this.assertBoardWorkOrder(workOrderId);
    assertNonNegativeSafeInteger(capturedGeneration, 'captured Board repair generation');
    const now = this.clock();
    assertNonNegativeSafeInteger(now, 'owner-event Board application time');
    const applied = this.db
      .prepare(
        `UPDATE owner_event_board_refresh_intents
            SET applied_at = ?, updated_at = ?
          WHERE applied_at IS NULL AND repair_generation <= ?`
      )
      .run(now, now, capturedGeneration).changes;
    const followupPending = this.maxPendingGeneration() !== null;
    if (followupPending) {
      this.postTerminalFollowups.add(workOrderId);
    }
    return { applied, followupPending };
  }

  consumePostTerminalFollowup(workOrderId: number): boolean {
    if (!this.postTerminalFollowups.delete(workOrderId)) return false;
    return this.maxPendingGeneration() !== null;
  }

  private readAcceptance(batchId: number): OwnerEventBoardRefreshAcceptance | null {
    const row = this.db
      .prepare(
        `SELECT batch_id, batch_key, repair_generation, workorder_id, applied_at
           FROM owner_event_board_refresh_intents WHERE batch_id = ?`
      )
      .get(batchId) as StoredAcceptanceRow | undefined;
    return row ? acceptanceFromRow(row) : null;
  }

  private assertBoardWorkOrder(workOrderId: number): void {
    if (!Number.isSafeInteger(workOrderId) || workOrderId <= 0) {
      throw new Error('Board workorder id must be a positive safe integer');
    }
    const row = this.db
      .prepare(
        `SELECT id FROM operator_tasks
          WHERE id = ? AND kind = 'system' AND source_channel = 'workorder:board'`
      )
      .get(workOrderId) as { id: number } | undefined;
    if (!row) {
      throw new Error(`Board workorder ${workOrderId} does not exist`);
    }
  }
}
