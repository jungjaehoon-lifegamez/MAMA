import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The systemd user unit MAMA writes on Linux. */
export const SYSTEMD_UNIT = 'mama.service';

export function systemdUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

export type ServiceRun = (command: string, args: string[]) => SpawnSyncReturns<string>;

export function defaultServiceRun(command: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: 'utf8' });
}

/**
 * The unit's state as `systemctl --user is-active` prints it (active, inactive, failed,
 * activating, deactivating), or null when no unit file is installed or not on Linux.
 */
export function systemdUnitState(
  home: string,
  run: ServiceRun = defaultServiceRun,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform !== 'linux' || !existsSync(systemdUnitPath(home))) return null;
  const result = run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}`.trim() || 'unknown';
}
