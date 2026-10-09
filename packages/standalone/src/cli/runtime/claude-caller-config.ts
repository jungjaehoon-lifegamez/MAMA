import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function resolveCallerHookPath(): string {
  return join(__dirname, '..', '..', 'runtime', 'claude-caller-hook.js');
}

/** The host's logging proxy the shell sandbox's network goes through (W35.4). */
export interface SandboxNetworkProxy {
  httpProxyPort: number;
  socksProxyPort: number;
}

/** Owner workspace project settings; the CLI still reads project,local only. */
export function ensureClaudeCallerHook(
  workspaceDir: string,
  deniedReadPaths: readonly string[] = [],
  networkProxy?: SandboxNetworkProxy,
  tmpDir = join(resolve(workspaceDir), '.tmp')
): void {
  workspaceDir = resolve(workspaceDir);
  const directory = join(workspaceDir, '.claude');
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(resolveCallerHookPath())}`;
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'mcp__mama__.*', hooks: [{ type: 'command', command }] }],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        allowWrite: [workspaceDir],
        denyRead: [...deniedReadPaths],
        denyWrite: [directory],
      },
      // Shell network goes to the host's deny-all proxy, which reports each attempt (W35.4).
      ...(networkProxy === undefined ? {} : { network: { ...networkProxy } }),
    },
    env: {
      CLAUDE_CODE_TMPDIR: tmpDir,
      // Children complete inside the owner turn, while their host calls have an active run.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
  };
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(workspaceDir, '.tmp'), { recursive: true, mode: 0o700 });
  // Both loaded scopes are host-owned. Never retain hooks or environment from prior contents.
  writeFileSync(join(directory, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(join(directory, 'settings.local.json'), '{}\n', { mode: 0o600 });
}
