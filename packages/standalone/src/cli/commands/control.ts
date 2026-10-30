import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { defaultConfigPath } from '../../runtime/config.js';
import { CliInputError } from '../prompt.js';
import { releaseReport } from '../runtime/release-check.js';
import {
  INSTALL_COMMAND,
  nodeMovePlaces,
  readNodeMoveJournal,
  type NodeMoveJournal,
} from '../runtime/node-move-journal.js';
import { unfinishedUpdate } from '../runtime/update-journal.js';
import {
  drainDaemon,
  lockHolder,
  type DrainCounts,
  type DrainDeadlines,
  type LockOwner,
} from '../runtime/daemon-control.js';
import {
  defaultServiceRun,
  SYSTEMD_UNIT,
  systemdUnitState,
  type ServiceRun,
} from '../runtime/systemd-service.js';
import { askDaemon, bootoutLaunchdService, installControlPaths, launchdService } from './daemon.js';

/** `mama status` exits 0 while the daemon runs and 3 when nothing serves the install. */
export const STATUS_STOPPED_EXIT = 3;

interface ControlOptions {
  home?: string;
  configPath?: string;
  write?: (line: string) => void;
  /** Milliseconds between checks while waiting for a stop; tests shorten it. */
  pollMs?: number;
  /** How long `mama stop` waits for the install to be released. */
  timeoutMs?: number;
  /** How long a released install must stay free before `mama stop` reports it stopped. */
  settleMs?: number;
  /** Runs systemctl; tests replace it. */
  run?: ServiceRun;
  /** How long a drain waits on a daemon that stops answering; tests shorten them. */
  drainDeadlines?: DrainDeadlines;
}

function localTime(ms: unknown): string {
  return typeof ms === 'number' ? new Date(ms).toLocaleString('sv-SE') : 'unknown';
}

function holderLine(holder: LockOwner): string {
  return `${holder.command} (pid ${holder.pid}) holds the install`;
}

function statusLines(status: Record<string, unknown>): string[] {
  const lines = [
    `running: ${String(status.command)} (pid ${String(status.pid)}, version ${String(status.version)}${typeof status.node === 'string' ? `, Node.js ${status.node}` : ''}, since ${localTime(status.startedAt)})`,
  ];
  if (status.stage !== 'running') lines.push(`boot stage: ${String(status.stage)}`);
  const drain = status.drain as { holds: number; since: number } | null | undefined;
  if (drain) {
    lines.push(
      `claims held for ${drain.holds === 1 ? 'a drain' : `${drain.holds} drains`} since ${localTime(drain.since)}: new inputs wait`
    );
  }
  const update = status.update as { since: number; to: string } | null | undefined;
  if (update) {
    lines.push(
      `claims held since ${localTime(update.since)} for the update to ${update.to}: new inputs wait until mama update confirms it`
    );
  }
  const turns = Array.isArray(status.runningTurns)
    ? (status.runningTurns as Array<{ session: string; count: number }>)
    : [];
  lines.push(
    turns.length === 0
      ? 'turns running: none'
      : `turns running: ${turns.map((turn) => `${turn.session} ${turn.count}`).join(', ')}`
  );
  const inputs = Array.isArray(status.inputs)
    ? (status.inputs as Array<{ status: string; count: number }>)
    : [];
  lines.push(
    inputs.length === 0
      ? 'inputs waiting: none'
      : `inputs waiting: ${inputs.map((input) => `${input.status} ${input.count}`).join(', ')}`
  );
  const connectors = Array.isArray(status.connectors)
    ? (status.connectors as Array<{
        name: string;
        healthy: boolean;
        lastPoll: string | null;
        error: string | null;
      }>)
    : [];
  for (const connector of connectors) {
    const poll = connector.lastPoll ? localTime(Date.parse(connector.lastPoll)) : 'not yet';
    lines.push(
      `connector ${connector.name}: ${connector.healthy ? 'ok' : 'failing'}, last poll ${poll}` +
        (connector.error ? `, error: ${connector.error}` : '')
    );
  }
  const lastError = status.lastError as { at: number; line: string } | null | undefined;
  if (lastError) lines.push(`last error ${localTime(lastError.at)}: ${lastError.line}`);
  return lines;
}

