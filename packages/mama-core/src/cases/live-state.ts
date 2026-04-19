import { randomUUID } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import {
  buildCaseFieldTargetRef,
  buildMembershipTargetRef,
  canonicalTargetRef,
  type CanonicalTargetRef,
} from './target-ref.js';
import { runImmediateTransaction, type ImmediateTransactionAdapter } from './sqlite-transaction.js';
import type {
  CaseCorrectionTargetKind,
  CaseFastWriteStatus as CaseFastWriteStatusFromTypes,
  CaseMembershipSourceType,
} from './types.js';

export type CaseFastWriteErrorCode =
  | 'case.precompile_gap'
  | 'case.lock_held'
  | 'case.terminal_status'
  | 'case.correction_active_conflict';

export interface CaseMembershipWritePlan {
  source_type: 'decision' | 'event' | 'observation' | 'artifact';
  source_id: string;
  role?: 'requester' | 'implementer' | 'reviewer' | 'observer' | 'affected' | null;
  confidence: number;
  reason: string;
  status: 'active' | 'candidate';
}

type CaseFastWriteStatus = CaseFastWriteStatusFromTypes;

export interface WriteCaseLiveStateInput {
  case_id: string;
  source_event_id: string;
  source_type: 'event';
  status?: CaseFastWriteStatus;
  last_activity_at?: string;
  membership?: CaseMembershipWritePlan;
  actor?: 'memory_agent';
  now?: string;
}

export type WriteCaseLiveStateResult =
  | {
      kind: 'applied';
      case_id: string;
      applied_targets: Array<{
        target_kind: 'case_field' | 'membership';
        target_ref_json: string;
      }>;
      skipped_targets: Array<{
        target_kind: 'case_field' | 'membership';
        target_ref_json: string;
        correction_id: string;
      }>;
      audit_event_ids: string[];
    }
  | { kind: 'precompile_gap'; code: 'case.precompile_gap'; case_id: string }
  | { kind: 'rejected'; code: CaseFastWriteErrorCode; message: string; case_id: string };

type LiveStateAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'> &
  Partial<Pick<ImmediateTransactionAdapter, 'exec'>>;

interface CaseTruthGateRow {
  case_id: string;
  status: string;
}

interface CaseChainRow {
  case_id: string;
}

interface LockRow {
  correction_id: string;
  case_id: string;
  target_kind: CaseCorrectionTargetKind;
  field_name: string | null;
  target_ref_json: string;
  target_ref_hash: Uint8Array;
}

interface TargetPlan {
  target_kind: 'case_field' | 'membership';
  target_ref_json: string;
  target_ref_hash: Buffer;
}

const TERMINAL_CASE_STATUSES = new Set(['merged', 'archived', 'split']);
const FAST_WRITE_STATUSES = new Set<CaseFastWriteStatus>([
  'active',
  'blocked',
  'resolved',
  'stale',
]);

function isCaseFastWriteStatus(value: unknown): value is CaseFastWriteStatus {
  return typeof value === 'string' && FAST_WRITE_STATUSES.has(value as CaseFastWriteStatus);
}

function normalizeNow(value?: string): string {
  return value ?? new Date().toISOString();
}

function createdAtMs(now: string): number {
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function placeholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error('Cannot build SQL IN clause for an empty value list.');
  }
  return values.map(() => '?').join(', ');
}

function toHashKey(value: Uint8Array | Buffer): string {
  return Buffer.from(value).toString('hex');
}

function targetPlanForCanonical(
  target_kind: 'case_field' | 'membership',
  canonical: CanonicalTargetRef
): TargetPlan {
  return {
    target_kind,
    target_ref_json: canonical.json,
    target_ref_hash: canonical.hash,
  };
}

function buildTargetPlans(input: WriteCaseLiveStateInput): TargetPlan[] {
  const targets: TargetPlan[] = [];

  if (input.status !== undefined) {
    targets.push(
      targetPlanForCanonical('case_field', canonicalTargetRef(buildCaseFieldTargetRef('status')))
    );
  }

  if (input.last_activity_at !== undefined) {
    targets.push(
      targetPlanForCanonical(
        'case_field',
        canonicalTargetRef(buildCaseFieldTargetRef('last_activity_at'))
      )
    );
  }

  if (input.membership) {
    targets.push(
      targetPlanForCanonical(
        'membership',
        canonicalTargetRef(
          buildMembershipTargetRef(
            input.membership.source_type as CaseMembershipSourceType,
            input.membership.source_id
          )
        )
      )
    );
  }

  return targets;
}

