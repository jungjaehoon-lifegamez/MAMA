/**
 * Mechanical adapters between the public memory write surfaces and the
 * knowledge command boundary.
 *
 * Every write funnels through `appendJudgment` (or `ingestSource` for raw
 * evidence): the adapter builds exactly one command, derives honest access —
 * never fabricating authority the caller did not present — and maps the receipt
 * back to the legacy result shape.
 */

import crypto from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import { buildMemoryScopeId, initDB, getAdapter, prepareDecisionEmbedding } from '../db-manager.js';
import type { DatabaseAdapter, DecisionInput } from '../db-manager.js';
import { appendJudgment } from '../knowledge/judgments.js';
import type { JudgmentAccess } from '../knowledge/judgments.js';
import type {
  JudgmentAmendment,
  JudgmentProjections,
  JsonValue,
  RecordLink,
} from './judgment-types.js';
import type { MemoryScopeRef } from './types.js';
import type { NormalizedMemoryProvenance } from './provenance.js';

/** Principal label for writes that carry no authenticated identity. */
const UNSIGNED_PRINCIPAL = 'unsigned-local';

/** Access for a caller with no signed identity: it is admitted to exactly the
 * scopes it declared, nothing more. */
export function unsignedWriteAccess(scopes: readonly MemoryScopeRef[]): JudgmentAccess {
  return { principalId: UNSIGNED_PRINCIPAL, agentId: UNSIGNED_PRINCIPAL, scopes: [...scopes] };
}

/**
 * Access derived from normalized write provenance.
 *
 * Unsigned callers self-declare their scopes, so admission covers the requested
 * scopes and the record's `agent_id` stays empty (honest unsigned write).
 * Trusted envelopes (`authoritativeScopes`) admit only the intersection with
 * the requested scopes — an envelope must never widen the write beyond what the
 * caller asked to bind.
 */
export function writeAccessForProvenance(
  provenance: NormalizedMemoryProvenance,
  requestedScopes: readonly MemoryScopeRef[],
  authoritativeScopes?: readonly MemoryScopeRef[]
): JudgmentAccess {
  const identity = provenance.agent_id ?? provenance.actor;
  const admitted = authoritativeScopes
    ? authoritativeScopes.filter((scope) =>
        requestedScopes.some((req) => req.kind === scope.kind && req.id === scope.id)
      )
    : [...requestedScopes];
  return { principalId: identity, agentId: provenance.agent_id ?? identity, scopes: admitted };
}

/** Scope refs currently bound to a memory row — the partition a write into
 * that row must be admitted to. */
export function boundScopesOf(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  memoryId: string
): MemoryScopeRef[] {
  return adapter
    .prepare(
      `SELECT ms.kind, ms.external_id
       FROM memory_scope_bindings msb
       JOIN memory_scopes ms ON ms.id = msb.scope_id
       WHERE msb.memory_id = ?
       ORDER BY msb.is_primary DESC`
    )
    .all(memoryId)
    .map((row) => {
      const record = row as { kind: string; external_id: string };
      return { kind: record.kind as MemoryScopeRef['kind'], id: record.external_id };
    });
}

/**
 * Fail-first visibility check for explicitly authored relationship targets,
 * preserving the legacy error contract.
 *
 * Trusted envelopes check visibility strictly inside admitted scopes (unbound
 * legacy rows are not reachable — same as the pre-boundary envelope check).
 * Unsigned callers keep the legacy existence check for the original error
 * text; scope admission is then enforced by the command boundary itself.
 */
export function assertRelationshipTargetsVisible(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  targetIds: readonly string[],
  admittedScopes: readonly MemoryScopeRef[],
  trustedEnvelope: boolean
): void {
  for (const targetId of targetIds) {
    if (trustedEnvelope) {
      const scopeIds = admittedScopes.map((scope) => buildMemoryScopeId(scope.kind, scope.id));
      const placeholders = scopeIds.map(() => '?').join(', ');
      const visible =
        scopeIds.length > 0 &&
        adapter
          .prepare(
            `SELECT 1 FROM decisions d
             JOIN memory_scope_bindings b ON b.memory_id = d.id
             WHERE d.id = ? AND b.scope_id IN (${placeholders}) LIMIT 1`
          )
          .get(targetId, ...scopeIds) !== undefined;
      if (!visible) {
        const denied = new Error('Relationship target is unavailable') as Error & {
          code?: string;
        };
        denied.code = 'relationship_target_unavailable';
        throw denied;
      }
      continue;
    }
    const target = adapter.prepare('SELECT id FROM decisions WHERE id = ?').get(targetId);
    if (!target) {
      throw new Error(`mama.save() relationship target does not exist: ${targetId}`);
    }
  }
}

export interface ExplicitRelationship {
  type: string;
  targetId: string;
}

const LINK_RELATIONS = new Set<RecordLink['relation']>([
  'supersedes',
  'refines',
  'contradicts',
  'mentions',
  'derived_from',
  'builds_on',
  'debates',
  'synthesizes',
  'blocks',
  'next_action_for',
  'case_member',
]);

/**
 * Map deduplicated legacy relationships onto command fields.
 *
 * Trusted envelopes get the authored form: `supersedes` targets become
 * scope-checked `replaces`, and link-able relations also enter the twin edge
 * graph as explicit `links` — both fail closed inside the boundary.
 *
 * Unsigned callers keep the legacy contract: the adapter already checked that
 * each target exists, so relationships are written only as `decision_edges`
 * projection rows and `supersedes` targets are moved out of current truth
 * through the `supersedeTargets` projection — never as scope-checked authored
 * links the caller was not admitted to.
 */
