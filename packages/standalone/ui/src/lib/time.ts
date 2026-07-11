const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function getFreshnessClass(now: number, updatedAt: number): string {
  if (!Number.isFinite(updatedAt)) {
    return 'bg-surface-secondary text-text-tertiary';
  }
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
  if (!Number.isFinite(then)) {
    return 'unknown';
  }
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

export function formatDday(now: number, dueDate: string | null): string {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(now)) {
    return '-';
  }
  const [year, month, day] = dueDate.split('-').map(Number);
  const dueUtc = Date.UTC(year, month - 1, day);
  const due = new Date(dueUtc);
  if (
    due.getUTCFullYear() !== year ||
    due.getUTCMonth() !== month - 1 ||
    due.getUTCDate() !== day
  ) {
    return '-';
  }
  const current = new Date(now);
  const todayUtc = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate());
  const days = Math.round((dueUtc - todayUtc) / DAY_MS);
  if (days === 0) return 'D-day';
  return days > 0 ? `D-${days}` : `D+${Math.abs(days)}`;
}
