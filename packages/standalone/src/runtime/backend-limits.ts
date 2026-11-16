import type { BackendLimits } from '@jungjaehoon/mama-core/runtime/backend-limits';

/**
 * The latest usage limit each backend's CLI reported in this daemon. A limit belongs to the
 * login, which every session shares, so one value per backend is kept, in memory: it is
 * reported again on the next turn.
 */
const latest = new Map<BackendLimits['backend'], BackendLimits>();

export function recordBackendLimits(limits: BackendLimits): void {
  latest.set(limits.backend, limits);
}

export function backendLimits(): BackendLimits[] {
  return [...latest.values()];
}
