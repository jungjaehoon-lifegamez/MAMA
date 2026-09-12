import { randomUUID } from 'node:crypto';

import { isObservationVersionVisible } from '../connectors/observation-visibility.js';
import { getAdapter } from '../db-manager.js';
import { assertTwinRefsVisible, TwinRefNotVisibleError } from '../edges/ref-validation.js';
import type { MemoryScopeRef } from '../memory/types.js';
import {
  addAliases,
  createNode,
  currentIdentityRevision,
  mergeNodes,
  RegistryError,
  resolveNodeById,
} from './store.js';

type Endpoint = 'from' | 'to';
type Db = ReturnType<typeof getAdapter>;

interface CorrectionBase {
  commandId: string;
  expectedRevision: number;
  reason: string;
  scopes?: readonly MemoryScopeRef[];
  evidence?: ReadonlyArray<{ kind: 'observation'; id: string }>;
}

export type IdentityCorrection =
  | (CorrectionBase & {
      operation: 'add_alias';
      nodeId: string;
      alias: string;
    })
  | (CorrectionBase & {
      operation: 'merge';
      survivorId: string;
      memberIds: readonly string[];
    })
  | (CorrectionBase & {
      operation: 'split';
      parentId: string;
      children: ReadonlyArray<{ clientKey?: string; name: string; aliases?: readonly string[] }>;
      assignments: readonly IdentityCorrectionAssignment[];
    })
  | (CorrectionBase & {
      operation: 'assign_refs';
      parentId: string;
      assignments: readonly IdentityCorrectionAssignment[];
    });

interface IdentityCorrectionAssignmentBase {
  edgeId: string;
  endpoint: Endpoint;
}

export type IdentityCorrectionAssignment = IdentityCorrectionAssignmentBase &
  (
    | { targetNodeId: string | null; targetClientKey?: never }
    | { targetClientKey: string; targetNodeId?: never }
  );

export interface IdentityCorrectionReceipt {
  commandId: string;
  identityRevision: number;
  children: Array<{ clientKey: string; ref: { kind: 'registry'; id: string } }>;
  changedSlots: Array<{ edgeId: string; endpoint: Endpoint }>;
  unresolved: Array<{ edgeId: string; endpoint: Endpoint }>;
}

export interface TrustedIdentityCorrectionContext {
  principalId: string;
  agentId: string;
  scopes: readonly MemoryScopeRef[];
  connectors: readonly string[];
  channels?: Readonly<Record<string, readonly string[]>>;
}

