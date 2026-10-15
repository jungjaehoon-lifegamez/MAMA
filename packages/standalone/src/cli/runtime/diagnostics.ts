import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveApiPort } from '../../api/viewer-server.js';
import { loadConnector } from '../../connectors/index.js';
import type { IConnector } from '../../connectors/framework/types.js';
import { loadConfig, type W1Config } from '../../runtime/config.js';
import { backendEnvironment } from '../../runtime/backend-security.js';
import { connectorLoadPaths, planConnectors } from '../../runtime/connectors.js';
import { createTimeZoneSetting } from '../../runtime/timezone.js';
import { readDocumentToolkit } from '../../tools/document-toolkit.js';
import {
  readStartScript,
  shellWords,
  startExports,
  startPathValue,
  versionedNodePath,
} from '../launch-files.js';
import { isIcalSecret, SECRET_NAMES } from '../secrets.js';
import {
  askDaemon,
  launchdService,
  MESSENGER_SECRETS,
  pathsFor,
  validateDeliveryRoutes,
} from '../commands/daemon.js';
import { probeBackend, type BackendName, type ProbeRun, defaultProbeRun } from './backend-probe.js';
import type { DaemonControlReply } from './daemon-control.js';
import { systemdUnitState, type ServiceRun, defaultServiceRun } from './systemd-service.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  /** What doctor found, in its own words; the shareable report carries only this. */
  readonly detail: string;
  /** What doctor read from the install (paths, error messages); shown here, never reported. */
  readonly context?: string;
  /** What to do about a warn or fail. */
  readonly fix?: string;
}

export interface DiagnosticsOptions {
  home?: string;
  configPath?: string;
  platform?: NodeJS.Platform;
  run?: ProbeRun;
  serviceRun?: ServiceRun;
  /** No network call: Telegram is not asked and sources are not started. */
  offline?: boolean;
  /** A Telegram Bot API call; tests replace it. */
  telegramCall?: (
    token: string,
    method: string,
    params?: Record<string, string>
  ) => Promise<Record<string, unknown>>;
  findIn?: (name: string, dirs: string[]) => string | undefined;
  /** Ask the install's daemon for its status; tests replace it. */
  askStatus?: () => Promise<DaemonControlReply>;
  /** Builds a source as boot does; tests replace it so no source reaches the network. */
  loadSource?: typeof loadConnector;
  /** How long each source may take to start and answer (default 20 s). */
  sourceTimeoutMs?: number;
  /** Whether something listens on the viewer's address; tests replace it. */
  portInUse?: (port: number, host: string) => Promise<boolean>;
}

const LOG_WARN_BYTES = 50 * 1024 * 1024;
/** The PATH a service manager gives a unit that does not set one ($PATH in start.sh). */
const SERVICE_DEFAULT_PATH: Record<string, string[]> = {
  darwin: ['/usr/bin', '/bin', '/usr/sbin', '/sbin'],
  linux: ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'],
};
/** systemd states of an installed unit that can be started or is running. */
const SYSTEMD_USABLE = new Set(['active', 'inactive', 'activating', 'deactivating', 'reloading']);

function findIn(name: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** auth.env's assignments, unquoted as sh reads them; values are never printed. */
function readAuthEnv(root: string): Record<string, string> {
  const path = join(root, 'auth.env');
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '' || line.trim().startsWith('#')) return;
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      // start.sh sources the file under `set -e`, so any other line runs as a command.
      if (!match) throw new Error(`line ${index + 1} is not an assignment`);
      try {
        values[match[1]] = shellWords(match[2])[0] ?? '';
      } catch (error) {
        throw new Error(`line ${index + 1}: ${message(error)}`);
      }
    });
  return values;
}

