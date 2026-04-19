import { randomUUID } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { insertCaseCorrectionLock } from './corrections.js';
import { runImmediateTransaction, type ImmediateTransactionAdapter } from './sqlite-transaction.js';
import type { CaseMembershipSourceType } from './types.js';

export type MergeCaseErrorCode =
  | 'case.confirmation_required'
  | 'case.merge_self'
  | 'case.merge_chain_cycle'
  | 'case.terminal_status';

export interface MergeCasesInput {
  loser_case_id: string;
  survivor_case_id: string;
  reason: string;
  confirmed: true;
  confirmed_by: string;
  confirmation_summary: string;
  now?: string;
}

export type MergeCasesResult =
  | { kind: 'merged'; loser_case_id: string; survivor_case_id: string; audit_event_id: string }
  | { kind: 'precompile_gap'; code: 'case.precompile_gap'; case_id: string }
  | { kind: 'rejected'; code: MergeCaseErrorCode; message: string };

export interface SplitCaseChildPlan {
  title: string;
  current_wiki_path?: string | null;
  membership_sources: Array<{
    source_type: 'decision' | 'event' | 'observation' | 'artifact';
    source_id: string;
    remove_from_parent?: boolean;
  }>;
}

export interface SplitCaseInput {
  parent_case_id: string;
  children: SplitCaseChildPlan[];
  trusted_child_case_ids: string[];
  reason: string;
  confirmed: true;
  confirmed_by: string;
  confirmation_summary: string;
  now?: string;
}

export type SplitCaseResult =
  | { kind: 'split'; parent_case_id: string; child_case_ids: string[]; audit_event_id: string }
  | { kind: 'precompile_gap'; code: 'case.precompile_gap'; case_id: string }
  | {
      kind: 'rejected';
      code:
        | 'case.confirmation_required'
        | 'case.terminal_status'
        | 'case.split_requires_two_children'
        | 'case.child_id_not_trusted'
        | 'case.child_id_count_mismatch';
      message: string;
    };

type MergeSplitAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'> &
  Partial<Pick<ImmediateTransactionAdapter, 'exec'>>;

interface CaseTruthRow {
  case_id: string;
  current_wiki_path: string | null;
  title: string;
  status: string;
  canonical_case_id: string | null;
  split_from_case_id: string | null;
  scope_refs: string | null;
  confidence: string | null;
}

interface MembershipRow {
  role: string | null;
  confidence: number | null;
  reason: string | null;
  status: string;
}

type ChainResolution =
  | { kind: 'resolved'; terminal_case_id: string; chain: string[] }
  | { kind: 'precompile_gap'; case_id: string }
  | { kind: 'cycle'; message: string };

const TERMINAL_CASE_STATUSES = new Set(['merged', 'archived', 'split']);
const CHILD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeNow(value?: string): string {
  return value ?? new Date().toISOString();
}

