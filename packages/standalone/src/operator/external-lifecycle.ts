/**
 * Host-authored contracts for reconciling Kagemusha card observations.
 *
 * TG-01/TG-05/TG-06: connector evidence is untrusted. These immutable
 * candidate records are the only lifecycle-shaped data a board work order may
 * carry; they do not expose connector titles, content, or arbitrary metadata.
 */

export const EXTERNAL_LIFECYCLE_STATUSES = [
  'pending',
  'in_progress',
  'review',
  'done',
  'cancelled',
] as const;
export type ExternalLifecycleStatus = (typeof EXTERNAL_LIFECYCLE_STATUSES)[number];

export interface ExternalObservationSnapshot {
  readonly eventId: string;
  readonly connector: 'kagemusha';
  readonly sourceType: 'kanban_card';
  readonly externalSourceId: string;
  readonly channelPartition: string;
  readonly contentSha256: string;
  readonly sourceTimestampMs: number;
  readonly operatorIngestSeq: number;
  readonly operatorObservationSeq: number;
  readonly observedStatus: string;
  readonly evidenceSummary: string;
}

export interface BindingCandidate extends ExternalObservationSnapshot {
  readonly kind: 'binding';
  readonly candidateId: string;
  readonly taskId: number;
  readonly taskRevision: number;
}

export interface LifecycleCandidate extends ExternalObservationSnapshot {
  readonly kind: 'lifecycle';
  readonly candidateId: string;
  readonly bindingId: number;
  readonly bindingRevision: number;
  readonly taskId: number;
  readonly taskRevision: number;
  readonly proposedStatus: ExternalLifecycleStatus;
}

export interface ExternalLifecycleCandidateSet {
  readonly bindingCandidates: readonly BindingCandidate[];
  readonly lifecycleCandidates: readonly LifecycleCandidate[];
  readonly diagnostics: readonly ExternalLifecycleDiagnostic[];
}

export const EXTERNAL_LIFECYCLE_DIAGNOSTIC_CODES = [
  'missing_event',
  'unsupported_connector',
  'unsupported_source_type',
  'malformed_metadata',
  'unknown_status',
  'ambiguous_task_pair',
  'receipt_already_exists',
] as const;
export type ExternalLifecycleDiagnosticCode = (typeof EXTERNAL_LIFECYCLE_DIAGNOSTIC_CODES)[number];

export interface ExternalLifecycleDiagnostic {
  readonly eventId: string;
  readonly code: ExternalLifecycleDiagnosticCode;
}

export interface TaskHintLookup {
  readonly directTaskIdsByEventId: ReadonlyMap<string, readonly number[]>;
  readonly effectTaskIdsByEventId: ReadonlyMap<string, readonly number[]>;
}

export interface CandidateTaskSnapshot {
  readonly taskId: number;
  readonly revision: number;
}

export interface ExistingExternalBindingSnapshot {
  readonly bindingId: number;
  readonly bindingRevision: number;
  readonly taskId: number;
  readonly externalSourceId: string;
  readonly connector: 'kagemusha';
  readonly sourceType: 'kanban_card';
  readonly lastObservationSeq: number;
}

/**
 * Where a candidate decision's authority comes from (Task B2).
 *
 * `board`: the legacy path - the candidate lives in the payload of a claimed,
 * in-progress Board attempt. `owner_run`: the host attested the candidate
 * snapshot under an authenticated owner scope, model run and signed envelope
 * (see TaskLedger.attestOwnerActionCandidates). Both resolve to the SAME
 * receipted CAS decision; neither may carry model-authored candidate bytes.
 */
export type ExternalCandidateSource =
  | { readonly kind: 'board'; readonly attemptId: number }
  | {
      readonly kind: 'owner_run';
      readonly context: import('./owner-action-effects.js').OwnerActionContext;
    };

/** Bounded, intent-free view of one attested owner-run candidate. */
export interface OwnerAttestedCandidateSummary {
  readonly candidateId: string;
  readonly kind: 'binding' | 'lifecycle';
  readonly taskId: number;
  readonly eventId: string;
}

export interface BindingCandidateIdentityInput {
  readonly kind: 'binding';
  readonly eventId: string;
  readonly externalSourceId: string;
  readonly channelPartition: string;
  readonly contentSha256: string;
  readonly operatorObservationSeq: number;
  readonly taskId: number;
  readonly taskRevision: number;
}

export interface LifecycleCandidateIdentityInput extends Omit<
  BindingCandidateIdentityInput,
  'kind'
> {
  readonly kind: 'lifecycle';
  readonly bindingId: number;
  readonly bindingRevision: number;
  readonly proposedStatus: ExternalLifecycleStatus;
}