function readCaseChain(adapter: LiveStateAdapter, caseId: string): string[] {
  const rows = adapter
    .prepare(
      `
        WITH RECURSIVE case_chain(case_id) AS (
          SELECT case_id
          FROM case_truth
          WHERE case_id = ?

          UNION

          SELECT ct.case_id
          FROM case_truth ct
          JOIN case_chain cc ON ct.canonical_case_id = cc.case_id
        )
        SELECT case_id
        FROM case_chain
      `
    )
    .all(caseId) as CaseChainRow[];

  return rows.map((row) => row.case_id);
}

function readActiveLocks(
  adapter: LiveStateAdapter,
  chainIds: string[],
  targets: TargetPlan[]
): Map<string, LockRow> {
  if (chainIds.length === 0 || targets.length === 0) {
    return new Map();
  }

  const targetHashes = targets.map((target) => target.target_ref_hash);
  const rows = adapter
    .prepare(
      `
        SELECT correction_id, case_id, target_kind, field_name, target_ref_json, target_ref_hash
        FROM case_corrections
        WHERE case_id IN (${placeholders(chainIds)})
          AND is_lock_active = 1
          AND reverted_at IS NULL
          AND target_ref_hash IN (${placeholders(targetHashes)})
      `
    )
    .all(...chainIds, ...targetHashes) as LockRow[];

  const locks = new Map<string, LockRow>();
  for (const row of rows) {
    locks.set(toHashKey(row.target_ref_hash), row);
  }
  return locks;
}

function findTarget(
  targets: TargetPlan[],
  target_kind: 'case_field' | 'membership',
  target_ref_json: string
): TargetPlan | null {
  return (
    targets.find(
      (target) => target.target_kind === target_kind && target.target_ref_json === target_ref_json
    ) ?? null
  );
}

function hasLock(locks: Map<string, LockRow>, target: TargetPlan | null): LockRow | null {
  if (!target) {
    return null;
  }
  return locks.get(toHashKey(target.target_ref_hash)) ?? null;
}

function insertSkippedAuditEvent(input: {
  adapter: LiveStateAdapter;
  case_id: string;
  source_event_id: string;
  skipped_targets: Array<{
    target_kind: 'case_field' | 'membership';
    target_ref_json: string;
    correction_id: string;
  }>;
  now: string;
}): string {
  const eventId = `me_${randomUUID()}`;

  input.adapter
    .prepare(
      `
        INSERT INTO memory_events (
          event_id, event_type, actor, source_turn_id, memory_id, topic,
          scope_refs, evidence_refs, reason, created_at
        )
        VALUES (?, 'case.fast_write_lock_skipped', 'memory_agent', ?, NULL, ?, ?, ?, ?, ?)
      `
    )
    .run(
      eventId,
      input.source_event_id,
      `case:${input.case_id}`,
      canonicalizeJSON([{ type: 'case', id: input.case_id }]),
      canonicalizeJSON([input.source_event_id]),
      canonicalizeJSON({ skipped_targets: input.skipped_targets }),
      createdAtMs(input.now)
    );

  return eventId;
}

