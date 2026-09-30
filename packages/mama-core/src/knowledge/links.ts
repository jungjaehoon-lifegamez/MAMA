import crypto from 'node:crypto';

import type { DatabaseAdapter } from '../db-manager.js';
import { canonicalizeJSON } from '../canonicalize.js';
import type { RecordLink } from '../memory/judgment-types.js';
import {
  admittedScopeIds,
  getTwinEdge,
  insertTwinEdge,
  JudgmentError,
  referenceExists,
} from './judgments.js';
import type { JudgmentAccess } from './judgments.js';
import type { TwinRef } from './twin-edge-types.js';

/**
 * One edge the agent appends between records that already exist, with the sentence of why.
 *
 * Nothing is edited: a link is a new row, and a wrong link is answered by a newer one that
 * contradicts it. The row is its own receipt, so no record or revision is written for it.
 */
export interface LinkCommand {
  commandId: string;
  /** The record the statement is made from; for a work item, its head revision. */
  from: { kind: 'memory'; id: string };
  /** An edge target is a correction and takes `contradicts`. */
  to: TwinRef;
  relation: RecordLink['relation'];
  reason: string;
  /** Observations or records the reason rests on. */
  evidenceRefs?: TwinRef[];
  /** Extra relation attributes, such as a person's role. */
  attrs?: Record<string, unknown>;
  agentId?: string | null;
  modelRunId?: string | null;
}

export interface LinkReceipt {
  edgeId: string;
  createdAt: number;
  /** True when the command id was already written with this same link. */
  replayed: boolean;
}

/** A stored link, found by the command id that wrote it. */
export interface StoredLink extends LinkReceipt {
  from: TwinRef;
  to: TwinRef;
  relation: string;
  reason: string | null;
  evidenceRefs: TwinRef[];
}

const TARGET_KINDS = new Set<TwinRef['kind']>(['memory', 'registry', 'observation', 'edge']);
const EVIDENCE_KINDS = new Set<TwinRef['kind']>(['memory', 'observation']);
/**
 * Relations a link states. Replacing (supersedes) and amending change the target's state, so they
 * are acts written with a record (`replaces`, an amendment), and a source citation (derived_from)
 * is written with the record that rests on it.
 */
const RELATIONS = new Set<RecordLink['relation']>([
  'refines',
  'contradicts',
  'mentions',
  'builds_on',
  'debates',
  'synthesizes',
  'blocks',
  'next_action_for',
]);

function nonblank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JudgmentError('INVALID_COMMAND', `${field} must be nonblank`);
  }
  return value;
}

/** A link's id is fixed by who asked and under which command id, so a retry finds its row. */
export function linkEdgeId(principalId: string, commandId: string): string {
  return `link_${crypto
    .createHash('sha256')
    .update(canonicalizeJSON({ principalId, commandId }))
    .digest('hex')
    .slice(0, 24)}`;
}

function linkContentHash(edgeId: string, command: LinkCommand): Buffer {
  return crypto
    .createHash('sha256')
    .update(
      canonicalizeJSON({
        edgeId,
        from: command.from,
        to: command.to,
        relation: command.relation,
        reason: command.reason,
        evidenceRefs: command.evidenceRefs ?? [],
        attrs: command.attrs ?? {},
      })
    )
    .digest();
}

function assertReachable(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  refs: readonly TwinRef[],
  access: JudgmentAccess
): void {
  // The same rule a record's own links follow (judgments.ts): the ends sit in the caller's
  // admitted scopes, and an edge target has both of its ends there.
  const scopeIds = admittedScopeIds(access);
  for (const ref of refs) {
    if (!referenceExists(adapter, ref as never, scopeIds)) {
      // Echo only the caller's own input: an unavailable id reads the same whether wrong or outside scope.
      throw new JudgmentError(
        'REFERENCE_NOT_FOUND',
        `A link end is unavailable: ${ref.kind} ${ref.id}`
      );
    }
  }
}

