import type { OperatorTrigger, TriggerStatus } from '../api/client';

export type TriggerStatusFilter = 'all' | TriggerStatus;

export function filterTriggers(
  triggers: readonly OperatorTrigger[],
  query: string,
  status: TriggerStatusFilter
): OperatorTrigger[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return triggers.filter((trigger) => {
    if (status !== 'all' && trigger.status !== status) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return (
      trigger.kind.toLocaleLowerCase().includes(normalizedQuery) ||
      trigger.match.keywords.some((keyword) =>
        keyword.toLocaleLowerCase().includes(normalizedQuery)
      )
    );
  });
}
