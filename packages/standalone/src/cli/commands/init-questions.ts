import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cliAuth,
  type AuthRequirement,
  type ConnectorsConfig,
} from '../../connectors/framework/types.js';
import { loadConnector } from '../../connectors/index.js';
import type { W1Config } from '../../runtime/config.js';
import { connectorLoadPaths, planConnectors } from '../../runtime/connectors.js';
import { createTimeZoneSetting } from '../../runtime/timezone.js';
import { gwsTool } from '../../connectors/framework/gws-utils.js';
import { backendEnvironment } from '../../runtime/backend-security.js';
import { CliInputError, nonblankLine, type PromptAdapter } from '../prompt.js';
import { shellQuote, type SecretName } from '../secrets.js';
import { probeBackend, type ProbeRun } from '../runtime/backend-probe.js';
import { telegramCheck } from '../runtime/diagnostics.js';
import {
  serviceSight,
  sourceToolLines,
  sourceTools,
  type SourceToolReport,
} from '../runtime/source-tools.js';
import { findExecutable, findIn } from '../launch-files.js';
import { pathsFor } from './daemon.js';
import { serviceLaunch, type ServiceOptions } from './service.js';

/** The questions `mama init --section` asks, and the checks it shares with the whole setup. */

const connectorNames = [
  'slack',
  'chatwork',
  'trello',
  'calendar',
  'gmail',
  'drive',
  'sheets',
  'notion',
  'obsidian',
  'discord',
  'telegram',
  'imessage',
  'claude-code',
] as const;
const connectorSecrets: Record<string, SecretName[]> = {
  slack: ['MAMA_SLACK_TOKEN'],
  chatwork: ['MAMA_CHATWORK_TOKEN'],
  trello: ['MAMA_TRELLO_KEY', 'MAMA_TRELLO_TOKEN'],
  calendar: [],
  gmail: [],
  drive: [],
  sheets: [],
  notion: ['MAMA_NOTION_TOKEN'],
  obsidian: [],
  discord: ['MAMA_DISCORD_TOKEN'],
  telegram: ['MAMA_TELEGRAM_SOURCE_TOKEN'],
  imessage: [],
  'claude-code': [],
};

const noSecretConnectorNames = new Set(['obsidian', 'imessage', 'claude-code']);

export async function yes(prompt: PromptAdapter, label: string): Promise<boolean> {
  const value = (await prompt.text(`${label} [y/N]`)).trim().toLowerCase();
  if (['', 'n', 'no'].includes(value)) return false;
  if (['y', 'yes'].includes(value)) return true;
  throw new CliInputError('Answer yes or no.');
}

export async function text(prompt: PromptAdapter, label: string): Promise<string> {
  return nonblankLine(await prompt.text(label)).trim();
}

async function optionalText(prompt: PromptAdapter, label: string): Promise<string | undefined> {
  const value = (await prompt.text(label)).trim();
  return value === '' ? undefined : nonblankLine(value).trim();
}