async function defaultTelegramCall(
  token: string,
  method: string,
  params: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}${query ? `?${query}` : ''}`,
    { signal: AbortSignal.timeout(8_000) }
  );
  return (await response.json()) as Record<string, unknown>;
}

/** True when something listens; a refusal means free; any other error (a host that cannot be
 * reached or bound) rejects, since the viewer would fail on it too. */
function portAnswers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      error.code === 'ECONNREFUSED' ? resolve(false) : reject(error)
    );
  });
}

function secretFix(name: string): string {
  return (SECRET_NAMES as readonly string[]).includes(name) || isIcalSecret(name)
    ? `mama secret set ${name}`
    : `add ${name} to auth.env`;
}

/**
 * Check an install as its service would run it. Nothing here writes MAMA's files, opens its
 * database or starts a service; the backend's own status command may update the backend's config.
 * Each check names what it found and, when it is not ok, what to do.
 */
export async function runDiagnostics(options: DiagnosticsOptions = {}): Promise<Check[]> {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? join(home, '.mama', 'config.yaml');
  const root = dirname(configPath);
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultProbeRun;
  const locate = options.findIn ?? findIn;
  const checks: Check[] = [];

  let config: W1Config | null = null;
  // Setting names can be anything the owner typed, so they stay out of the report.
  let ignored: readonly string[] = [];
  try {
    config = loadConfig({ home, path: configPath, onIgnored: (names) => (ignored = names) });
    validateDeliveryRoutes(config);
    pathsFor(configPath, config);
    checks.push({
      name: 'config',
      status: 'ok',
      detail: ignored.length > 0 ? `loads; ${ignored.length} setting(s) it ignores` : 'loads',
      context: [configPath, ...(ignored.length > 0 ? [`ignored: ${ignored.join(', ')}`] : [])].join(
        '; '
      ),
    });
  } catch (error) {
    checks.push({
      name: 'config',
      status: 'fail',
      detail: 'does not load as boot reads it',
      context: message(error),
      fix: `correct ${configPath}; the daemon refuses to boot until this passes`,
    });
  }

  if (config) {
    checks.push(
      config.member_root
        ? { name: 'member_root', status: 'ok', detail: 'set', context: config.member_root }
        : {
            name: 'member_root',
            status: 'warn',
            detail: 'not set; the daemon needs it once a person is registered',
            fix: 'set member_root to an absolute folder outside HOME in config.yaml',
          }
    );
  }

  // What the service runs: the start script's Node, PATH and exports, not this shell's.
  const startPath = join(root, 'start.sh');
  let servicePath = SERVICE_DEFAULT_PATH[platform] ?? [];
  let exports: Record<string, string> = {};
  // A script mama did not write is assumed to load auth.env; a generated one must still.
  let loadsAuth = true;
  if (!existsSync(startPath)) {
    checks.push({
      name: 'start.sh',
      status: 'fail',
      detail: 'does not exist',
      fix: 'mama service install writes it',
    });
  } else {
    // launchd and systemd run the script itself.
    try {
      accessSync(startPath, constants.X_OK);
    } catch {
      checks.push({
        name: 'start.sh',
        status: 'fail',
        detail: 'is not executable, so the service cannot run it',
        fix: `chmod 700 ${startPath}`,
      });
    }
    try {
      const reading = readStartScript(readFileSync(startPath, 'utf8'), home);
      exports = startExports(reading);
      if (reading.generated && !reading.loadsAuthEnv) {
        loadsAuth = false;
        checks.push({
          name: 'start.sh',
          status: 'fail',
          detail: 'no longer loads auth.env, so the daemon gets none of its secrets',
          fix: 'mama service install --replace rewrites it',
        });
      }
      if (reading.path !== null) {
        servicePath = [
          ...startPathValue(reading.path, home),
          ...(/\$\{?PATH\}?/.test(reading.path) ? servicePath : []),
        ];
      }
      const [, node, cli] = reading.exec === null ? [] : shellWords(reading.exec);
      if (!reading.generated) {
        checks.push({
          name: 'start.sh',
          status: 'warn',
          detail: 'not written by mama; its PATH and exports are read, its Node is not checked',
          fix: 'mama service install shows what it would change; --replace rewrites it',
        });
      } else if (node === undefined || cli === undefined) {
        checks.push({
          name: 'start.sh',
          status: 'fail',
          detail: 'has no exec line naming Node and the MAMA command',
          fix: 'mama service install --replace rewrites it',
        });
      } else {
        checks.push(nodeCheck(node, cli, run));
      }
    } catch (error) {
      checks.push({
        name: 'start.sh',
        status: 'fail',
        detail: 'does not parse',
        context: message(error),
        fix: 'mama service install --replace rewrites it',
      });
    }
  }
  // start.sh loads auth.env with `set -a`, then its own exports override it.
  let auth: Record<string, string> = {};
  try {
    if (loadsAuth) auth = readAuthEnv(root);
  } catch (error) {
    checks.push({
      name: 'auth.env',
      status: 'fail',
      detail: 'does not parse; start.sh stops when it loads it',
      context: message(error),
      fix: `correct the quoting in ${join(root, 'auth.env')}`,
    });
  }
  const serviceEnv: NodeJS.ProcessEnv = {
    HOME: home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    ...auth,
    ...exports,
    PATH: servicePath.join(':'),
  };
  const secret = (name: string): boolean => Boolean(serviceEnv[name]?.trim());

  if (config) {
    const backend = config.agent.backend as BackendName;
    const executable = locate(backend, servicePath);
    if (!executable) {
      checks.push({
        name: 'backend',
        status: 'fail',
        detail: `${backend} is not on the service's PATH`,
        fix: `install ${backend}, then run mama service install so start.sh includes it`,
      });
    } else {
      // The daemon's backend gets its environment without credential-shaped variables.
      const env = backendEnvironment(serviceEnv);
      const codexHome = config.agent.codex_home ?? join(root, '.codex');
      const probe = probeBackend(backend, executable, { codexHome, run, env });
      if (probe.problem || !probe.versionOk) {
        checks.push({
          name: 'backend',
          status: 'fail',
          detail: probe.problem ?? `${backend} ${probe.version} is older than ${probe.minimum}`,
          fix: `update ${backend} to ${probe.minimum} or newer`,
        });
      } else if (!probe.loggedIn) {
        checks.push({
          name: 'backend',
          status: 'fail',
          detail: `${backend} ${probe.version} is not signed in for the service`,
          fix: backend === 'claude' ? 'claude auth login' : `CODEX_HOME='${codexHome}' codex login`,
        });
      } else {
        checks.push({
          name: 'backend',
          status: 'ok',
          detail: `${backend} ${probe.version}, signed in`,
        });
      }
    }

    // The shell sandbox is required, so it must actually start, not only exist.
    if (backend === 'claude') checks.push(sandboxCheck(platform, servicePath, locate, run));

    for (const messenger of ['telegram', 'discord', 'slack'] as const) {
      if (!config[messenger]?.enabled) continue;
      const missing = MESSENGER_SECRETS[messenger].filter((name) => !secret(name));
      if (missing.length > 0) {
        checks.push({
          name: messenger,
          status: 'fail',
          detail: `${missing.join(' and ')} not set; boot stops at the messengers stage`,
          fix: missing.map(secretFix).join('; '),
        });
      } else if (messenger === 'telegram' && !options.offline) {
        checks.push(
          await telegramCheck(
            serviceEnv.MAMA_TELEGRAM_TOKEN,
            config.telegram.owner_chat_id,
            options.telegramCall ?? defaultTelegramCall
          )
        );
      } else {
        checks.push({ name: messenger, status: 'ok', detail: 'secrets set' });
      }
    }

    checks.push(
      ...(await sourceChecks(config, configPath, servicePath, locate, secret, {
        env: serviceEnv,
        online: !options.offline,
        load: options.loadSource ?? loadConnector,
        timeoutMs: options.sourceTimeoutMs ?? SOURCE_PROBE_MS,
      }))
    );
    checks.push(toolkitCheck(config));
  }

  let port: number | null = null;
  try {
    port = resolveApiPort(serviceEnv.MAMA_API_PORT);
  } catch (error) {
    checks.push({
      name: 'port',
      status: 'fail',
      detail: 'MAMA_API_PORT is not a usable port',
      context: message(error),
      fix: 'set MAMA_API_PORT in start.sh to an integer between 1024 and 65535',
    });
  }
  checks.push(
    ...(await daemonChecks(
      options.askStatus ?? (() => askDaemon('status', { home, configPath })),
      port,
      serviceEnv.MAMA_API_HOST ?? '127.0.0.1',
      options.portInUse ?? portAnswers
    ))
  );
  checks.push(serviceCheck(platform, home, options.serviceRun ?? defaultServiceRun));

  for (const name of ['daemon.log', 'security-events.jsonl']) {
    const path = join(root, 'logs', name);
    if (!existsSync(path)) continue;
    try {
      accessSync(path, constants.R_OK);
    } catch (error) {
      checks.push({
        name: 'logs',
        status: 'warn',
        detail: `${name} cannot be read`,
        context: message(error),
        fix: `give ${name} back to the user that runs MAMA`,
      });
      continue;
    }
    const size = statSync(path).size;
    if (size > LOG_WARN_BYTES) {
      checks.push({
        name: 'logs',
        status: 'warn',
        detail: `${name} is ${Math.round(size / 1024 / 1024)} MB`,
        fix: 'log rotation arrives with W1.5; until then move the file aside while the daemon is stopped',
      });
    }
  }
  return checks;
}