function createdAtMs(now: string): number {
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function confirmed(input: {
  confirmed?: boolean;
  confirmed_by?: unknown;
  confirmation_summary?: unknown;
}): boolean {
  return (
    input.confirmed === true && nonEmpty(input.confirmed_by) && nonEmpty(input.confirmation_summary)
  );
}

function readCase(adapter: MergeSplitAdapter, caseId: string): CaseTruthRow | null {
  const row = adapter.prepare('SELECT * FROM case_truth WHERE case_id = ?').get(caseId) as
    | CaseTruthRow
    | undefined;
  return row ?? null;
}

function resolveCanonicalChain(adapter: MergeSplitAdapter, caseId: string): ChainResolution {
  const visited = new Set<string>();
  const chain: string[] = [];
  let current = caseId;

  for (;;) {
    const depth = chain.length + 1;
    const cycleChain = [...chain, current];

    if (visited.has(current) || depth > 64) {
      return {
        kind: 'cycle',
        message: `Case merge chain cycle detected at depth ${depth} starting from case_id=${caseId}. Chain=${cycleChain.join(' -> ')}.`,
      };
    }

    visited.add(current);
    chain.push(current);

    const row = readCase(adapter, current);
    if (!row) {
      return { kind: 'precompile_gap', case_id: current };
    }

    if (!row.canonical_case_id) {
      return { kind: 'resolved', terminal_case_id: current, chain };
    }

    current = row.canonical_case_id;
  }
}

function insertMemoryEvent(input: {
  adapter: MergeSplitAdapter;
  event_type: 'case.merged' | 'case.split';
  topic: string;
  scope_refs: unknown;
  evidence_refs: unknown;
  reason: unknown;
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
        VALUES (?, ?, 'user', NULL, NULL, ?, ?, ?, ?, ?)
      `
    )
    .run(
      eventId,
      input.event_type,
      input.topic,
      canonicalizeJSON(input.scope_refs),
      canonicalizeJSON(input.evidence_refs),
      canonicalizeJSON(input.reason),
      createdAtMs(input.now)
    );

  return eventId;
}

function hasCallerChildCaseIds(children: SplitCaseChildPlan[]): boolean {
  return children.some((child) => Object.prototype.hasOwnProperty.call(child, 'case_id'));
}

function trustedChildIdsAreValid(ids: string[]): boolean {
  return ids.every((id) => CHILD_UUID_PATTERN.test(id) && !id.startsWith('case_'));
}

function childIdsAreUnique(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

function readParentMembership(
  adapter: MergeSplitAdapter,
  parentCaseId: string,
  sourceType: CaseMembershipSourceType,
  sourceId: string
): MembershipRow | null {
  const row = adapter
    .prepare(
      `
        SELECT role, confidence, reason, status
          FROM case_memberships
         WHERE case_id = ?
           AND source_type = ?
           AND source_id = ?
      `
    )
    .get(parentCaseId, sourceType, sourceId) as MembershipRow | undefined;

  return row ?? null;
}

function upsertChildMembership(input: {
  adapter: MergeSplitAdapter;
  child_case_id: string;
  source_type: CaseMembershipSourceType;
  source_id: string;
  parent_membership: MembershipRow | null;
  now: string;
}): void {
  input.adapter
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status, added_by,
          added_at, updated_at, user_locked
        )
        VALUES (?, ?, ?, ?, ?, ?, 'active', 'user-correction', ?, ?, 1)
        ON CONFLICT(case_id, source_type, source_id) DO UPDATE SET
          role = excluded.role,
          confidence = excluded.confidence,
          reason = excluded.reason,
          status = 'active',
          added_by = 'user-correction',
          updated_at = excluded.updated_at,
          user_locked = 1
      `
    )
    .run(
      input.child_case_id,
      input.source_type,
      input.source_id,
      input.parent_membership?.role ?? null,
      input.parent_membership?.confidence ?? null,
      input.parent_membership?.reason ?? 'User assigned source during case split.',
      input.now,
      input.now
    );
}

function removeParentMembership(input: {
  adapter: MergeSplitAdapter;
  parent_case_id: string;
  source_type: CaseMembershipSourceType;
  source_id: string;
  now: string;
}): void {
  input.adapter
    .prepare(
      `
        UPDATE case_memberships
           SET status = 'removed',
               user_locked = 1,
               updated_at = ?
         WHERE case_id = ?
           AND source_type = ?
           AND source_id = ?
      `
    )
    .run(input.now, input.parent_case_id, input.source_type, input.source_id);
}

export function mergeCases(adapter: DatabaseAdapter, input: MergeCasesInput): MergeCasesResult {
  const tx = adapter as unknown as MergeSplitAdapter;

  if (!confirmed(input)) {
    return {
      kind: 'rejected',
      code: 'case.confirmation_required',
      message: 'confirmed=true, confirmed_by, and confirmation_summary are required.',
    };
  }

  return runImmediateTransaction(tx, () => {
    const now = normalizeNow(input.now);

    if (input.loser_case_id === input.survivor_case_id) {
      return {
        kind: 'rejected',
        code: 'case.merge_self',
        message: 'loser_case_id and survivor_case_id must be different.',
      };
    }

    const loser = readCase(tx, input.loser_case_id);
    if (!loser) {
      return { kind: 'precompile_gap', code: 'case.precompile_gap', case_id: input.loser_case_id };
    }

    const survivor = readCase(tx, input.survivor_case_id);
    if (!survivor) {
      return {
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: input.survivor_case_id,
      };
    }

    const loserResolution = resolveCanonicalChain(tx, input.loser_case_id);
    if (loserResolution.kind === 'cycle') {
      return { kind: 'rejected', code: 'case.merge_chain_cycle', message: loserResolution.message };
    }
    if (loserResolution.kind === 'precompile_gap') {
      return {
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: loserResolution.case_id,
      };
    }

    const survivorResolution = resolveCanonicalChain(tx, input.survivor_case_id);
    if (survivorResolution.kind === 'cycle') {
      return {
        kind: 'rejected',
        code: 'case.merge_chain_cycle',
        message: survivorResolution.message,
      };
    }
    if (survivorResolution.kind === 'precompile_gap') {
      return {
        kind: 'precompile_gap',
        code: 'case.precompile_gap',
        case_id: survivorResolution.case_id,
      };
    }

    if (loserResolution.terminal_case_id === survivorResolution.terminal_case_id) {
      return {
        kind: 'rejected',
        code: 'case.merge_self',
        message: 'loser and survivor resolve to the same canonical case.',
      };
    }
    const canonicalLoserCaseId = loserResolution.terminal_case_id;
    const canonicalSurvivorCaseId = survivorResolution.terminal_case_id;

    if (TERMINAL_CASE_STATUSES.has(loser.status) || TERMINAL_CASE_STATUSES.has(survivor.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: 'Merged, archived, and split cases cannot be merge endpoints.',
      };
    }

    insertCaseCorrectionLock(tx as unknown as DatabaseAdapter, {
      case_id: canonicalLoserCaseId,
      target_kind: 'case_field',
      target_ref: { kind: 'case_field', field: 'canonical_case_id' },
      field_name: null,
      old_value_json: canonicalizeJSON({
        status: loser.status,
        canonical_case_id: loser.canonical_case_id,
      }),
      new_value_json: canonicalizeJSON({
        status: 'merged',
        canonical_case_id: canonicalSurvivorCaseId,
      }),
      reason: input.reason,
      applied_by: input.confirmed_by,
      applied_at: now,
      is_lock_active: 0,
    });

    tx.prepare(
      `
        UPDATE case_truth
           SET status = 'merged',
               canonical_case_id = ?,
               updated_at = ?
         WHERE case_id = ?
      `
    ).run(canonicalSurvivorCaseId, now, canonicalLoserCaseId);

    const auditEventId = insertMemoryEvent({
      adapter: tx,
      event_type: 'case.merged',
      topic: `case:${canonicalSurvivorCaseId}`,
      scope_refs: [
        { type: 'case', id: canonicalSurvivorCaseId },
        { type: 'case', id: canonicalLoserCaseId },
      ],
      evidence_refs: [canonicalLoserCaseId, canonicalSurvivorCaseId],
      reason: {
        reason: input.reason,
        confirmed_by: input.confirmed_by,
        confirmation_summary: input.confirmation_summary,
      },
      now,
    });

    return {
      kind: 'merged',
      loser_case_id: input.loser_case_id,
      survivor_case_id: input.survivor_case_id,
      audit_event_id: auditEventId,
    };
  });
}

export function splitCase(adapter: DatabaseAdapter, input: SplitCaseInput): SplitCaseResult {
  const tx = adapter as unknown as MergeSplitAdapter;

  if (!confirmed(input)) {
    return {
      kind: 'rejected',
      code: 'case.confirmation_required',
      message: 'confirmed=true, confirmed_by, and confirmation_summary are required.',
    };
  }

  if (hasCallerChildCaseIds(input.children)) {
    return {
      kind: 'rejected',
      code: 'case.child_id_not_trusted',
      message: 'Child case IDs are runner-owned and must not be supplied in child payloads.',
    };
  }

  if (input.children.length < 2) {
    return {
      kind: 'rejected',
      code: 'case.split_requires_two_children',
      message: 'A split requires at least two children.',
    };
  }

  if (input.trusted_child_case_ids.length !== input.children.length) {
    return {
      kind: 'rejected',
      code: 'case.child_id_count_mismatch',
      message: 'trusted_child_case_ids length must match children length.',
    };
  }

  if (
    !childIdsAreUnique(input.trusted_child_case_ids) ||
    !trustedChildIdsAreValid(input.trusted_child_case_ids)
  ) {
    return {
      kind: 'rejected',
      code: 'case.child_id_not_trusted',
      message: 'trusted_child_case_ids must be unique UUIDs minted by the standalone runner.',
    };
  }

  return runImmediateTransaction(tx, () => {
    const now = normalizeNow(input.now);
    const parent = readCase(tx, input.parent_case_id);

    if (!parent) {
      return { kind: 'precompile_gap', code: 'case.precompile_gap', case_id: input.parent_case_id };
    }

    if (TERMINAL_CASE_STATUSES.has(parent.status)) {
      return {
        kind: 'rejected',
        code: 'case.terminal_status',
        message: `Cannot split terminal case status ${parent.status}.`,
      };
    }

    tx.prepare(
      `
        UPDATE case_truth
           SET status = 'split',
               updated_at = ?
         WHERE case_id = ?
      `
    ).run(now, input.parent_case_id);

    for (const [index, child] of input.children.entries()) {
      const childCaseId = input.trusted_child_case_ids[index];

      tx.prepare(
        `
          INSERT INTO case_truth (
            case_id, current_wiki_path, title, status, split_from_case_id, wiki_path_history,
            scope_refs, confidence, created_at, updated_at
          )
          VALUES (?, ?, ?, 'active', ?, '[]', ?, ?, ?, ?)
        `
      ).run(
        childCaseId,
        child.current_wiki_path ?? null,
        child.title,
        input.parent_case_id,
        parent.scope_refs ?? '[]',
        parent.confidence ?? null,
        now,
        now
      );

      for (const membership of child.membership_sources) {
        const sourceType = membership.source_type as CaseMembershipSourceType;
        const parentMembership = readParentMembership(
          tx,
          input.parent_case_id,
          sourceType,
          membership.source_id
        );

        upsertChildMembership({
          adapter: tx,
          child_case_id: childCaseId,
          source_type: sourceType,
          source_id: membership.source_id,
          parent_membership: parentMembership,
          now,
        });

        if (membership.remove_from_parent === true) {
          removeParentMembership({
            adapter: tx,
            parent_case_id: input.parent_case_id,
            source_type: sourceType,
            source_id: membership.source_id,
            now,
          });
        }
      }
    }

    insertCaseCorrectionLock(tx as unknown as DatabaseAdapter, {
      case_id: input.parent_case_id,
      target_kind: 'case_field',
      target_ref: { kind: 'case_field', field: 'status' },
      field_name: 'status',
      old_value_json: canonicalizeJSON(parent.status),
      new_value_json: canonicalizeJSON({
        status: 'split',
        child_case_ids: input.trusted_child_case_ids,
      }),
      reason: input.reason,
      applied_by: input.confirmed_by,
      applied_at: now,
      is_lock_active: 0,
    });

    const auditEventId = insertMemoryEvent({
      adapter: tx,
      event_type: 'case.split',
      topic: `case:${input.parent_case_id}`,
      scope_refs: [
        { type: 'case', id: input.parent_case_id },
        ...input.trusted_child_case_ids.map((id) => ({ type: 'case', id })),
      ],
      evidence_refs: input.trusted_child_case_ids,
      reason: {
        reason: input.reason,
        confirmed_by: input.confirmed_by,
        confirmation_summary: input.confirmation_summary,
        child_case_ids: input.trusted_child_case_ids,
      },
      now,
    });

    return {
      kind: 'split',
      parent_case_id: input.parent_case_id,
      child_case_ids: input.trusted_child_case_ids,
      audit_event_id: auditEventId,
    };
  });
}