export async function runStatus(
  args: readonly string[],
  options: ControlOptions = {}
): Promise<number> {
  const json = args.length === 1 && args[0] === '--json';
  if (args.length > 1 || (args.length === 1 && !json)) {
    throw new CliInputError('Usage: mama status [--json]');
  }
  const write = options.write ?? ((line: string) => console.log(line));
  // The service line is extra: a failing service manager is reported in it, not in place of status.
  let service: string | null;
  try {
    const launchd = launchdService();
    const unit = systemdUnitState(options.home ?? homedir(), options.run ?? defaultServiceRun);
    service = launchd.loaded ? 'launchd (loaded)' : unit !== null ? `systemd (${unit})` : null;
  } catch (error) {
    service = `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
  const reply = await askDaemon('status', options);
  // The daemon's last release check, from its file: it outlives the daemon, and nothing here asks
  // the registry.
  const home = options.home ?? homedir();
  const release = releaseReport(dirname(options.configPath ?? defaultConfigPath(home)), home);
  const releaseLines = (): string[] =>
    release === null
      ? []
      : [
          `release: ${release.detail}${release.context ? ` (${release.context})` : ''}`,
          ...(release.steps ?? []).map((step) => `  update: ${step}`),
          ...(release.fix === undefined ? [] : [`  fix: ${release.fix}`]),
        ];
  if (reply.state === 'stopped') {
    // A stopped install may be stopped by an unfinished update: start.sh exits on its hold file.
    // So may a move of the managed Node, which holds it on the same file.
    let update:
      | ReturnType<typeof unfinishedUpdate>
      | { move: NodeMoveJournal }
      | { unreadable: string };
    try {
      const root = dirname(options.configPath ?? defaultConfigPath(home));
      const move = readNodeMoveJournal(nodeMovePlaces(root).journal);
      update = move === null ? unfinishedUpdate(root) : { move };
    } catch (error) {
      update = { unreadable: error instanceof Error ? error.message : String(error) };
    }
    const updateLine =
      update === null
        ? null
        : 'unreadable' in update
          ? `update journal cannot be read: ${update.unreadable}; mama doctor names it`
          : 'move' in update
            ? `Node move unfinished: ${update.move.from} → ${update.move.to} (${update.move.phase}, step ${update.move.step}); run the install command again, which finishes or undoes it: ${INSTALL_COMMAND}`
            : 'journal' in update
              ? `update unfinished: ${update.journal.from} → ${update.journal.to} (${update.journal.phase}, step ${update.journal.step}); resolve it with: ${update.command}`
              : `update hold file ${update.hold} is in place with no journal, so start.sh exits at once; remove it, then mama service start`;
    if (json) {
      write(
        JSON.stringify({
          state: 'stopped',
          holder: reply.holder,
          service,
          release: release?.state ?? null,
          update: updateLine,
        })
      );
    } else {
      write(reply.holder ? `stopped; ${holderLine(reply.holder)}` : 'stopped');
      if (updateLine) write(updateLine);
      if (service) write(`service: ${service}`);
      for (const line of releaseLines()) write(line);
    }
    return STATUS_STOPPED_EXIT;
  }
  if (reply.reply.ok !== true) {
    throw new CliInputError(`The daemon refused status: ${String(reply.reply.error)}`);
  }
  const status = reply.reply.status as Record<string, unknown>;
  if (json) {
    write(JSON.stringify({ state: 'running', status, service, release: release?.state ?? null }));
  } else {
    for (const line of statusLines(status)) write(line);
    if (service) write(`service: ${service}`);
    for (const line of releaseLines()) write(line);
  }
  return 0;
}

type StopOutcome =
  | { kind: 'released' }
  | { kind: 'replaced'; holder: LockOwner }
  | { kind: 'timeout'; holder: LockOwner };

/**
 * Wait until the stopped holder's lock is gone. A different holder appearing means something
 * started in its place, such as a service manager restarting the daemon; that is not a stop.
 */
async function waitForRelease(
  stopping: LockOwner,
  options: ControlOptions,
  write: (line: string) => void
): Promise<StopOutcome> {
  const paths = installControlPaths(options);
  const pollMs = options.pollMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const started = Date.now();
  let reported = started;
  for (;;) {
    const holder = lockHolder(paths);
    if (holder === null) {
      // A supervisor may start a replacement after a pause; the install must stay free a moment.
      await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 3_000));
      const next = lockHolder(paths);
      return next === null ? { kind: 'released' } : { kind: 'replaced', holder: next };
    }
    if (holder.nonce !== stopping.nonce) return { kind: 'replaced', holder };
    if (Date.now() - started >= timeoutMs) return { kind: 'timeout', holder };
    if (Date.now() - reported >= 30_000) {
      write(`still stopping: ${holderLine(holder)}`);
      reported = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function finish(outcome: StopOutcome, write: (line: string) => void, done: string): number {
  if (outcome.kind === 'released') {
    write(done);
    return 0;
  }
  if (outcome.kind === 'replaced') {
    write(`stopped, but ${holderLine(outcome.holder)} now: something started it again`);
    return 1;
  }
  write(`not stopped yet: ${holderLine(outcome.holder)}; check mama status`);
  return 1;
}

function waitingFor(counts: DrainCounts): string {
  const turns = `${counts.running} turn${counts.running === 1 ? '' : 's'} running`;
  const inputs = `${counts.claimed} input${counts.claimed === 1 ? '' : 's'} claimed`;
  return `${turns}, ${inputs}`;
}

function minutes(ms: number): string {
  return `${Math.ceil(ms / 60_000)} min`;
}

/**
 * Stop the install's daemon. A daemon is drained first: it claims nothing new, and the stop waits
 * until its running turns and claimed inputs finish, so their replies are delivered. The drain's
 * connection stays open through the stop, so nothing starts in between; inputs that arrive wait
 * for the next start. `--now` skips the drain and interrupts what runs; at the next start MAMA
 * delivers its stored result or tells its sender that it was interrupted.
 */
export async function runStop(
  args: readonly string[],
  options: ControlOptions = {}
): Promise<number> {
  const now = args.length === 1 && args[0] === '--now';
  if (args.length > 1 || (args.length === 1 && !now)) {
    throw new CliInputError('Usage: mama stop [--now]');
  }
  const write = options.write ?? ((line: string) => console.log(line));
  const holder = lockHolder(installControlPaths(options));
  // A replay, backfill or register-owner is left to finish; a stopped install has nothing to drain.
  if (now || holder?.command !== 'daemon') return await stopNow(options, write);
  let reported = false;
  const drain = await drainDaemon(
    installControlPaths(options),
    (progress) => {
      if (progress.idle) return;
      write(
        reported
          ? `still draining: ${waitingFor(progress)}`
          : `draining: new inputs wait; waiting for ${waitingFor(progress)} (at most ${minutes(progress.bound)})`
      );
      reported = true;
    },
    options.drainDeadlines
  );
  if (drain === null) {
    write(
      `not stopped: ${holderLine(holder)} does not answer on its control socket; mama stop --now stops it without draining`
    );
    return 1;
  }
  try {
    const outcome = await drain.outcome;
    if (outcome.kind === 'bound') {
      write(
        `not stopped: still ${waitingFor(outcome)} after ${minutes(outcome.bound)}; nothing changed, new inputs are claimed again (mama stop --now interrupts them)`
      );
      return 1;
    }
    if (outcome.kind === 'refused') {
      // A daemon older than the drain answers `unknown op`.
      write(
        `not stopped: the daemon refused the drain: ${outcome.error}; mama stop --now stops it without draining`
      );
      return 1;
    }
    if (outcome.kind === 'silent') {
      write(`not stopped: ${outcome.error}; mama stop --now stops it without draining`);
      return 1;
    }
    if (outcome.kind === 'closed') {
      write(
        'not stopped by this command: the daemon ended the drain before it was idle; check mama status'
      );
      return 1;
    }
    write('drained: nothing runs; stopping');
    // Still held: the service manager's stop or the socket's stop comes next.
    return await stopNow(options, write);
  } finally {
    drain.release();
  }
}

/**
 * Today's stop, also `--now`. A daemon run by a loaded LaunchAgent is unloaded, so KeepAlive does
 * not restart it; any other daemon is asked through the control socket. A replay, backfill or
 * register-owner is left to finish. A running turn is interrupted.
 */
async function stopNow(options: ControlOptions, write: (line: string) => void): Promise<number> {
  let holder = lockHolder(installControlPaths(options));
  const service = launchdService();
  const run = options.run ?? defaultServiceRun;
  const unit = systemdUnitState(options.home ?? homedir(), run);
  // A service manager restarts its daemon, so it is stopped first, whichever process holds the
  // install now: a loaded LaunchAgent is unloaded, and a systemd unit that runs or waits to
  // restart is stopped (which also cancels a pending restart).
  if (service.loaded) bootoutLaunchdService();
  const unitStopped = unit !== null && unit !== 'inactive' && unit !== 'failed';
  if (unitStopped) {
    const result = run('systemctl', ['--user', 'stop', SYSTEMD_UNIT]);
    if (result.error || result.status !== 0) {
      write(
        `not stopped: systemctl --user stop ${SYSTEMD_UNIT} failed: ${result.error?.message ?? (`${result.stderr ?? ''}`.trim() || `exit ${String(result.status)}`)}`
      );
      return 1;
    }
  }
  const unloaded = service.loaded
    ? ' (launchd service unloaded)'
    : unitStopped
      ? ' (systemd unit stopped)'
      : '';
  // systemctl stop returns once the unit's daemon has exited; what holds the install now is
  // something else, such as a daemon started in a terminal.
  if (unitStopped) holder = lockHolder(installControlPaths(options));
  if (holder === null) {
    write(unloaded ? `stopped${unloaded}` : 'already stopped');
    return 0;
  }
  if (holder.command !== 'daemon') {
    write(`not stopped${unloaded}: ${holderLine(holder)} and stops when it finishes`);
    return 1;
  }
  if (service.loaded && service.pid === holder.pid) {
    return finish(
      await waitForRelease(holder, options, write),
      write,
      `stopped${unloaded}; mama service start starts it again`
    );
  }
  const reply = await askDaemon('stop', options);
  if (reply.state === 'stopped') {
    write(`not stopped${unloaded}: ${holderLine(holder)} does not answer on its control socket`);
    return 1;
  }
  if (reply.reply.ok !== true) {
    write(`not stopped${unloaded}: ${String(reply.reply.error)}`);
    return 1;
  }
  write('stopping');
  return finish(await waitForRelease(holder, options, write), write, `stopped${unloaded}`);
}