/** start.sh's Node: still there, outside one version's folder, and able to load MAMA's SQLite. */
function nodeCheck(node: string, cli: string, run: ProbeRun): Check {
  const rewrite = 'mama service install rewrites start.sh with a Node path that survives upgrades';
  if (!existsSync(node)) {
    return {
      name: 'node',
      status: 'fail',
      detail: 'the Node start.sh runs is gone',
      context: node,
      fix: rewrite,
    };
  }
  if (!existsSync(cli)) {
    return {
      name: 'node',
      status: 'fail',
      detail: 'the MAMA command start.sh runs is gone',
      context: cli,
      fix: 'mama service install from the current install rewrites start.sh',
    };
  }
  // A Node upgrade across a major version cannot load a native module built for the old one.
  let binding: string;
  try {
    binding = dirname(createRequire(cli).resolve('better-sqlite3/package.json'));
  } catch (error) {
    return {
      name: 'node',
      status: 'fail',
      detail: 'the MAMA command start.sh runs has no SQLite module installed',
      context: message(error),
      fix: 'reinstall MAMA',
    };
  }
  const load = run(node, [
    '-e',
    "new (require(process.argv[1]))(':memory:').close(); process.stdout.write(process.version)",
    binding,
  ]);
  const version = /^v\d+\.\d+\.\d+$/.test(`${load.stdout ?? ''}`) ? `${load.stdout}` : 'Node';
  if (load.error || load.status !== 0) {
    return {
      name: 'node',
      status: 'fail',
      detail: 'the Node start.sh runs cannot load the SQLite module MAMA was installed with',
      context: node,
      fix: 'reinstall MAMA with this Node, or point start.sh at the Node it was installed with',
    };
  }
  if (versionedNodePath(node)) {
    return {
      name: 'node',
      status: 'warn',
      detail: `start.sh runs ${version} from one version's folder; an upgrade or a switch removes it`,
      context: node,
      fix: node.includes('/Cellar/')
        ? rewrite
        : 'run mama service install from a shell whose node is not an nvm, volta or fnm version',
    };
  }
  return { name: 'node', status: 'ok', detail: `${version} loads SQLite`, context: node };
}

