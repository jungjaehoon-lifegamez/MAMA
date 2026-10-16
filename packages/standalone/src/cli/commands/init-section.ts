import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import type { ConnectorsConfig } from '../../connectors/framework/types.js';
import { validateConnectorConfig } from '../../connectors/config-loader.js';
import { loadConfig, parseConfig } from '../../runtime/config.js';
import { findExecutable } from '../launch-files.js';
import { CliInputError, createTerminalPrompt, nonblankLine, requireTTY } from '../prompt.js';
import { updateSecrets, type SecretName } from '../secrets.js';
import { defaultTelegramCall } from '../runtime/diagnostics.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  refuseWhileRestoring,
} from '../runtime/daemon-control.js';
import type { InitOptions } from './init.js';
import {
  askBackend,
  askDiscord,
  askJev,
  askSlack,
  askTimezone,
  checkBackend,
  checkTelegram,
  collectConnectors,
  gwsConnectorNames,
} from './init-questions.js';

/** The parts of a setup `mama init --section` asks again; the folders stay, member data is there. */
export const initSections = [
  'telegram',
  'model',
  'timezone',
  'connectors',
  'discord',
  'slack',
  'jev',
] as const;

/** Replace a file whole: a reader sees the old file or the new one. */
function replaceFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Ask one part of an existing setup again and save it: the answers are checked as `mama init`
 * checks them, the changed config.yaml is parsed as the daemon parses it before it is written,
 * and tokens go only to auth.env. The daemon reads its settings at boot and holds the install
 * lock, so a change waits until it is stopped.
 */
export async function runInitSection(section: string, options: InitOptions = {}): Promise<void> {
  if (!(initSections as readonly string[]).includes(section))
    throw new CliInputError(`Choose a section: ${initSections.join(', ')}`);
  const prompt = options.prompt ?? createTerminalPrompt();
  requireTTY(prompt);
  const write = (line: string) => prompt.write(line);
  const home = options.home ?? homedir();
  const root = join(home, '.mama');
  const configPath = join(root, 'config.yaml');
  if (!existsSync(configPath))
    throw new CliInputError('MAMA is not set up here; run mama init first.');
  const lock = acquireInstallLock(daemonControlPaths(root), 'init --section');
  try {
    refuseWhileRestoring(root);
    const config = loadConfig({ home, path: configPath });
    const secrets: Partial<Record<SecretName, string>> = {};
    let change: ((doc: Record<string, unknown>) => void) | undefined;
    let connectors: ConnectorsConfig | undefined;
    let jevKey: string | undefined;
    if (section === 'telegram') {
      const token = nonblankLine(await prompt.secret('Telegram bot token'));
      // The owners and the common group stay; the new bot must be in that group.
      await checkTelegram(
        token,
        config.telegram?.owner_chat_id,
        options.telegramCall ?? defaultTelegramCall,
        write
      );
      secrets.MAMA_TELEGRAM_TOKEN = token;
    } else if (section === 'model') {
      const locate = options.findExecutable ?? findExecutable;
      const { backend, model } = await askBackend(prompt, (name) =>
        checkBackend(name, root, locate, options.probeRun)
      );
      change = (doc) => {
        doc.agent = { ...(doc.agent as Record<string, unknown> | undefined), backend, model };
      };
    } else if (section === 'timezone') {
      const timezone = await askTimezone(prompt, config.timezone);
      change = (doc) => {
        doc.timezone = timezone;
      };
    } else if (section === 'connectors') {
      // The sources named are set up again; the others keep their settings.
      connectors = await collectConnectors(prompt, secrets);
    } else if (section === 'discord') {
      const discord = await askDiscord(prompt, secrets);
      change = (doc) => {
        doc.discord = discord;
      };
    } else if (section === 'slack') {
      const slack = await askSlack(prompt, secrets);
      change = (doc) => {
        doc.slack = slack;
      };
    } else {
      const jev = await askJev(prompt, root);
      jevKey = jev.key;
      change = (doc) => {
        doc.jev = { ...(doc.jev as Record<string, unknown> | undefined), enabled: jev.enabled };
      };
    }
    // Every answer is in, and what will be written passes the daemon's own checks, before
    // anything is written.
    let configText: string | undefined;
    let hadComments = false;
    if (change) {
      const raw = readFileSync(configPath, 'utf8');
      const doc = yaml.load(raw) as Record<string, unknown>;
      change(doc);
      parseConfig(doc, { home });
      configText = yaml.dump(doc, { lineWidth: -1, noRefs: true });
      hadComments = /^\s*#/m.test(raw);
    }
    const connectorsPath = join(root, 'connectors.json');
    let connectorsText: string | undefined;
    if (connectors) {
      const merged = {
        ...(existsSync(connectorsPath)
          ? (JSON.parse(readFileSync(connectorsPath, 'utf8')) as ConnectorsConfig)
          : {}),
        ...connectors,
      };
      try {
        validateConnectorConfig(merged);
      } catch (error) {
        throw new CliInputError(`connectors.json would be refused: ${(error as Error).message}`);
      }
      connectorsText = `${JSON.stringify(merged, null, 2)}\n`;
    }
    if (Object.keys(secrets).length > 0) updateSecrets(home, secrets);
    if (connectorsText !== undefined) {
      replaceFile(connectorsPath, connectorsText);
      if (Object.keys(connectors!).some((name) => gwsConnectorNames.has(name)))
        write('Log in with the Google scopes your selected connectors need: gws auth login.');
    }
    if (jevKey !== undefined)
      writeFileSync(join(root, 'jev-key'), `${jevKey}\n`, { flag: 'wx', mode: 0o600 });
    if (configText !== undefined) {
      replaceFile(configPath, configText);
      if (hadComments) write('config.yaml was written again; its comments were not kept.');
    }
  } finally {
    lock.release();
  }
  write(`Saved ${section}. MAMA uses it from its next start: mama service start`);
}
