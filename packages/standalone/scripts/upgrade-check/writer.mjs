/**
 * Runs inside the previous release's install (run.mjs copies it there), so every import below is
 * that release's code: an install set up the way its owner would set one up, then work written
 * through its own actions. Its paths are that release's internals; when a later "previous" moves
 * one, the import fails naming it, and the fix ships with that release.
 *
 * Usage: node writer.mjs <written.json>   (HOME, MAMA_API_PORT, MAMA_UPGRADE_TOOLS and
 * MAMA_UPGRADE_MEMBERS come from run.mjs)
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runInit } from '@jungjaehoon/mama-os/dist/cli/commands/init.js';
import { runRegisterOwner } from '@jungjaehoon/mama-os/dist/cli/commands/register-owner.js';
import { bootDaemon } from '@jungjaehoon/mama-os/dist/cli/commands/daemon.js';

const [writtenPath] = process.argv.slice(2);
const home = process.env.HOME;
const root = join(home, '.mama');
const ownerTelegramId = '424242';
const commonChat = '-1001234567890';

// `mama init` with an owner's answers: no optional messenger, no Jev, no tunnel, no service file
// (the service label is global, and the check must not install one). A question this table does
// not know fails the run, so a later release that asks something new is noticed rather than
// answered by accident.
const declined = [
  /^Enable Discord owner messages/,
  /^Enable Slack owner messages/,
  /^Use Jev \(TypeSafe\)/,
  /^Expose the viewer through a tunnel/,
  /^Write ~\/Library\/LaunchAgents\/com\.mama\.server\.plist/,
];
function answer(label) {
  if (/\[y\/N\]$/.test(label) && declined.some((question) => question.test(label))) {
    return 'n';
  }
  if (/^Backend/.test(label)) {
    return 'codex';
  }
  if (/^Model$/.test(label)) {
    return 'fixture-model';
  }
  if (/^Owner timezone/.test(label)) {
    return 'UTC';
  }
  if (/chat id/.test(label)) {
    return commonChat;
  }
  if (/^Connectors to enable/.test(label)) {
    return 'obsidian';
  }
  if (/^Obsidian vault path/.test(label)) {
    return join(home, 'vault');
  }
  throw new Error(`mama init asked a question the upgrade check does not answer: ${label}`);
}
await runInit({
  home,
  prompt: {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    text: async (label) => answer(label),
    secret: async (label) => {
      if (label !== 'Telegram bot token') {
        throw new Error(`mama init asked for a secret the upgrade check does not answer: ${label}`);
      }
      return 'upgrade-check-secret';
    },
    write: () => {},
  },
  toolsRoot: process.env.MAMA_UPGRADE_TOOLS,
  // The document toolkit needs LibreOffice on the host; it is installed software, not state an
  // upgrade has to keep.
  installToolkit: async () => {},
});

// register-owner needs member_root; releases whose init does not write it leave it to the owner.
const configPath = join(root, 'config.yaml');
if (!/^member_root:/m.test(readFileSync(configPath, 'utf8'))) {
  appendFileSync(configPath, `member_root: ${process.env.MAMA_UPGRADE_MEMBERS}\n`);
}
await runRegisterOwner([ownerTelegramId]);

const errors = [];
let written;
let databasePath;
const daemon = await bootDaemon({
  mode: 'replay',
  home,
  logger: { info: () => {}, error: (line) => errors.push(line) },
  replay: async (context) => {
    databasePath = context.config.database.path;
    const call = async (name, input, operationId) => {
      const outcome = await context.owner.surface.hostToolCall(name, input, operationId, {});
      if (outcome?.status !== 'completed') {
        throw new Error(`${name} did not complete: ${JSON.stringify(outcome?.error ?? outcome)}`);
      }
      return outcome.data;
    };
    const created = await call(
      'work.create',
      {
        topic: 'upgrade check work',
        summary: 'Work the previous release created',
        set: { title: 'Prepare the upgrade fixture' },
        eventDatetime: '2026-10-01T10:00:00+09:00',
      },
      'upgrade-check:work:create'
    );
    const revised = await call(
      'work.revise',
      {
        commitmentId: created.commitmentId,
        summary: 'Work the previous release revised',
        set: { status: 'in_progress' },
        eventDatetime: '2026-10-02T10:00:00+09:00',
      },
      'upgrade-check:work:revise'
    );
    const lesson = await call(
      'memory.save',
      {
        topic: 'upgrade_check_lesson',
        kind: 'lesson',
        summary: 'A lesson the previous release saved',
        details: 'Kept across an upgrade.',
        appliesWhen: 'When an upgrade has to keep what was learned.',
        source: { package: 'owner-agent', source_type: 'memory.save' },
      },
      'upgrade-check:memory:lesson'
    );
    // Accepting schedules a drain, which runs after stop() has begun, so the message stays pending
    // for the next boot, as one taken just before a stop would. The check after stop() fails if a
    // later release drains it first.
    const messageRef = `telegram:${commonChat}:9001`;
    context.owner.intake.acceptOwnerMessage({
      id: messageRef,
      channelKey: `telegram:${commonChat}`,
      occurredAt: Date.parse('2026-10-03T10:00:00+09:00'),
      text: 'An owner message the previous release accepted',
    });
    written = {
      commitmentId: created.commitmentId,
      revision: revised.revision,
      title: 'Prepare the upgrade fixture',
      status: 'in_progress',
      lessonId: lesson.id,
      messageRef,
    };
  },
});
await daemon.stop();
if (errors.length > 0) {
  throw new Error(`the previous release logged errors:\n${errors.join('\n')}`);
}
if (!written) {
  throw new Error('the previous release did not run the replay');
}
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const left = db.prepare("SELECT status FROM mailbox_inputs WHERE kind = 'owner_message'").all();
db.close();
if (left.length !== 1 || left[0].status !== 'pending') {
  throw new Error(`the owner message is not left pending: ${JSON.stringify(left)}`);
}
writeFileSync(writtenPath, `${JSON.stringify(written, null, 2)}\n`);
