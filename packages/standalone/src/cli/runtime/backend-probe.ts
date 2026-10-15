import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/**
 * The oldest backend CLI versions a MAMA release was verified on. MAMA depends on their sandbox,
 * hook, settings and permission behaviour, so an older CLI is refused; raise these only after
 * verifying a newer one.
 */
export const MINIMUM_BACKEND_VERSIONS = {
  claude: '2.1.299',
  codex: '0.160.1',
} as const;

export type BackendName = keyof typeof MINIMUM_BACKEND_VERSIONS;

export type ProbeRun = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => SpawnSyncReturns<string>;

export function defaultProbeRun(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, env: env ?? process.env });
}

/** Compare dotted numeric versions; a missing part counts as 0. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export interface BackendProbe {
  readonly version: string | null;
  readonly minimum: string;
  readonly versionOk: boolean;
  readonly loggedIn: boolean;
  /** Why the version or the login could not be read; never a credential. */
  readonly problem: string | null;
}

/**
 * Read a backend CLI's version and whether it is signed in, without printing anything the CLI
 * says about the account. `env` is the environment the daemon gives the backend, so a login that
 * only this shell's variables provide does not count; Codex is asked about the managed home.
 */
export function probeBackend(
  backend: BackendName,
  executable: string,
  options: { codexHome?: string; run?: ProbeRun; env?: NodeJS.ProcessEnv } = {}
): BackendProbe {
  const run = options.run ?? defaultProbeRun;
  const env = options.env ?? process.env;
  const minimum = MINIMUM_BACKEND_VERSIONS[backend];
  const versionRun = run(executable, ['--version'], env);
  const version = versionRun.error
    ? null
    : (/(\d+\.\d+\.\d+)/.exec(`${versionRun.stdout ?? ''}`)?.[1] ?? null);
  if (version === null) {
    return {
      version: null,
      minimum,
      versionOk: false,
      loggedIn: false,
      problem: `${backend} --version printed no version`,
    };
  }
  const versionOk = compareVersions(version, minimum) >= 0;
  if (backend === 'claude') {
    const status = run(executable, ['auth', 'status', '--json'], env);
    let loggedIn = false;
    try {
      loggedIn = (JSON.parse(`${status.stdout ?? ''}`) as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      return {
        version,
        minimum,
        versionOk,
        loggedIn: false,
        problem: 'claude auth status did not answer in JSON',
      };
    }
    return { version, minimum, versionOk, loggedIn, problem: null };
  }
  const status = run(executable, ['login', 'status'], {
    ...env,
    ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}),
  });
  return {
    version,
    minimum,
    versionOk,
    loggedIn: !status.error && status.status === 0,
    problem: null,
  };
}
