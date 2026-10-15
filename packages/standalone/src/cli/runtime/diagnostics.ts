import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { loadConfig, type W1Config } from '../../runtime/config.js';
import { readDocumentToolkit } from '../../tools/document-toolkit.js';
import { readStartScript, startPathValue, versionedNodePath } from '../launch-files.js';
import { askDaemon, launchdService, pathsFor, validateDeliveryRoutes } from '../commands/daemon.js';
import { probeBackend, type BackendName, type ProbeRun, defaultProbeRun } from './backend-probe.js';
import { systemdUnitState, type ServiceRun, defaultServiceRun } from './systemd-service.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about a warn or fail. */
  readonly fix?: string;
}

export interface DiagnosticsOptions {
  home?: string;
  configPath?: string;
  platform?: NodeJS.Platform;
  run?: ProbeRun;
  serviceRun?: ServiceRun;
  /** A Telegram Bot API call; tests replace it. Null skips the network check. */
  telegramCall?:
    | ((
        token: string,
        method: string,
        params?: Record<string, string>
      ) => Promise<Record<string, unknown>>)
    | null;
  findIn?: (name: string, dirs: string[]) => string | undefined;
}

const LOG_WARN_BYTES = 50 * 1024 * 1024;

function findIn(name: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** A value from auth.env (`export NAME='value'`), unquoted; never printed. */
export function authEnvValue(root: string, name: string): string | undefined {
  const path = join(root, 'auth.env');
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`).exec(line);
    if (!match) continue;
    const raw = match[1].trim();
    return raw.startsWith("'")
      ? raw.slice(1, -1).replace(/'"'"'/g, "'")
      : raw.replace(/^"|"$/g, '');
  }
  return undefined;
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

function portAnswers(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Check an install read-only: nothing here writes a file, opens the database or starts a
 * service. Each check names what it found and, when it is not ok, what to do.
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
  try {
    config = loadConfig({ home, path: configPath });
    validateDeliveryRoutes(config);
    pathsFor(configPath, config);
    checks.push({ name: 'config', status: 'ok', detail: configPath });
  } catch (error) {
    checks.push({
      name: 'config',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      fix: `correct ${configPath}; the daemon refuses to boot until this passes`,
    });
  }

  if (config) {
    checks.push(
      config.member_root
        ? { name: 'member_root', status: 'ok', detail: config.member_root }
        : {
            name: 'member_root',
            status: 'fail',
            detail: 'not set',
            fix: 'set member_root to an absolute folder outside HOME in config.yaml',
          }
    );
  }

  // What the service runs: the start script's Node and PATH, not this shell's.
  const startPath = join(root, 'start.sh');
  let servicePath = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (existsSync(startPath)) {
    const script = readFileSync(startPath, 'utf8');
    const reading = readStartScript(script, home);
    const node = /^exec\s+'([^']+)'/.exec(reading.exec ?? '')?.[1];
    if (!reading.generated || node === undefined) {
      checks.push({
        name: 'start.sh',
        status: 'warn',
        detail: 'not written by mama, so its Node and PATH are not checked',
        fix: 'mama service install shows what it would change; --replace rewrites it',
      });
    } else if (!existsSync(node)) {
      checks.push({
        name: 'node',
        status: 'fail',
        detail: `${node} is gone`,
        fix: 'mama service install rewrites start.sh with a Node path that survives upgrades',
      });
    } else if (versionedNodePath(node)) {
      checks.push({
        name: 'node',
        status: 'warn',
        detail: `${node} belongs to one Node version; an upgrade or a version switch removes it`,
        fix: 'mama service install rewrites start.sh with a Node path that survives upgrades',
      });
    } else {
      checks.push({ name: 'node', status: 'ok', detail: node });
    }
    if (reading.path) servicePath = startPathValue(reading.path, home);
  } else {
    checks.push({
      name: 'start.sh',
      status: 'fail',
      detail: `${startPath} does not exist`,
      fix: 'mama service install writes it',
    });
  }

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
      const probe = probeBackend(backend, executable, {
        codexHome: config.agent.codex_home ?? join(root, '.codex'),
        run,
      });
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
          detail: `${backend} ${probe.version} is not signed in`,
          fix:
            backend === 'claude'
              ? 'claude auth login'
              : `CODEX_HOME='${config.agent.codex_home ?? join(root, '.codex')}' codex login`,
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
    if (backend === 'claude') {
      const sandbox =
        platform === 'darwin'
          ? run('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])
          : run('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '/bin/true']);
      const socat = platform === 'darwin' ? null : run('socat', ['-V']);
      if (sandbox.error || sandbox.status !== 0) {
        checks.push({
          name: 'sandbox',
          status: 'fail',
          detail: `${platform === 'darwin' ? 'sandbox-exec' : 'bwrap'} could not start a sandbox`,
          fix:
            platform === 'darwin'
              ? 'sandbox-exec ships with macOS; check that nothing blocks it'
              : 'install bubblewrap and allow unprivileged user namespaces',
        });
      } else if (socat && (socat.error || socat.status !== 0)) {
        checks.push({
          name: 'sandbox',
          status: 'fail',
          detail: 'socat is missing; the Claude sandbox needs it on Linux',
          fix: 'install socat',
        });
      } else {
        checks.push({ name: 'sandbox', status: 'ok', detail: 'starts' });
      }
    }

    if (config.telegram?.enabled) {
      const token = authEnvValue(root, 'MAMA_TELEGRAM_TOKEN');
      if (!token) {
        checks.push({
          name: 'telegram',
          status: 'fail',
          detail: 'MAMA_TELEGRAM_TOKEN is not in auth.env',
          fix: 'mama secret set MAMA_TELEGRAM_TOKEN',
        });
      } else if (options.telegramCall !== null) {
        const call = options.telegramCall ?? defaultTelegramCall;
        try {
          const reply = await call(token, 'getMe');
          const result = reply.result as Record<string, unknown> | undefined;
          // Privacy mode hides group messages unless the bot is an administrator there.
          let admin = false;
          if (
            result &&
            result.can_read_all_group_messages !== true &&
            config.telegram.owner_chat_id
          ) {
            const member = await call(token, 'getChatMember', {
              chat_id: String(config.telegram.owner_chat_id),
              user_id: String(result.id),
            });
            const status = (member.result as { status?: unknown } | undefined)?.status;
            admin = status === 'administrator' || status === 'creator';
          }
          if (reply.ok !== true || !result) {
            checks.push({
              name: 'telegram',
              status: 'fail',
              detail: 'Telegram refused the bot token',
              fix: 'mama secret set MAMA_TELEGRAM_TOKEN with the token BotFather gave',
            });
          } else if (result.can_read_all_group_messages !== true && !admin) {
            checks.push({
              name: 'telegram',
              status: 'warn',
              detail: 'the bot cannot read group messages',
              fix: 'turn privacy off for the bot in BotFather, then remove and re-add it to the group',
            });
          } else {
            checks.push({
              name: 'telegram',
              status: 'ok',
              detail: admin
                ? 'token valid; an administrator of the common group, so it reads its messages'
                : 'token valid, reads group messages',
            });
          }
        } catch (error) {
          checks.push({
            name: 'telegram',
            status: 'warn',
            detail: `could not reach Telegram: ${error instanceof Error ? error.name : 'error'}`,
          });
        }
      }
    }

    if (config.tools_root) {
      let present = false;
      try {
        present = readDocumentToolkit(config.tools_root, () => {}) !== null;
      } catch {
        present = false;
      }
      checks.push(
        present
          ? { name: 'toolkit', status: 'ok', detail: config.tools_root }
          : {
              name: 'toolkit',
              status: 'warn',
              detail: `no usable toolkit under ${config.tools_root}`,
              fix: 'mama tools install',
            }
      );
    } else {
      checks.push({
        name: 'toolkit',
        status: 'warn',
        detail: 'tools_root is not set; document work has no toolkit',
        fix: 'set tools_root outside HOME in config.yaml, then mama tools install',
      });
    }
  }

  const daemon = await askDaemon('status', { home, configPath });
  const port = Number(process.env.MAMA_API_PORT ?? 3847);
  if (daemon.state === 'running') {
    checks.push({ name: 'daemon', status: 'ok', detail: 'running' });
  } else {
    checks.push({
      name: 'daemon',
      status: 'warn',
      detail: daemon.holder ? `stopped; ${daemon.holder.command} holds the install` : 'stopped',
      fix: 'mama service start',
    });
    if (await portAnswers(port)) {
      checks.push({
        name: 'port',
        status: 'fail',
        detail: `port ${port} is in use by another process`,
        fix: `free port ${port} or set MAMA_API_PORT`,
      });
    }
  }

  const launchd = platform === 'darwin' ? launchdService() : { loaded: false, pid: null };
  const unit = systemdUnitState(home, options.serviceRun ?? defaultServiceRun, platform);
  checks.push(
    launchd.loaded
      ? {
          name: 'service',
          status: 'ok',
          detail: `launchd${launchd.pid === null ? ' (loaded, not running)' : ''}`,
        }
      : unit !== null
        ? {
            name: 'service',
            status: unit === 'failed' ? 'fail' : 'ok',
            detail: `systemd (${unit})`,
          }
        : {
            name: 'service',
            status: 'warn',
            detail: 'no service manager runs the daemon',
            fix: 'mama service install, then mama service start',
          }
  );

  for (const name of ['daemon.log', 'security-events.jsonl']) {
    const path = join(root, 'logs', name);
    if (!existsSync(path)) continue;
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

/**
 * Mask what a bug report must not carry: home paths, quoted text (message content), long digit
 * runs (chat and user ids), emails, URLs beyond their host, principal ids and long tokens.
 */
export function redact(line: string, home: string = homedir()): string {
  return line
    .split(home)
    .join('~')
    .replace(/"[^"]*"/g, '"<text>"')
    .replace(/'[^']*'/g, "'<text>'")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/(https?:\/\/[^/\s]+)[^\s]*/g, '$1/<path>')
    .replace(/principal_[A-Za-z0-9_]+/g, 'principal_<id>')
    .replace(/[A-Za-z0-9_\-:]{24,}/g, '<token>')
    .replace(/-?\d{6,}/g, '<n>')
    .slice(0, 200);
}
