import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveApiPort } from '../../api/viewer-server.js';
import { readStartScript, startExports, UPDATE_HOLD_LINE } from '../launch-files.js';
import { CliInputError } from '../prompt.js';
import { refuseWhileRestoring } from '../runtime/daemon-control.js';
import { installKind, requireServicePackage } from '../runtime/install-kind.js';
import {
  INSTALL_COMMAND,
  managedNodePath,
  nodeMovePlaces,
  readNodeMoveJournal,
  removeNodeMoveJournal,
  writeNodeMoveJournal,
  type NodeMoveJournal,
  type NodeMovePlaces,
} from '../runtime/node-move-journal.js';
import { npmErrorCode } from '../runtime/release-check.js';
import { readUpdateJournal, rollbackCommand, type UpdatePaths } from '../runtime/update-journal.js';
import { waitForBoot } from './init.js';
import { serviceFile, type ServiceOptions } from './service.js';
import type { UpdateDeps } from './update.js';

/*
 * `mama update --node <folder>` (docs/development/work/install.md, "Moving the managed Node"):
 * the install command, run again with another Node pin, stages that Node in ~/.mama/node.new and
 * runs this through ~/.mama/bin/mama, so it runs on the Node it moves away from. update.ts loads
 * this module statically: from step 3 on, the folders this CLI was loaded from are renamed (both
 * ~/.mama/node and, on a major change, ~/.mama/npm), so it runs loaded code and Node's built-ins
 * only.
 *
 * 1. update.lock, so no update or second move runs beside it; the journal (node-move.json).
 * 2. On a major change, a copy of ~/.mama/npm rebuilt by the new Node's npm, before any stop.
 * 3. The drained stop, update.hold (start.sh exits on it), then the renames.
 * 4. Doctor's Node check under the new Node, the hold removed, the service started and its boot
 *    awaited, on the new Node; then `committed`, the old folders removed, the journal closed.
 * A failure before `committed` puts the old folders back and starts them. A killed run leaves the
 * journal and the hold; install.sh finishes or undoes it in plain sh.
 */