/**
 * The link a principal already wrote under this command id, if any: a retry finds it here, with
 * what it states, so the caller can tell a retry from another link under the same id.
 */
export function findLink(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  commandId: string,
  access: JudgmentAccess
): StoredLink | null {
  const existing = getTwinEdge(adapter as never, linkEdgeId(access.principalId, commandId));
  return existing
    ? {
        edgeId: existing.edge_id,
        createdAt: existing.created_at,
        replayed: true,
        from: existing.subject_ref,
        to: existing.object_ref,
        relation: existing.edge_type,
        reason: existing.reason_text,
        evidenceRefs: (existing.evidence_refs as TwinRef[] | null) ?? [],
      }
    : null;
}

export function appendLink(
  adapter: Pick<DatabaseAdapter, 'prepare' | 'transaction' | 'transactionImmediate'>,
  command: LinkCommand,
  access: JudgmentAccess
): LinkReceipt {
  nonblank(command.commandId, 'commandId');
  nonblank(access.principalId, 'principalId');
  const reason = nonblank(command.reason, 'reason').trim();
  if (command.from?.kind !== 'memory') {
    throw new JudgmentError('INVALID_COMMAND', 'A link starts from a memory record');
  }
  nonblank(command.from.id, 'from.id');
  if (!command.to || !TARGET_KINDS.has(command.to.kind)) {
    throw new JudgmentError(
      'INVALID_COMMAND',
      'A link targets a memory record, a registry node, an observation or an edge'
    );
  }
  nonblank(command.to.id, 'to.id');
  if (!RELATIONS.has(command.relation)) {
    throw new JudgmentError('INVALID_COMMAND', `Unknown link relation: ${command.relation}`);
  }
  if (command.to.kind === 'edge' && command.relation !== 'contradicts') {
    throw new JudgmentError(
      'INVALID_COMMAND',
      'A link to an edge is a correction and takes the relation contradicts'
    );
  }
  for (const ref of command.evidenceRefs ?? []) {
    if (!EVIDENCE_KINDS.has(ref.kind)) {
      throw new JudgmentError('INVALID_COMMAND', 'Link evidence is an observation or a record');
    }
    nonblank(ref.id, 'evidence id');
  }

  const edgeId = linkEdgeId(access.principalId, command.commandId);
  const contentHash = linkContentHash(edgeId, { ...command, reason });
  const replay = (): LinkReceipt | null => {
    const existing = getTwinEdge(adapter as never, edgeId);
    if (!existing) return null;
    if (!existing.content_hash.equals(contentHash)) {
      throw new JudgmentError(
        'COMMAND_CONFLICT',
        'The command id is already bound to another link'
      );
    }
    return { edgeId, createdAt: existing.created_at, replayed: true };
  };

  assertReachable(adapter, [command.from, command.to, ...(command.evidenceRefs ?? [])], access);
  const earlier = replay();
  if (earlier) return earlier;

  const now = Date.now();
  const transaction = adapter.transactionImmediate
    ? adapter.transactionImmediate.bind(adapter)
    : adapter.transaction.bind(adapter);
  return transaction((): LinkReceipt => {
    const raced = replay();
    if (raced) return raced;
    insertTwinEdge(adapter as never, {
      edge_id: edgeId,
      edge_type: command.relation,
      subject_ref: command.from,
      object_ref: command.to,
      relation_attrs: { ...(command.attrs ?? {}), reason },
      confidence: 1.0,
      source: access.edgeSource ?? 'agent',
      agent_id: Object.hasOwn(command, 'agentId') ? (command.agentId ?? undefined) : access.agentId,
      model_run_id: command.modelRunId ?? undefined,
      request_idempotency_key: command.commandId,
      reason_text: reason,
      evidence_refs: command.evidenceRefs?.length ? command.evidenceRefs : undefined,
      content_hash: contentHash,
      created_at: now,
    });
    return { edgeId, createdAt: now, replayed: false };
  });
}
