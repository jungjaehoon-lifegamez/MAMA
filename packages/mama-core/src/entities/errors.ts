export interface EntityErrorEnvelope {
  error: {
    code: string;
    message: string;
    hint: string;
    doc_url: string;
  };
}

export abstract class EntityError extends Error {
  abstract readonly code: string;
  abstract readonly doc_section: string;
  readonly context: Record<string, unknown>;
  readonly hint: string;

  constructor(opts: { message: string; context?: Record<string, unknown>; hint: string }) {
    super(opts.message);
    this.name = new.target.name;
    this.context = opts.context ?? {};
    this.hint = opts.hint;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  toErrorEnvelope(): EntityErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        doc_url: `docs/operations/entity-substrate-runbook.md${this.doc_section}`,
      },
    };
  }
}

export class InvalidEntityLabelError extends EntityError {
  readonly code = 'entity.invalid_label';
  readonly doc_section = '#invalid-label';

  constructor(context: Record<string, unknown> = {}) {
    super({
      message: 'Invalid entity label.',
      context,
      hint: 'Provide a non-empty entity label before normalization.',
    });
  }
}

export class EmbeddingUnavailableError extends EntityError {
  readonly code = 'entity.embedding_unavailable';
  readonly doc_section = '#embedding-unavailable';

  constructor(context: Record<string, unknown> = {}) {
    super({
      message: 'Entity embedding model is unavailable.',
      context,
      hint: 'Verify the embedding model is installed and reachable before generating candidates.',
    });
  }
}

export class OntologyViolationError extends EntityError {
  readonly code = 'entity.ontology_violation';
  readonly doc_section = '#ontology-violation';

  constructor(context: Record<string, unknown> = {}) {
    super({
      message: 'Entity operation violates ontology constraints.',
      context,
      hint: 'Check entity kinds and relation signatures before applying the change.',
    });
  }
}

export class MergeTargetStaleError extends EntityError {
  readonly code = 'entity.merge_target_stale';
  readonly doc_section = '#merge-target-stale';

  constructor(context: Record<string, unknown> = {}) {
    super({
      message: 'Merge target is stale.',
      context,
      hint: 'Reload the target entity state and retry the merge against the latest version.',
    });
  }
}

export class EntityLabelMissingError extends EntityError {
  readonly code = 'entity.label_missing';
  readonly doc_section = '#label-missing';

  constructor(context: Record<string, unknown> = {}) {
    super({
      message: 'Canonical entity label is missing.',
      context,
      hint: 'Set a preferred label before projecting or displaying the entity.',
    });
  }
}

export class CandidateStaleError extends EntityError {
  readonly code = 'entity.candidate_stale';
  readonly doc_section = '#candidate-stale';

  constructor(context: Record<string, unknown> = {}) {
    super({
      message: 'Resolution candidate is stale.',
      context,
      hint: 'Refresh the candidate list and review the latest evidence before acting.',
    });
  }
}

export class AuditRunInProgressError extends EntityError {
  readonly code = 'entity.audit_run_in_progress';
  readonly doc_section = '#audit-run-in-progress';

  constructor(context: Record<string, unknown> = {}) {
    super({
      message: 'Another entity audit run is already in progress.',
      context,
      hint: 'Wait for the current audit to finish or inspect its run status before starting a new one.',
    });
  }
}
