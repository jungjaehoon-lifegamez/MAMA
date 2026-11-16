/**
 * The usage limit a backend CLI reports for its login, read from the events it already emits:
 * Claude's `rate_limit_event` on its stream and Codex's `account/rateLimits/updated`
 * notification. Each window says how much of it is used and when it resets.
 */

export interface BackendLimitWindow {
  /** The window's length, such as `5h` or `7d`. */
  readonly window: string;
  /** Percent of the window used, 0 to 100. */
  readonly usedPercent: number;
  /** When the window resets, in epoch milliseconds, or null when the CLI does not say. */
  readonly resetsAt: number | null;
}

export interface BackendLimits {
  readonly backend: 'claude' | 'codex';
  readonly windows: readonly BackendLimitWindow[];
  /** When the event was read, in epoch milliseconds. */
  readonly observedAt: number;
}

export type BackendLimitsListener = (limits: BackendLimits) => void;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resetMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null;
}

const CLAUDE_WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d' };

/** `rate_limit_info` of a Claude `rate_limit_event`; null when it names no measured window. */
export function claudeBackendLimits(info: unknown, observedAt: number): BackendLimits | null {
  const windows = record(record(info)?.unifiedWindows);
  if (!windows) return null;
  const read: BackendLimitWindow[] = [];
  for (const [name, value] of Object.entries(windows)) {
    const window = record(value);
    if (typeof window?.utilization !== 'number') continue;
    read.push({
      window: CLAUDE_WINDOWS[name] ?? name,
      usedPercent: Math.round(window.utilization * 100),
      resetsAt: resetMs(window.resetsAt),
    });
  }
  return read.length === 0 ? null : { backend: 'claude', windows: read, observedAt };
}

function minutesLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Params of a Codex `account/rateLimits/updated` notification; null when no window is set. */
export function codexBackendLimits(params: unknown, observedAt: number): BackendLimits | null {
  const limits = record(record(params)?.rateLimits);
  if (!limits) return null;
  const read: BackendLimitWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const window = record(limits[key]);
    if (typeof window?.usedPercent !== 'number' || typeof window.windowDurationMins !== 'number')
      continue;
    read.push({
      window: minutesLabel(window.windowDurationMins),
      usedPercent: window.usedPercent,
      resetsAt: resetMs(window.resetsAt),
    });
  }
  return read.length === 0 ? null : { backend: 'codex', windows: read, observedAt };
}
