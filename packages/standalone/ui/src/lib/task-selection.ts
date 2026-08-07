/**
 * A task id is a positive integer. A selection arriving from the host (deep
 * link, popstate) is ignored when it is anything else: coercing it would open
 * a detail drawer on whatever row happened to answer.
 */
export function positiveTaskId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