export async function collectConnectors(
  prompt: PromptAdapter,
  secrets: Partial<Record<SecretName, string>>
): Promise<ConnectorsConfig> {
  const selected = (
    await prompt.text(
      `Connectors to enable (${connectorNames.join(', ')}; comma-separated, blank for none)`
    )
  ).trim();
  const names = selected === '' ? [] : [...new Set(selected.split(',').map((name) => name.trim()))];
  if (names.some((name) => !(connectorNames as readonly string[]).includes(name))) {
    throw new CliInputError(`Choose connectors from: ${connectorNames.join(', ')}`);
  }
  const config: ConnectorsConfig = {};
  for (const name of names) {
    for (const tokenName of connectorSecrets[name])
      secrets[tokenName] = nonblankLine(await prompt.secret(tokenName));
    if (name === 'slack')
      secrets.MAMA_SLACK_APP_TOKEN = nonblankLine(await prompt.secret('MAMA_SLACK_APP_TOKEN'));
    if (name === 'calendar')
      prompt.write(
        'Calendar currently reads the primary calendar only; its source channel id is calendar.'
      );

    if (name === 'gmail') {
      config.gmail = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: { inbox: { role: 'hub' } },
        auth: cliAuth(gwsTool),
      };
      continue;
    }
    if (name === 'notion') {
      config.notion = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: { workspace: { role: 'hub', name: 'Notion workspace' } },
        auth: { type: 'token', tokenName: 'MAMA_NOTION_TOKEN' },
      };
      continue;
    }
    if (name === 'obsidian') {
      const vaultPath = await text(prompt, 'Obsidian vault path');
      config.obsidian = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: { vault: { role: 'hub', name: 'Vault', vaultPath } },
        auth: { type: 'none' },
      };
      continue;
    }
    if (name === 'claude-code') {
      const selectedProjects = (
        await text(prompt, 'Claude Code project directory names (comma-separated)')
      )
        .split(',')
        .map((project) => project.trim());
      if (selectedProjects.some((project) => !project || /[/\\\s]/.test(project))) {
        throw new CliInputError(
          'Enter Claude Code project directory names without paths or spaces.'
        );
      }
      const channels: ConnectorsConfig[string]['channels'] = {};
      for (const project of selectedProjects) {
        const alias = await text(prompt, `Display alias for ${project}`);
        channels[project] = { role: 'hub', name: alias };
      }
      config['claude-code'] = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels,
        auth: { type: 'none' },
      };
      continue;
    }
    if (name === 'drive') {
      const folderIds = (await text(prompt, 'Drive folder ids (comma-separated)'))
        .split(',')
        .map((id) => id.trim());
      if (folderIds.some((id) => !id || /\s/.test(id)))
        throw new CliInputError('Enter Drive folder ids separated by commas without spaces.');
      config.drive = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: Object.fromEntries(
          folderIds.map((folderId) => [folderId, { role: 'hub', folderId }])
        ),
        auth: cliAuth(gwsTool),
      };
      continue;
    }
    if (name === 'sheets') {
      const spreadsheetId = await text(prompt, 'Google Sheets spreadsheet id');
      const sheetRange = await text(prompt, 'Google Sheets header-and-data range');
      const dataRange = await optionalText(
        prompt,
        'Separate data range (blank to use the full range)'
      );
      config.sheets = {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: {
          spreadsheet: {
            role: 'hub',
            spreadsheetId,
            sheetRange,
            ...(dataRange ? { dataRange } : {}),
          },
        },
        auth: cliAuth(gwsTool),
      };
      continue;
    }

    const ids = (
      await text(
        prompt,
        `${name} ${name === 'trello' ? 'board' : 'channel'} ids (comma-separated ids only)`
      )
    )
      .split(',')
      .map((id) => id.trim());
    if (ids.some((id) => !id || /\s/.test(id)))
      throw new CliInputError('Enter channel ids separated by commas, without display names.');
    if (name === 'calendar' && (ids.length !== 1 || ids[0] !== 'calendar')) {
      throw new CliInputError(
        'Calendar supports only the source channel id calendar (primary calendar).'
      );
    }
    config[name] = {
      enabled: true,
      pollIntervalMinutes: 5,
      channels: Object.fromEntries(
        ids.map((id) => [id, { role: 'hub', ...(name === 'trello' ? { boardId: id } : {}) }])
      ),
      auth:
        name === 'calendar'
          ? cliAuth(gwsTool)
          : noSecretConnectorNames.has(name)
            ? { type: 'none' }
            : { type: 'token', tokenName: connectorSecrets[name].at(-1)! },
    };
  }
  return config;
}

/** A source as boot builds it from connectors.json, with what it needs. */
export interface BuiltSource {
  readonly name: string;
  readonly needs: AuthRequirement[];
}

