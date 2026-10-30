/**
 * `mama uninstall` removes the service, and the data only when asked and confirmed. Every
 * launchctl call is replaced: the LaunchAgent label is global, and a test must never reach the
 * running one.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUninstall } from '../../src/cli/commands/uninstall.js';
import { acquireInstallLock, daemonControlPaths } from '../../src/cli/runtime/daemon-control.js';
import type { PromptAdapter } from '../../src/cli/prompt.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));

const roots: string[] = [];
const platform = process.platform;
// A person's temporary files live under the machine's shared /tmp parents, named by a hash of the
// id. Ids no real install uses keep the tests away from a running install's people.
const PERSON = `fixture-person-${process.pid}-${Date.now()}`;
const OTHER = `fixture-other-${process.pid}-${Date.now()}`;
afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  Object.defineProperty(process, 'platform', { value: platform });
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function result(status: number): SpawnSyncReturns<string> {
  return { status, stdout: '', stderr: '', signal: null, pid: 1, output: [] } as never;
}

/** launchctl print: 113 when the agent is not loaded; every launchctl call is recorded. */
function launchd(loaded: boolean): string[] {
  const calls: string[] = [];
  vi.mocked(spawnSync).mockImplementation(((command: string, args: string[]) => {
    if (command === 'launchctl') calls.push(args[0]!);
    if (command === 'launchctl' && args[0] === 'print') {
      return loaded ? result(0) : result(113);
    }
    return result(0);
  }) as never);
  return calls;
}

