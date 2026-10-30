/**
 * Loaded with `--require` (NODE_OPTIONS) by the move leg (move.mjs): in `mama update --node` only,
 * SIGKILLs the process right after the rename named by MAMA_KILL_AT, `<basename of the target>#<n>`
 * (`node-move.json#2`: the journal's second write; `node.old#1`: the old Node set aside). A real
 * kill, between two steps, with nothing in the product to stage it: the journal and the folders
 * are left as a power cut would leave them. Any other process this preload reaches is untouched.
 */
const fs = require('node:fs');
const path = require('node:path');

const at = process.env.MAMA_KILL_AT;
if (at && process.argv.includes('update') && process.argv.includes('--node')) {
  const [name, nth] = at.split('#');
  const rename = fs.renameSync;
  let seen = 0;
  fs.renameSync = function renameSync(from, to) {
    rename.call(this, from, to);
    if (path.basename(String(to)) === name && ++seen === Number(nth)) {
      process.kill(process.pid, 'SIGKILL');
    }
  };
}