/**
 * Each enabled source in `plan`, built as boot builds it, with its own requirements: a source
 * names its tool there, since connectors.json's `auth` is not what the source runs. A source that
 * cannot be built comes back with its error; boot would stop at the connectors stage.
 */
export async function buildSources(
  plan: ReturnType<typeof planConnectors>,
  config: W1Config,
  configPath: string
): Promise<Array<BuiltSource | { readonly name: string; readonly error: Error }>> {
  const paths = pathsFor(configPath, config);
  const timeZone = createTimeZoneSetting(config.timezone);
  const built: Array<BuiltSource | { name: string; error: Error }> = [];
  for (const name of plan.enabledConnectorNames) {
    try {
      const source = await loadConnector(
        name,
        plan.config.config[name],
        connectorLoadPaths(name, {
          statePath: paths.connectorsRoot,
          kagemushaDbPath: paths.kagemushaDbPath,
          timeZone,
        })
      );
      built.push({ name, needs: source.getAuthRequirements() });
    } catch (error) {
      built.push({ name, error: error as Error });
    }
  }
  return built;
}

/**
 * For `sources`, each tool they run as the service would find it (install.md, PR 3), with how to
 * install it and its login; `enabled` is every source that will run. start.sh is read only when
 * a source runs a tool.
 */
export function sourceToolReports(
  sources: readonly BuiltSource[],
  enabled: readonly BuiltSource[],
  install: { root: string; home: string; platform: NodeJS.Platform },
  config: W1Config,
  options: Pick<ServiceOptions, 'findExecutable' | 'nodePath' | 'cliPath' | 'toolDirectoryExists'>
): SourceToolReport[] {
  if (!sources.some(({ needs }) => needs.some((need) => need.type === 'cli'))) return [];
  const { root, home, platform } = install;
  const service = serviceSight(
    root,
    home,
    platform,
    () => serviceLaunch(config.agent.backend, options),
    options.toolDirectoryExists
  );
  return sourceTools(
    sources,
    service,
    { root, home },
    { inDirs: findIn, shell: options.findExecutable ?? findExecutable },
    enabled
  );
}

/**
 * For the enabled sources in connectors.json, each tool they run that the service cannot find,
 * with how to install it, and each one's login: what `mama init` says when it continues a setup
 * that stopped (often at the boot wait, when a source's tool is missing). connectors.json is read
 * as boot and doctor read it (planConnectors). It reports; what boot refuses doctor names in full.
 */
export async function writeSourceTools(
  install: { root: string; home: string; platform: NodeJS.Platform; configPath: string },
  config: W1Config,
  options: Pick<ServiceOptions, 'findExecutable' | 'nodePath' | 'cliPath' | 'toolDirectoryExists'>,
  write: (line: string) => void,
  /** What to do once a missing tool is installed. */
  next: string
): Promise<void> {
  const { configPath } = install;
  let plan: ReturnType<typeof planConnectors>;
  try {
    plan = planConnectors({
      configPath: pathsFor(configPath, config).connectorsConfigPath,
      onIgnored: () => {},
      ...(config.wiki?.enabled
        ? { wikiRoot: resolve(config.wiki.vaultPath!, config.wiki.wikiDir!) }
        : {}),
    });
  } catch (error) {
    write(
      `connectors.json does not load as boot reads it (${(error as Error).message}); mama doctor names what to correct.`
    );
    return;
  }
  const sources: BuiltSource[] = [];
  for (const source of await buildSources(plan, config, configPath)) {
    if ('error' in source)
      write(
        `${source.name} cannot be built from connectors.json (${source.error.message}); mama doctor names it.`
      );
    else sources.push(source);
  }
  const reports = sourceToolReports(sources, sources, install, config, options);
  for (const line of sourceToolLines(reports, next)) write(line);
}

export type TelegramCall = Parameters<typeof telegramCheck>[2];

export function validTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new CliInputError(`Timezone "${timezone}" is not a valid IANA time zone.`);
  }
  return timezone;
}