function sandboxCheck(
  platform: NodeJS.Platform,
  servicePath: string[],
  locate: (name: string, dirs: string[]) => string | undefined,
  run: ProbeRun
): Check {
  if (platform === 'darwin') {
    const result = run('/usr/bin/sandbox-exec', [
      '-p',
      '(version 1)(allow default)',
      '/usr/bin/true',
    ]);
    return result.error || result.status !== 0
      ? {
          name: 'sandbox',
          status: 'fail',
          detail: 'sandbox-exec could not start a sandbox',
          fix: 'sandbox-exec ships with macOS; check that nothing blocks it',
        }
      : { name: 'sandbox', status: 'ok', detail: 'starts' };
  }
  // Claude's Linux sandbox runs bwrap without network and relays through socat.
  const bwrap = locate('bwrap', servicePath);
  const socat = locate('socat', servicePath);
  if (!bwrap || !socat) {
    return {
      name: 'sandbox',
      status: 'fail',
      detail: `${[!bwrap && 'bwrap', !socat && 'socat'].filter(Boolean).join(' and ')} not on the service's PATH`,
      fix: 'install bubblewrap and socat',
    };
  }
  const relay = run(socat, ['-V']);
  if (relay.error || relay.status !== 0) {
    return {
      name: 'sandbox',
      status: 'fail',
      detail: 'socat does not run',
      context: socat,
      fix: 'reinstall socat',
    };
  }
  const result = run(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '/bin/true']);
  return result.error || result.status !== 0
    ? {
        name: 'sandbox',
        status: 'fail',
        detail: 'bwrap could not start a sandbox without network',
        fix: 'allow unprivileged user namespaces (kernel.unprivileged_userns_clone, or the AppArmor userns rule)',
      }
    : { name: 'sandbox', status: 'ok', detail: 'starts' };
}

