const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function getFreshnessClass(now: number, updatedAt: number): string {
  const age = Math.max(0, now - updatedAt);
  if (age < HOUR_MS) {
    return 'bg-agent-light text-agent';
  }
  if (age <= 6 * HOUR_MS) {
    return 'bg-surface-secondary text-text-tertiary';
  }
  return 'bg-warning-soft text-warning-text';
}

export function formatRelativeTime(now: number, then: number): string {
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE_MS) {
    return 'just now';
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}
