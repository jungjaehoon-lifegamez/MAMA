import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The systemd user unit MAMA writes on Linux. */
export const SYSTEMD_UNIT = 'mama.service';

/** Where systemd's user manager loads units from: XDG_CONFIG_HOME when set, else ~/.config. */
export function systemdUnitPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(config, 'systemd', 'user', SYSTEMD_UNIT);
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
