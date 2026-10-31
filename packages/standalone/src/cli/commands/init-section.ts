import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { parseConnectorConfig } from '../../connectors/config-loader.js';
import type { ConnectorsConfig } from '../../connectors/framework/types.js';
import { loadConfig, parseConfig, type W1Config } from '../../runtime/config.js';
import { planConnectors } from '../../runtime/connectors.js';
import { findExecutable } from '../launch-files.js';
import { CliInputError, createTerminalPrompt, nonblankLine, requireTTY } from '../prompt.js';
import { updateSecrets, type SecretName } from '../secrets.js';
import { defaultTelegramCall, withEnvironment } from '../runtime/diagnostics.js';
import { openSetupPage } from '../runtime/setup-page.js';
import { sourceToolLines } from '../runtime/source-tools.js';
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
  buildSources,
  type BuiltSource,
  checkBackend,
  mamaCommand,
  terminalSignIn,
  checkTelegram,
  collectConnectors,
  sourceToolReports,
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

/** What the sources section says once a refused source's tool is in place and signed in. */
const SOURCE_NEXT = 'Then run this again.';

/**
 * The new sources' tools, before anything is written (install.md, W2.4.5e). Boot starts every
 * enabled source: one whose tool the service cannot find fails its start (gws --version), which
 * stops boot, and one whose tool is not signed in fails every poll. Either refuses the section,
 * so a source is enabled only after its tool is installed and signed in. The sign-in is each
 * source's own check (Calendar reads the calendar; the others ask gws whether Google still
 * accepts its sign-in), run with the PATH and HOME the service gives it.
 */
async function checkSourceTools(
  added: readonly BuiltSource[],
  enabled: readonly BuiltSource[],
  install: { root: string; home: string; config: W1Config; options: InitOptions; mama: string }
): Promise<void> {
  const { root, home, config, options, mama } = install;
  const platform = options.platform ?? process.platform;
  const tools = sourceToolReports(added, enabled, { root, home, platform }, config, options);
  if (tools === null) return;
  const missing = tools.reports.filter(({ servicePath }) => servicePath === null);
  if (missing.length > 0)
    throw new CliInputError(
      ['Nothing was saved.', ...sourceToolLines(missing, SOURCE_NEXT, mama)].join('\n')
    );
  const env = {
    HOME: home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    PATH: tools.service.path.join(':'),
  };
  const signedOut: string[] = [];
  for (const { name, source, needs } of added)
    if (
      needs.some((need) => need.type === 'cli') &&
      !(await withEnvironment(env, () => source.authenticate()))
    )
      signedOut.push(name);
  if (signedOut.length === 0) return;
  throw new CliInputError(
    [
      'Nothing was saved.',
      ...tools.reports.flatMap(({ tool, sources, login }) => {
        const who = sources.filter((name) => signedOut.includes(name));
        return who.length === 0
          ? []
          : [
              `${tool.command} is not signed in for ${who.join(', ')}.`,
              tool.beforeLogin,
              `Sign in first: ${login}`,
            ];
      }),
      SOURCE_NEXT,
    ].join('\n')
  );
}

/**
 * The sources `--section connectors --non-interactive` sets up: MAMA_INIT_CONNECTORS, a JSON
 * object of connectors.json blocks keyed by source name, checked as boot checks connectors.json.
 * Blocks name their tokens (`auth.tokenName`) and never hold one.
 */
function environmentConnectors(env: NodeJS.ProcessEnv): ConnectorsConfig {
  const source = env.MAMA_INIT_CONNECTORS?.trim();
  if (!source)
    throw new CliInputError(
      'mama init --section connectors --non-interactive needs MAMA_INIT_CONNECTORS: a JSON object of connectors.json blocks, keyed by source name.'
    );
  let ignored: readonly string[] = [];
  const loaded = parseConnectorConfig(source, 'MAMA_INIT_CONNECTORS', (names) => {
    ignored = names;
  });
  if (!loaded.ok) throw new CliInputError(`${loaded.error.message}; nothing was saved.`);
  // Boot skips a source name or a setting it does not know, so such a block would be saved and
  // never run.
  if (ignored.length > 0)
    throw new CliInputError(
      `MAMA_INIT_CONNECTORS names what MAMA does not read: ${ignored.join(', ')}; nothing was saved.`
    );
  return loaded.config;
}

/**
 * The secrets the sources being enabled read, each entered on the setup page (install.md,
 * W2.4.5b), one field each and named as auth.env names it. Their names come from each source's
 * own requirements, which name the tokens a block's `auth` does not (Trello's key).
 */
async function sourceSecretsOnPage(
  sources: readonly BuiltSource[],
  options: InitOptions,
  write: (line: string) => void
): Promise<Partial<Record<SecretName, string>>> {
  const readers = new Map<string, string[]>();
  for (const { name, needs } of sources)
    for (const need of needs)
      if (need.type === 'token' && need.tokenName !== undefined)
        readers.set(need.tokenName, [...(readers.get(need.tokenName) ?? []), name]);
  // Each token source is built only with its own token name (its constructor checks the block),
  // so the page never takes the owner's bot token, MAMA_AUTH_TOKEN or the Slack app token.
  const names = [...readers.keys()];
  const secrets: Partial<Record<SecretName, string>> = {};
  if (names.length === 0) return secrets;
  let taken!: () => void;
  const allTaken = new Promise<void>((resolve) => {
    taken = resolve;
  });
  const page = await openSetupPage({
    fields: names.map((name, index) => ({
      name,
      label: `${name}, for ${readers.get(name)!.join(', ')}`,
      secret: true,
      check: async (value: string) => {
        secrets[name as SecretName] = nonblankLine(value).trim();
        write(`${name} taken`);
        if (index < names.length - 1) return `${name} is taken.`;
        taken();
        return 'Every token is taken.';
      },
    })),
    write,
    platform: options.platform ?? process.platform,
    ...(options.openRun ? { openRun: options.openRun } : {}),
    ...(options.setupPageMs === undefined ? {} : { lifetimeMs: options.setupPageMs }),
  });
  try {
    await Promise.race([allTaken, page.stopped]);
  } finally {
    page.close();
  }
  return secrets;
}

