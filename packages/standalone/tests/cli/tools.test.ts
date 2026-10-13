import * as yaml from 'js-yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/runtime/config.js';
import { runTools } from '../../src/cli/commands/tools.js';

let root: string;
let home: string;
let configPath: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tools-command-')));
  home = join(root, 'home');
  mkdirSync(home);
  configPath = join(home, 'config.yaml');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      timezone: 'UTC',
      tools_root: join(root, 'tools'),
      agent: { backend: 'claude', model: 'fixture', max_turns: 1, timeout: 1000 },
      database: { path: join(home, 'state.db') },
      logging: { level: 'info', file: join(home, 'daemon.log') },
      telegram: { enabled: false, allowed_chats: [] },
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('updates on the host without stopping the daemon or rewriting an existing tools_root', async () => {
  const before = readFileSync(configPath, 'utf8');
  const install = vi.fn(async (config) => {
    expect(config.tools_root).toBe(join(root, 'tools'));
  });
  const write = vi.fn();
  await runTools(['install'], { home, configPath, install, write });
  expect(install).toHaveBeenCalledOnce();
  expect(readFileSync(configPath, 'utf8')).toBe(before);
  expect(write).toHaveBeenCalledWith(expect.stringContaining('installed'));
  expect(loadConfig({ home, path: configPath }).tools_root).toBe(join(root, 'tools'));
});

it('preserves config on failure and prints the retry command', async () => {
  const before = readFileSync(configPath, 'utf8');
  await expect(
    runTools(['install'], {
      home,
      configPath,
      install: async () => {
        throw new Error('fixture failure');
      },
    })
  ).rejects.toThrow(/mama tools install/);
  expect(readFileSync(configPath, 'utf8')).toBe(before);
});

it('enrolls an old config after successful host installation, preserving unrelated fields', async () => {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  delete raw.tools_root;
  raw.wiki = { enabled: false };
  // The owner's file is block YAML with comments; enrollment appends one key and keeps the rest.
  const original = `# owner comment\n${yaml.dump(raw)}`;
  writeFileSync(configPath, original);
  const toolsRoot = join(root, 'tools');
  const write = vi.fn();
  await runTools(['install'], {
    home,
    configPath,
    toolsRoot,
    install: async (config) => {
      expect(config.tools_root).toBe(toolsRoot);
    },
    write,
  });
  expect(loadConfig({ home, path: configPath }).tools_root).toBe(toolsRoot);
  expect(loadConfig({ home, path: configPath }).wiki?.enabled).toBe(false);
  expect(readFileSync(configPath, 'utf8')).toBe(
    `${original}tools_root: ${JSON.stringify(toolsRoot)}\n`
  );
  expect(write).toHaveBeenCalledWith(expect.stringContaining('Restart'));
});

it('refuses to rewrite a flow-style config and names the key to add', async () => {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  delete raw.tools_root;
  const before = JSON.stringify(raw);
  writeFileSync(configPath, before);
  await expect(
    runTools(['install'], {
      home,
      configPath,
      toolsRoot: join(root, 'tools'),
      install: async () => {},
    })
  ).rejects.toThrow(/add tools_root/);
  expect(readFileSync(configPath, 'utf8')).toBe(before);
});

it.each([{ args: [] }, { args: ['update'] }, { args: ['install', 'extra'] }])(
  'refuses unsupported CLI arguments $args',
  async ({ args }) => {
    await expect(runTools(args, { home, configPath })).rejects.toThrow(/Usage: mama tools install/);
  }
);

it('requires an explicit tools_root on Linux without invoking installation', async () => {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  delete raw.tools_root;
  writeFileSync(configPath, JSON.stringify(raw));
  const install = vi.fn();
  await expect(
    runTools(['install'], { home, configPath, platform: 'linux', install })
  ).rejects.toThrow(/tools_root.*mama tools install/);
  expect(install).not.toHaveBeenCalled();
});