async function telegramCheck(
  token: string | undefined,
  commonChat: string | number | undefined,
  call: NonNullable<DiagnosticsOptions['telegramCall']>
): Promise<Check> {
  let me: Record<string, unknown> | undefined;
  try {
    const reply = await call(token ?? '', 'getMe');
    me = reply.ok === true ? (reply.result as Record<string, unknown> | undefined) : undefined;
  } catch (error) {
    return {
      name: 'telegram',
      status: 'warn',
      detail: `could not reach Telegram (${error instanceof Error ? error.name : 'error'})`,
    };
  }
  if (!me) {
    return {
      name: 'telegram',
      status: 'fail',
      detail: 'Telegram refused the bot token',
      fix: 'mama secret set MAMA_TELEGRAM_TOKEN with the token BotFather gave',
    };
  }
  if (commonChat === undefined || commonChat === '') {
    return { name: 'telegram', status: 'ok', detail: 'token valid; no common group configured' };
  }
  // Removed from the group, the bot hears nothing there whatever its privacy setting.
  let status: unknown;
  try {
    const member = await call(token ?? '', 'getChatMember', {
      chat_id: String(commonChat),
      user_id: String(me.id),
    });
    if (member.ok !== true && member.error_code !== 400 && member.error_code !== 403) {
      return {
        name: 'telegram',
        status: 'warn',
        detail: `token valid; Telegram did not answer about the common group (${String(member.error_code)})`,
      };
    }
    status =
      member.ok === true ? (member.result as { status?: unknown } | undefined)?.status : undefined;
  } catch (error) {
    return {
      name: 'telegram',
      status: 'warn',
      detail: `token valid; could not ask about the common group (${error instanceof Error ? error.name : 'error'})`,
    };
  }
  if (typeof status !== 'string' || status === 'left' || status === 'kicked') {
    return {
      name: 'telegram',
      status: 'fail',
      detail: 'the bot is not in the common group',
      fix: 'add the bot to the group owner_chat_id names',
    };
  }
  const admin = status === 'administrator' || status === 'creator';
  if (me.can_read_all_group_messages !== true && !admin) {
    return {
      name: 'telegram',
      status: 'warn',
      detail: 'the bot cannot read group messages',
      fix: 'turn privacy off for the bot in BotFather, then remove and re-add it to the group',
    };
  }
  return {
    name: 'telegram',
    status: 'ok',
    detail: admin
      ? 'token valid; an administrator of the common group, so it reads its messages'
      : 'token valid; a member of the common group that reads its messages',
  };
}