/**
 * Ask one part of an existing setup again and save it: the answers are checked as `mama init`
 * checks them, the changed config.yaml is parsed as the daemon parses it before it is written,
 * and tokens go only to auth.env. The daemon reads its settings at boot and holds the install
 * lock, so a change waits until it is stopped. `--section connectors --non-interactive` takes the
 * sources from MAMA_INIT_CONNECTORS and their tokens on the setup page; every other part needs a
 * terminal (install.md, W2.4.5e).
 */
export async function runInitSection(
  section: string,
  options: InitOptions = {},
  nonInteractive = false
): Promise<void> {
  if (!(initSections as readonly string[]).includes(section))
    throw new CliInputError(`Choose a section: ${initSections.join(', ')}`);
  if (nonInteractive && section !== 'connectors')
    throw new CliInputError(
      `mama init --section ${section} has no --non-interactive form yet; only connectors has one.`
    );
  const prompt = options.prompt ?? createTerminalPrompt();
  if (!nonInteractive) requireTTY(prompt);
  const write = (line: string) => prompt.write(line);
  const home = options.home ?? homedir();
  const root = join(home, '.mama');
  const configPath = join(root, 'config.yaml');
  if (!existsSync(configPath))
    throw new CliInputError('MAMA is not set up here; run the install command first.');
  const mama = mamaCommand(root);
  const lock = acquireInstallLock(daemonControlPaths(root), 'init --section');
  try {
    refuseWhileRestoring(root);
  } catch (error) {
    lock.release();
    throw error;
  }
  try {
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
        { groupRequired: true, next: 'run this again' }
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
            'run this again',
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
      connectors = nonInteractive
        ? environmentConnectors(options.env ?? process.env)
        : await collectConnectors(prompt, secrets);
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
        // The loader reads names in any case (both forms give them in lower case); a source asked
        // again replaces its entry whatever case the file gave it.
        for (const name of Object.keys(current))
          if (Object.hasOwn(connectors, name.toLowerCase())) delete current[name];
        const temporary = stage(
          connectorsPath,
          `${JSON.stringify({ ...current, ...connectors }, null, 2)}\n`
        );
        const refused = (error: unknown) =>
          new CliInputError(
            `connectors.json would be refused at boot: ${(error as Error).message.split(temporary).join(connectorsPath)}`
          );
        let plan: ReturnType<typeof planConnectors>;
        try {
          plan = planConnectors({
            configPath: temporary,
            onIgnored: () => {},
            ...(config.wiki?.enabled
              ? { wikiRoot: resolve(config.wiki.vaultPath!, config.wiki.wikiDir!) }
              : {}),
          });
        } catch (error) {
          throw refused(error);
        }
        // Boot builds every enabled source, then starts it.
        const enabled: BuiltSource[] = [];
        for (const source of await buildSources(plan, config, configPath)) {
          if (!('error' in source)) enabled.push(source);
          else if (Object.hasOwn(connectors, source.name)) throw refused(source.error);
          else
            throw new CliInputError(
              `${source.name}, already on in ${connectorsPath}, cannot be built (${source.error.message}), so boot would stop. Nothing was saved. Turn it off with its block and "enabled": false in MAMA_INIT_CONNECTORS beside the new one, or correct it in ${connectorsPath}.`
            );
        }
        const added = enabled.filter(({ name }) => Object.hasOwn(connectors!, name));
        await checkSourceTools(added, enabled, { root, home, config, options, mama });
        if (nonInteractive)
          Object.assign(secrets, await sourceSecretsOnPage(added, options, write));
      }
      if (Object.keys(secrets).length > 0) updateSecrets(home, secrets);
      if (jevKey !== undefined)
        writeFileSync(jevKeyFile, `${jevKey}\n`, { flag: 'wx', mode: 0o600 });
      for (const { temporary, path } of staged) renameSync(temporary, path);
      if (reshaped)
        write(
          'config.yaml was written again in plain YAML; its comments and layout were not kept.'
        );
    } finally {
      for (const { temporary } of staged) rmSync(temporary, { force: true });
    }
  } catch (error) {
    // The section holds the install lock, so MAMA is stopped while it runs, and a refusal or an
    // expired page leaves it stopped.
    if (error instanceof CliInputError)
      throw new CliInputError(
        `${error.message}\nMAMA is still stopped; start it with ${mama} service start.`,
        { cause: error }
      );
    throw error;
  } finally {
    lock.release();
  }
  // doctor checks what this command cannot see: the service's PATH for a new backend or a
  // source's tool, and the rest of the install as boot will read it.
  write(
    `Saved ${section}. Check the install with ${mama} doctor, then start MAMA: ${mama} service start`
  );
}
