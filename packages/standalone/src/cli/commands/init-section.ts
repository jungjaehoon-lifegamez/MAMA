import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import type { ConnectorsConfig } from '../../connectors/framework/types.js';
import { loadConfig, parseConfig } from '../../runtime/config.js';
import { planConnectors } from '../../runtime/connectors.js';
import { findExecutable } from '../launch-files.js';
import { CliInputError, createTerminalPrompt, nonblankLine, requireTTY } from '../prompt.js';
import { updateSecrets, type SecretName } from '../secrets.js';
import { defaultTelegramCall } from '../runtime/diagnostics.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  refuseWhileRestoring,
} from '../runtime/daemon-control.js';
import { pathsFor, validateDeliveryRoutes } from './daemon.js';
import type { InitOptions } from './init.js';
import {
  askBackend,
  askDiscord,
  askJev,
  askSlack,
  askTimezone,
  checkBackend,
  terminalSignIn,
  checkTelegram,
  collectConnectors,
  writeSourceTools,
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

/**
 * A messenger block asked again keeps the settings the questions do not cover (file_delivery);
 * turned off, it also keeps its channels for turning it on again.
 */
function mergeBlock(current: unknown, answer: Record<string, unknown>): Record<string, unknown> {
  const kept = current as Record<string, unknown> | undefined;
  if (answer.enabled === false && kept) return { ...kept, enabled: false };
  return { ...kept, ...answer };
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
    const jevKeyFile = config.jev?.keyFile ?? join(root, 'jev-key');
    if (section === 'telegram') {
      const token = nonblankLine(await prompt.secret('Telegram bot token'));
      // The owners and the common group stay, so the new bot must already be in that group.
      await checkTelegram(
        token,
        config.telegram?.owner_chat_id,
        options.telegramCall ?? defaultTelegramCall,
        write,
        { groupRequired: true }
      );
      secrets.MAMA_TELEGRAM_TOKEN = token;
    } else if (section === 'model') {
      const locate = options.findExecutable ?? findExecutable;
      const { backend, model } = await askBackend(
        prompt,
        (name) =>
          checkBackend(
            name,
            config.agent.codex_home ?? join(root, '.codex'),
            locate,
            options.probeRun,
            { run: options.signIn ?? terminalSignIn, write }
          ),
        locate
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
        doc.discord = mergeBlock(doc.discord, discord);
      };
    } else if (section === 'slack') {
      const slack = await askSlack(prompt, secrets);
      change = (doc) => {
        doc.slack = mergeBlock(doc.slack, slack);
      };
    } else {
      const jev = await askJev(prompt, jevKeyFile);
      jevKey = jev.key;
      change = (doc) => {
        doc.jev = { ...(doc.jev as Record<string, unknown> | undefined), enabled: jev.enabled };
      };
    }
    // Every answer is in. The new files are staged in runtime/, which the agent may not read, and
    // must pass the checks MAMA runs at boot before anything takes their place.
    const staging = join(root, 'runtime');
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const staged: Array<{ temporary: string; path: string }> = [];
    const stage = (path: string, content: string): string => {
      const temporary = join(staging, `init-section.${randomUUID()}.tmp`);
      staged.push({ temporary, path });
      writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
      return temporary;
    };
    try {
      let reshaped = false;
      if (change) {
        const raw = readFileSync(configPath, 'utf8');
        const doc = yaml.load(raw) as Record<string, unknown>;
        // A file init wrote reads back the same; one written by hand loses comments and layout.
        reshaped = yaml.dump(doc) !== raw;
        change(doc);
        const changed = parseConfig(doc, { home });
        try {
          validateDeliveryRoutes(changed);
        } catch (error) {
          throw new CliInputError(
            `${(error as Error).message}; set that route in config.yaml to a messenger that stays on, then run this again.`
          );
        }
        stage(configPath, yaml.dump(doc));
      }
      if (connectors) {
        const connectorsPath = pathsFor(configPath, config).connectorsConfigPath;
        const current = existsSync(connectorsPath)
          ? (JSON.parse(readFileSync(connectorsPath, 'utf8')) as ConnectorsConfig)
          : {};
        // The loader reads names in any case; a source asked again replaces its entry whatever
        // case the file gave it.
        for (const name of Object.keys(current))
          if (Object.hasOwn(connectors, name.toLowerCase())) delete current[name];
        const temporary = stage(
          connectorsPath,
          `${JSON.stringify({ ...current, ...connectors }, null, 2)}\n`
        );
        try {
          planConnectors({
            configPath: temporary,
            onIgnored: () => {},
            ...(config.wiki?.enabled
              ? { wikiRoot: resolve(config.wiki.vaultPath!, config.wiki.wikiDir!) }
              : {}),
          });
        } catch (error) {
          throw new CliInputError(
            `connectors.json would be refused at boot: ${(error as Error).message.split(temporary).join(connectorsPath)}`
          );
        }
      }
      if (Object.keys(secrets).length > 0) updateSecrets(home, secrets);
      if (jevKey !== undefined)
        writeFileSync(jevKeyFile, `${jevKey}\n`, { flag: 'wx', mode: 0o600 });
      for (const { temporary, path } of staged) renameSync(temporary, path);
      if (connectors)
        await writeSourceTools(
          connectors,
          { root, home, platform: options.platform ?? process.platform, configPath },
          config,
          options,
          write,
          'Once it is installed, run mama service install (it adds the folder gws went to), then start MAMA: mama service start'
        );
      if (reshaped)
        write(
          'config.yaml was written again in plain YAML; its comments and layout were not kept.'
        );
    } finally {
      for (const { temporary } of staged) rmSync(temporary, { force: true });
    }
  } finally {
    lock.release();
  }
  // doctor checks what this command cannot see: the service's PATH for a new backend or a
  // source's tool, and the rest of the install as boot will read it.
  write(
    `Saved ${section}. Check the install with mama doctor, then start MAMA: mama service start`
  );
}
