/**
 * Loaded with `--require` (NODE_OPTIONS) by the move leg (move.mjs): in `mama update --node` only,
 * SIGKILLs the process right after the point MAMA_KILL_AT names, `<point>#<n>`:
 *
 * - `<basename of a rename's target>#<n>` (`node-move.json#2`: the journal's second write;
 *   `node.old#1`: the old Node set aside);
 * - `service-start#<n>`: the service manager's start (launchctl bootstrap or kickstart, systemctl
 *   start), so the daemon boots on the new Node with no hold, as a move killed while it waits for
 *   the boot leaves it.
 *
 * A real kill, between two steps, with nothing in the product to stage it: the journal and the
 * folders are left as a power cut would leave them. Any other process this preload reaches is
 * untouched.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const at = process.env.MAMA_KILL_AT;
if (at && process.argv.includes('update') && process.argv.includes('--node')) {
  const [name, nth] = at.split('#');
  let seen = 0;
  const after = (matches) => {
    if (matches && ++seen === Number(nth)) {
      process.kill(process.pid, 'SIGKILL');
    }
  };
  if (name === 'service-start') {
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = function (command, args = [], ...rest) {
      const result = spawnSync.call(this, command, args, ...rest);
      const tool = path.basename(String(command));
      after(
        (tool === 'launchctl' && (args[0] === 'bootstrap' || args[0] === 'kickstart')) ||
          (tool === 'systemctl' && args.includes('start'))
      );
      return result;
    };
  } else {
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) {
      rename.call(this, from, to);
      after(path.basename(String(to)) === name);
    };
  }
}
