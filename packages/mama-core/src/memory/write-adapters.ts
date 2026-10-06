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
import { prepareDecisionEmbedding } from '../db-manager.js';
import type { DatabaseAdapter, DatabaseInstance, DecisionInput } from '../db-manager.js';
import { appendJudgment } from '../knowledge/judgments.js';
import type { JudgmentAccess } from '../knowledge/judgments.js';
import type { JudgmentAmendment, JsonValue, RecordLink } from './judgment-types.js';
import type { MemoryScopeRef } from './types.js';
import type { NormalizedMemoryProvenance } from './provenance.js';

/** Principal label for writes that carry no authenticated identity. */
const UNSIGNED_PRINCIPAL = 'unsigned-local';

/** Access for a caller with no signed identity: it is admitted to exactly the
 * scopes it declared, nothing more. */
export function unsignedWriteAccess(scopes: readonly MemoryScopeRef[]): JudgmentAccess {
  return {
    principalId: UNSIGNED_PRINCIPAL,
    agentId: UNSIGNED_PRINCIPAL,
    scopes: [...scopes],
    // Not a principal and not a caller of actions: this access exists for the
    // direct-write path below dispatch. Empty is what it can truthfully claim,
    // and if it ever did reach dispatch every action would be denied.
    actions: [],
  };
}

/**
 * Access derived from normalized write provenance — the legacy direct-write
 * path, where the caller is the process itself and declares its own scopes.
 * Unified-action writes do NOT come through here: dispatch passes the real
 * `JudgmentAccess` (the call authority) straight to `appendJudgment`.
 */
export function writeAccessForProvenance(
  provenance: NormalizedMemoryProvenance,
  requestedScopes: readonly MemoryScopeRef[]
): JudgmentAccess {
  const identity = provenance.agent_id ?? provenance.actor;
  return {
    principalId: identity,
    agentId: provenance.agent_id ?? identity,
    scopes: [...requestedScopes],
    // Same as above: provenance names who wrote, not what they may call.
    actions: [],
  };
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
  options: { adapter: DatabaseInstance }
): Promise<{ recordId: string; commandId: string }> {
  const adapter = options.adapter;
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
    { adapter, embedder: null }
  );
  return { recordId: receipt.recordId, commandId: receipt.commandId };
}