/** connectors.json as the connector runtime reads it, and what each enabled source needs. */
async function sourceChecks(
  config: W1Config,
  configPath: string,
  servicePath: string[],
  locate: (name: string, dirs: string[]) => string | undefined,
  secret: (name: string) => boolean,
  start: {
    env: NodeJS.ProcessEnv;
    online: boolean;
    load: typeof loadConnector;
    timeoutMs: number;
  }
): Promise<Check[]> {
  const paths = pathsFor(configPath, config);
  let plan: ReturnType<typeof planConnectors>;
  try {
    plan = planConnectors({
      configPath: paths.connectorsConfigPath,
      // Channel keys can be owner names; they stay out of the terminal and the report.
      onIgnored: () => {},
      ...(config.wiki?.enabled
        ? { wikiRoot: resolve(config.wiki.vaultPath!, config.wiki.wikiDir!) }
        : {}),
    });
  } catch (error) {
    return [
      {
        name: 'sources',
        status: 'fail',
        detail: 'connectors.json does not load as boot reads it',
        context: message(error),
        fix: `correct ${paths.connectorsConfigPath}`,
      },
    ];
  }
  const checks: Check[] = [];
  const timeZone = createTimeZoneSetting(config.timezone);
  for (const name of plan.enabledConnectorNames) {
    let connector: IConnector;
    try {
      connector = await start.load(
        name,
        plan.config.config[name],
        connectorLoadPaths(name, {
          statePath: paths.connectorsRoot,
          kagemushaDbPath: paths.kagemushaDbPath,
          timeZone,
        })
      );
    } catch (error) {
      checks.push({
        name: `source ${name}`,
        status: 'fail',
        detail: 'cannot be built from connectors.json; boot stops at the connectors stage',
        context: message(error),
      });
      continue;
    }
    const needs = connector.getAuthRequirements();
    // A secret's name can carry an owner's channel key (iCal), so it stays out of the report.
    const secrets = needs.flatMap((need) =>
      need.type === 'token' && need.tokenName && !secret(need.tokenName) ? [need.tokenName] : []
    );
    const commands = needs.flatMap((need) =>
      need.type === 'cli' && need.cli && !locate(need.cli, servicePath)
        ? [{ cli: need.cli, login: need.cliAuthCommand }]
        : []
    );
    if (secrets.length > 0 || commands.length > 0) {
      checks.push({
        name: `source ${name}`,
        status: 'fail',
        detail: [
          ...(secrets.length > 0 ? [`${secrets.length} secret(s) it needs are not set`] : []),
          ...commands.map(({ cli }) => `the ${cli} command is not on the service's PATH`),
        ].join('; '),
        ...(secrets.length > 0 ? { context: secrets.join(', ') } : {}),
        fix: [
          ...secrets.map(secretFix),
          ...commands.map(({ cli, login }) => `install ${cli}${login ? ` and run ${login}` : ''}`),
        ].join('; '),
      });
      continue;
    }
    if (!start.online) continue;
    // Boot starts each source in the daemon's environment; no source's start writes anything.
    // Boot only starts a source; a poll then needs its credentials accepted, so ask that too.
    let failure: Check | null = null;
    try {
      await withEnvironment(start.env, () =>
        bounded(start.timeoutMs, async () => {
          try {
            await connector.init();
          } catch (error) {
            failure = {
              name: `source ${name}`,
              status: 'fail',
              detail: 'does not start; boot stops at the connectors stage',
              context: message(error),
            };
            return;
          }
          if (!(await connector.authenticate())) {
            failure = {
              name: `source ${name}`,
              status: 'fail',
              detail: 'starts, but its credentials or sign-in are refused, so its polls fail',
              fix:
                needs
                  .map(
                    (need) =>
                      need.cliAuthCommand ?? (need.tokenName ? secretFix(need.tokenName) : '')
                  )
                  .filter(Boolean)
                  .join('; ') || undefined,
            };
          }
        })
      );
    } catch (error) {
      failure = {
        name: `source ${name}`,
        status: 'fail',
        detail: 'could not be asked whether its credentials work',
        context: message(error),
      };
    } finally {
      await connector.dispose();
    }
    if (failure) checks.push(failure);
  }
  return checks;
}

