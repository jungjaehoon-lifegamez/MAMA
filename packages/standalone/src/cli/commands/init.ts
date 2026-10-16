import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import type { ConnectorsConfig } from '../../connectors/framework/types.js';
import { loadConfig, parseConfig, type W1Config } from '../../runtime/config.js';
import { validateMemberRoot } from '../../runtime/member-paths.js';
import { assertRootAncestors, validateToolsRoot } from '../../runtime/tools-paths.js';
import { backendEnvironment, physicalReadPath } from '../../runtime/backend-security.js';
import { resolveApiPort } from '../../api/viewer-server.js';
import { installDocumentToolkit } from '../../tools/document-toolkit.js';
import { findExecutable } from '../launch-files.js';
import {
  CliInputError,
  createTerminalPrompt,
  nonblankLine,
  requireTTY,
  type PromptAdapter,
} from '../prompt.js';
import { shellQuote, updateSecrets, type SecretName } from '../secrets.js';
import { probeBackend, type ProbeRun } from '../runtime/backend-probe.js';
import { defaultTelegramCall, portAnswers, telegramCheck } from '../runtime/diagnostics.js';
import { defaultRoots, prepareRoot, type DefaultRoots } from '../runtime/default-roots.js';
import {
  initComplete,
  readInitState,
  writeInitState,
  type InitState,
  type InitStep,
} from '../runtime/init-state.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  refuseWhileRestoring,
  type DaemonControlReply,
} from '../runtime/daemon-control.js';
import { defaultServiceRun, type ServiceRun } from '../runtime/systemd-service.js';
import { askDaemon } from './daemon.js';
import { registerOwnerHolding } from './register-owner.js';
import { installService, startService } from './service.js';

export interface InitOptions {
  home?: string;
  prompt?: PromptAdapter;
  cliPath?: string;
  nodePath?: string;
  findExecutable?: (name: string) => string | undefined;
  platform?: NodeJS.Platform;
  /** This account's name and uid, for the per-user folders; tests name them. */
  user?: string;
  uid?: number;
  installToolkit?: (config: W1Config) => Promise<unknown>;
  /** Where `--non-interactive` reads its answers; by default this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Calls the Telegram Bot API; tests replace it. */
  telegramCall?: Parameters<typeof telegramCheck>[2];
  /** Runs the backend CLI to read its version and login; tests replace it. */
  probeRun?: ProbeRun;
  /** Runs launchctl or systemctl for the service step; tests replace it. */
  serviceRun?: ServiceRun;
  /** Installs and starts the service with the viewer's settings; tests replace it. */
  startService?: (viewer: Record<string, string>) => Promise<void>;
  /** Asks the install's daemon for its status while init waits for its boot; tests replace it. */
  daemonStatus?: () => Promise<DaemonControlReply>;
  /** Whether the viewer answers /health; tests replace it. */
  health?: () => Promise<boolean>;
  /** Whether something listens on a port; tests replace it. */
  portAnswers?: (port: number, host: string) => Promise<boolean>;
  bootTimeoutMs?: number;
  pollMs?: number;
}

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

const gwsConnectorNames = new Set(['calendar', 'gmail', 'drive', 'sheets']);
const noSecretConnectorNames = new Set(['obsidian', 'imessage', 'claude-code']);

async function yes(prompt: PromptAdapter, label: string): Promise<boolean> {
  const value = (await prompt.text(`${label} [y/N]`)).trim().toLowerCase();
  if (['', 'n', 'no'].includes(value)) return false;
  if (['y', 'yes'].includes(value)) return true;
  throw new CliInputError('Answer yes or no.');
}

async function text(prompt: PromptAdapter, label: string): Promise<string> {
  return nonblankLine(await prompt.text(label)).trim();
}

async function optionalText(prompt: PromptAdapter, label: string): Promise<string | undefined> {
  const value = (await prompt.text(label)).trim();
  return value === '' ? undefined : nonblankLine(value).trim();
}

