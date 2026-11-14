import { expect, it } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { checkBackend } from '../../src/cli/commands/init-questions.js';
import type { ProbeRun } from '../../src/cli/runtime/backend-probe.js';

function reply(stdout: string, status = 0): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr: '', status, signal: null };
}

/** A signed-in Claude Code; bwrap and socat answer as `installed` says. */
function host(installed: { bwrap: boolean; socat: boolean; aptGet: boolean }) {
  const paths: Record<string, string | undefined> = {
    claude: '/opt/fixture/bin/claude',
    bwrap: installed.bwrap ? '/usr/bin/bwrap' : undefined,
    socat: installed.socat ? '/usr/bin/socat' : undefined,
    'apt-get': installed.aptGet ? '/usr/bin/apt-get' : undefined,
  };
  const run: ProbeRun = (command, args) => {
    if (command.endsWith('/claude') && args[0] === '--version')
      return reply('2.1.325 (Claude Code)');
    if (command.endsWith('/claude')) return reply('{"loggedIn":true}');
    return reply('');
  };
  return { locate: (name: string) => paths[name], run };
}

it('refuses a Claude backend on Linux without bwrap and socat, naming the command', () => {
  const { locate, run } = host({ bwrap: false, socat: false, aptGet: true });
  expect(() =>
    checkBackend(
      'claude',
      '/fixture/.codex',
      locate,
      run,
      'run the install command again',
      undefined,
      'linux'
    )
  ).toThrow(
    "Claude's shell sandbox cannot start: bwrap and socat not on the service's PATH. Run: sudo apt-get install -y bubblewrap socat, then run the install command again."
  );
  const other = host({ bwrap: true, socat: false, aptGet: false });
  expect(() =>
    checkBackend(
      'claude',
      '/fixture/.codex',
      other.locate,
      other.run,
      'run this again',
      undefined,
      'linux'
    )
  ).toThrow(
    /socat not on the service's PATH\. Run: install bubblewrap and socat with your package manager/
  );
});

it('passes once the sandbox starts, and never checks it on macOS or for Codex', () => {
  const ready = host({ bwrap: true, socat: true, aptGet: true });
  expect(() =>
    checkBackend('claude', '/fixture/.codex', ready.locate, ready.run, 'next', undefined, 'linux')
  ).not.toThrow();
  const missing = host({ bwrap: false, socat: false, aptGet: true });
  expect(() =>
    checkBackend(
      'claude',
      '/fixture/.codex',
      missing.locate,
      missing.run,
      'next',
      undefined,
      'darwin'
    )
  ).not.toThrow();
});
