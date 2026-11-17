import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMAMACodexAppServerConfig } from '../../src/runtime/drivers/codex-home.js';
import { CodexRuntimeProcess } from '../../src/runtime/runtime-process.js';

describe('managed Codex shell configuration', () => {
  it('opts into live web search without changing the core default or shell network policy', () => {
    const baseline = buildMAMACodexAppServerConfig();
    expect(baseline).toContain('web_search = false');
    expect(buildMAMACodexAppServerConfig(undefined, undefined, { webSearch: false })).toBe(
      baseline
    );
    const enabled = buildMAMACodexAppServerConfig(undefined, undefined, { webSearch: true });
    expect(enabled).toBe(
      `web_search = "live"\n${baseline.replace('web_search = false', 'web_search = true')}`
    );
    expect(enabled).not.toContain('network_access = true');
  });

  it('writes consumer shell environment overrides without changing the isolated home or sandbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-shell-env-'));
    const runtime = new CodexRuntimeProcess({
      hostRootDir: root,
      cwd: root,
      shellTool: true,
      webSearch: true,
      shellEnvironment: { PATH: '/opt/toolchain/bin:/usr/bin:/bin' },
      allowLoginShell: false,
      command: join(root, 'missing-codex'),
    });
    try {
      await expect(runtime.prompt('prepare configuration')).rejects.toThrow('ENOENT');
      const config = readFileSync(join(root, '.codex/config.toml'), 'utf8');
      expect(config).toContain('allow_login_shell = false');
      expect(config).toContain('web_search = "live"');
      expect(config).toContain('web_search = true');
      expect(config).toContain('[shell_environment_policy.set]');
      expect(config).toContain('"PATH" = "/opt/toolchain/bin:/usr/bin:/bin"');
      expect(config).not.toContain('"HOME" =');
      expect(config).toContain('sandbox_mode = "workspace-write"');
      expect(config).not.toContain('network_access = true');
    } finally {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps Codex apps off unless the consumer opts in, with their instructions', () => {
    const baseline = buildMAMACodexAppServerConfig();
    expect(baseline).toContain('apps = false');
    expect(baseline).toContain('include_apps_instructions = false');
    const enabled = buildMAMACodexAppServerConfig(undefined, undefined, { apps: true });
    expect(enabled).toContain('apps = true');
    expect(enabled).toContain('include_apps_instructions = true');
    // Read only: app writes are not offered.
    expect(enabled).toContain(
      '[apps._default]\ndestructive_enabled = false\nopen_world_enabled = false'
    );
    expect(enabled).not.toContain('default_tools_approval_mode');
    expect(baseline).not.toContain('[apps._default]');
    expect(enabled).toContain('plugins = false');
  });

  it('keeps shell and unified execution disabled by default', () => {
    const config = buildMAMACodexAppServerConfig();
    expect(config).toContain('shell_tool = false');
    expect(config).toContain('unified_exec = false');
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).toContain('approval_policy = "on-request"');
  });

  it('enables only the shell when the consumer opts in', () => {
    const config = buildMAMACodexAppServerConfig('medium', ['# Consumer notes'], {
      shellTool: true,
    });
    expect(config).toContain('shell_tool = true');
    expect(config).toContain('unified_exec = false');
    expect(config).toBe(
      buildMAMACodexAppServerConfig('medium', ['# Consumer notes']).replace(
        'shell_tool = false',
        'shell_tool = true'
      )
    );
  });

  it('preserves the default output when the consumer explicitly disables the shell', () => {
    expect(buildMAMACodexAppServerConfig(undefined, undefined, { shellTool: false })).toBe(
      buildMAMACodexAppServerConfig()
    );
  });

  it.each([undefined, true] as const)(
    'writes the runtime shell option (%s) through the app-server driver',
    async (shellTool) => {
      const root = mkdtempSync(join(tmpdir(), 'codex-shell-config-'));
      const runtime = new CodexRuntimeProcess({
        hostRootDir: root,
        cwd: root,
        shellTool,
        // Configuration is written before spawn; no real CLI or owner turn is needed.
        command: join(root, 'missing-codex'),
      });
      try {
        await expect(runtime.prompt('prepare configuration')).rejects.toThrow('ENOENT');
        const config = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
        expect(config).toContain(shellTool ? 'shell_tool = true' : 'shell_tool = false');
        expect(config).toContain('unified_exec = false');
        expect(config).toContain('sandbox_mode = "workspace-write"');
      } finally {
        await runtime.stop();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