export interface IdentityAssignment {
  edgeId: string;
  endpoint: Endpoint;
  originalRef: { kind: string; id: string };
  resolvedRef: { kind: 'registry'; id: string } | null;
  identityRevision: number;
  commandId: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

function scopeKey(scope: MemoryScopeRef): string {
  return `${scope.kind}\0${scope.id}`;
}

function requireTrustedContext(trusted: TrustedIdentityCorrectionContext): void {
  if (!trusted.principalId.trim()) {
    throw new RegistryError('invalid_principal', 'A trusted principal is required');
  }
  if (!trusted.agentId.trim()) {
    throw new RegistryError('invalid_agent', 'A trusted agent is required');
  }
  if (trusted.scopes.length === 0) {
    throw new RegistryError('invalid_scope', 'At least one signed scope is required');
  }
  for (const scope of trusted.scopes) {
    if (!scope.id.trim()) {
      throw new RegistryError('invalid_scope', 'Signed scope ids must be nonblank');
    }
  }
}

function effectiveScopes(
  correction: IdentityCorrection,
  trusted: TrustedIdentityCorrectionContext
): readonly MemoryScopeRef[] {
  requireTrustedContext(trusted);
  const requested = correction.scopes ?? trusted.scopes;
  if (requested.length === 0) {
    throw new RegistryError('invalid_scope', 'At least one effective scope is required');
  }
  const allowed = new Set(trusted.scopes.map(scopeKey));
  for (const scope of requested) {
    if (!scope.id.trim() || !allowed.has(scopeKey(scope))) {
      throw new RegistryError('scope_denied', 'Requested registry scope is unavailable');
    }
  }
  return [...new Map(requested.map((scope) => [scopeKey(scope), scope])).values()];
}

function genericTargetUnavailable(): never {
  throw new RegistryError('registry_target_unavailable', 'Registry target is unavailable');
}

function nodeBindings(db: Db, nodeId: string): MemoryScopeRef[] {
  return db
    .prepare(
      'SELECT scope_kind AS kind, scope_id AS id FROM registry_scope_bindings WHERE node_id = ?'
    )
    .all(nodeId) as MemoryScopeRef[];
}

function requireVisibleNode(db: Db, nodeId: string, scopes: readonly MemoryScopeRef[]): void {
  const node = resolveNodeById(nodeId);
  if (!node) {
    genericTargetUnavailable();
  }
  const allowed = new Set(scopes.map(scopeKey));
  if (!nodeBindings(db, nodeId).some((scope) => allowed.has(scopeKey(scope)))) {
    genericTargetUnavailable();
  }
}

function requireFullNodeAuthority(db: Db, nodeId: string, scopes: readonly MemoryScopeRef[]): void {
  requireVisibleNode(db, nodeId, scopes);
  const allowed = new Set(scopes.map(scopeKey));
  const bindings = nodeBindings(db, nodeId);
  if (bindings.length === 0 || bindings.some((scope) => !allowed.has(scopeKey(scope)))) {
    genericTargetUnavailable();
  }
}

function requireVisibleEdge(
  db: Db,
  edgeId: string,
  trusted: TrustedIdentityCorrectionContext,
  scopes: readonly MemoryScopeRef[]
): void {
  try {
    assertTwinRefsVisible(db, [{ kind: 'edge', id: edgeId }], {
      scopes: [...scopes],
      connectors: [...trusted.connectors],
      principalId: trusted.principalId,
      agentId: trusted.agentId,
      ...(trusted.channels ? { channels: trusted.channels } : {}),
    });
  } catch (error) {
    if (error instanceof TwinRefNotVisibleError) {
      genericTargetUnavailable();
    }
    throw error;
  }
}

function edgeSlot(db: Db, edgeId: string, endpoint: Endpoint): { kind: string; id: string } {
  const row = db
    .prepare(
      'SELECT subject_kind, subject_id, object_kind, object_id FROM twin_edges WHERE edge_id = ?'
    )
    .get(edgeId) as
    | { subject_kind: string; subject_id: string; object_kind: string; object_id: string }
    | undefined;
  if (!row) {
    genericTargetUnavailable();
  }
  return endpoint === 'from'
    ? { kind: row.subject_kind, id: row.subject_id }
    : { kind: row.object_kind, id: row.object_id };
}

function validateEvidence(
  db: Db,
  correction: IdentityCorrection,
  scopes: readonly MemoryScopeRef[],
  trusted: TrustedIdentityCorrectionContext
): void {
  if ((correction.evidence?.length ?? 0) > 0) {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observation_versions'")
      .get();
    if (!table) {
      throw new RegistryError(
        'missing_observation_schema',
        'observation_versions is required to validate supplied evidence'
      );
    }
  }
  for (const ref of correction.evidence ?? []) {
    if (
      ref.kind !== 'observation' ||
      !isObservationVersionVisible(db, ref.id, {
        principalId: trusted.principalId,
        agentId: trusted.agentId,
        scopes,
        connectors: trusted.connectors,
        channels: trusted.channels,
      })
    ) {
      throw new RegistryError(
        'correction_evidence_unavailable',
        'Correction evidence is unavailable'
      );
    }
  }
}

function validateAccess(
  db: Db,
  correction: IdentityCorrection,
  scopes: readonly MemoryScopeRef[],
  trusted: TrustedIdentityCorrectionContext
): void {
  if (correction.operation === 'add_alias') {
    requireVisibleNode(db, correction.nodeId, scopes);
  }
  if (correction.operation === 'merge') {
    requireFullNodeAuthority(db, correction.survivorId, scopes);
    for (const memberId of correction.memberIds) {
      requireFullNodeAuthority(db, memberId, scopes);
    }
  }
  if (correction.operation === 'split' || correction.operation === 'assign_refs') {
    requireFullNodeAuthority(db, correction.parentId, scopes);
    for (const assignment of correction.assignments) {
      requireVisibleEdge(db, assignment.edgeId, trusted, scopes);
      if (assignment.targetNodeId !== undefined && assignment.targetNodeId !== null) {
        requireVisibleNode(db, assignment.targetNodeId, scopes);
      }
    }
  }
  validateEvidence(db, correction, scopes, trusted);
}

function parseScopes(value: unknown): MemoryScopeRef[] {
  if (typeof value !== 'string') {
    throw new Error('registry_corrections.scope_json must be JSON text');
  }
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (scope) =>
        !scope ||
        typeof scope !== 'object' ||
        typeof (scope as { kind?: unknown }).kind !== 'string' ||
        typeof (scope as { id?: unknown }).id !== 'string'
    )
  ) {
    throw new Error('registry_corrections.scope_json must contain scope references');
  }
  return parsed as MemoryScopeRef[];
}