export function relationshipsToCommandFields(
  relationships: readonly ExplicitRelationship[],
  options?: { trusted?: boolean }
): {
  links: RecordLink[];
  replaces: Array<{ id: string; reason: string }>;
  decisionEdges: NonNullable<JudgmentProjections['decisionEdges']>;
  supersedeTargets: string[];
} {
  const trusted = options?.trusted === true;
  const links: RecordLink[] = [];
  const replaces: Array<{ id: string; reason: string }> = [];
  const supersedeTargets: string[] = [];
  const decisionEdges: Array<{
    targetId: string;
    relationship: string;
    reason?: string | null;
    weight?: number;
  }> = [];
  const seen = new Set<string>();
  for (const relationship of relationships) {
    const key = `${relationship.type}:${relationship.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = `Explicit ${relationship.type} reference in reasoning`;
    decisionEdges.push({
      targetId: relationship.targetId,
      relationship: relationship.type,
      reason,
      weight: 1,
    });
    if (relationship.type === 'supersedes') {
      if (trusted) {
        replaces.push({ id: relationship.targetId, reason });
      } else {
        supersedeTargets.push(relationship.targetId);
      }
      continue;
    }
    if (trusted && LINK_RELATIONS.has(relationship.type as RecordLink['relation'])) {
      links.push({
        relation: relationship.type as RecordLink['relation'],
        target: { kind: 'memory', id: relationship.targetId },
      });
    }
  }
  return { links, replaces, decisionEdges, supersedeTargets };
}

/**
 * Embedder for the command boundary that preserves the legacy enhanced
 * embedding input.
 */
export function commandEmbedder(decision: DecisionInput): {
  embed(text: string, role: 'query' | 'passage'): Promise<Float32Array | null>;
} {
  return { embed: () => prepareDecisionEmbedding(decision) };
}

export interface OutcomeAmendmentInput {
  outcome?: string | null;
  failureReason?: string | null;
  limitation?: string | null;
  confidence?: number | null;
  durationDays?: number | null;
  /** Extra fields written on the amendment record's payload for audit. */
  payload?: Record<string, JsonValue>;
  /** Callers that can name their own command id get replay for free. */
  commandId?: string;
  recordedAt?: number;
  eventReason?: string;
}

/**
 * Append one judgment record carrying an authored outcome change and apply the
 * maintained `decisions` projection columns on the target in the same
 * transaction. Identical payloads on the same target replay the stored receipt
 * instead of appending a second record.
 */
export async function appendOutcomeAmendment(
  decisionId: string,
  input: OutcomeAmendmentInput,
  options?: { adapter?: DatabaseAdapter }
): Promise<{ recordId: string; commandId: string }> {
  await initDB();
  const adapter = options?.adapter ?? getAdapter();
  const target = adapter.prepare('SELECT id, topic FROM decisions WHERE id = ?').get(decisionId) as
    | { id: string; topic: string }
    | undefined;
  if (!target) {
    throw new Error(`Decision not found: ${decisionId}`);
  }
  const scopes = boundScopesOf(adapter, decisionId);
  const payload: Record<string, JsonValue> = {
    amended: decisionId,
    outcome: input.outcome ?? null,
    failure_reason: input.failureReason ?? null,
    limitation: input.limitation ?? null,
    confidence: input.confidence ?? null,
    duration_days: input.durationDays ?? null,
    ...(input.payload ?? {}),
  };
  const commandId =
    input.commandId ??
    `outcome:${decisionId}:${crypto
      .createHash('sha256')
      .update(canonicalizeJSON(payload))
      .digest('hex')
      .slice(0, 16)}`;
  const amendment: JudgmentAmendment = { target: { kind: 'memory', id: decisionId } };
  if (input.outcome !== undefined) amendment.outcome = input.outcome;
  if (input.failureReason !== undefined) amendment.failureReason = input.failureReason;
  if (input.limitation !== undefined) amendment.limitation = input.limitation;
  if (input.confidence !== undefined && input.confidence !== null) {
    amendment.confidence = input.confidence;
  }
  if (input.durationDays !== undefined) amendment.durationDays = input.durationDays;
  const receipt = await appendJudgment(
    {
      commandId,
      // Audit records point at the amended memory through the 'amends' link
      // rather than sharing its topic, so they never enter the topic's
      // evolution candidate pool or current-truth recall.
      topic: `judgment/${decisionId}`,
      summary: `Outcome ${input.outcome ?? 'update'} recorded for ${decisionId}`,
      ...(input.failureReason || input.limitation
        ? { reasoning: (input.failureReason ?? input.limitation)! }
        : {}),
      recordKind: 'judgment',
      payload,
      scopes,
      agentId: null,
      links: [
        {
          relation: 'amends' as RecordLink['relation'],
          target: { kind: 'memory', id: decisionId },
        },
      ],
      amends: [amendment],
      record: { kind: 'fact', status: 'active', summary: `Outcome ${input.outcome ?? 'update'}` },
      ...(input.recordedAt !== undefined ? { recordedAt: input.recordedAt } : {}),
      event: { reason: input.eventReason ?? `outcome amendment for ${decisionId}` },
    },
    unsignedWriteAccess(scopes),
    { adapter }
  );
  return { recordId: receipt.recordId, commandId: receipt.commandId };
}