export interface MoveContext {
  readonly home: string;
  readonly root: string;
  readonly paths: UpdatePaths;
  readonly write: (line: string) => void;
  readonly deps: UpdateDeps;
  readonly env: NodeJS.ProcessEnv;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal with the stable code an /update's progress carries instead of its text. */
function refusal(code: string, text: string): CliInputError {
  return Object.assign(new CliInputError(text), { code });
}

/**
 * What both the update and the move need before they stop anything: a service to start MAMA
 * again (nothing else would after the stop), and a start.sh that honours the hold, which only a
 * start.sh `mama service install` wrote does (an older one would boot an unheld daemon on a
 * reboot midway).
 */
export function requireHoldingService(root: string, options: ServiceOptions): void {
  if (!existsSync(serviceFile(options))) {
    throw refusal(
      'service.missing',
      'mama update starts MAMA again through its service, and none is installed: run mama service install first'
    );
  }
  const startPath = join(root, 'start.sh');
  if (
    !readFileSync(startPath, 'utf8')
      .split('\n')
      .some((line) => line.trim() === UPDATE_HOLD_LINE)
  ) {
    throw refusal(
      'start_sh.no_hold',
      `${startPath} does not stop a start while an update holds the install; run mama service install, then mama update`
    );
  }
}

/**
 * Put each folder set aside back over whatever took its place, and drop the new Node and the
 * rebuilt copy; install.sh's recovery does the same in sh.
 */
function putBack(places: NodeMovePlaces): void {
  for (const [folder, aside] of [
    [places.node, places.aside],
    [places.prefix, places.prefixAside],
  ] as const) {
    if (!existsSync(aside)) continue;
    rmSync(folder, { recursive: true, force: true });
    renameSync(aside, folder);
  }
  rmSync(places.staged, { recursive: true, force: true });
  rmSync(places.prefixCopy, { recursive: true, force: true });
}

function viewerPort(context: MoveContext): number {
  return resolveApiPort(
    startExports(
      readStartScript(readFileSync(join(context.root, 'start.sh'), 'utf8'), context.home)
    ).MAMA_API_PORT
  );
}

export async function moveNode(
  context: MoveContext,
  folder: string,
  options: ServiceOptions
): Promise<number> {
  const { root, home, write, deps, env, paths } = context;
  const places = nodeMovePlaces(root);
  const install = installKind(root, home);
  requireServicePackage(install, deps.runningPackage());
  if (
    install.kind !== 'npm' ||
    install.nodePath !== managedNodePath(root) ||
    install.prefix !== places.prefix
  ) {
    throw refusal(
      'node_move.unmanaged',
      `mama update --node moves the Node the install command put in ${places.node}; this service runs ${install.nodePath} on ${install.packageRoot}`
    );
  }
  requireHoldingService(root, options);
  // The renames take it by this name, and install.sh's recovery knows only this one.
  if (resolve(folder) !== places.staged) {
    throw refusal(
      'node_move.place',
      `The new Node must be staged at ${places.staged}, beside ${places.node}, not ${resolve(folder)}`
    );
  }
  const newNode = join(places.staged, 'bin', 'node');
  if (!lstatSync(places.staged).isDirectory() || !existsSync(newNode)) {
    throw refusal('node_move.place', `${places.staged} holds no Node.js (no bin/node)`);
  }
  // A rename does not cross filesystems, and step 3 renames after the stop.
  if (statSync(places.staged).dev !== statSync(root).dev) {
    throw refusal(
      'node_move.place',
      `${places.staged} is on another filesystem than ${root}; the move renames it into place`
    );
  }
  refuseWhileRestoring(root);

  // Step 1: the lock and the journal.
  const lock = deps.lock(paths.lock, 'update --node');
  try {
    const update = readUpdateJournal(paths.journal);
    if (update !== null) {
      throw refusal(
        'update.open',
        `An earlier update (${update.from} → ${update.to}) is unfinished; resolve it first: ${rollbackCommand(update)}`
      );
    }
    const open = readNodeMoveJournal(places.journal);
    if (open !== null) {
      throw refusal(
        'node_move.open',
        `An earlier move of the managed Node (${open.from} → ${open.to}) is unfinished; run the install command again, which finishes or undoes it: ${INSTALL_COMMAND}`
      );
    }
    const from = await deps.nodeVersion(install.nodePath);
    const to = await deps.nodeVersion(newNode);
    if (from === to) {
      write(`Node.js ${from} runs MAMA already; nothing to move`);
      return 0;
    }
    const major = from.split('.')[0] !== to.split('.')[0];
    const version = deps.version();
    write(`move: Node.js ${from} → ${to} for ${install.packageRoot} (${version})`);
    write('steps:');
    for (const line of [
      ...(major
        ? [
            `copy ${places.prefix} to ${places.prefixCopy} and rebuild it with Node.js ${to}'s npm (a major change: native modules are built for one); a failure changes nothing`,
          ]
        : []),
      'drain: new inputs wait, running turns finish; then stop the service',
      `swap: ${places.node} goes to ${places.aside}, ${places.staged} takes its place${major ? `; ${places.prefix} goes to ${places.prefixAside}, the rebuilt copy takes its place` : ''}`,
      `check that Node.js ${to} loads MAMA's SQLite, start the service and wait for its boot`,
      `on any failure, Node.js ${from} is put back and started`,
    ]) {
      write(`  ${line}`);
    }
    const journal: NodeMoveJournal = {
      format: 'mama-node-move',
      phase: 'prepare',
      step: 1,
      from,
      to,
      major,
      startedAt: new Date().toISOString(),
    };
    const step = (number: number): void => {
      journal.step = number;
      writeNodeMoveJournal(places.journal, journal);
    };
    step(1);

    // Step 2: the prefix's copy, rebuilt for the new major, while the daemon still runs. A copy,
    // so a rollback finds the old prefix untouched; a rebuild, not a reinstall, since the
    // published core range is a caret and a reinstall could bring a newer core.
    if (major) {
      step(2);
      write(`rebuilding a copy of ${places.prefix} for Node.js ${to}`);
      try {
        rmSync(places.prefixCopy, { recursive: true, force: true });
        cpSync(places.prefix, places.prefixCopy, {
          recursive: true,
          verbatimSymlinks: true,
          preserveTimestamps: true,
        });
        await deps.npm(
          ['rebuild', '-g', '--prefix', places.prefixCopy, '--no-update-notifier'],
          newNode,
          env
        );
      } catch (error) {
        rmSync(places.prefixCopy, { recursive: true, force: true });
        removeNodeMoveJournal(places.journal);
        throw refusal(
          `npm.${npmErrorCode(error)}`,
          `Rebuilding ${places.prefixCopy} with Node.js ${to} failed: ${npmErrorCode(error)}; nothing else changed`
        );
      }
    }

    // Step 3: the drained stop, the hold, the renames.
    step(3);
    if ((await deps.stop(false)) !== 0) {
      rmSync(places.prefixCopy, { recursive: true, force: true });
      removeNodeMoveJournal(places.journal);
      write(
        deps.serviceRuns()
          ? `not moved: the stop did not finish (above); Node.js ${from} stays and still runs MAMA`
          : `not moved: the stop did not finish cleanly (above) and the service is not running; Node.js ${from} stays, and mama service start starts it again`
      );
      return 1;
    }
    // From here a start (a reboot, an owner's mama service start) finds the hold and exits.
    writeFileSync(paths.hold, `${process.pid}\n`, { mode: 0o600 });
    try {
      renameSync(places.node, places.aside);
      renameSync(places.staged, places.node);
      if (major) {
        renameSync(places.prefix, places.prefixAside);
        renameSync(places.prefixCopy, places.prefix);
      }

      // Step 4: the new Node loads MAMA's SQLite, boots it, and is the Node the daemon runs.
      step(4);
      const check = await deps.nodeCheck(install.nodePath, install.cliPath);
      if (check.status === 'fail') {
        throw new Error(
          `doctor's Node check fails on Node.js ${to}: ${check.detail}${check.context === undefined ? '' : ` (${check.context})`}`
        );
      }
      rmSync(paths.hold, { force: true });
      await deps.start();
      const port = viewerPort(context);
      await waitForBoot({
        status: () => deps.control('status'),
        health: () => deps.health(port),
        timeoutMs: deps.bootWaitMs,
        pollMs: deps.pollMs,
        write,
        version,
        next: `the move goes back to Node.js ${from}`,
      });
      const reply = await deps.control('status');
      const running =
        reply.state === 'running' && reply.reply.ok === true
          ? (reply.reply.status as { node?: unknown }).node
          : null;
      if (running !== `v${to}`) {
        throw new Error(`the daemon runs Node.js ${String(running)}, not ${to}`);
      }
    } catch (error) {
      return await undo(context, journal, places, error);
    }
    // On disk before the cleanup: from here a killed run is finished, never undone.
    journal.phase = 'committed';
    writeNodeMoveJournal(places.journal, journal);
    rmSync(places.aside, { recursive: true, force: true });
    rmSync(places.prefixAside, { recursive: true, force: true });
    removeNodeMoveJournal(places.journal);
    write(`moved: MAMA runs on Node.js ${to} (was ${from})`);
    return 0;
  } finally {
    lock.release();
  }
}

/**
 * Put Node.js `from` back after a failure at step 3 or 4: stop what the new Node started (it may
 * have run turns, so it drains when it answers), hold, rename back, start. Exits 1 either way.
 */
async function undo(
  context: MoveContext,
  journal: NodeMoveJournal,
  places: NodeMovePlaces,
  failure: unknown
): Promise<number> {
  const { write, deps, paths } = context;
  write(`moving back to Node.js ${journal.from}: step ${journal.step} failed: ${message(failure)}`);
  try {
    const reply = await deps.control('status').catch(() => null);
    const answers = reply?.state === 'running' && reply.reply.ok === true;
    if ((await deps.stop(!answers)) !== 0) throw new Error('the service did not stop');
    writeFileSync(paths.hold, `${process.pid}\n`, { mode: 0o600 });
    putBack(places);
  } catch (error) {
    writeFileSync(paths.hold, `${process.pid}\n`, { mode: 0o600 });
    write(
      `the move was not undone: ${message(error)}. The install stays stopped on its hold file, with ${places.journal}; run the install command again, which undoes it: ${INSTALL_COMMAND}`
    );
    return 1;
  }
  // The folders are back: the move is undone, whatever the start below says.
  rmSync(paths.hold, { force: true });
  removeNodeMoveJournal(places.journal);
  try {
    await deps.start();
    const port = viewerPort(context);
    await waitForBoot({
      status: () => deps.control('status'),
      health: () => deps.health(port),
      timeoutMs: deps.bootWaitMs,
      pollMs: deps.pollMs,
      write,
      version: deps.version(),
      next: 'mama doctor checks the install',
    });
  } catch (error) {
    write(
      `not moved: Node.js ${journal.from} is back in place, but MAMA did not start on it: ${message(error)}`
    );
    return 1;
  }
  write(`not moved: Node.js ${journal.from} runs MAMA again; Node.js ${journal.to} is removed`);
  return 1;
}
