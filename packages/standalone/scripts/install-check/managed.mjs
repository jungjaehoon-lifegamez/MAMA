/**
 * Runs under the managed Node (~/.mama/node/bin/node) on the package install.sh installed, so
 * every import below is that package's code (run.mjs passes its folder).
 *
 *   managed.mjs init <packageRoot>   mama init with fixed answers, stopped before the service step
 *   managed.mjs kind <packageRoot>   installKind of this HOME's install, as JSON
 *   managed.mjs finish <packageRoot> record init's service step as done, as a real boot would:
 *                                    the check boots no daemon (no service manager, no model)
 *
 * Init's answers are the `--non-interactive` ones (MAMA_INIT_*): the interactive init pairs the
 * owner over Telegram, which the check has no bot for. The Bot API is a stand-in that accepts the
 * token and the group; the backend is the stub codex run.mjs puts first on PATH, which reports a
 * supported version and a login, so init's own version and login probe runs on it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [command, packageRoot] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(packageRoot, 'dist', path)).href);
const home = homedir();

if (command === 'kind') {
  const { installKind } = await load('cli/runtime/install-kind.js');
  process.stdout.write(JSON.stringify(installKind(join(home, '.mama'), home)));
} else if (command === 'finish') {
  const { readInitState, writeInitState } = await load('cli/runtime/init-state.js');
  const root = join(home, '.mama');
  const state = readInitState(root);
  writeInitState(root, { version: state.version, done: [...state.done, 'service'] });
} else if (command === 'init') {
  const { runInit } = await load('cli/commands/init.js');
  // The service step is the check's next step, through ~/.mama/bin/mama, as the owner runs it.
  const stop = new Error('install check: init stops before the service step');
  const telegramCall = async (_token, method) => {
    if (method === 'getMe') {
      return {
        ok: true,
        result: { id: 1, username: 'install_check_bot', can_read_all_group_messages: true },
      };
    }
    if (method === 'getChatMember') {
      return { ok: true, result: { status: 'administrator' } };
    }
    throw new Error(`install check: unexpected Telegram call ${method}`);
  };
  try {
    await runInit(['--non-interactive'], {
      home,
      prompt: {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        text: async (label) => {
          throw new Error(`install check: init asked ${label}`);
        },
        secret: async (label) => {
          throw new Error(`install check: init asked for ${label}`);
        },
        write: (line) => console.log(`  init | ${line}`),
      },
      telegramCall,
      // The document toolkit installs host software (brew, LibreOffice); not this check's.
      installToolkit: async () => {},
      startService: async () => {
        throw stop;
      },
    });
    throw new Error('install check: init finished without reaching the service step');
  } catch (error) {
    if (error !== stop) {
      throw error;
    }
  }
} else {
  throw new Error(`usage: managed.mjs init|kind|finish <packageRoot>`);
}