async function collectConnectors(
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
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
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
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
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
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
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
      auth: gwsConnectorNames.has(name)
        ? { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' }
        : noSecretConnectorNames.has(name)
          ? { type: 'none' }
          : { type: 'token', tokenName: connectorSecrets[name].at(-1)! },
    };
  }
  return config;
}

/** The answers `mama init` asks for, from a person at a terminal or from MAMA_INIT_* variables. */
interface InitAnswers {
  backend: 'claude' | 'codex';
  model: string;
  timezone: string;
  secrets: Partial<Record<SecretName, string>>;
  chatId: string;
  ownerTelegramId: string;
  memberRoot: string;
  toolsRoot: string;
  /** Which roots are the per-user defaults, whose parent folder is this user's too. */
  memberRootIsDefault: boolean;
  toolsRootIsDefault: boolean;
  connectors: ConnectorsConfig;
  discordConfig: Record<string, unknown>;
  slackConfig: Record<string, unknown>;
  viewer: Record<string, string>;
  jevEnabled: boolean;
  jevKey: string | undefined;
}

type TelegramCall = Parameters<typeof telegramCheck>[2];

function requiredVariable(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new CliInputError(`mama init --non-interactive needs ${name}`);
  return nonblankLine(value).trim();
}

function validTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new CliInputError(`Timezone "${timezone}" is not a valid IANA time zone.`);
  }
  return timezone;
}

function validChatId(chatId: string): string {
  if (!/^-[1-9]\d*$/.test(chatId)) {
    throw new CliInputError(
      'Enter a Telegram group or supergroup id (negative); private chats go to personal intake and cannot reach the common session.'
    );
  }
  return chatId;
}

function validTelegramId(id: string): string {
  if (!/^[1-9]\d*$/.test(id))
    throw new CliInputError('Enter your numeric Telegram user ID (only digits).');
  return id;
}

/**
 * The backend this install will run must be installed, at least the version a release was
 * verified on, and signed in, before anything is written: the daemon would otherwise fail its
 * first turn. Codex is asked about the managed home MAMA gives it.
 */
function checkBackend(
  backend: 'claude' | 'codex',
  root: string,
  locate: (name: string) => string | undefined,
  run: ProbeRun | undefined
): void {
  const executable = locate(backend);
  const login =
    backend === 'claude'
      ? 'claude auth login'
      : `CODEX_HOME=${shellQuote(join(root, '.codex'))} codex login`;
  if (!executable) {
    throw new CliInputError(
      `${backend} is not on this PATH. Install it, sign in with: ${login}, then run mama init again.`
    );
  }
  // The daemon starts the backend without secret-shaped variables; a login that only this
  // shell's API key gives would pass here and fail every turn.
  const probe = probeBackend(backend, executable, {
    env: backendEnvironment(),
    ...(backend === 'codex' ? { codexHome: join(root, '.codex') } : {}),
    ...(run ? { run } : {}),
  });
  if (probe.version === null) throw new CliInputError(`${probe.problem}; check ${executable}`);
  // An old CLI is the more useful answer even when its login could not be read.
  if (!probe.versionOk) {
    throw new CliInputError(
      `${backend} ${probe.version} is older than ${probe.minimum}, the oldest MAMA was verified on; update it, then run mama init again.`
    );
  }
  if (probe.problem) throw new CliInputError(`${probe.problem}; check ${executable}`);
  if (!probe.loggedIn) {
    throw new CliInputError(`${backend} is not signed in. Run: ${login}, then mama init again.`);
  }
}

