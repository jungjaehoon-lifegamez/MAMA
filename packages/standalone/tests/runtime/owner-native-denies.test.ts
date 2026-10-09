import { createRequire } from 'node:module';
import {
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
import { afterEach, expect, it, vi } from 'vitest';
import { buildMAMACodexAppServerConfig } from '@jungjaehoon/mama-core/runtime/drivers/codex-home';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { createNativeSession, type NativeDriverOptions } from '../../src/runtime/native-session.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import {
  claudeOwnerAllowedTools,
  claudeOwnerDisallowedTools,
} from '../../src/agent/claude-native-tool-policy.js';

const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Removing the owner-runtime list, losing a logical/physical form or reusing the member's
// ownerDataReadPaths must break these generated native permission contracts.
it.each([
  ['claude', true],
  ['codex', true],
  ['claude', false],
  ['codex', false],
] as const)(
  'denies only owner DB/raw/member native reads (%s, member_root=%s)',
  async (backend, withMembers) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-owner-denies-')));
    roots.push(root);
    const home = join(root, 'home');
    const storage = join(root, 'storage');
    const alias = join(root, 'alias');
    for (const dir of [
      home,
      storage,
      join(storage, 'canonical'),
      join(storage, 'raw'),
      join(storage, 'members'),
    ])
      mkdirSync(dir, { recursive: true });
    // A DB-file symlink and a parent-directory symlink have different sidecar names.
    writeFileSync(join(storage, 'canonical', 'data.db'), '');
    symlinkSync(join(storage, 'canonical', 'data.db'), join(storage, 'product.db'));
    symlinkSync(storage, alias);
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude-config'));
    vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', join(home, 'claude-config'));
    const mama = join(home, 'product');
    const workspace = join(mama, 'workspace');
    const downloads = join(mama, 'downloads');
    let driver!: NativeDriverOptions;
    // Only the socket and model process are substituted; DB boot, assembly and settings are real.
    vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
    const runtime = await createOwnerRuntime({
      backend,
      model: 'fixture',
      runtimeRoot: mama,
      workspaceDir: workspace,
      databasePath: join(alias, 'product.db'),
      rawPath: join(alias, 'raw'),
      ...(withMembers ? { memberRoot: join(alias, 'members') } : {}),
      socketPath: join(mama, 'runtime.sock'),
      credentialPath: join(mama, 'runtime', 'credential'),
      timeZone: createTimeZoneSetting('UTC'),
      ownerPrincipalId: 'owner',
      agentId: 'owner-agent',
      scopes: [],
      maxTurns: 10,
      timeout: 1000,
      attachmentPorts: { downloadsDir: downloads },
      embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
      createSession: (options) =>
        createNativeSession({
          ...options,
          createAgent: (generated) => {
            driver = generated;
            return {
              backendType: backend,
              supportsNativeSubagents: true,
              prompt: async () => ({ response: 'fixture', session_id: 'fixture' }),
              setSessionId: () => {},
              setSystemPrompt: () => {},
              stop: async () => {},
              isHealthy: () => true,
              getMetrics: () => ({
                requestCount: 0,
                failureCount: 0,
                avgLatencyMs: 0,
                lastRequestAt: null,
              }),
            } as IModelRunner;
          },
        }),
    });
    try {
      const expected = [
        join(alias, 'product.db'),
        join(alias, 'product.db-wal'),
        join(alias, 'product.db-shm'),
        join(storage, 'canonical', 'data.db'),
        join(storage, 'canonical', 'data.db-wal'),
        join(storage, 'canonical', 'data.db-shm'),
        join(storage, 'product.db-wal'),
        join(storage, 'product.db-shm'),
        join(alias, 'raw'),
        join(storage, 'raw'),
        '/tmp/mama-m',
        join(realpathSync('/tmp'), 'mama-m'),
        ...(withMembers ? [join(alias, 'members'), join(storage, 'members')] : []),
      ];
      for (const path of expected) expect(driver.deniedReadPaths, path).toContain(path);
      for (const path of [home, mama, workspace, downloads, join(mama, 'owner-policy.md')])
        expect(driver.deniedReadPaths, path).not.toContain(path);
      if (!withMembers) expect(driver.deniedReadPaths).not.toContain(join(storage, 'members'));
      expect(driver.deniedReadPaths).toContain(join(mama, 'auth.env'));
      expect(driver.deniedReadPaths).toContain(join(mama, 'runtime'));
      if (backend === 'claude') {
        const settings = JSON.parse(readFileSync(join(workspace, '.claude/settings.json'), 'utf8'));
        expect(settings.sandbox.filesystem.denyRead).toEqual(driver.deniedReadPaths);
        const rules = claudeOwnerDisallowedTools(driver.deniedReadPaths, workspace);
        for (const path of expected) {
          expect(rules).toContain(`Read(/${path})`);
          expect(rules).toContain(`Read(/${path}/**)`);
        }
        expect(claudeOwnerAllowedTools(workspace)).toEqual(
          expect.arrayContaining(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])
        );
        expect(settings.sandbox.filesystem.allowWrite).toEqual([workspace]);
      } else {
        const config = buildMAMACodexAppServerConfig('medium', undefined, driver);
        expect(config).toContain('default_permissions = "host-workspace"');
        for (const path of expected) expect(config).toContain(`${JSON.stringify(path)} = "deny"`);
        for (const path of [workspace, downloads])
          expect(config).not.toContain(`${JSON.stringify(path)} = "deny"`);
        expect(config).toContain('web_search = "live"');
      }
      // The host retains its connection even though that same database file is natively denied.
      expect(runtime.database.adapter.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });
    } finally {
      await runtime.stop();
    }
  }
);