/** Some sources fetch without a deadline; doctor waits this long for each before moving on. */
const SOURCE_PROBE_MS = 20_000;

function bounded<T>(ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    run(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Run with process.env as the daemon's process has it, then put this shell's back. */
async function withEnvironment<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const replace = (next: NodeJS.ProcessEnv): void => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    for (const [name, value] of Object.entries(next)) {
      if (value !== undefined) process.env[name] = value;
    }
  };
  replace(env);
  try {
    return await run();
  } finally {
    replace(saved);
  }
}

function toolkitCheck(config: W1Config): Check {
  if (!config.tools_root) {
    return {
      name: 'toolkit',
      status: 'warn',
      detail: 'tools_root is not set; document work has no toolkit',
      fix: 'set tools_root outside HOME in config.yaml, then mama tools install',
    };
  }
  // Boot reads the toolkit the same way; an unsafe tools_root stops it at the config stage.
  let present: boolean;
  try {
    present = readDocumentToolkit(config.tools_root, () => {}) !== null;
  } catch (error) {
    return {
      name: 'toolkit',
      status: 'fail',
      detail: 'tools_root is unsafe; boot refuses it',
      context: message(error),
      fix: 'make tools_root and the folders above it writable only by you (or sticky), and owned by you',
    };
  }
  return present
    ? { name: 'toolkit', status: 'ok', detail: 'installed', context: config.tools_root }
    : {
        name: 'toolkit',
        status: 'warn',
        detail: 'not installed under tools_root',
        context: config.tools_root,
        fix: 'mama tools install',
      };
}