export function writeCaseLiveStateFromEvent(
  adapter: DatabaseAdapter,
  input: WriteCaseLiveStateInput
): WriteCaseLiveStateResult {
  const liveAdapter = adapter as unknown as LiveStateAdapter;

  return runImmediateTransaction(liveAdapter, () => {
    const caseRow = liveAdapter
      .prepare(
        `
          SELECT case_id, status
          FROM case_truth
          WHERE case_id = ?
        `
      )
      .get(input.case_id) as CaseTruthGateRow | undefined;

    if (!caseRow) {
      return { kind: 'precompile_gap', code: 'case.precompile_gap', case_id: input.case_id };
    }

    if (TERMINAL_CASE_STATUSES.has(caseRow.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: `Memory-agent cannot update terminal case status ${caseRow.status}.`,
        case_id: input.case_id,
      };
    }

    if (input.status !== undefined && !isCaseFastWriteStatus(input.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: `Memory-agent cannot write terminal case status ${String(input.status)}.`,
        case_id: input.case_id,
      };
    }

    const now = normalizeNow(input.now);
    const chainIds = readCaseChain(liveAdapter, input.case_id);
    const targets = buildTargetPlans(input);
    const locks = readActiveLocks(liveAdapter, chainIds, targets);

    const applied_targets: Array<{
      target_kind: 'case_field' | 'membership';
      target_ref_json: string;
    }> = [];
    const skipped_targets: Array<{
      target_kind: 'case_field' | 'membership';
      target_ref_json: string;
      correction_id: string;
    }> = [];

    const statusTarget = targets[0] ?? null;
    const lastActivityTarget =
      input.status !== undefined ? (targets[1] ?? null) : (targets[0] ?? null);
    const membershipTarget = input.membership
      ? findTarget(
          targets,
          'membership',
          canonicalTargetRef(
            buildMembershipTargetRef(
              input.membership.source_type as CaseMembershipSourceType,
              input.membership.source_id
            )
          ).json
        )
      : null;

    const statusLock = input.status !== undefined ? hasLock(locks, statusTarget) : null;
    const lastActivityLock =
      input.last_activity_at !== undefined ? hasLock(locks, lastActivityTarget) : null;
    const membershipLock = input.membership ? hasLock(locks, membershipTarget) : null;

    if (statusLock && statusTarget) {
      skipped_targets.push({
        target_kind: statusTarget.target_kind,
        target_ref_json: statusTarget.target_ref_json,
        correction_id: statusLock.correction_id,
      });
    }

    if (lastActivityLock && lastActivityTarget) {
      skipped_targets.push({
        target_kind: lastActivityTarget.target_kind,
        target_ref_json: lastActivityTarget.target_ref_json,
        correction_id: lastActivityLock.correction_id,
      });
    }

    if (membershipLock && membershipTarget) {
      skipped_targets.push({
        target_kind: membershipTarget.target_kind,
        target_ref_json: membershipTarget.target_ref_json,
        correction_id: membershipLock.correction_id,
      });
    }

    const shouldWriteStatus = input.status !== undefined && !statusLock;
    const shouldWriteLastActivity = input.last_activity_at !== undefined && !lastActivityLock;

    if (shouldWriteStatus || shouldWriteLastActivity) {
      const updateResult = liveAdapter
        .prepare(
          `
            UPDATE case_truth
               SET status = CASE WHEN ? = 1 THEN ? ELSE status END,
                   last_activity_at = CASE WHEN ? = 1 THEN ? ELSE last_activity_at END,
                   state_updated_at = ?,
                   updated_at = ?
             WHERE case_id = ?
               AND status NOT IN ('merged','archived','split')
          `
        )
        .run(
          shouldWriteStatus ? 1 : 0,
          input.status ?? null,
          shouldWriteLastActivity ? 1 : 0,
          input.last_activity_at ?? null,
          now,
          now,
          input.case_id
        );

      if (updateResult.changes > 0) {
        if (shouldWriteStatus && statusTarget) {
          applied_targets.push({
            target_kind: statusTarget.target_kind,
            target_ref_json: statusTarget.target_ref_json,
          });
        }
        if (shouldWriteLastActivity && lastActivityTarget) {
          applied_targets.push({
            target_kind: lastActivityTarget.target_kind,
            target_ref_json: lastActivityTarget.target_ref_json,
          });
        }
      }
    }

    if (input.membership && !membershipLock && membershipTarget) {
      const membershipResult = liveAdapter
        .prepare(
          `
            INSERT INTO case_memberships (
              case_id, source_type, source_id, role, confidence, reason, status,
              added_by, added_at, user_locked, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'memory-agent', ?, 0, ?)
            ON CONFLICT(case_id, source_type, source_id) DO UPDATE SET
              role = excluded.role,
              confidence = excluded.confidence,
              reason = excluded.reason,
              status = excluded.status,
              added_by = 'memory-agent',
              updated_at = excluded.updated_at
            WHERE case_memberships.user_locked = 0
              AND case_memberships.status <> 'stale'
          `
        )
        .run(
          input.case_id,
          input.membership.source_type,
          input.membership.source_id,
          input.membership.role ?? null,
          input.membership.confidence,
          input.membership.reason,
          input.membership.status,
          now,
          now
        );

      if (membershipResult.changes > 0) {
        applied_targets.push({
          target_kind: membershipTarget.target_kind,
          target_ref_json: membershipTarget.target_ref_json,
        });
      }
    }

    const audit_event_ids =
      skipped_targets.length > 0
        ? [
            insertSkippedAuditEvent({
              adapter: liveAdapter,
              case_id: input.case_id,
              source_event_id: input.source_event_id,
              skipped_targets,
              now,
            }),
          ]
        : [];

    return {
      kind: 'applied',
      case_id: input.case_id,
      applied_targets,
      skipped_targets,
      audit_event_ids,
    };
  });
}
