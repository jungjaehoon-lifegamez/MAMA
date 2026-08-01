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
  eventId: string;
  connector: 'kagemusha';
  sourceType: 'kanban_card';
  externalSourceId: string;
  channelPartition: string;
  contentSha256: string;
  sourceTimestampMs: number;
  operatorIngestSeq: number;
  operatorObservationSeq: number;
  observedStatus: string;
  evidenceSummary: string;
}

export interface BindingCandidate extends ExternalObservationSnapshot {
  kind: 'binding';
  candidateId: string;
  taskId: number;
  taskRevision: number;
}

export interface LifecycleCandidate extends ExternalObservationSnapshot {
  kind: 'lifecycle';
  candidateId: string;
  bindingId: number;
  bindingRevision: number;
  taskId: number;
  taskRevision: number;
  proposedStatus: ExternalLifecycleStatus;
}

export interface ExternalLifecycleCandidateSet {
  bindingCandidates: readonly BindingCandidate[];
  lifecycleCandidates: readonly LifecycleCandidate[];
  diagnostics: readonly ExternalLifecycleDiagnostic[];
}

export type ExternalLifecycleDiagnosticCode =
  | 'missing_event'
  | 'unsupported_connector'
  | 'unsupported_source_type'
  | 'malformed_metadata'
  | 'unknown_status'
  | 'ambiguous_task_pair'
  | 'receipt_already_exists';

export interface ExternalLifecycleDiagnostic {
  eventId: string;
  code: ExternalLifecycleDiagnosticCode;
}

export interface TaskHintLookup {
  directTaskIdsByEventId: ReadonlyMap<string, readonly number[]>;
  effectTaskIdsByEventId: ReadonlyMap<string, readonly number[]>;
}

export interface CandidateTaskSnapshot {
  taskId: number;
  revision: number;
}

export interface ExistingExternalBindingSnapshot {
  bindingId: number;
  bindingRevision: number;
  taskId: number;
  externalSourceId: string;
  connector: 'kagemusha';
  sourceType: 'kanban_card';
  lastObservationSeq: number;
}

export interface BindingCandidateIdentityInput {
  kind: 'binding';
  eventId: string;
  externalSourceId: string;
  channelPartition: string;
  contentSha256: string;
  operatorObservationSeq: number;
  taskId: number;
  taskRevision: number;
}

export interface LifecycleCandidateIdentityInput extends Omit<
  BindingCandidateIdentityInput,
  'kind'
> {
  kind: 'lifecycle';
  bindingId: number;
  bindingRevision: number;
  proposedStatus: ExternalLifecycleStatus;
}
