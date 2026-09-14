/**
 * Case errors.
 *
 * `CaseMergeChainCycleError` used to live in `entities/errors.ts` and extend
 * that module's `EntityError`. Nothing about a cycle in `case_truth` belongs to
 * the entity substrate; it sat there because the two subsystems were written
 * together. It carries its own shape now.
 *
 * @module cases/errors
 */

export interface CaseErrorEnvelope {
  error: {
    code: string;
    message: string;
    hint: string;
    doc_url: string;
  };
}

export class CaseMergeChainCycleError extends Error {
  readonly code = 'case.merge_chain_cycle';
  readonly doc_section = '#case-merge-chain-cycle';
  readonly context: Record<string, unknown>;
  readonly hint: string;

  constructor(context: { case_id: string; chain: string[]; detected_at_depth: number }) {
    super(
      `Case merge chain cycle detected at depth ${context.detected_at_depth} starting from case_id=${context.case_id}. Chain=${context.chain.join(' -> ')}.`
    );
    this.name = new.target.name;
    this.context = context;
    this.hint = 'Inspect case_truth.canonical_case_id links and remove the cycle before retrying.';

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  toErrorEnvelope(): CaseErrorEnvelope {
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