async function daemonChecks(
  ask: () => Promise<DaemonControlReply>,
  port: number | null,
  host: string,
  portInUse: (port: number, host: string) => Promise<boolean>
): Promise<Check[]> {
  let daemon: DaemonControlReply;
  try {
    daemon = await ask();
  } catch (error) {
    return [
      {
        name: 'daemon',
        status: 'fail',
        detail: 'holds the install but does not answer on its control socket',
        context: message(error),
        fix: 'daemon.log shows what it is doing (a migration can hold it); if it stays silent, mama stop and mama service start',
      },
    ];
  }
  if (daemon.state === 'stopped') {
    const checks: Check[] = [
      {
        name: 'daemon',
        status: 'warn',
        detail: daemon.holder ? `stopped; ${daemon.holder.command} holds the install` : 'stopped',
        fix: 'mama service start',
      },
    ];
    if (port === null) return checks;
    let used: boolean;
    try {
      used = await portInUse(port, host);
    } catch (error) {
      checks.push({
        name: 'port',
        status: 'fail',
        detail: 'MAMA_API_HOST is not an address this machine can bind',
        context: message(error),
        fix: 'set MAMA_API_HOST in start.sh to a local address, or remove it for 127.0.0.1',
      });
      return checks;
    }
    if (used) {
      checks.push({
        name: 'port',
        status: 'fail',
        detail: `port ${port} is in use by another process`,
        fix: `free port ${port} or set MAMA_API_PORT in start.sh`,
      });
    }
    return checks;
  }
  if (daemon.reply.ok !== true) {
    return [
      {
        name: 'daemon',
        status: 'fail',
        detail: 'running, but it refused status',
        context: String(daemon.reply.error),
        fix: 'daemon.log shows why',
      },
    ];
  }
  const status = (daemon.reply.status ?? {}) as {
    command?: unknown;
    stage?: unknown;
    startedAt?: unknown;
    connectors?: unknown;
  };
  const checks: Check[] = [];
  const stage = typeof status.stage === 'string' ? status.stage : 'unknown';
  const startedAt = typeof status.startedAt === 'number' ? status.startedAt : Date.now();
  // A replay or backfill does its work inside the boot, for as long as it takes.
  if (status.command === 'replay' || status.command === 'backfill') {
    return [
      {
        name: 'daemon',
        status: 'warn',
        detail: `stopped; ${status.command} holds the install (stage ${stage})`,
        fix: `mama service start after the ${status.command} ends`,
      },
    ];
  }
  if (stage === 'running') {
    checks.push({ name: 'daemon', status: 'ok', detail: 'running' });
  } else {
    // A first poll of many sources can hold the connectors stage for minutes; time alone
    // does not make a boot stuck, so this names the stage and how long it has been there.
    const minutes = Math.floor((Date.now() - startedAt) / 60_000);
    checks.push({
      name: 'daemon',
      status: 'warn',
      detail: `at boot stage ${stage} for ${minutes} min`,
      fix: 'daemon.log shows what that stage is doing',
    });
  }
  // Each source as the running daemon last polled it.
  for (const connector of (Array.isArray(status.connectors) ? status.connectors : []) as {
    name?: unknown;
    healthy?: unknown;
    lastPoll?: unknown;
    error?: unknown;
  }[]) {
    const lastPoll = typeof connector.lastPoll === 'string' ? connector.lastPoll : 'never';
    checks.push(
      connector.healthy === true
        ? { name: `source ${connector.name}`, status: 'ok', detail: `last poll ${lastPoll}` }
        : {
            name: `source ${connector.name}`,
            status: 'warn',
            detail: `unhealthy; last poll ${lastPoll}`,
            ...(typeof connector.error === 'string' ? { context: connector.error } : {}),
            fix: 'daemon.log shows this source; the daemon keeps polling it',
          }
    );
  }
  return checks;
}

function serviceCheck(platform: NodeJS.Platform, home: string, serviceRun: ServiceRun): Check {
  let launchd: { loaded: boolean; pid: number | null };
  let unit: string | null;
  try {
    launchd = platform === 'darwin' ? launchdService() : { loaded: false, pid: null };
    unit = systemdUnitState(home, serviceRun, platform);
  } catch (error) {
    return {
      name: 'service',
      status: 'warn',
      detail: `could not ask ${platform === 'darwin' ? 'launchd' : 'systemd'}`,
      context: message(error),
    };
  }
  if (launchd.loaded) {
    return {
      name: 'service',
      status: 'ok',
      detail: `launchd${launchd.pid === null ? ' (loaded, not running)' : ''}`,
    };
  }
  if (unit === null) {
    return {
      name: 'service',
      status: 'warn',
      detail: 'no service manager runs the daemon',
      fix: 'mama service install, then mama service start',
    };
  }
  if (unit === 'failed') {
    return {
      name: 'service',
      status: 'fail',
      detail: 'systemd (failed)',
      fix: 'journalctl --user -u mama.service shows why',
    };
  }
  return SYSTEMD_USABLE.has(unit)
    ? { name: 'service', status: 'ok', detail: `systemd (${unit})` }
    : {
        name: 'service',
        status: 'warn',
        detail: 'systemctl --user did not answer; no user session manager is running',
        fix: 'log in on a session, or mama service install --enable-linger',
      };
}
