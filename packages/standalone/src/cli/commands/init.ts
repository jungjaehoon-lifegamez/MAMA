import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { loadConfig, parseConfig, type W1Config } from '../../runtime/config.js';
import { validateMemberRoot } from '../../runtime/member-paths.js';
import { assertRootAncestors, validateToolsRoot } from '../../runtime/tools-paths.js';
import { physicalReadPath } from '../../runtime/backend-security.js';
import { resolveApiPort } from '../../api/viewer-server.js';
import { installDocumentToolkit } from '../../tools/document-toolkit.js';
import { findExecutable } from '../launch-files.js';
import { CliInputError, nonblankLine, type PromptAdapter } from '../prompt.js';
import { updateSecrets, type SecretName } from '../secrets.js';
import type { ProbeRun } from '../runtime/backend-probe.js';
import { defaultTelegramCall, portAnswers, telegramCheck } from '../runtime/diagnostics.js';
import { openSetupPage, type OpenRun } from '../runtime/setup-page.js';
import { defaultRoots, prepareRoot, type DefaultRoots } from '../runtime/default-roots.js';
import {
  bindCommonGroup,
  botName,
  confirmUpdates,
  pairOwner,
} from '../runtime/telegram-pairing.js';
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
import {
  checkBackend,
  type BackendSignIn,
  checkTelegram,
  type TelegramCall,
  writeSourceTools,
  report,
  validTimezone,
} from './init-questions.js';
import { initSections, runInitSection } from './init-section.js';
import { registerOwnerHolding } from './register-owner.js';
import { installService, startService } from './service.js';

export interface InitOptions {
  home?: string;
  prompt?: PromptAdapter;
  cliPath?: string;
  nodePath?: string;
  findExecutable?: (name: string) => string | undefined;
  /** Which package-manager tool folders exist for start.sh's PATH; tests name them. */
  toolDirectoryExists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  /** This account's name and uid, for the per-user folders; tests name them. */
  user?: string;
  uid?: number;
  installToolkit?: (config: W1Config) => Promise<unknown>;
  /** Where `--non-interactive` reads its answers; by default this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Calls the Telegram Bot API; tests replace it. */
  telegramCall?: Parameters<typeof telegramCheck>[2];
  /** Runs open or xdg-open on the setup page's redirect file; tests replace it. */
  openRun?: OpenRun;
  /** How long the setup page takes entries; 15 minutes by default. */
  setupPageMs?: number;
  /** Runs the backend CLI to read its version and login; tests replace it. */
  probeRun?: ProbeRun;
  /**
   * Runs a signed-out backend's login on the terminal, for `mama init --section model`; tests
   * replace it. The whole setup runs no login: it names it, for the person's agent to run.
   */
  signIn?: BackendSignIn;
  /** Runs launchctl or systemctl for the service step; tests replace it. */
  serviceRun?: ServiceRun;
  /** Installs and starts the service with the viewer's settings; tests replace it. */
  startService?: (viewer: Record<string, string>) => Promise<void>;
  /** Asks the install's daemon for its status while init waits for its boot; tests replace it. */
  daemonStatus?: () => Promise<DaemonControlReply>;
  /** Asks the started daemon for one real backend turn; tests replace it. */
  daemonProbe?: () => Promise<DaemonControlReply>;
  /** Whether the viewer answers /health; tests replace it. */
  health?: () => Promise<boolean>;
  /** Whether something listens on a port; tests replace it. */
  portAnswers?: (port: number, host: string) => Promise<boolean>;
  bootTimeoutMs?: number;
  pollMs?: number;
}

/** What init says to do about a source's tool the service cannot find. */
const SOURCE_TOOL_NEXT =
  'Do that now; if setup stops waiting for MAMA to start, running the install command again continues it.';

/** The setup's answers: MAMA_INIT_* and the viewer's variables, then the setup page. */
interface InitAnswers {
  backend: 'claude' | 'codex';
  model: string;
  timezone: string;
  secrets: Partial<Record<SecretName, string>>;
  chatId: string;
  ownerTelegramId: string;
  memberRoot: string;
  toolsRoot: string;
  viewer: Record<string, string>;
}