/**
 * Run a backend's own sign-in attached to the terminal, for `mama init --section model`: it names
 * the command and runs it for the person, then reads the login again. Its exit status. The whole
 * setup only names the login, for the person's agent to run (owner-setup.md).
 */
export type BackendSignIn = (command: string, args: string[], env: NodeJS.ProcessEnv) => number;

export const terminalSignIn: BackendSignIn = (command, args, env) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/**
 * The backend this install will run must be installed, at least the version a release was
 * verified on, and signed in, before anything is written: the daemon would otherwise fail its
 * first turn. Codex is asked about the managed home MAMA gives it. With `signIn` (a terminal,
 * `--section model`), a signed-out backend's login runs here, and the login is read again;
 * without it, the login is named with the backend's full path, for the person's agent to run.
 * `next` is the caller's next step after a fix.
 */
export function checkBackend(
  backend: 'claude' | 'codex',
  codexHome: string,
  locate: (name: string) => string | undefined,
  run: ProbeRun | undefined,
  next: string,
  signIn?: { run: BackendSignIn; write: (line: string) => void }
): void {
  const executable = locate(backend);
  const command = executable === undefined ? backend : shellQuote(executable);
  const login =
    backend === 'claude'
      ? `${command} auth login`
      : `CODEX_HOME=${shellQuote(codexHome)} ${command} login`;
  if (!executable) {
    throw new CliInputError(
      `${backend} is not on this PATH. Install it, sign in with: ${login}, then ${next}.`
    );
  }
  // The daemon starts the backend without secret-shaped variables; a login that only this
  // shell's API key gives would pass here and fail every turn.
  const env = backendEnvironment();
  const read = () =>
    probeBackend(backend, executable, {
      env,
      ...(backend === 'codex' ? { codexHome } : {}),
      ...(run ? { run } : {}),
    });
  let probe = read();
  if (probe.version === null) throw new CliInputError(`${probe.problem}; check ${executable}`);
  // An old CLI is the more useful answer even when its login could not be read.
  if (!probe.versionOk) {
    throw new CliInputError(
      `${backend} ${probe.version} is older than ${probe.minimum}, the oldest MAMA was verified on; update it, then ${next}.`
    );
  }
  if (probe.problem) throw new CliInputError(`${probe.problem}; check ${executable}`);
  // Codex refuses a CODEX_HOME that does not exist; this one is MAMA's own, made here so the login
  // named below, or run on a terminal, works.
  if (!probe.loggedIn && backend === 'codex')
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (!probe.loggedIn && signIn) {
    signIn.write(`${backend} is not signed in; running: ${login}`);
    let status: number;
    if (backend === 'codex') {
      status = signIn.run(executable, ['login'], { ...env, CODEX_HOME: codexHome });
    } else {
      status = signIn.run(executable, ['auth', 'login'], env);
    }
    if (status !== 0) {
      throw new CliInputError(`${login} exited ${status}; sign in with it yourself, then ${next}.`);
    }
    probe = read();
    if (probe.problem) throw new CliInputError(`${probe.problem}; check ${executable}`);
  }
  if (!probe.loggedIn) {
    throw new CliInputError(`${backend} is not signed in. Run: ${login}, then ${next}.`);
  }
}

/** Telegram must accept the token; anything about the group is reported and doctor checks again. */
export async function checkTelegram(
  token: string,
  chatId: string | undefined,
  call: TelegramCall,
  write: (line: string) => void,
  options: { groupRequired?: boolean; next: string }
): Promise<void> {
  const check = await telegramCheck(token, chatId, call);
  if (check.detail === 'Telegram refused the bot token') {
    throw new CliInputError(`Telegram refused the bot token; copy it again from BotFather.`);
  }
  if (check.detail.startsWith('could not reach Telegram')) {
    throw new CliInputError(
      `${check.detail}, so the token is unchecked; check the network, then ${options.next}.`
    );
  }
  // A new bot the common group cannot be shown to hold, or to read, would leave that channel silent.
  if (options.groupRequired && check.status !== 'ok')
    throw new CliInputError(
      `${check.detail}${check.fix ? `: ${check.fix}` : ''}; the token was not saved. Run this again once that is fixed.`
    );
  report(check, write);
}