function validateCommon(correction: IdentityCorrection): void {
  if (!correction.commandId.trim()) {
    throw new RegistryError('invalid_command', 'Correction command id must be nonblank');
  }
  if (!Number.isSafeInteger(correction.expectedRevision) || correction.expectedRevision < 0) {
    throw new RegistryError(
      'invalid_revision',
      'Correction revision must be a nonnegative integer'
    );
  }
  if (!correction.reason.trim()) {
    throw new RegistryError('missing_reason', 'A correction reason is required');
  }
  if (correction.operation === 'merge' && correction.memberIds.length === 0) {
    throw new RegistryError('invalid_merge', 'A merge requires at least one member');
  }
  if (correction.operation === 'split') {
    if (correction.children.length < 2) {
      throw new RegistryError('split_too_small', 'A split requires at least two children');
    }
    const keys = correction.children.map((child, index) => child.clientKey ?? String(index));
    if (keys.some((key) => !key.trim()) || new Set(keys).size !== keys.length) {
      throw new RegistryError('invalid_client_key', 'Split child client keys must be unique');
    }
    const knownKeys = new Set(keys);
    for (const assignment of correction.assignments) {
      if (assignment.targetClientKey !== undefined && !knownKeys.has(assignment.targetClientKey)) {
        throw new RegistryError('invalid_client_key', 'Split assignment client key is unknown');
      }
    }
  }
  if (
    correction.operation === 'assign_refs' &&
    correction.assignments.some((assignment) => assignment.targetClientKey !== undefined)
  ) {
    throw new RegistryError('invalid_client_key', 'Client keys are valid only during split');
  }
}