/** Telegram must accept the token; anything about the group is reported and doctor checks again. */
async function checkTelegram(
  token: string,
  chatId: string,
  call: TelegramCall,
  write: (line: string) => void
): Promise<void> {
  const check = await telegramCheck(token, chatId, call);
  if (check.detail === 'Telegram refused the bot token') {
    throw new CliInputError(`Telegram refused the bot token; copy it again from BotFather.`);
  }
  if (check.detail.startsWith('could not reach Telegram')) {
    throw new CliInputError(
      `${check.detail}, so the token is unchecked; check the network, then run mama init again.`
    );
  }
  if (check.status !== 'ok')
    write(`telegram: ${check.detail}${check.fix ? ` (${check.fix})` : ''}`);
}

async function askAnswers(
  prompt: PromptAdapter,
  root: string,
  defaults: DefaultRoots | undefined,
  checks: {
    backend(name: 'claude' | 'codex'): void;
    telegram(token: string, chat: string): Promise<void>;
  }
): Promise<InitAnswers> {
  const backend = await text(prompt, 'Backend (claude|codex)');
  if (backend !== 'claude' && backend !== 'codex')
    throw new CliInputError('Backend must be claude or codex.');
  checks.backend(backend);
  const model = await text(prompt, 'Model');
  const machineTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneAnswer = (await prompt.text(`Owner timezone [${machineTimeZone}]`)).trim();
  const timezone = validTimezone(timezoneAnswer || machineTimeZone);
  const secrets: Partial<Record<SecretName, string>> = {
    MAMA_TELEGRAM_TOKEN: nonblankLine(await prompt.secret('Telegram bot token')),
  };
  const chatId = validChatId(
    await text(prompt, 'Telegram common group/supergroup chat id (negative)')
  );
  await checks.telegram(secrets.MAMA_TELEGRAM_TOKEN!, chatId);
  const ownerTelegramId = validTelegramId(
    await text(prompt, 'Your Telegram user ID (numeric; @userinfobot shows it)')
  );
  const memberAnswer = (
    await prompt.text(
      `Folder for member workspaces, outside your home${defaults ? ` [${defaults.memberRoot}]` : ''}`
    )
  ).trim();
  const toolsAnswer = (
    await prompt.text(
      `Folder for the document tools, outside your home${defaults ? ` [${defaults.toolsRoot}]` : ''}`
    )
  ).trim();
  const memberRoot = memberAnswer || defaults?.memberRoot;
  const toolsRoot = toolsAnswer || defaults?.toolsRoot;
  if (!memberRoot || !toolsRoot)
    throw new CliInputError('This platform has no default folders; enter both folders.');
  const connectors = await collectConnectors(prompt, secrets);
  const discordEnabled = await yes(prompt, 'Enable Discord owner messages');
  let discordConfig: Record<string, unknown> = {
    enabled: false,
    allowed_channels: [],
    owner_user_ids: [],
  };
  if (discordEnabled) {
    secrets.MAMA_DISCORD_TOKEN ??= nonblankLine(await prompt.secret('Discord bot token'));
    const channel = await text(prompt, 'Discord owner channel id');
    const user = await text(prompt, 'Discord owner user id');
    discordConfig = {
      enabled: true,
      owner_channel_id: channel,
      allowed_channels: [channel],
      owner_user_ids: [user],
    };
  }
  const slackEnabled = await yes(prompt, 'Enable Slack owner messages');
  let slackConfig: Record<string, unknown> = {
    enabled: false,
    allowed_channels: [],
    owner_user_ids: [],
  };
  if (slackEnabled) {
    secrets.MAMA_SLACK_TOKEN ??= nonblankLine(await prompt.secret('Slack bot token'));
    secrets.MAMA_SLACK_APP_TOKEN ??= nonblankLine(
      await prompt.secret('Slack Socket Mode app token')
    );
    const channel = await text(prompt, 'Slack owner channel id');
    const user = await text(prompt, 'Slack owner user id');
    slackConfig = {
      enabled: true,
      owner_channel_id: channel,
      allowed_channels: [channel],
      owner_user_ids: [user],
    };
  }
  const viewer: Record<string, string> = {};
  // Jev (TypeSafe) is the owner's choice: the agent's judge tool, off unless chosen here.
  const jevEnabled = await yes(
    prompt,
    'Use Jev (TypeSafe) so the agent can judge many messages or items without reading them all? Owner text in those calls goes to the Jev service'
  );
  let jevKey: string | undefined;
  if (jevEnabled && !existsSync(join(root, 'jev-key'))) {
    prompt.write('Get a Jev API key from TypeSafe: https://docs.typesafe.ai');
    jevKey = nonblankLine(await prompt.secret('Jev API key'));
  }
  if (await yes(prompt, 'Expose the viewer through a tunnel')) {
    const issuer = await text(prompt, 'Access issuer (HTTPS URL)');
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      throw new CliInputError('Access issuer must be an HTTPS origin.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new CliInputError('Access issuer must be an HTTPS origin.');
    }
    viewer.MAMA_CF_ACCESS_ISSUER = url.origin;
    viewer.MAMA_CF_ACCESS_AUD = await text(prompt, 'Access audience');
    const hostname = await text(prompt, 'Viewer hostname (no scheme or path)');
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(hostname))
      throw new CliInputError('Enter a hostname without scheme or path.');
    viewer.MAMA_VIEWER_HOSTNAMES = hostname;
    const emails = (
      await prompt.text('Viewer owner emails for access monitoring (comma-separated, optional)')
    ).trim();
    if (emails) viewer.MAMA_VIEWER_OWNER_EMAILS = nonblankLine(emails);
  }
  return {
    backend,
    model,
    timezone,
    secrets,
    chatId,
    ownerTelegramId,
    memberRoot,
    toolsRoot,
    memberRootIsDefault: !memberAnswer,
    toolsRootIsDefault: !toolsAnswer,
    connectors,
    discordConfig,
    slackConfig,
    viewer,
    jevEnabled,
    jevKey,
  };
}

