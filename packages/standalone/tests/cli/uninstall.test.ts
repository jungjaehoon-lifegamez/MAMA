/**
 * `mama uninstall` removes the service, and the data only when asked and confirmed. Every
 * launchctl call is replaced: the LaunchAgent label is global, and a test must never reach the
 * running one.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUninstall } from '../../src/cli/commands/uninstall.js';
import { acquireInstallLock, daemonControlPaths } from '../../src/cli/runtime/daemon-control.js';
import type { PromptAdapter } from '../../src/cli/prompt.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function result(status: number): SpawnSyncReturns<string> {
  return { status, stdout: '', stderr: '', signal: null, pid: 1, output: [] } as never;
}

/** An install with a LaunchAgent that launchd has not loaded. */
function install() {
  vi.mocked(spawnSync).mockImplementation(((command: string, args: string[]) =>
    command === 'launchctl' && args[0] === 'print' ? result(113) : result(0)) as never);
  const home = mkdtempSync(join(tmpdir(), 'mama-uninstall-'));
  const outside = mkdtempSync(join(tmpdir(), 'mama-uninstall-outside-'));
  roots.push(home, outside);
  const root = join(home, '.mama');
  const members = join(outside, 'members');
  const tools = join(outside, 'tools');
  mkdirSync(join(root, 'logs'), { recursive: true });
  mkdirSync(join(members, 'person'), { recursive: true });
  mkdirSync(join(tools, 'skills', 'common'), { recursive: true });
  mkdirSync(join(tools, 'apps'), { recursive: true });
  writeFileSync(join(root, 'logs', 'daemon.log'), 'x'.repeat(1024));
  writeFileSync(join(members, 'person', 'state.json'), '{}');
  writeFileSync(join(tools, 'skills', 'common', 'SKILL.md'), '# skill');
  writeFileSync(join(tools, 'apps', 'toolkit'), 'binary');
  writeFileSync(
    join(root, 'config.yaml'),
    JSON.stringify({
      version: 1,
      member_root: members,
      tools_root: tools,
      agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
    })
  );
  const plist = join(home, 'Library', 'LaunchAgents', 'com.mama.server.plist');
  mkdirSync(join(plist, '..'), { recursive: true });
  writeFileSync(plist, '<plist/>');
  // The config names member_root and tools_root by their physical paths.
  return {
    home,
    root,
    members: realpathSync(members),
    tools: realpathSync(tools),
    plist,
  };
}

function prompt(answer: string, tty = true): PromptAdapter & { lines: string[] } {
  const lines: string[] = [];
  return {
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    text: async () => answer,
    secret: async () => answer,
    write: (line) => lines.push(line),
    lines,
  };
}

const base = (home: string) => ({ home, platform: 'darwin' as const, write: () => {} });

describe('mama uninstall', () => {
  it('lists what would go with --dry-run and changes nothing', async () => {
    const { home, root, members, tools, plist } = install();
    const out: string[] = [];
    const code = await runUninstall(['--dry-run', '--data'], {
      ...base(home),
      write: (line) => out.push(line),
    });
    expect(code).toBe(0);
    expect(out[0]).toBe(`would stop MAMA and remove its service: ${plist}`);
    expect(out.join('\n')).toContain(`would remove ${members} (`);
    expect(out.join('\n')).toContain(`would remove ${join(tools, 'skills')} (`);
    expect(out.join('\n')).toContain(`would remove ${root} (`);
    for (const path of [plist, root, members, tools]) expect(existsSync(path)).toBe(true);
  });

  it('removes only the service without --data', async () => {
    const { home, root, members, plist } = install();
    expect(await runUninstall([], base(home))).toBe(0);
    expect(existsSync(plist)).toBe(false);
    for (const path of [root, members]) expect(existsSync(path)).toBe(true);
  });

  it('removes nothing unless the MAMA home is typed back on a terminal', async () => {
    const { home, root, members, plist } = install();
    await expect(
      runUninstall(['--data'], { ...base(home), prompt: prompt(root, false) })
    ).rejects.toThrow('requires a TTY');
    await expect(
      runUninstall(['--data'], { ...base(home), prompt: prompt('yes') })
    ).rejects.toThrow('Not confirmed; nothing was removed.');
    for (const path of [plist, root, members]) expect(existsSync(path)).toBe(true);
  });

  it('removes the service and the data, keeping the toolkit', async () => {
    const { home, root, members, tools, plist } = install();
    const asked = prompt(root);
    expect(await runUninstall(['--data'], { ...base(home), prompt: asked })).toBe(0);
    expect(asked.lines.join('\n')).toContain(`removes ${members}`);
    for (const path of [plist, root, members, join(tools, 'skills')]) {
      expect(existsSync(path)).toBe(false);
    }
    expect(existsSync(join(tools, 'apps', 'toolkit'))).toBe(true);
  });

  it('also removes the toolkit with --toolkit', async () => {
    const { home, root, tools } = install();
    expect(
      await runUninstall(['--data', '--toolkit'], { ...base(home), prompt: prompt(root) })
    ).toBe(0);
    expect(existsSync(tools)).toBe(false);
  });

  it('refuses a target that is the home folder itself', async () => {
    const { home } = install();
    // A hand-edited install whose config sits in the home folder itself.
    writeFileSync(
      join(home, 'config.yaml'),
      JSON.stringify({
        version: 1,
        agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
        database: { path: join(home, 'memory.db') },
        logging: { level: 'info', file: join(home, 'daemon.log') },
      })
    );
    await expect(
      runUninstall(['--data'], {
        ...base(home),
        configPath: join(home, 'config.yaml'),
        prompt: prompt(home),
      })
    ).rejects.toThrow(`refusing to remove ${home}`);
    expect(existsSync(home)).toBe(true);
  });

  it('leaves the data while another process holds the install', async () => {
    const { home, root, members } = install();
    const held = acquireInstallLock(daemonControlPaths(root), 'daemon');
    try {
      await expect(
        runUninstall(['--data'], { ...base(home), prompt: prompt(root) })
      ).rejects.toThrow();
    } finally {
      held.release();
    }
    for (const path of [root, members]) expect(existsSync(path)).toBe(true);
  });

  it('shows its usage for flags it does not take', async () => {
    const { home } = install();
    await expect(runUninstall(['--toolkit'], base(home))).rejects.toThrow('Usage: mama uninstall');
    await expect(runUninstall(['--all'], base(home))).rejects.toThrow('Usage: mama uninstall');
  });
});