export function appendIdentityCorrection(
  correction: IdentityCorrection,
  trusted: TrustedIdentityCorrectionContext
): IdentityCorrectionReceipt {
  validateCommon(correction);
  const db = getAdapter();
  const requestedScopes = effectiveScopes(correction, trusted);
  const payloadJson = canonicalJson(correction);

  return db.transaction(() => {
    const replay = db
      .prepare(
        `SELECT principal_id, agent_id, payload_json, scope_json, receipt_json
           FROM registry_corrections WHERE command_id = ?`
      )
      .get(correction.commandId) as
      | {
          principal_id: string;
          agent_id: string;
          payload_json: string;
          scope_json: string;
          receipt_json: string;
        }
      | undefined;
    if (replay) {
      if (
        replay.principal_id !== trusted.principalId ||
        replay.agent_id !== trusted.agentId ||
        replay.payload_json !== payloadJson ||
        replay.scope_json !== canonicalJson(requestedScopes)
      ) {
        throw new RegistryError(
          'COMMAND_CONFLICT',
          'Correction command has different authority or payload'
        );
      }
      const persistedScopes = parseScopes(replay.scope_json);
      validateAccess(db, correction, persistedScopes, trusted);
      return JSON.parse(replay.receipt_json) as IdentityCorrectionReceipt;
    }

    const current = currentIdentityRevision();
    if (current !== correction.expectedRevision) {
      throw new RegistryError(
        'REVISION_CONFLICT',
        `Expected identity revision ${correction.expectedRevision}, current revision is ${current}`
      );
    }
    validateAccess(db, correction, requestedScopes, trusted);

    const committedRevision = current + 1;
    const now = Date.now();
    const children: Array<{ clientKey: string; ref: { kind: 'registry'; id: string } }> = [];

    if (correction.operation === 'add_alias') {
      addAliases(correction.nodeId, [correction.alias], requestedScopes);
    } else if (correction.operation === 'merge') {
      for (const memberId of correction.memberIds) {
        mergeNodes({ loser: memberId, survivor: correction.survivorId, reason: correction.reason });
      }
    } else if (correction.operation === 'split') {
      for (const [index, child] of correction.children.entries()) {
        const childId = createNode({
          kind: resolveNodeById(correction.parentId)?.kind ?? '',
          name: child.name,
          aliases: child.aliases,
          parentId: correction.parentId,
          note: correction.reason,
          scopes: requestedScopes,
        });
        children.push({
          clientKey: child.clientKey ?? String(index),
          ref: { kind: 'registry', id: childId },
        });
      }
    }

    const childIds = new Map(children.map((child) => [child.clientKey, child.ref.id]));
    const resolvedAssignments =
      correction.operation === 'split' || correction.operation === 'assign_refs'
        ? correction.assignments.map((assignment) => ({
            edgeId: assignment.edgeId,
            endpoint: assignment.endpoint,
            targetNodeId:
              assignment.targetClientKey !== undefined
                ? (childIds.get(assignment.targetClientKey) ?? genericTargetUnavailable())
                : assignment.targetNodeId === undefined
                  ? genericTargetUnavailable()
                  : assignment.targetNodeId,
          }))
        : [];

    const receipt: IdentityCorrectionReceipt = {
      commandId: correction.commandId,
      identityRevision: committedRevision,
      children,
      changedSlots:
        correction.operation === 'split' || correction.operation === 'assign_refs'
          ? resolvedAssignments.map(({ edgeId, endpoint }) => ({ edgeId, endpoint }))
          : [],
      unresolved:
        correction.operation === 'split' || correction.operation === 'assign_refs'
          ? resolvedAssignments
              .filter((assignment) => assignment.targetNodeId === null)
              .map(({ edgeId, endpoint }) => ({ edgeId, endpoint }))
          : [],
    };

    db.prepare(
      `INSERT INTO registry_corrections
       (command_id, operation, expected_revision, committed_revision, principal_id, agent_id,
        origin, payload_json, reason, evidence_json, scope_json, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'trusted', ?, ?, ?, ?, ?, ?)`
    ).run(
      correction.commandId,
      correction.operation,
      correction.expectedRevision,
      committedRevision,
      trusted.principalId,
      trusted.agentId,
      payloadJson,
      correction.reason.trim(),
      canonicalJson(correction.evidence ?? []),
      canonicalJson(requestedScopes),
      canonicalJson(receipt),
      now
    );

    if (correction.operation === 'split' || correction.operation === 'assign_refs') {
      for (const assignment of resolvedAssignments) {
        const original = edgeSlot(db, assignment.edgeId, assignment.endpoint);
        db.prepare(
          `INSERT INTO registry_ref_assignments
           (command_id, edge_id, endpoint, original_kind, original_id, resolved_node_id,
            committed_revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          correction.commandId,
          assignment.edgeId,
          assignment.endpoint,
          original.kind,
          original.id,
          assignment.targetNodeId,
          committedRevision,
          now
        );
      }
    }
    db.prepare('UPDATE registry_identity_state SET revision = ? WHERE singleton = 1').run(
      committedRevision
    );
    return receipt;
  });
}

export function readIdentityAssignments(
  edgeId: string,
  adapter: Pick<Db, 'prepare'> = getAdapter()
): IdentityAssignment[] {
  const rows = adapter
    .prepare(
      `SELECT command_id, edge_id, endpoint, original_kind, original_id, resolved_node_id,
              committed_revision
         FROM registry_ref_assignments
        WHERE edge_id = ?
          AND committed_revision = (
            SELECT MAX(current_assignment.committed_revision)
              FROM registry_ref_assignments current_assignment
             WHERE current_assignment.edge_id = registry_ref_assignments.edge_id
               AND current_assignment.endpoint = registry_ref_assignments.endpoint
          )
        ORDER BY endpoint`
    )
    .all(edgeId) as Array<{
    command_id: string;
    edge_id: string;
    endpoint: Endpoint;
    original_kind: string;
    original_id: string;
    resolved_node_id: string | null;
    committed_revision: number;
  }>;
  return rows.map((row) => ({
    edgeId: row.edge_id,
    endpoint: row.endpoint,
    originalRef: { kind: row.original_kind, id: row.original_id },
    resolvedRef:
      row.resolved_node_id === null ? null : { kind: 'registry', id: row.resolved_node_id },
    identityRevision: row.committed_revision,
    commandId: row.command_id,
  }));
}

export function newCorrectionCommandId(): string {
  return `correction_${randomUUID().replace(/-/g, '')}`;
}