/**
 * `--non-interactive`: the answers come from the environment (the Docker image and scripts use
 * this). Secrets come only from variables, never from flags, which `ps` shows. No source,
 * messenger besides Telegram, Jev or tunnel is set up this way; `mama init --section` adds them.
 */
async function environmentAnswers(
  env: NodeJS.ProcessEnv,
  defaults: DefaultRoots | undefined,
  checks: {
    backend(name: 'claude' | 'codex'): void;
    telegram(token: string, chat: string): Promise<void>;
  }
): Promise<InitAnswers> {
  const backend = requiredVariable(env, 'MAMA_INIT_BACKEND');
  if (backend !== 'claude' && backend !== 'codex')
    throw new CliInputError('MAMA_INIT_BACKEND must be claude or codex.');
  checks.backend(backend);
  const token = requiredVariable(env, 'MAMA_TELEGRAM_TOKEN');
  const chatId = validChatId(requiredVariable(env, 'MAMA_INIT_COMMON_CHAT_ID'));
  await checks.telegram(token, chatId);
  const memberRoot = env.MAMA_INIT_MEMBER_ROOT?.trim() || defaults?.memberRoot;
  const toolsRoot = env.MAMA_INIT_TOOLS_ROOT?.trim() || defaults?.toolsRoot;
  if (!memberRoot || !toolsRoot)
    throw new CliInputError(
      'This platform has no default folders; set MAMA_INIT_MEMBER_ROOT and MAMA_INIT_TOOLS_ROOT.'
    );
  return {
    backend,
    model: requiredVariable(env, 'MAMA_INIT_MODEL'),
    timezone: validTimezone(
      env.MAMA_INIT_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
    ),
    secrets: { MAMA_TELEGRAM_TOKEN: token },
    chatId,
    ownerTelegramId: validTelegramId(requiredVariable(env, 'MAMA_INIT_OWNER_TELEGRAM_ID')),
    memberRoot,
    toolsRoot,
    memberRootIsDefault: !env.MAMA_INIT_MEMBER_ROOT?.trim(),
    toolsRootIsDefault: !env.MAMA_INIT_TOOLS_ROOT?.trim(),
    connectors: {},
    discordConfig: { enabled: false, allowed_channels: [], owner_user_ids: [] },
    slackConfig: { enabled: false, allowed_channels: [], owner_user_ids: [] },
    viewer: {},
    jevEnabled: false,
    jevKey: undefined,
  };
}