export function report(
  check: Awaited<ReturnType<typeof telegramCheck>>,
  write: (line: string) => void
) {
  if (check.status !== 'ok')
    write(`telegram: ${check.detail}${check.fix ? ` (${check.fix})` : ''}`);
}

/** Discord owner messages: off, or one owner channel and the owner's user id. */
export async function askDiscord(
  prompt: PromptAdapter,
  secrets: Partial<Record<SecretName, string>>
): Promise<Record<string, unknown>> {
  if (!(await yes(prompt, 'Enable Discord owner messages')))
    return { enabled: false, allowed_channels: [], owner_user_ids: [] };
  secrets.MAMA_DISCORD_TOKEN ??= nonblankLine(await prompt.secret('Discord bot token'));
  const channel = await text(prompt, 'Discord owner channel id');
  const user = await text(prompt, 'Discord owner user id');
  return {
    enabled: true,
    owner_channel_id: channel,
    allowed_channels: [channel],
    owner_user_ids: [user],
  };
}

/** Slack owner messages: off, or one owner channel and the owner's user id. */
export async function askSlack(
  prompt: PromptAdapter,
  secrets: Partial<Record<SecretName, string>>
): Promise<Record<string, unknown>> {
  if (!(await yes(prompt, 'Enable Slack owner messages')))
    return { enabled: false, allowed_channels: [], owner_user_ids: [] };
  secrets.MAMA_SLACK_TOKEN ??= nonblankLine(await prompt.secret('Slack bot token'));
  secrets.MAMA_SLACK_APP_TOKEN ??= nonblankLine(await prompt.secret('Slack Socket Mode app token'));
  const channel = await text(prompt, 'Slack owner channel id');
  const user = await text(prompt, 'Slack owner user id');
  return {
    enabled: true,
    owner_channel_id: channel,
    allowed_channels: [channel],
    owner_user_ids: [user],
  };
}

/** Jev (TypeSafe) is the owner's choice: the agent's judge tool, off unless chosen here. */
export async function askJev(
  prompt: PromptAdapter,
  keyFile: string
): Promise<{ enabled: boolean; key: string | undefined }> {
  const enabled = await yes(
    prompt,
    'Use Jev (TypeSafe) so the agent can judge many messages or items without reading them all? Owner text in those calls goes to the Jev service'
  );
  if (!enabled || existsSync(keyFile)) return { enabled, key: undefined };
  prompt.write('Get a Jev API key from TypeSafe: https://docs.typesafe.ai');
  return { enabled, key: nonblankLine(await prompt.secret('Jev API key')) };
}

/** The only backend on PATH is the answer Enter keeps; with both or neither, one is typed. */
export async function askBackend(
  prompt: PromptAdapter,
  check: (name: 'claude' | 'codex') => void,
  locate: (name: string) => string | undefined
): Promise<{ backend: 'claude' | 'codex'; model: string }> {
  const found = (['claude', 'codex'] as const).filter((name) => locate(name) !== undefined);
  const shown = found.length === 1 ? found[0] : undefined;
  const backend =
    (await optionalText(prompt, `Backend (claude|codex)${shown ? ` [${shown}]` : ''}`)) ??
    shown ??
    '';
  if (backend !== 'claude' && backend !== 'codex')
    throw new CliInputError('Backend must be claude or codex.');
  check(backend);
  return { backend, model: await text(prompt, 'Model') };
}

/** Enter keeps the timezone shown: the current setting, or else this machine's. */
export async function askTimezone(prompt: PromptAdapter, current?: string): Promise<string> {
  const shown = current ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const answer = (await prompt.text(`Owner timezone [${shown}]`)).trim();
  return validTimezone(answer || shown);
}
