/**
 * A write whose result is not known: the service may have done it (its answer was lost, it
 * timed out, it reported a server error). The approval runtime stores such an outcome as unknown,
 * never as a failure to retry, so an approved send is not posted twice (approvals.md, A6).
 */
export const OUTCOME_UNKNOWN = 'outcome_unknown';

export function outcomeUnknown(message: string): Error {
  return Object.assign(new Error(message), { name: OUTCOME_UNKNOWN });
}