/** An install with a LaunchAgent, two registered people and a folder MAMA did not create. */
function install(options: { loaded?: boolean } = {}) {
  // launchctl is read only on macOS; the replaced one answers wherever the tests run.
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const calls = launchd(options.loaded ?? false);
  const home = mkdtempSync(join(tmpdir(), 'mama-uninstall-'));
  const outside = mkdtempSync(join(tmpdir(), 'mama-uninstall-outside-'));
  roots.push(home, outside);
  const root = join(home, '.mama');
  const members = join(outside, 'members');
  const tools = join(outside, 'tools');
  mkdirSync(join(root, 'logs'), { recursive: true });
  mkdirSync(join(members, PERSON), { recursive: true });
  mkdirSync(join(members, '.retired-gone-1'), { recursive: true });
  mkdirSync(join(members, 'not-mama'), { recursive: true });
  mkdirSync(join(tools, 'skills', 'common'), { recursive: true });
  mkdirSync(join(tools, 'apps'), { recursive: true });
  writeFileSync(join(root, 'logs', 'daemon.log'), 'x'.repeat(1024));
  writeFileSync(join(members, PERSON, 'state.json'), '{}');
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
  const db = new Database(join(root, 'memory.db'));
  db.exec('CREATE TABLE principals (principal_id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO principals VALUES (?), (?)').run(PERSON, OTHER);
  db.close();
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
    calls,
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
    expect(out.join('\n')).toContain(`would remove ${join(members, PERSON)} (`);
    expect(out.join('\n')).toContain(`would remove ${join(members, '.retired-gone-1')} (`);
    expect(out.join('\n')).not.toContain(join(members, 'not-mama'));
    expect(out.join('\n')).toContain(`would remove ${members} too, if nothing else is left in it`);
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
    expect(asked.lines.join('\n')).toContain(`removes ${join(members, PERSON)}`);
    for (const path of [
      plist,
      root,
      join(members, PERSON),
      join(members, '.retired-gone-1'),
      join(tools, 'skills'),
    ]) {
      expect(existsSync(path)).toBe(false);
    }
    // What MAMA did not create stays, and so does the folder that holds it.
    expect(existsSync(join(members, 'not-mama'))).toBe(true);
    expect(existsSync(join(tools, 'apps', 'toolkit'))).toBe(true);
  });

  /** The program the install command keeps in the MAMA home, and its startup block. */
  function managed(home: string, root: string) {
    for (const path of [
      'node/bin/node',
      'npm/lib/node_modules/@jungjaehoon/mama-os/package.json',
      'bin/mama',
    ]) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), 'program');
    }
    writeFileSync(
      join(home, '.profile'),
      'mine\n# >>> mama >>>\nexport PATH="$HOME/.mama/bin:$PATH"\n# <<< mama <<<\n'
    );
  }

  it('removes the managed program with --data after the rest of the home, and names the startup block', async () => {
    const { home, root } = install();
    managed(home, root);
    const asked = prompt(root);
    const out: string[] = [];
    expect(
      await runUninstall(['--data'], {
        ...base(home),
        prompt: asked,
        write: (line) => out.push(line),
      })
    ).toBe(0);
    expect(asked.lines.join('\n')).toContain(
      `removes ${join(root, 'npm')} (0.0 MB): the managed program the install command put here`
    );
    expect(existsSync(root)).toBe(false);
    const removed = out.filter((line) => line.startsWith('removed '));
    expect(removed.slice(-4)).toEqual([
      `removed ${root}`,
      `removed ${join(root, 'npm')}`,
      `removed ${join(root, 'bin')}`,
      `removed ${join(root, 'node')}`,
    ]);
    expect(out.join('\n')).not.toContain('npm uninstall -g');
    expect(out.at(-1)).toBe(
      `remove the lines from '# >>> mama >>>' to '# <<< mama <<<' in ${join(home, '.profile')}: the install command wrote them to put ${join(root, 'bin')} on PATH`
    );
    // The block is the owner's file to change.
    expect(readFileSync(join(home, '.profile'), 'utf8')).toContain('# >>> mama >>>');
  });

  it('keeps the Node and the mama command when the prefix cannot be removed', async () => {
    const { home, root } = install();
    managed(home, root);
    const locked = join(root, 'npm', 'lib', 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'file'), '');
    chmodSync(locked, 0o500);
    const out: string[] = [];
    try {
      expect(
        await runUninstall(['--data'], {
          ...base(home),
          prompt: prompt(root),
          write: (line) => out.push(line),
        })
      ).toBe(1);
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(out).toContain(
      `kept ${join(root, 'node')}: run mama uninstall --data again once the above is removed`
    );
    expect(existsSync(join(root, 'node', 'bin', 'node'))).toBe(true);
    expect(existsSync(join(root, 'bin', 'mama'))).toBe(true);
  });

  it('keeps and names the managed program without --data', async () => {
    const { home, root } = install();
    managed(home, root);
    const out: string[] = [];
    expect(await runUninstall([], { ...base(home), write: (line) => out.push(line) })).toBe(0);
    expect(out).toContain(
      `the managed program stays: ${join(root, 'npm')}, ${join(root, 'bin')}, ${join(root, 'node')} (mama uninstall --data removes it with the data)`
    );
    expect(out.join('\n')).toContain(`in ${join(home, '.profile')}`);
    expect(existsSync(join(root, 'node', 'bin', 'node'))).toBe(true);
  });

  it("also removes the toolkit's read-only versions with --toolkit, and tools_root once empty", async () => {
    const { home, root, tools } = install();
    rmSync(join(tools, 'apps'), { recursive: true });
    // As the installer leaves a version: folders 0555, files 0444.
    mkdirSync(join(tools, 'v-1', 'program'), { recursive: true });
    writeFileSync(join(tools, 'v-1', 'program', 'soffice'), 'binary');
    chmodSync(join(tools, 'v-1', 'program', 'soffice'), 0o444);
    chmodSync(join(tools, 'v-1', 'program'), 0o555);
    chmodSync(join(tools, 'v-1'), 0o555);
    symlinkSync(join(tools, 'v-1'), join(tools, 'current'));
    mkdirSync(join(tools, '.leases'));
    writeFileSync(join(tools, '.mama-document-toolkit'), '');
    expect(
      await runUninstall(['--data', '--toolkit'], { ...base(home), prompt: prompt(root) })
    ).toBe(0);
    expect(existsSync(tools)).toBe(false);
  });

  it("leaves Homebrew's apps and fonts, says how to remove them, and keeps tools_root", async () => {
    const { home, root, tools } = install();
    mkdirSync(join(tools, 'fonts'));
    const out: string[] = [];
    expect(
      await runUninstall(['--data', '--toolkit'], {
        ...base(home),
        write: (line) => out.push(line),
        prompt: prompt(root),
      })
    ).toBe(0);
    expect(existsSync(join(tools, 'apps'))).toBe(true);
    expect(out.join('\n')).toContain(`kept ${tools}`);
  });

  it('removes what it can when one entry cannot be removed, and reports it', async () => {
    const { home, root, members, plist } = install();
    // The person's folder sits in a folder that does not allow removing it.
    chmodSync(members, 0o555);
    const out: string[] = [];
    try {
      expect(
        await runUninstall(['--data'], {
          ...base(home),
          write: (line) => out.push(line),
          prompt: prompt(root),
        })
      ).toBe(1);
    } finally {
      chmodSync(members, 0o755);
    }
    expect(out.join('\n')).toContain(`could not remove ${join(members, PERSON)}`);
    for (const path of [plist, root]) expect(existsSync(path)).toBe(false);
  });

  it('refuses the home folder written in another letter case', async () => {
    const { home } = install();
    const upper = home.toUpperCase();
    // Only a case-insensitive disk (the macOS default) names the same folder this way.
    if (!existsSync(upper) || upper === home) return;
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
        configPath: join(upper, 'config.yaml'),
        prompt: prompt(upper),
      })
    ).rejects.toThrow('refusing to remove');
    expect(existsSync(home)).toBe(true);
  });

  it('stops a running service before it removes anything', async () => {
    const { home, root, plist, calls } = install({ loaded: true });
    expect(await runUninstall(['--data'], { ...base(home), prompt: prompt(root) })).toBe(0);
    expect(calls).toContain('bootout');
    for (const path of [plist, root]) expect(existsSync(path)).toBe(false);
  });

  it('names data set outside the MAMA home, and leaves it', async () => {
    const { home, root } = install();
    const elsewhere = mkdtempSync(join(tmpdir(), 'mama-uninstall-log-'));
    roots.push(elsewhere);
    const config = JSON.parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
    config.logging.file = join(elsewhere, 'daemon.log');
    writeFileSync(join(root, 'config.yaml'), JSON.stringify(config));
    writeFileSync(join(elsewhere, 'daemon.log'), 'kept');
    const out: string[] = [];
    await runUninstall(['--dry-run', '--data'], { ...base(home), write: (line) => out.push(line) });
    expect(out.join('\n')).toContain(`stays: ${join(elsewhere, 'daemon.log')} (the daemon log`);
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

  it('changes nothing while another process holds the install and cannot be stopped', async () => {
    const { home, root, members, plist } = install();
    const held = acquireInstallLock(daemonControlPaths(root), 'backup');
    try {
      expect(await runUninstall(['--data'], { ...base(home), prompt: prompt(root) })).not.toBe(0);
    } finally {
      held.release();
    }
    for (const path of [plist, root, members]) expect(existsSync(path)).toBe(true);
  });

  it('shows its usage for flags it does not take', async () => {
    const { home } = install();
    await expect(runUninstall(['--toolkit'], base(home))).rejects.toThrow('Usage: mama uninstall');
    await expect(runUninstall(['--all'], base(home))).rejects.toThrow('Usage: mama uninstall');
  });
});
