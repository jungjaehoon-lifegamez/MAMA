/**
 * Runs under the managed Node (~/.mama/node/bin/node) on the package install.sh installed, so
 * every import below is that package's code (run.mjs passes its folder).
 *
 *   managed.mjs init <packageRoot>   mama init --non-interactive, stopped before the service step
 *   managed.mjs kind <packageRoot>   installKind of this HOME's install, as JSON
 *   managed.mjs finish <packageRoot> record init's service step as done, as a real boot would:
 *                                    the check boots no daemon (no service manager, no model)
 *
 * Init reads its answers from run.mjs's MAMA_INIT_* variables and takes the bot token and the
 * pairing code on its setup page. This script is the owner there, on purpose, which the install
 * skill forbids an agent: it reads the redirect file init names, posts the token, and posts the
 * code the bot was asked to send. The Bot API is a stand-in: the owner's private message and their
 * /bind in the group wait in getUpdates, and sendMessage hands over the code. The backend is the
 * stub codex run.mjs puts first on PATH, which reports a supported version and a login, so init's
 * own version and login probe runs on it.
 */
import { readFileSync } from 'node:fs';
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
  const token = 'install-check-secret';
  const owner = 424242;
  const group = -1001234567890;
  const updates = [
    {
      update_id: 1,
      message: { chat: { id: owner, type: 'private' }, from: { id: owner }, text: 'hello' },
    },
    {
      update_id: 2,
      message: {
        chat: { id: group, type: 'supergroup' },
        from: { id: owner },
        text: '/bind',
        entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    },
  ];
  let codeSent;
  const code = new Promise((resolve) => (codeSent = resolve));
  const telegramCall = async (asked, method, params = {}) => {
    if (asked !== token) {
      return { ok: false, error_code: 401 };
    }
    if (method === 'getMe') {
      return {
        ok: true,
        result: { id: 1, username: 'install_check_bot', can_read_all_group_messages: true },
      };
    }
    if (method === 'getChatMember') {
      return { ok: true, result: { status: 'administrator' } };
    }
    if (method === 'getUpdates') {
      if (params.offset === '-1') {
        return { ok: true, result: [] };
      }
      const pending = updates.filter((update) => update.update_id >= Number(params.offset));
      if (pending.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ok: true, result: pending };
    }
    if (method === 'sendMessage') {
      if (params.chat_id === String(owner)) {
        codeSent(/(\d{6})/.exec(params.text)[1]);
      }
      return { ok: true, result: {} };
    }
    throw new Error(`install check: unexpected Telegram call ${method}`);
  };
  const lines = [];
  let page;
  const post = async (fields) => {
    const response = await fetch(page, { method: 'POST', body: new URLSearchParams(fields) });
    if (!response.ok) {
      throw new Error(`install check: the setup page answered ${response.status}`);
    }
  };
  const enter = async (file) => {
    page = /url=(http[^"]+)"/.exec(readFileSync(file, 'utf8'))[1];
    await post({ token });
    await post({ code: await code });
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
        write: (line) => {
          lines.push(line);
          console.log(`  init | ${line}`);
          const opened = /^setup page: opened in the browser from (.+\/open\.html); /.exec(line);
          if (opened) {
            enter(opened[1]).catch((error) => {
              console.error(error);
              process.exit(1);
            });
          }
        },
      },
      telegramCall,
      // No browser on the runner: the redirect file is read above, as a browser would.
      openRun: async () => ({ exit: Promise.resolve(0) }),
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
  for (const step of ['bot token accepted for @install_check_bot', 'pairing code accepted']) {
    if (!lines.includes(step)) {
      throw new Error(`install check: init did not say "${step}"`);
    }
  }
  const nonce = new URL(page).pathname.slice(1);
  if (lines.some((line) => line.includes(token) || line.includes(nonce))) {
    throw new Error('install check: a line init printed holds the token or the page URL');
  }
} else {
  throw new Error(`usage: managed.mjs init|kind|finish <packageRoot>`);
}
