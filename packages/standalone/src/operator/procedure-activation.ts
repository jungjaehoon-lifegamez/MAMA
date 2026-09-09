import { createHash } from 'node:crypto';
import { procedureScopeKey, type ProcedureAccess, type ProcedureStore } from './procedure-store.js';
import type { OwnerEventActivation, OwnerEventBatch } from './owner-event-inbox.js';

/** TG-04/TG-05: authority is supplied by the host before any private metadata is rendered. */
export function resolveProcedureActivation(
  store: ProcedureStore,
  access: ProcedureAccess,
  activation: OwnerEventActivation
): OwnerEventActivation {
  const scopeKey = procedureScopeKey(access);
  if (
    [activation.procedureRef, activation.queuedProcedureRef].some(
      (ref) => ref?.scopeKey !== undefined && ref.scopeKey !== scopeKey
    )
  )
    return unavailableActivation(activation);
  if (!activation.procedureRef) {
    // Only a host-admitted body snapshot is imported. Connector text is never an import input.
    if (activation.procedure.length === 0) return activation;
    if (!access.channelId) return unavailableActivation(activation);
    const snapshot = JSON.stringify({
      triggerId: activation.triggerId,
      kind: activation.kind,
      memoryQuery: activation.memoryQuery,
      procedure: activation.procedure,
      requiredEvidence: activation.requiredEvidence,
    });
    const snapshotHash = createHash('sha256').update(snapshot).digest('hex');
    const channelHash = createHash('sha256').update(access.channelId).digest('hex');
    const id = `legacy-trigger:${activation.triggerId}:${channelHash}`;
    try {
      const imported =
        store.getLegacyTriggerBinding(activation.triggerId, access) ??
        store.importLegacyTrigger(
          {
            id,
            expectedRevision: 0,
            correctionId: `legacy-import:${id}:${snapshotHash}`,
            title: activation.kind || activation.triggerId,
            description: activation.memoryQuery,
            whenToUse: 'When this existing trigger matches in its authorized channel',
            whenNotToUse: 'Outside this trigger match and authorized channel',
            body: activation.procedure
              .map((step) => `${step.action}: ${step.description}`)
              .join('\n'),
            expectedResults: [],
            originalInstruction: snapshot,
            scope: {
              ownerScope: access.ownerScope,
              projectId: access.projectId,
              channelIds: [access.channelId],
            },
            sourceRefs: [...activation.requiredEvidence],
            origin: { id, hash: snapshotHash },
          },
          access,
          { triggerId: activation.triggerId, snapshotHash }
        );
      activation = {
        ...activation,
        procedureRef: { id: imported.id, revision: imported.revision, scopeKey: imported.scopeKey },
        queuedProcedureRef: {
          id: imported.id,
          revision: imported.revision,
          scopeKey: imported.scopeKey,
        },
      };
    } catch {
      return unavailableActivation(activation);
    }
  }
  const queued = activation.queuedProcedureRef ?? activation.procedureRef;
  if (!queued) return unavailableActivation(activation);
  const original = store.read(queued.id, access, queued.revision);
  const current = original ? store.read(queued.id, access) : null;
  if (!original || !current) {
    return {
      triggerId: activation.triggerId,
      kind: '',
      memoryQuery: '',
      procedure: [],
      requiredEvidence: [],
      procedureRef: activation.procedureRef,
      queuedProcedureRef: { ...queued, scopeKey },
      availability: 'unavailable',
      resolutionReason: 'procedure_unavailable',
    };
  }
  return {
    triggerId: activation.triggerId,
    kind: current.title,
    memoryQuery: current.description,
    procedureRef: { id: current.id, revision: current.revision, scopeKey },
    queuedProcedureRef: { ...queued, scopeKey },
    availability: 'available',
    resolutionReason:
      queued.revision === current.revision
        ? 'queued_revision_current'
        : 'current_authorized_revision',
    procedure: [
      {
        action: 'apply_procedure',
        description: [
          `Use when: ${current.whenToUse}`,
          `Do not use when: ${current.whenNotToUse}`,
          current.body,
          `Expected results: ${current.expectedResults.join('; ')}`,
        ].join('\n'),
      },
    ],
    requiredEvidence: [...current.sourceRefs],
  };
}

/** TG-06: recheck revocation without changing an already admitted attempt's revision. */
export function assertActiveProcedureActivations(
  store: ProcedureStore,
  access: ProcedureAccess,
  batch: Pick<OwnerEventBatch, 'activations'>
): void {
  for (const activation of batch.activations) {
    if (!activation.procedureRef || activation.availability === 'unavailable') continue;
    if (
      (activation.procedureRef.scopeKey !== undefined &&
        activation.procedureRef.scopeKey !== procedureScopeKey(access)) ||
      !store.read(activation.procedureRef.id, access, activation.procedureRef.revision)
    ) {
      throw new Error('admitted procedure unavailable under current authority');
    }
  }
}

function unavailableActivation(activation: OwnerEventActivation): OwnerEventActivation {
  return {
    triggerId: activation.triggerId,
    kind: '',
    memoryQuery: '',
    procedure: [],
    requiredEvidence: [],
    procedureRef: activation.procedureRef,
    queuedProcedureRef: activation.queuedProcedureRef,
    availability: 'unavailable',
    resolutionReason: 'procedure_unavailable',
  };
}