function requiredVariable(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new CliInputError(`mama init --non-interactive needs ${name}`);
  return nonblankLine(value).trim();
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

/** The variables start.sh exports for a viewer behind a Cloudflare Access tunnel (service.ts). */
const TUNNEL_VARIABLES = [
  'MAMA_CF_ACCESS_ISSUER',
  'MAMA_CF_ACCESS_AUD',
  'MAMA_VIEWER_HOSTNAMES',
  'MAMA_VIEWER_OWNER_EMAILS',
] as const;

/**
 * The tunnel, from those variables: none set, no tunnel; any set, the issuer, audience and
 * hostname are needed and the owner emails stay optional.
 */
function tunnelVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  if (!TUNNEL_VARIABLES.some((name) => env[name]?.trim())) return {};
  const issuer = requiredVariable(env, 'MAMA_CF_ACCESS_ISSUER');
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new CliInputError('MAMA_CF_ACCESS_ISSUER must be an HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new CliInputError('MAMA_CF_ACCESS_ISSUER must be an HTTPS origin.');
  }
  const viewer: Record<string, string> = {
    MAMA_CF_ACCESS_ISSUER: url.origin,
    MAMA_CF_ACCESS_AUD: requiredVariable(env, 'MAMA_CF_ACCESS_AUD'),
  };
  const hostname = requiredVariable(env, 'MAMA_VIEWER_HOSTNAMES');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(hostname))
    throw new CliInputError('MAMA_VIEWER_HOSTNAMES must be one hostname, without scheme or path.');
  viewer.MAMA_VIEWER_HOSTNAMES = hostname;
  const emails = env.MAMA_VIEWER_OWNER_EMAILS?.trim();
  if (emails) viewer.MAMA_VIEWER_OWNER_EMAILS = nonblankLine(emails);
  return viewer;
}

/**
 * The bot token and the pairing code, entered on the setup page (install.md, W2.4.5b). The token
 * is checked as Telegram answers it; then pairOwner's `ask` is answered by the code's entry, whose
 * reply waits for pairOwner: another `ask` means a wrong code, a return the right one. One process
 * runs from the token to /bind, since the codes and the update offset live in pairOwner's memory.
 */
async function pairOnSetupPage(options: {
  call: TelegramCall;
  write: (line: string) => void;
  platform: NodeJS.Platform;
  openRun?: OpenRun;
  lifetimeMs?: number;
}): Promise<{ token: string; ownerId: string; chatId: string }> {
  const { call, write } = options;
  let taken!: (value: { token: string; botUsername: string }) => void;
  const tokenTaken = new Promise<{ token: string; botUsername: string }>((resolve) => {
    taken = resolve;
  });
  // pairOwner's first ask: it has dropped what the bot held from before (telegram-pairing.ts).
  let asked!: () => void;
  let notAsked!: (error: unknown) => void;
  const firstAsk = new Promise<void>((resolve, reject) => {
    asked = resolve;
    notAsked = reject;
  });
  firstAsk.catch(() => {});
  /** The ask waiting for an entry, and the entry waiting for pairOwner's verdict. */
  let waiting: ((code: string) => void) | undefined;
  let entry: { accept: (said: string) => void; refuse: (error: unknown) => void } | undefined;
  /** pairOwner's last line: after a wrong code, the one that says so. */
  let lastLine = '';
  const page = await openSetupPage({
    fields: [
      {
        name: 'token',
        label: 'Telegram bot token (from BotFather)',
        secret: true,
        check: async (value) => {
          let token: string;
          let botUsername: string;
          try {
            token = nonblankLine(value).trim();
            // The page asks again, so a network failure names the entry, not a rerun.
            await checkTelegram(token, undefined, call, write, {
              next: 'enter it again on the setup page',
            });
            botUsername = await botName({ token, call, write });
          } catch (error) {
            if (error instanceof CliInputError) write(error.message);
            throw error;
          }
          write(`bot token accepted for @${botUsername}`);
          taken({ token, botUsername });
          // A message sent before pairOwner's first poll would be dropped with the held ones.
          await firstAsk;
          return `The bot token is accepted for @${botUsername}. In Telegram, send @${botUsername} a new private message; it answers with a pairing code.`;
        },
      },
      {
        name: 'code',
        label: 'Pairing code (from the bot)',
        secret: false,
        check: (value) =>
          new Promise<string>((accept, refuse) => {
            const answer = waiting;
            // The page takes one entry at a time, and asks for the code only after pairOwner did.
            if (answer === undefined)
              throw new Error('a pairing code was entered with none asked for');
            waiting = undefined;
            entry = { accept, refuse };
            answer(value);
          }),
      },
    ],
    write,
    platform: options.platform,
    ...(options.openRun ? { openRun: options.openRun } : {}),
    ...(options.lifetimeMs === undefined ? {} : { lifetimeMs: options.lifetimeMs }),
  });
  try {
    const { token, botUsername } = await Promise.race([tokenTaken, page.stopped]);
    const owner = await pairOwner({
      token,
      call,
      botUsername,
      write: (line) => {
        lastLine = line;
        write(line);
      },
      ask: (_label, signal) => {
        // pairOwner asks again only after a wrong code, and wrote why just before.
        entry?.refuse(new CliInputError(lastLine));
        entry = undefined;
        asked();
        return new Promise<string>((resolve, reject) => {
          waiting = resolve;
          signal.addEventListener('abort', () => reject(new Error('pairing stopped')), {
            once: true,
          });
          page.stopped.catch(reject);
        });
      },
    });
    write('pairing code accepted');
    entry?.accept(
      `The pairing code is accepted. Add @${botUsername} to the group for common work as an administrator, then send /bind in that group. This page has closed.`
    );
    const group = await bindCommonGroup({
      token,
      call,
      write,
      botUsername,
      ownerId: owner.ownerId,
      offset: owner.offset,
      earlier: owner.groupMessages,
    });
    await confirmUpdates({ token, call, write, offset: group.offset });
    // The bot's post in the group proved the token; the group's privacy and membership are only
    // reported, and doctor checks them again later.
    report(await telegramCheck(token, group.chatId, call), write);
    return { token, ownerId: owner.ownerId, chatId: group.chatId };
  } catch (error) {
    // An entry still waiting gets the sentence that ends the setup.
    notAsked(error);
    entry?.refuse(error);
    throw error;
  } finally {
    page.close();
  }
}

