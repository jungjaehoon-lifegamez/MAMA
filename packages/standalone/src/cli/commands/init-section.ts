import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { loadConnectorConfig, parseConnectorConfig } from '../../connectors/config-loader.js';
import type { ConnectorsConfig } from '../../connectors/framework/types.js';
import { loadConfig, parseConfig, type W1Config } from '../../runtime/config.js';
import { planConnectors } from '../../runtime/connectors.js';
import { findExecutable, mamaCommand } from '../launch-files.js';
import { CliInputError, createTerminalPrompt, nonblankLine, requireTTY } from '../prompt.js';
import { updateSecrets, type SecretName } from '../secrets.js';
import {
  defaultTelegramCall,
  readAuthEnv,
  serviceEnvironment,
  withEnvironment,
} from '../runtime/diagnostics.js';
import { takeSecrets, type PageSecret } from '../runtime/setup-page.js';
import { sourceToolLines } from '../runtime/source-tools.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  refuseWhileRestoring,
} from '../runtime/daemon-control.js';
import { pathsFor, validateDeliveryRoutes } from './daemon.js';
import type { InitOptions } from './init.js';
import { serviceFile } from './service.js';
import {
  askBackend,
  askDiscord,
  askJev,
  askSlack,
  askTimezone,
  buildSources,
  type BuiltSource,
  checkBackend,
  terminalSignIn,
  checkTelegram,
  validTimezone,
  collectConnectors,
  secretReaders,
  sourceToolReports,
  type StoredSecrets,
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

/** The setup page's field for the Jev key, which goes to its own file, not auth.env. */
const JEV_KEY_FIELD = 'jev-key';

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
  // As doctor asks it: the environment start.sh gives the daemon.
  const env = serviceEnvironment(
    home,
    readAuthEnv(root),
    tools.service.exports,
    tools.service.path
  );
  /** Each refused source's reason, in gws's words: no sign-in, a missing scope, the network. */
  const refused = new Map<string, string>();
  for (const { name, source, needs } of added)
    if (
      needs.some((need) => need.type === 'cli') &&
      !(await withEnvironment(env, () => source.authenticate()))
    )
      // A Google source's failed check keeps gws's reason as its health error.
      refused.set(name, (await source.healthCheck()).error!);
  if (refused.size === 0) return;
  throw new CliInputError(
    [
      'Nothing was saved.',
      ...tools.reports.flatMap(({ tool, sources, login }) => {
        const who = sources.filter((name) => refused.has(name));
        return who.length === 0
          ? []
          : [
              ...who.map((name) => refused.get(name)!),
              tool.beforeLogin,
              // One login serves every source that runs the tool, so it names what all need.
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

/** The token names `sources` read, each with the sources that read it. */
function tokenReaders(sources: readonly BuiltSource[]): Map<string, string[]> {
  const readers = new Map<string, string[]>();
  for (const { name, needs } of sources)
    for (const need of needs)
      if (need.type === 'token' && need.tokenName !== undefined)
        readers.set(need.tokenName, [...(readers.get(need.tokenName) ?? []), name]);
  return readers;
}

/**
 * auth.env's secrets with a value, as start.sh gives them to boot, and what else reads each name
 * (#552). A blank value is missing to boot and doctor, so it is asked for, not kept.
 */
function storedSecrets(root: string, readers: (name: string) => string): StoredSecrets {
  return {
    names: new Set(
      Object.entries(readAuthEnv(root))
        .filter(([, value]) => value.trim() !== '')
        .map(([name]) => name)
    ),
    readers,
  };
}

/**
 * MAMA_INIT_REPLACE_SECRETS, the environment form of the terminal's "Replace it": the stored
 * secrets among `asks`, the ones this part takes, that the page asks for again (#552). A name the
 * part does not take would be kept while the person thinks it was replaced, so `refusal` refuses
 * it.
 */
function replacedSecrets(
  env: NodeJS.ProcessEnv,
  asks: Iterable<string>,
  refusal: (name: string) => string
): Set<string> {
  const taken = new Set(asks);
  const names = new Set(
    env.MAMA_INIT_REPLACE_SECRETS?.split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  );
  for (const name of names) if (!taken.has(name)) throw new CliInputError(refusal(name));
  return names;
}

/** What a part other than connectors says of a replaced name it does not take. */
function partRefusal(section: string, asks: readonly string[]): (name: string) => string {
  return (name) =>
    `MAMA_INIT_REPLACE_SECRETS names ${name}, which mama init --section ${section} does not ask for${asks.length > 0 ? ` (it asks for ${asks.join(' and ')})` : ''}; mama secret set ${name} --non-interactive replaces a secret on its own. Nothing was saved.`;
}

/**
 * Of `names`, the ones the setup page asks for: one auth.env already holds is kept, and said,
 * unless `replace` names it.
 */
function secretsToAsk(
  names: Iterable<string>,
  stored: StoredSecrets,
  replace: ReadonlySet<string>,
  write: (line: string) => void
): string[] {
  return [...names].filter((name) => {
    if (!stored.names.has(name) || replace.has(name)) return true;
    const others = stored.readers(name);
    write(
      `${name} is in auth.env already and is kept${others ? `; ${others} reads it too` : ''}. To enter another, run this again with MAMA_INIT_REPLACE_SECRETS=${name}.`
    );
    return false;
  });
}

/**
 * The secrets the sources being enabled read, for the setup page (install.md, W2.4.5b), one field
 * each and named as auth.env names it. Their names come from each source's own requirements,
 * which name the tokens a block's `auth` does not (Trello's key). One auth.env already holds is
 * kept unless `replace` names it: the Slack and Discord sources read their messenger's bot token,
 * so a token entered for the source switches the messenger too (#552).
 */
function sourcePageSecrets(
  sources: readonly BuiltSource[],
  stored: StoredSecrets,
  replace: ReadonlySet<string>,
  write: (line: string) => void
): PageSecret[] {
  const readers = tokenReaders(sources);
  // Each token source is built only with its own token name (its constructor checks the block),
  // so the page never takes the owner's bot token, MAMA_AUTH_TOKEN or the Slack app token.
  return secretsToAsk(readers.keys(), stored, replace, write).map((name) => {
    const others = stored.readers(name);
    return {
      name,
      label: `${name}, for ${readers.get(name)!.join(', ')}${
        stored.names.has(name)
          ? `. It replaces the one in auth.env${others ? `, which ${others} also reads: from the next start, the messenger uses the token entered here` : ''}.`
          : ''
      }`,
    };
  });
}

/** The tokens a messenger part asks for, as the terminal's questions name them. */
const MESSENGER_TOKENS = {
  discord: [['MAMA_DISCORD_TOKEN', 'Discord bot token']],
  slack: [
    ['MAMA_SLACK_TOKEN', 'Slack bot token'],
    ['MAMA_SLACK_APP_TOKEN', 'Slack Socket Mode app token'],
  ],
} as const satisfies Record<'discord' | 'slack', ReadonlyArray<readonly [SecretName, string]>>;

/** A messenger part's tokens for the setup page; one auth.env holds is kept unless replaced. */
function messengerPageSecrets(
  messenger: 'discord' | 'slack',
  stored: StoredSecrets,
  replace: ReadonlySet<string>,
  write: (line: string) => void
): PageSecret[] {
  const labels = new Map<string, string>(MESSENGER_TOKENS[messenger]);
  return secretsToAsk(labels.keys(), stored, replace, write).map((name) => {
    const others = stored.readers(name);
    return {
      name,
      label: `${labels.get(name)!} (${name})${
        stored.names.has(name)
          ? `. It replaces the one in auth.env${others ? `, which ${others} also reads: from the next start, it uses the token entered here too` : ''}.`
          : ''
      }`,
    };
  });
}

/** A variable a part's --non-interactive form needs. */
function variable(env: NodeJS.ProcessEnv, name: string, section: string): string {
  const value = env[name]?.trim();
  if (!value)
    throw new CliInputError(`mama init --section ${section} --non-interactive needs ${name}`);
  return nonblankLine(value).trim();
}

/** A variable that turns a part on or off. */
function onOff(env: NodeJS.ProcessEnv, name: string, section: string): boolean {
  const value = variable(env, name, section);
  if (value === 'on' || value === 'off') return value === 'on';
  throw new CliInputError(`${name} must be on or off.`);
}

/**
 * A messenger's owner messages from the environment, as askDiscord and askSlack ask them: off, or
 * one owner channel and the owner's user id.
 */
function environmentMessenger(
  env: NodeJS.ProcessEnv,
  messenger: 'discord' | 'slack'
): Record<string, unknown> {
  const prefix = `MAMA_INIT_${messenger.toUpperCase()}`;
  if (!onOff(env, prefix, messenger))
    return { enabled: false, allowed_channels: [], owner_user_ids: [] };
  const channel = variable(env, `${prefix}_CHANNEL_ID`, messenger);
  const user = variable(env, `${prefix}_USER_ID`, messenger);
  return {
    enabled: true,
    owner_channel_id: channel,
    allowed_channels: [channel],
    owner_user_ids: [user],
  };
}

/**
 * auth.env's secrets for a messenger part, with the sources on in connectors.json that read the
 * messenger's token. connectors.json is read as boot reads it; one boot would refuse stops here.
 */
function sourceSecrets(root: string, connectorsPath: string): StoredSecrets {
  const loaded = loadConnectorConfig(connectorsPath, () => {});
  if (!loaded.ok)
    throw new CliInputError(
      `${loaded.error.message}, so MAMA would not start; correct it, then run this again.`
    );
  return storedSecrets(root, secretReaders(loaded.enabledNames, []));
}

/**
 * Ask one part of an existing setup again and save it: the answers are checked as `mama init`
 * checks them, the changed config.yaml is parsed as the daemon parses it before it is written,
 * and tokens go only to auth.env. The daemon reads its settings at boot and holds the install
 * lock, so a change waits until it is stopped. With `--non-interactive` the person's agent runs
 * it (install.md, W2.4.5e and W2.4.6): the answers that are not secret come from the environment,
 * and every secret is entered on the setup page once those answers and the boot checks pass.
 */
export async function runInitSection(
  section: string,
  options: InitOptions = {},
  nonInteractive = false
): Promise<void> {
  if (!(initSections as readonly string[]).includes(section))
    throw new CliInputError(`Choose a section: ${initSections.join(', ')}`);
  const prompt = options.prompt ?? createTerminalPrompt();
  if (!nonInteractive) requireTTY(prompt);
  const write = (line: string) => prompt.write(line);
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const root = join(home, '.mama');
  const configPath = join(root, 'config.yaml');
  if (!existsSync(configPath))
    throw new CliInputError('MAMA is not set up here; run the install command first.');
  const mama = mamaCommand(root);
  // `service start` needs the service file, which `service install` writes.
  const start = existsSync(serviceFile({ home, platform: options.platform ?? process.platform }))
    ? `${mama} service start`
    : `${mama} service install, then ${mama} service start`;
  const lock = acquireInstallLock(daemonControlPaths(root), 'init --section');
  try {
    refuseWhileRestoring(root);
  } catch (error) {
    lock.release();
    throw error;
  }
  try {
    const config = loadConfig({ home, path: configPath });
    const connectorsPath = pathsFor(configPath, config).connectorsConfigPath;
    // A secret auth.env already holds is kept unless the person asks to replace it (#552); the
    // parts that ask for one read it.
    let stored: StoredSecrets | undefined;
    const secrets: Partial<Record<SecretName, string>> = {};
    /** Without a terminal: the secrets the setup page takes, once everything else passes. */
    const page: PageSecret[] = [];
    let pageDone = 'Every token is taken.';
    /** A part other than connectors takes only its own secrets again. */
    const replaceOnly = (asks: readonly string[]) =>
      nonInteractive ? replacedSecrets(env, asks, partRefusal(section, asks)) : new Set<string>();
    let change: ((doc: Record<string, unknown>) => void) | undefined;
    let connectors: ConnectorsConfig | undefined;
    let jevKey: string | undefined;
    const jevKeyFile = config.jev?.keyFile ?? join(root, 'jev-key');
    if (section === 'telegram') {
      // The owners and the common group stay, so the new bot must already be in that group.
      const check = (token: string, next: string) =>
        checkTelegram(
          token,
          config.telegram?.owner_chat_id,
          options.telegramCall ?? defaultTelegramCall,
          write,
          { groupRequired: true, next }
        );
      if (nonInteractive) {
        replaceOnly(['MAMA_TELEGRAM_TOKEN']);
        page.push({
          name: 'MAMA_TELEGRAM_TOKEN',
          label: 'Telegram bot token (from BotFather), for a bot already in the common group',
          check: (token) => check(token, 'enter it again on this page'),
        });
        pageDone = 'The bot token is taken.';
      } else {
        const token = nonblankLine(await prompt.secret('Telegram bot token'));
        await check(token, 'run this again');
        secrets.MAMA_TELEGRAM_TOKEN = token;
      }
    } else if (section === 'model') {
      replaceOnly([]);
      const locate = options.findExecutable ?? findExecutable;
      // A signed-out backend's login runs at a terminal; without one it is named, for the
      // person's agent to run.
      const check = (name: 'claude' | 'codex') =>
        checkBackend(
          name,
          config.agent.codex_home ?? join(root, '.codex'),
          locate,
          options.probeRun,
          'run this again',
          nonInteractive ? undefined : { run: options.signIn ?? terminalSignIn, write }
        );
      let backend: 'claude' | 'codex';
      let model: string;
      if (nonInteractive) {
        const named = variable(env, 'MAMA_INIT_BACKEND', section);
        if (named !== 'claude' && named !== 'codex')
          throw new CliInputError('MAMA_INIT_BACKEND must be claude or codex.');
        model = variable(env, 'MAMA_INIT_MODEL', section);
        check(named);
        backend = named;
      } else ({ backend, model } = await askBackend(prompt, check, locate));
      change = (doc) => {
        doc.agent = { ...(doc.agent as Record<string, unknown> | undefined), backend, model };
      };
    } else if (section === 'timezone') {
      replaceOnly([]);
      const timezone = nonInteractive
        ? validTimezone(variable(env, 'MAMA_INIT_TIMEZONE', section))
        : await askTimezone(prompt, config.timezone);
      change = (doc) => {
        doc.timezone = timezone;
      };
    } else if (section === 'connectors') {
      // The sources named are set up again; the others keep their settings. Their tokens are also
      // read by the messengers that are on.
      stored = storedSecrets(
        root,
        secretReaders(
          [],
          (['telegram', 'discord', 'slack'] as const).filter((name) => config[name]?.enabled)
        )
      );
      connectors = nonInteractive
        ? environmentConnectors(env)
        : await collectConnectors(prompt, secrets, stored);
    } else if (section === 'discord' || section === 'slack') {
      const messengerStored = sourceSecrets(root, connectorsPath);
      let block: Record<string, unknown>;
      if (nonInteractive) {
        block = environmentMessenger(env, section);
        const asks = block.enabled ? MESSENGER_TOKENS[section].map(([name]) => name) : [];
        const replace = replaceOnly(asks);
        if (block.enabled)
          page.push(...messengerPageSecrets(section, messengerStored, replace, write));
      } else
        block =
          section === 'discord'
            ? await askDiscord(prompt, secrets, messengerStored)
            : await askSlack(prompt, secrets, messengerStored);
      change = (doc) => {
        doc[section] = mergeBlock(doc[section], block);
      };
    } else {
      let enabled: boolean;
      if (nonInteractive) {
        replaceOnly([]);
        enabled = onOff(env, 'MAMA_INIT_JEV', section);
        // As at a terminal, a key file already in place is kept.
        if (enabled && !existsSync(jevKeyFile)) {
          write('Get a Jev API key from TypeSafe: https://docs.typesafe.ai');
          page.push({ name: JEV_KEY_FIELD, label: 'Jev API key (from TypeSafe)' });
          pageDone = 'The Jev API key is taken.';
        }
      } else {
        const jev = await askJev(prompt, jevKeyFile);
        enabled = jev.enabled;
        jevKey = jev.key;
      }
      change = (doc) => {
        doc.jev = { ...(doc.jev as Record<string, unknown> | undefined), enabled };
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
        // Checked before the sources' tools, whose sign-in check can take a while.
        const replace = nonInteractive
          ? replacedSecrets(
              env,
              tokenReaders(added).keys(),
              (name) =>
                `MAMA_INIT_REPLACE_SECRETS names ${name}, which no source in MAMA_INIT_CONNECTORS reads; nothing was saved.`
            )
          : new Set<string>();
        await checkSourceTools(added, enabled, { root, home, config, options, mama });
        if (nonInteractive) page.push(...sourcePageSecrets(added, stored!, replace, write));
      }
      // Last, once every other answer and check has passed, so a refusal costs no entry.
      if (page.length > 0)
        for (const [name, value] of Object.entries(
          await takeSecrets(page, pageDone, {
            write,
            platform: options.platform ?? process.platform,
            ...(options.openRun ? { openRun: options.openRun } : {}),
            ...(options.setupPageMs === undefined ? {} : { lifetimeMs: options.setupPageMs }),
          })
        ))
          if (name === JEV_KEY_FIELD) jevKey = value;
          else secrets[name as SecretName] = value;
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
      throw new CliInputError(`${error.message}\nMAMA is still stopped; start it with ${start}.`, {
        cause: error,
      });
    throw error;
  } finally {
    lock.release();
  }
  // doctor checks what this command cannot see: the service's PATH for a new backend or a
  // source's tool, and the rest of the install as boot will read it.
  write(`Saved ${section}. Check the install with ${mama} doctor, then start MAMA: ${start}`);
}
