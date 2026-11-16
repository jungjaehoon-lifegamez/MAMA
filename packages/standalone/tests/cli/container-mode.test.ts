import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installService, runService, startService } from '../../src/cli/commands/service.js';
import { runUpdate } from '../../src/cli/commands/update.js';
import { openSetupPage } from '../../src/cli/runtime/setup-page.js';
import { requestUpdate } from '../../src/cli/runtime/update-request.js';
import {
  CONTAINER_SERVICE,
  CONTAINER_UPDATE,
  inContainer,
} from '../../src/cli/runtime/container.js';
import { systemdUnitPath } from '../../src/cli/runtime/systemd-service.js';

// The Docker image (v1 D1) sets MAMA_CONTAINER=1: Docker starts, stops and updates MAMA.
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function install(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), 'mama-container-'));
  roots.push(home);
  const root = join(home, '.mama');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'config.yaml'),
    JSON.stringify({
      version: 1,
      agent: { backend: 'claude', model: 'fixture', max_turns: 10, timeout: 1000 },
      database: { path: join(root, 'memory.db') },
      logging: { level: 'info', file: join(root, 'logs', 'daemon.log') },
      telegram: { enabled: false },
    })
  );
  return { home, root };
}

const serviceOptions = (home: string, lines: string[]) => ({
  home,
  platform: 'linux' as const,
  write: (line: string) => lines.push(line),
  nodePath: '/opt/node/bin/node',
  cliPath: '/opt/mama/lib/node_modules/@jungjaehoon/mama-os/dist/cli/index.js',
  findExecutable: (name: string) => `/opt/mama/bin/${name}`,
  toolDirectoryExists: () => false,
  // Nothing in the container may ask systemd.
  run: () => {
    throw new Error('no service manager runs in the container');
  },
});

describe('container mode', () => {
  it('is on only with MAMA_CONTAINER=1', () => {
    expect(inContainer({ MAMA_CONTAINER: '1' })).toBe(true);
    expect(inContainer({})).toBe(false);
    expect(inContainer({ MAMA_CONTAINER: 'yes' })).toBe(false);
  });

  it('writes start.sh for the container command and no systemd unit', async () => {
    vi.stubEnv('MAMA_CONTAINER', '1');
    const { home, root } = install();
    const lines: string[] = [];
    expect(await installService([], serviceOptions(home, lines))).toBe(0);
    expect(existsSync(join(root, 'start.sh'))).toBe(true);
    expect(existsSync(systemdUnitPath(home))).toBe(false);
    expect(lines).toContain('start it with: docker compose up -d');
  });

  it('leaves starting, restarting and removing the service to Docker', async () => {
    vi.stubEnv('MAMA_CONTAINER', '1');
    const { home } = install();
    const lines: string[] = [];
    await expect(startService(serviceOptions(home, lines))).rejects.toThrow(CONTAINER_SERVICE);
    await expect(runService(['restart'], serviceOptions(home, lines))).rejects.toThrow(
      CONTAINER_SERVICE
    );
    await expect(runService(['uninstall'], serviceOptions(home, lines))).rejects.toThrow(
      CONTAINER_SERVICE
    );
  });

  it('refuses mama update and names the image pull', async () => {
    vi.stubEnv('MAMA_CONTAINER', '1');
    const { home } = install();
    const lines: string[] = [];
    await expect(runUpdate([], { home, write: (line) => lines.push(line) })).rejects.toThrow(
      CONTAINER_UPDATE
    );
  });

  it('answers /update with the image pull, starting no update job', () => {
    vi.stubEnv('MAMA_CONTAINER', '1');
    const { home, root } = install();
    const result = requestUpdate({
      mamaRoot: root,
      home,
      origin: { chatId: 1, messageId: 2 },
      version: '0.81.1',
      run: () => {
        throw new Error('no service manager runs in the container');
      },
    } as never);
    expect(result).toEqual({ kind: 'not_updatable', reason: CONTAINER_UPDATE });
  });

  it('puts the setup page file in the mounted folder and names its host path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-setup-mount-'));
    roots.push(dir);
    const lines: string[] = [];
    const opened: string[] = [];
    const page = await openSetupPage({
      fields: [{ name: 'token', label: 'The token', secret: true, check: async () => 'taken' }],
      write: (line) => lines.push(line),
      platform: 'linux',
      env: { MAMA_CONTAINER: '1', MAMA_SETUP_DIR: dir, MAMA_SETUP_HOST_DIR: '/srv/mama/setup' },
      openRun: async (command) => {
        opened.push(command);
        return { exit: Promise.resolve(0) };
      },
    });
    const [folder] = readdirSync(dir);
    expect(existsSync(join(dir, folder!, 'open.html'))).toBe(true);
    page.close();
    // No browser runs in the container; the person opens the file on the host.
    expect(opened).toEqual([]);
    expect(lines[0]).toMatch(
      new RegExp(
        `^setup page: open file:///srv/mama/setup/${folder}/open\\.html in the browser on this machine; it closes at \\d\\d:\\d\\d$`
      )
    );
  });

  it('stops before the page opens when the setup folder is not mounted', async () => {
    await expect(
      openSetupPage({
        fields: [],
        write: () => undefined,
        platform: 'linux',
        env: { MAMA_CONTAINER: '1' },
      })
    ).rejects.toThrow(/MAMA_SETUP_DIR and MAMA_SETUP_HOST_DIR/);
  });
});