/**
 * The setup's answers. Those from the environment are all checked before the setup page opens,
 * so a refused one does not make the owner pair again. The page takes the bot token and the
 * pairing code: a secret never comes from a variable or a flag, which `ps` shows, and no Telegram
 * ID is typed. Sources, Discord, Slack and Jev are set up afterwards with `mama init --section`.
 */
async function environmentAnswers(
  env: NodeJS.ProcessEnv,
  defaults: DefaultRoots | undefined,
  checks: {
    backend(name: 'claude' | 'codex'): void;
    roots(
      memberRoot: string,
      toolsRoot: string,
      isDefault: { member: boolean; tools: boolean }
    ): { memberRoot: string; toolsRoot: string };
    page(): Promise<{ token: string; ownerId: string; chatId: string }>;
  }
): Promise<InitAnswers> {
  const backend = requiredVariable(env, 'MAMA_INIT_BACKEND');
  if (backend !== 'claude' && backend !== 'codex')
    throw new CliInputError('MAMA_INIT_BACKEND must be claude or codex.');
  checks.backend(backend);
  const model = requiredVariable(env, 'MAMA_INIT_MODEL');
  const timezone = validTimezone(
    env.MAMA_INIT_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const memberAnswer = env.MAMA_INIT_MEMBER_ROOT?.trim() || defaults?.memberRoot;
  const toolsAnswer = env.MAMA_INIT_TOOLS_ROOT?.trim() || defaults?.toolsRoot;
  if (!memberAnswer || !toolsAnswer)
    throw new CliInputError(
      'This platform has no default folders; set MAMA_INIT_MEMBER_ROOT and MAMA_INIT_TOOLS_ROOT.'
    );
  const { memberRoot, toolsRoot } = checks.roots(memberAnswer, toolsAnswer, {
    member: !env.MAMA_INIT_MEMBER_ROOT?.trim(),
    tools: !env.MAMA_INIT_TOOLS_ROOT?.trim(),
  });
  const viewer = tunnelVariables(env);
  const paired = await checks.page();
  return {
    backend,
    model,
    timezone,
    secrets: { MAMA_TELEGRAM_TOKEN: paired.token },
    chatId: validChatId(paired.chatId),
    ownerTelegramId: validTelegramId(paired.ownerId),
    memberRoot,
    toolsRoot,
    viewer,
  };
}

/**
 * Wait until the started daemon reports its boot finished, then until the viewer answers. With a
 * `version`, the daemon must be that version: `mama update` waits for the one it installed.
 */
export async function waitForBoot(options: {
  status: () => Promise<DaemonControlReply>;
  health: () => Promise<boolean>;
  timeoutMs: number;
  pollMs: number;
  write: (line: string) => void;
  version?: string;
  /** What to do after a failed wait; init's own next step by default. */
  next?: string;
}): Promise<void> {
  const started = Date.now();
  let reported = started;
  let stage = 'not started';
  const next = options.next ?? 'running the install command again continues from here';
  for (;;) {
    // A daemon busy booting may miss one status deadline; that is no answer yet, not a failure.
    const reply = await options.status().catch(() => null);
    if (reply?.state === 'running' && reply.reply.ok === true) {
      const status = (reply.reply.status ?? {}) as { stage?: unknown; version?: unknown };
      stage = String(status.stage);
      if (options.version !== undefined && status.version !== options.version) {
        stage = `${stage} at version ${String(status.version)}, not ${options.version}`;
      } else if (stage === 'running') break;
    }
    if (Date.now() - started >= options.timeoutMs) {
      throw new CliInputError(
        `MAMA did not finish starting (last stage: ${stage}). mama logs shows why; ${next}.`
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
      `MAMA started but its viewer does not answer /health; mama doctor checks the install${options.next === undefined ? '' : `; ${options.next}`}.`
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
    `Ports ${DEFAULT_VIEWER_PORT}-${DEFAULT_VIEWER_PORT + 49} are all in use; free one, then run the install command again.`
  );
}

export async function viewerHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** How much longer than the daemon's own turn limit init waits for the backend check. */
const PROBE_MARGIN_MS = 60_000;

const initUsage = `Usage: mama init --non-interactive | mama init --section <${initSections.join('|')}> | mama init --section connectors --non-interactive`;

export async function runInit(
  args: readonly string[] = [],
  options: InitOptions = {}
): Promise<void> {
  if (args[0] === '--section') {
    const nonInteractive = args.length === 3 && args[2] === '--non-interactive';
    if (args.length !== 2 && !nonInteractive) throw new CliInputError(initUsage);
    return runInitSection(args[1], options, nonInteractive);
  }
  // The setup reads no terminal: the person's agent runs it (owner-setup.md).
  if (args.length !== 1 || args[0] !== '--non-interactive') throw new CliInputError(initUsage);
  const write = (line: string) => (options.prompt ? options.prompt.write(line) : console.log(line));
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const root = join(home, '.mama');
  const configPath = join(root, 'config.yaml');
  const lockPaths = daemonControlPaths(root);
  // While init writes the install, no daemon, restore or second init may run beside it, and the
  // step record is read and repaired under the same lock, so a second init cannot act on one the
  // first is still writing. A setup with only the service step left takes no lock: that step
  // writes no install files, and the daemon a failed wait left starting holds the lock.
  const peek = readInitState(root);
  // An install set up before init kept its steps, or by hand: init will not take it over. Said
  // before the lock, since that install's running daemon holds it.
  if (peek === null && existsSync(configPath))
    throw new CliInputError(
      'config.yaml already exists; init will not overwrite it. mama doctor checks this install.'
    );
  const serviceOnly =
    peek !== null &&
    (['config', 'owner', 'toolkit'] as const).every((step) => peek.done.includes(step));
  let lock = existsSync(root) && !serviceOnly ? acquireInstallLock(lockPaths, 'init') : undefined;
  let progress: InitState = { version: 1, done: [] };
  const mark = (step: InitStep) => {
    progress.done.push(step);
    writeInitState(root, progress);
  };
  const done = (step: InitStep) => progress.done.includes(step);
  try {
    let state = lock ? readInitState(root) : peek;
    // The record is written before the setup's files, so one without the config step means an
    // init stopped part-way through writing them. The files only init creates are removed and the
    // step starts over; auth.env is merged, and a Codex login made before init stays.
    if (state !== null && !state.done.includes('config')) {
      for (const name of ['config.yaml', 'connectors.json', 'jev-key'])
        rmSync(join(root, name), { force: true });
      write('An earlier mama init stopped while writing its files; that step starts over.');
      state = null;
    }
    if (existsSync(configPath)) {
      // An install set up before init kept its steps, or by hand: init will not take it over.
      if (state === null)
        throw new CliInputError('config.yaml already exists; init will not overwrite it.');
      // A status, not a refusal: running the install command again on a set-up install ends here.
      if (initComplete(state)) {
        write(
          'MAMA is already set up here; mama doctor checks it, mama service restart restarts it and mama update updates it.'
        );
        return;
      }
      write(`continuing setup: done so far: ${state.done.join(', ')}`);
    } else {
      state = null;
      // A partial manual setup must also be reviewed by the owner before replacing files.
      for (const name of ['connectors.json', 'start.sh']) {
        if (existsSync(join(root, name)))
          throw new CliInputError(`${name} already exists; init will not overwrite it.`);
      }
    }
    progress = state ?? { version: 1, done: [] };
    const locate = options.findExecutable ?? findExecutable;
    // Questions and checks come first, so a refused or cancelled setup leaves nothing in the MAMA
    // home. The two folders are made as soon as they are named: a folder that cannot be this
    // user's alone is refused before pairing, which would otherwise have to be done again.
    let answers: InitAnswers | undefined;
    if (!done('config')) {
      const defaults = defaultRoots({
        platform,
        home,
        ...(options.user === undefined ? {} : { user: options.user }),
      });
      const call = options.telegramCall ?? defaultTelegramCall;
      const checks = {
        // A signed-out backend's login is named, with the backend's full path; the agent runs it.
        backend: (name: 'claude' | 'codex') =>
          checkBackend(
            name,
            join(root, '.codex'),
            locate,
            options.probeRun,
            'run the install command again'
          ),
        roots: (
          memberAnswer: string,
          toolsAnswer: string,
          isDefault: { member: boolean; tools: boolean }
        ) => {
          const memberRoot = resolve(memberAnswer);
          const toolsRoot = resolve(toolsAnswer);
          try {
            validateMemberRoot(memberRoot, [home, root]);
            assertRootAncestors(physicalReadPath(memberRoot), 'member_root');
            validateToolsRoot(toolsRoot, [home, root, memberRoot]);
          } catch (error) {
            throw new CliInputError((error as Error).message);
          }
          for (const [folder, ownParent] of [
            [memberRoot, isDefault.member],
            [toolsRoot, isDefault.tools],
          ] as const) {
            prepareRoot(folder, {
              ownParent,
              ...(options.uid === undefined ? {} : { uid: options.uid }),
            });
          }
          return { memberRoot, toolsRoot };
        },
        page: () =>
          pairOnSetupPage({
            call,
            write,
            platform,
            ...(options.openRun ? { openRun: options.openRun } : {}),
            ...(options.setupPageMs === undefined ? {} : { lifetimeMs: options.setupPageMs }),
          }),
      };
      answers = await environmentAnswers(options.env ?? process.env, defaults, checks);
    }
    if (lock === undefined && !serviceOnly) {
      // A new install: the MAMA home is made only once the questions are answered, and another
      // init may have started one meanwhile.
      mkdirSync(root, { recursive: true, mode: 0o700 });
      lock = acquireInstallLock(lockPaths, 'init');
      if (readInitState(root) !== null || existsSync(configPath))
        throw new CliInputError(
          'Another mama init set up here meanwhile; run the install command again.'
        );
    }
    // A restore sets the launch files aside too, so even the service step waits for it.
    refuseWhileRestoring(root);
    let config: W1Config;
    if (answers !== undefined) {
      const { memberRoot, toolsRoot } = answers;
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
          discord: { enabled: false, allowed_channels: [], owner_user_ids: [] },
          slack: { enabled: false, allowed_channels: [], owner_user_ids: [] },
          delivery: { reports: 'telegram', notifications: 'telegram', security_alerts: 'telegram' },
          wiki: {
            enabled: true,
            vaultPath: join(root, 'workspace'),
            wikiDir: join(root, 'workspace', 'wiki'),
          },
        },
        { home }
      );
      answers.secrets.MAMA_AUTH_TOKEN = randomBytes(32).toString('hex');
      writeInitState(root, progress);
      mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
      mkdirSync(join(root, 'workspace', 'wiki'), { recursive: true, mode: 0o700 });
      // All answers are in before any write; the step is marked done once config.yaml exists.
      updateSecrets(home, answers.secrets);
      // No source yet: `mama init --section connectors` adds them.
      writeFileSync(join(root, 'connectors.json'), '{}\n', { flag: 'wx', mode: 0o600 });
      writeFileSync(configPath, yaml.dump(config), { flag: 'wx', mode: 0o600 });
      progress.viewer = answers.viewer;
      progress.pendingOwner = answers.ownerTelegramId;
      mark('config');
      write('Setup written. Credentials are stored only in auth.env (0600).');
    } else {
      config = loadConfig({ home, path: configPath });
      // A setup that stopped (often at the boot wait, when a source's tool is missing) names the
      // tools again: the service does not start until they are installed.
      await writeSourceTools(
        { root, home, platform, configPath },
        config,
        options,
        write,
        SOURCE_TOOL_NEXT
      );
    }
    if (!done('owner')) {
      const owner = progress.pendingOwner;
      if (!owner)
        throw new CliInputError(
          'No owner Telegram ID was recorded; run the install command again.'
        );
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
          ...(options.toolDirectoryExists
            ? { toolDirectoryExists: options.toolDirectoryExists }
            : {}),
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
    // The port was free when the setup was written; a reboot or another account's MAMA started
    // since may have taken it. This install's own daemon, if it runs, holds it legitimately.
    const ownDaemon = await (options.daemonStatus ?? (() => askDaemon('status', { home })))().catch(
      () => null
    );
    const answers = options.portAnswers ?? portAnswers;
    if (ownDaemon?.state !== 'running') {
      const stored = resolveApiPort(progress.viewer?.MAMA_API_PORT);
      if (await answers(stored, '127.0.0.1')) {
        const port = await freeViewerPort(answers);
        // Named even when it is the default, so it replaces the port start.sh carries.
        progress.viewer = { ...progress.viewer, MAMA_API_PORT: String(port) };
        writeInitState(root, progress);
      }
    }
    await startServiceFor(progress.viewer ?? {});
    const viewerPort = resolveApiPort(progress.viewer?.MAMA_API_PORT);
    await waitForBoot({
      status: options.daemonStatus ?? (() => askDaemon('status', { home })),
      health: options.health ?? (() => viewerHealth(viewerPort)),
      timeoutMs: options.bootTimeoutMs ?? 600_000,
      pollMs: options.pollMs ?? 1_000,
      write,
    });
    // The backend's version and login were read from this shell. One real turn through the
    // daemon proves it answers as the service runs it: its PATH, environment, sandbox and model.
    // The step is done only then, so running the install command again checks once more after a
    // fix.
    write('Checking the backend with one real turn through MAMA…');
    // A turn that keeps progressing may run until agent.max_turn_ms, and the daemon answers with its
    // own error before then; wait a little longer than that.
    const timeoutMs = loadConfig({ home, path: configPath }).agent.max_turn_ms + PROBE_MARGIN_MS;
    const probe = await (
      options.daemonProbe ?? (() => askDaemon('probe', { home, timeoutMs }))
    )().catch((error: unknown) => {
      throw new CliInputError(
        `MAMA did not answer the backend check (${error instanceof Error ? error.message : 'no answer'}). mama logs shows why; then run the install command again.`
      );
    });
    if (probe.state !== 'running')
      throw new CliInputError(
        'MAMA stopped before its backend could be checked. mama logs shows why; then run the install command again.'
      );
    if (probe.reply.ok !== true)
      throw new CliInputError(
        `The backend did not answer a real turn: ${String(probe.reply.error)}. mama logs shows more, and mama doctor checks the backend's login; fix it, then run the install command again.`
      );
    const probed = probe.reply.probe as { backend?: unknown; model?: unknown; ms?: unknown };
    write(
      `${String(probed.backend)} (${String(probed.model)}) answered a real turn in ${String(probed.ms)} ms.`
    );
    delete progress.viewer;
    mark('service');
  }
  write('MAMA is running. Send your bot a message in Telegram.');
}