/** Wait until the started daemon reports its boot finished, then until the viewer answers. */
async function waitForBoot(options: {
  status: () => Promise<DaemonControlReply>;
  health: () => Promise<boolean>;
  timeoutMs: number;
  pollMs: number;
  write: (line: string) => void;
}): Promise<void> {
  const started = Date.now();
  let reported = started;
  let stage = 'not started';
  for (;;) {
    // A daemon busy booting may miss one status deadline; that is no answer yet, not a failure.
    const reply = await options.status().catch(() => null);
    if (reply?.state === 'running' && reply.reply.ok === true) {
      stage = String((reply.reply.status as { stage?: unknown } | undefined)?.stage);
      if (stage === 'running') break;
    }
    if (Date.now() - started >= options.timeoutMs) {
      throw new CliInputError(
        `MAMA did not finish starting (last stage: ${stage}). mama logs shows why; mama init again continues from here.`
      );
    }
    if (Date.now() - reported >= 30_000) {
      options.write(`still starting (stage: ${stage})`);
      reported = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  if (!(await options.health())) {
    throw new CliInputError(
      'MAMA started but its viewer does not answer /health; mama doctor checks the install.'
    );
  }
}

const DEFAULT_VIEWER_PORT = resolveApiPort(undefined);

/** The first viewer port nothing listens on, from the default up. */
async function freeViewerPort(answers: (port: number, host: string) => Promise<boolean>) {
  for (let port = DEFAULT_VIEWER_PORT; port < DEFAULT_VIEWER_PORT + 50; port += 1) {
    if (!(await answers(port, '127.0.0.1'))) return port;
  }
  throw new CliInputError(
    `Ports ${DEFAULT_VIEWER_PORT}-${DEFAULT_VIEWER_PORT + 49} are all in use; free one, then run mama init again.`
  );
}

async function viewerHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runInit(
  args: readonly string[] = [],
  options: InitOptions = {}
): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--non-interactive'))
    throw new CliInputError('Usage: mama init [--non-interactive]');
  const nonInteractive = args[0] === '--non-interactive';
  const prompt = options.prompt ?? createTerminalPrompt();
  if (!nonInteractive) requireTTY(prompt);
  const write = (line: string) => prompt.write(line);
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const root = join(home, '.mama');
  const configPath = join(root, 'config.yaml');
  let state = readInitState(root);
  // The record is written before the setup's files, so one without the config step means an
  // init stopped part-way through writing them; only that init wrote anything here.
  if (state !== null && !state.done.includes('config')) {
    throw new CliInputError(
      `An earlier mama init stopped while writing its files. Remove ${root}, which holds nothing else yet, and run mama init again.`
    );
  }
  if (existsSync(configPath)) {
    // An install set up before init kept its steps, or by hand: init will not take it over.
    if (state === null)
      throw new CliInputError('config.yaml already exists; init will not overwrite it.');
    if (initComplete(state))
      throw new CliInputError(
        'MAMA is already set up here; mama doctor checks it and mama service restart restarts it.'
      );
    write(`continuing setup: done so far: ${state.done.join(', ')}`);
  } else {
    state = null;
    // A partial manual setup must also be reviewed by the owner before replacing files.
    for (const name of ['connectors.json', 'start.sh']) {
      if (existsSync(join(root, name)))
        throw new CliInputError(`${name} already exists; init will not overwrite it.`);
    }
  }
  const progress: InitState = state ?? { version: 1, done: [] };
  const mark = (step: InitStep) => {
    progress.done.push(step);
    writeInitState(root, progress);
  };
  const done = (step: InitStep) => progress.done.includes(step);
  const locate = options.findExecutable ?? findExecutable;
  // Questions and checks come first, so a refused or cancelled setup leaves nothing behind.
  let answers: InitAnswers | undefined;
  if (!done('config')) {
    const defaults = defaultRoots({
      platform,
      home,
      ...(options.user === undefined ? {} : { user: options.user }),
    });
    const checks = {
      backend: (name: 'claude' | 'codex') => checkBackend(name, root, locate, options.probeRun),
      telegram: (token: string, chat: string) =>
        checkTelegram(token, chat, options.telegramCall ?? defaultTelegramCall, write),
    };
    answers = nonInteractive
      ? await environmentAnswers(options.env ?? process.env, defaults, checks)
      : await askAnswers(prompt, root, defaults, checks);
    answers.memberRoot = resolve(answers.memberRoot);
    answers.toolsRoot = resolve(answers.toolsRoot);
    try {
      validateMemberRoot(answers.memberRoot, [home, root]);
      assertRootAncestors(physicalReadPath(answers.memberRoot), 'member_root');
      validateToolsRoot(answers.toolsRoot, [home, root, answers.memberRoot]);
    } catch (error) {
      throw new CliInputError((error as Error).message);
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // While init writes the install, no daemon, restore or second init may run beside it; a daemon
  // polling the same bot would also take the messages pairing reads. Once only the service step
  // is left there is nothing to write, and the daemon a failed wait left starting holds the lock.
  const writing = !done('config') || !done('owner') || !done('toolkit');
  const lock = writing ? acquireInstallLock(daemonControlPaths(root), 'init') : undefined;
  let config: W1Config;
  try {
    if (writing) refuseWhileRestoring(root);
    if (answers !== undefined) {
      const { memberRoot, toolsRoot } = answers;
      for (const [folder, isDefault] of [
        [memberRoot, answers.memberRootIsDefault],
        [toolsRoot, answers.toolsRootIsDefault],
      ] as const) {
        prepareRoot(folder, {
          ownParent: isDefault,
          ...(options.uid === undefined ? {} : { uid: options.uid }),
        });
      }
      // Each account on a machine runs its own MAMA; another's viewer may already hold the port.
      const port = await freeViewerPort(options.portAnswers ?? portAnswers);
      if (port !== DEFAULT_VIEWER_PORT) answers.viewer.MAMA_API_PORT = String(port);
      config = parseConfig(
        {
          version: 1,
          timezone: answers.timezone,
          member_root: memberRoot,
          tools_root: toolsRoot,
          agent: {
            backend: answers.backend,
            model: answers.model,
            effort: 'medium',
            max_turns: 100,
            // A turn is stopped after 10 minutes without progress, or after an hour in all
            // (owner, 2026-10-03); a full report on 2026-09-29 was cut off at 300 s while working.
            timeout: 600_000,
            max_turn_ms: 3_600_000,
            run_token_budget: 0,
          },
          database: { path: join(root, 'memory.db') },
          logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
          telegram: {
            enabled: true,
            owner_chat_id: answers.chatId,
            allowed_chats: [answers.chatId],
            polling: true,
          },
          discord: answers.discordConfig,
          slack: answers.slackConfig,
          delivery: { reports: 'telegram', notifications: 'telegram', security_alerts: 'telegram' },
          wiki: {
            enabled: true,
            vaultPath: join(root, 'workspace'),
            wikiDir: join(root, 'workspace', 'wiki'),
          },
          ...(answers.jevEnabled ? { jev: { enabled: true } } : {}),
        },
        { home }
      );
      answers.secrets.MAMA_AUTH_TOKEN = randomBytes(32).toString('hex');
      writeInitState(root, progress);
      mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
      mkdirSync(join(root, 'workspace', 'wiki'), { recursive: true, mode: 0o700 });
      // All answers are in before any write; the step is marked done once config.yaml exists.
      updateSecrets(home, answers.secrets);
      writeFileSync(
        join(root, 'connectors.json'),
        `${JSON.stringify(answers.connectors, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 }
      );
      if (answers.jevKey !== undefined)
        writeFileSync(join(root, 'jev-key'), `${answers.jevKey}\n`, { flag: 'wx', mode: 0o600 });
      writeFileSync(configPath, yaml.dump(config), { flag: 'wx', mode: 0o600 });
      progress.viewer = answers.viewer;
      progress.pendingOwner = answers.ownerTelegramId;
      mark('config');
      write('Setup written. Credentials are stored only in auth.env (0600).');
      if (answers.jevEnabled)
        write(
          `Jev is on (jev.enabled in config.yaml); its key is ${shellQuote(join(root, 'jev-key'))} (0600). Turn it off by removing jev.enabled.`
        );
      if (Object.keys(answers.connectors).some((name) => gwsConnectorNames.has(name))) {
        if (!locate('gws')) write('Install gws; the Google sources need it.');
        write('Log in with the Google scopes your selected connectors need: gws auth login.');
      }
    } else {
      config = loadConfig({ home, path: configPath });
    }
    if (!done('owner')) {
      const owner = progress.pendingOwner;
      if (!owner)
        throw new CliInputError('No owner Telegram ID was recorded; run mama init again.');
      await registerOwnerHolding(root, config, config.member_root!, owner);
      delete progress.pendingOwner;
      mark('owner');
      write("You are registered as this install's first owner.");
    }
    if (!done('toolkit')) {
      try {
        if (options.installToolkit) await options.installToolkit(config);
        else
          await installDocumentToolkit({
            toolsRoot: config.tools_root!,
            home,
            memberRoot: config.member_root,
            write,
          });
        write('Document toolkit installed for owner and member sessions.');
      } catch (error) {
        // MAMA runs without the document tools; their host requirements must not keep it from
        // starting. The daemon log names them as absent until mama tools install succeeds.
        write(
          `The document tools could not be installed: ${error instanceof Error ? error.message : 'unknown error'}. MAMA runs without them; run mama tools install once that is fixed.`
        );
      }
      mark('toolkit');
    }
  } finally {
    // The daemon takes this lock at boot; it must be free before the service starts it.
    lock?.release();
  }
  if (!done('service')) {
    const startServiceFor =
      options.startService ??
      (async (viewer: Record<string, string>) => {
        const serviceOptions = {
          home,
          platform,
          write,
          viewer,
          ...(options.serviceRun ? { run: options.serviceRun } : {}),
          ...(options.findExecutable ? { findExecutable: options.findExecutable } : {}),
          ...(options.nodePath ? { nodePath: options.nodePath } : {}),
          ...(options.cliPath ? { cliPath: options.cliPath } : {}),
        };
        // Linux keeps the user's services running after logout only with linger (B4). Enabling it
        // can need privileges this account lacks; that must not stop the service from starting.
        if (platform === 'linux') {
          const user = options.user ?? userInfo().username;
          const result = (options.serviceRun ?? defaultServiceRun)('loginctl', [
            'enable-linger',
            user,
          ]);
          if (result.error || result.status !== 0)
            write(
              `Linger could not be enabled, so MAMA stops when you log out. Run once: sudo loginctl enable-linger ${user}`
            );
        }
        await installService([], serviceOptions);
        await startService(serviceOptions);
      });
    await startServiceFor(progress.viewer ?? {});
    const viewerPort = resolveApiPort(progress.viewer?.MAMA_API_PORT);
    await waitForBoot({
      status: options.daemonStatus ?? (() => askDaemon('status', { home })),
      health: options.health ?? (() => viewerHealth(viewerPort)),
      timeoutMs: options.bootTimeoutMs ?? 600_000,
      pollMs: options.pollMs ?? 1_000,
      write,
    });
    delete progress.viewer;
    mark('service');
  }
  write('MAMA is running. Send your bot a message in Telegram.');
}
