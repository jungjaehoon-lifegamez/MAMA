/**
 * Host-built external lifecycle candidate discovery (Task B2).
 *
 * Extracted unchanged from cli/runtime/api-routes-init.ts so the gateway's
 * `task_external_candidates` read and the reconcile scheduler share ONE
 * builder. Candidate contents always come from the connector event index,
 * the ledger's support lookup and buildExternalLifecycleCandidateSet - never
 * from a model-authored snapshot.
 */
import type { PrivateConnectorPolicy } from '../connectors/private-connector-policy.js';
import type { ExternalLifecycleCandidateSet } from './external-lifecycle.js';
import {
  buildExternalLifecycleCandidateSet,
  classifyKagemushaObservation,
  type RawExternalObservation,
} from './external-lifecycle-candidates.js';
import type { OwnerActionContext } from './owner-action-effects.js';
import type { TaskLedger } from './task-ledger.js';

export type ConnectorEventAdapter = {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
};

export const MAX_RECONCILE_LIFECYCLE_DIAGNOSTICS = 100;

export interface ExternalLifecycleDiscoveryInput {
  eventIds: readonly string[];
  getAdapter: () => ConnectorEventAdapter;
  ledger: Pick<
    TaskLedger,
    'getExternalLifecycleCandidateSupport' | 'getReceiptedExternalCandidateIds'
  >;
  privateConnectorPolicy: PrivateConnectorPolicy;
  rawConnectorScope: readonly string[];
  /**
   * Exact source-partition visibility under the CURRENT owner grant. A
   * connector-only scope list is a boot-level capability, not owner
   * visibility; when the caller supplies this predicate, rows whose exact
   * (connector, channel) partition it rejects are consumed silently, exactly
   * like an unauthorized private row, and never reach a candidate.
   */
  isPartitionVisible?: (partition: { connector: string; channel: string }) => boolean;
}

/**
 * Construct the only lifecycle authority a reconcile work order (or an owner
 * run) may carry. Connector rows are parsed one by one: malformed/private-
 * unsupported evidence becomes bounded diagnostics, while a database failure
 * deliberately throws so the scheduler retains its unconsumed batch for retry.
 */
export function buildReconcileExternalLifecycleCandidates(
  input: ExternalLifecycleDiscoveryInput
): ExternalLifecycleCandidateSet {
  const eventIds = [...new Set(input.eventIds)];
  if (eventIds.length === 0) {
    return Object.freeze({
      bindingCandidates: Object.freeze([]),
      lifecycleCandidates: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
  }
  const placeholders = eventIds.map(() => '?').join(',');
  const rows = input
    .getAdapter()
    .prepare(
      `SELECT event_index_id, source_connector, source_type, source_id, channel, content_hash,
            source_timestamp_ms, operator_ingest_seq, operator_observation_seq, metadata_json
       FROM connector_event_index WHERE event_index_id IN (${placeholders})`
    )
    .all(...eventIds) as RawExternalObservation[];
  const eventOrder = new Map(eventIds.map((eventId, index) => [eventId, index]));
  rows.sort(
    (left, right) =>
      (eventOrder.get(String(left.event_index_id)) ?? Number.MAX_SAFE_INTEGER) -
      (eventOrder.get(String(right.event_index_id)) ?? Number.MAX_SAFE_INTEGER)
  );

  // This is intentionally limited to the boot-owned private capability and
  // the same raw connector scope projected into worker envelopes. Do not
  // discover connector state here: a reconcile run must not widen authority
  // after startup, especially from a historical connector row.
  const mayProjectKagemushaLifecycle =
    input.privateConnectorPolicy.isEnabled('kagemusha') &&
    input.rawConnectorScope.includes('kagemusha');
  const observations = [] as NonNullable<
    ReturnType<typeof classifyKagemushaObservation>['observation']
  >[];
  const diagnostics: NonNullable<ReturnType<typeof classifyKagemushaObservation>['diagnostic']>[] =
    [];
  const invalidEventIds = new Set<string>();
  const suppressedEventIds = new Set<string>();
  for (const row of rows) {
    const partitionHidden =
      input.isPartitionVisible !== undefined &&
      (typeof row.source_connector !== 'string' ||
        typeof row.channel !== 'string' ||
        !input.isPartitionVisible({ connector: row.source_connector, channel: row.channel }));
    if (
      (row.source_connector === 'kagemusha' && !mayProjectKagemushaLifecycle) ||
      partitionHidden
    ) {
      // Do not emit diagnostics for a denied private row: even a bounded
      // diagnostic is an unnecessary cross-boundary signal in a generic board
      // workorder. The scheduler consumes its matching private partition.
      if (typeof row.event_index_id === 'string') {
        suppressedEventIds.add(row.event_index_id);
      }
      continue;
    }
    const classified = classifyKagemushaObservation(row);
    if (classified.observation) {
      observations.push(classified.observation);
    } else if (classified.diagnostic) {
      diagnostics.push(classified.diagnostic);
      invalidEventIds.add(classified.diagnostic.eventId);
    }
  }
  const candidateEventIds = eventIds.filter(
    (eventId) => !invalidEventIds.has(eventId) && !suppressedEventIds.has(eventId)
  );
  const support = input.ledger.getExternalLifecycleCandidateSupport(
    candidateEventIds,
    observations.map((observation) => observation.externalSourceId)
  );
  const unreceipted = buildExternalLifecycleCandidateSet({
    eventIds: candidateEventIds,
    observations,
    ...support,
    receiptedCandidateIds: new Set(),
  });
  const receiptedCandidateIds = input.ledger.getReceiptedExternalCandidateIds([
    ...unreceipted.bindingCandidates.map((candidate) => candidate.candidateId),
    ...unreceipted.lifecycleCandidates.map((candidate) => candidate.candidateId),
  ]);
  const built = buildExternalLifecycleCandidateSet({
    eventIds: candidateEventIds,
    observations,
    ...support,
    receiptedCandidateIds,
  });
  return Object.freeze({
    bindingCandidates: built.bindingCandidates,
    lifecycleCandidates: built.lifecycleCandidates,
    diagnostics: Object.freeze(
      [...diagnostics, ...built.diagnostics].slice(0, MAX_RECONCILE_LIFECYCLE_DIAGNOSTICS)
    ),
  });
}

export interface OwnerExternalLifecycleAttestation {
  candidates: ExternalLifecycleCandidateSet;
  attested: number;
  alreadyAttested: number;
}

/**
 * Discover AND attest candidates for a verified owner run in one step. The
 * caller (the gateway) has already authenticated the owner, verified the
 * current model run / envelope, and bounded `eventIds` to what that owner may
 * see; `isPartitionVisible` carries that exact grant into row selection.
 * Everything stored comes from the same host builder as Board reconciliation.
 */
export function attestOwnerExternalLifecycleCandidates(
  input: ExternalLifecycleDiscoveryInput & {
    context: OwnerActionContext;
    ledger: ExternalLifecycleDiscoveryInput['ledger'] &
      Pick<TaskLedger, 'attestOwnerActionCandidates'>;
  }
): OwnerExternalLifecycleAttestation {
  const candidates = buildReconcileExternalLifecycleCandidates(input);
  const { attested, alreadyAttested } = input.ledger.attestOwnerActionCandidates(
    input.context,
    candidates
  );
  return { candidates, attested, alreadyAttested };
}
