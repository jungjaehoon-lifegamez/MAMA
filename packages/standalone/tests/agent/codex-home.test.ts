import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildCodexAppServerLaunchConfig,
  buildMAMACodexAppServerConfig,
  buildMAMACodexConfig,
  getLocalMCPServerEntry,
} from '../../src/agent/codex-home.js';

const pinnedCodexVersion = spawnSync('codex', ['--version'], { encoding: 'utf8' });
const hasPinnedCodex =
  pinnedCodexVersion.status === 0 &&
  typeof pinnedCodexVersion.stdout === 'string' &&
  pinnedCodexVersion.stdout.includes('0.144.0');
const requirePinnedCodex = process.env.MAMA_REQUIRE_CODEX_0144_TEST === 'true';
const pinnedCodexIt = it.skipIf(!hasPinnedCodex && !requirePinnedCodex);

function writeConfig(value: unknown): { configPath: string; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-codex-home-'));
  const configPath = path.join(directory, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify(value));
  return {
    configPath,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function overrides(args: string[]): string[] {
  expect(args.filter((arg) => arg === '-c')).toHaveLength(args.length / 2);
  return args.filter((_arg, index) => index % 2 === 1);
}

describe('Story: Codex home config generation', () => {
  describe('AC #1: build MAMA-specific Codex config', () => {
    it('does not expose a direct mama MCP server to Codex', () => {
      const config = buildMAMACodexConfig();

      expect(config).not.toContain('[mcp_servers.mama]');
      expect(config).not.toContain('packages/mcp-server/src/server.js');
      expect(config).not.toContain('vendor/mama-mcp-node-sqlite');
    });

    it('translates the per-agent Code-Act MCP config into Codex config.toml', () => {
      const mcpConfigPath = path.join(os.tmpdir(), `mama-code-act-${Date.now()}.json`);
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            'code-act': {
              command: 'node',
              args: ['code-act-server.js'],
              env: {
                MAMA_SERVER_PORT: '3847',
                MAMA_CODE_ACT_AGENT_ID: 'dashboard',
              },
            },
          },
        })
      );

      try {
        const config = buildMAMACodexConfig(mcpConfigPath);

        expect(config).toContain('[mcp_servers."code-act"]');
        expect(config).toContain('command = "node"');
        expect(config).toContain('args = ["code-act-server.js"]');
        expect(config).toContain('MAMA_CODE_ACT_AGENT_ID = "dashboard"');
      } finally {
        fs.unlinkSync(mcpConfigPath);
      }
    });

    it('skips mama MCP entries when translating external MCP config', () => {
      const mcpConfigPath = path.join(os.tmpdir(), `mama-code-act-${Date.now()}-mixed.json`);
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            mama: {
              command: 'node',
              args: ['packages/mcp-server/src/server.js'],
            },
            'code-act': {
              command: 'node',
              args: ['code-act-server.js'],
            },
          },
        })
      );

      try {
        const config = buildMAMACodexConfig(mcpConfigPath);

        expect(config).toContain('[mcp_servers."code-act"]');
        expect(config).not.toContain('[mcp_servers."mama"]');
        expect(config).not.toContain('packages/mcp-server/src/server.js');
      } finally {
        fs.unlinkSync(mcpConfigPath);
      }
    });
  });

  describe('AC #2: resolve local MCP entry path', () => {
    it('resolves the local MCP server entry from standalone dist layout', () => {
      const actual = path.normalize(getLocalMCPServerEntry()).replace(/\\/g, '/');
      const expected = path.normalize('packages/mcp-server/src/server.js').replace(/\\/g, '/');

      expect(actual).toContain(expected);
    });
  });

  describe('AC #3: invariant app-server home config', () => {
    it('is stable and contains no runner MCP entries', () => {
      const first = buildMAMACodexAppServerConfig();

      expect(first).toBe(buildMAMACodexAppServerConfig());
      expect(first).toContain('approval_policy = "on-request"');
      expect(first).toContain('shell_tool = false');
      expect(first).not.toContain('skip_git_repo_check');
      expect(first).not.toContain('[mcp_servers.');
      expect(first).not.toContain('mama-server');
      expect(first).not.toContain('code-act-server.js');
    });

    pinnedCodexIt(
      'is accepted with table-level overrides by pinned Codex 0.144 strict config',
      () => {
        expect(
          hasPinnedCodex,
          'MAMA_REQUIRE_CODEX_0144_TEST requires codex-cli 0.144.0 on PATH'
        ).toBe(true);
        const config = writeConfig({
          mcpServers: {
            'dotted.server': {
              command: 'node',
              args: ['server.js'],
              env_vars: ['TOKEN'],
              cwd: '/tmp',
              experimental_environment: 'local',
              required: true,
              supports_parallel_tool_calls: true,
              startup_timeout_sec: 1,
              tool_timeout_sec: 2,
              enabled: true,
              enabled_tools: ['read'],
              disabled_tools: ['write'],
              default_tools_approval_mode: 'prompt',
              tools: { read: { approval_mode: 'auto' } },
              scopes: ['profile'],
            },
            remote: {
              url: 'https://mcp.example.test',
              auth: 'oauth',
              bearer_token_env_var: 'BEARER_TOKEN',
              env_http_headers: { Authorization: 'AUTH_TOKEN' },
              environment_id: 'remote',
              oauth_resource: 'https://resource.example.test',
            },
          },
        });
        const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-codex-strict-'));
        fs.writeFileSync(path.join(codexHome, 'config.toml'), buildMAMACodexAppServerConfig());
        try {
          const launch = buildCodexAppServerLaunchConfig(config.configPath, {});
          expect(launch.args).toHaveLength(2);
          expect(launch.args[1]).toContain('"dotted.server" = { command = "node"');
          expect(launch.args[1]).toContain('"remote" = { url = "https://mcp.example.test"');
          const result = spawnSync(
            'codex',
            ['app-server', '--strict-config', '--stdio', ...launch.args],
            { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome }, input: '' }
          );
          expect(result.status, result.stderr).toBe(0);
        } finally {
          config.cleanup();
          fs.rmSync(codexHome, { recursive: true, force: true });
        }
      }
    );
  });

  describe('AC #4: secret-safe app-server launch overrides', () => {
    it('serializes one exact TOML table override with quoted dotted server keys', () => {
      const config = writeConfig({
        mcpServers: {
          zeta: { url: 'https://z.test', auth: 'chatgpt' },
          'alpha.dotted': { command: 'node', args: ['server.js'] },
        },
      });
      try {
        expect(buildCodexAppServerLaunchConfig(config.configPath, {}).args).toEqual([
          '-c',
          'mcp_servers={ "alpha.dotted" = { command = "node", args = ["server.js"] }, "zeta" = { url = "https://z.test", auth = "chatgpt" } }',
        ]);
      } finally {
        config.cleanup();
      }
    });

    it('deterministically converts all supported stdio fields and excludes mama', () => {
      const config = writeConfig({
        _installedBy: 'installer-a',
        mcpServers: {
          zeta: {
            command: 'node',
            args: ['server.js', '--stdio'],
            env: { ZETA_TOKEN: 'stdio-secret' },
            env_vars: ['INHERITED_NAME'],
            cwd: '/workspace/zeta',
            experimental_environment: 'local',
            required: true,
            supports_parallel_tool_calls: true,
            startup_timeout_sec: 12.5,
            tool_timeout_sec: 30,
            enabled: false,
            allowed_tools: ['search', 'read'],
            disabled_tools: ['delete'],
            default_tools_approval_mode: 'prompt',
            tools: {
              search: { approval_mode: 'approve' },
              read: { approval_mode: 'auto' },
            },
            scopes: ['documents:read', 'profile'],
            _installedBy: 'installer-a',
          },
          mama: { command: 'node', args: ['packages/mcp-server/src/server.js'] },
          alpha: { command: 'bun' },
        },
      });

      try {
        const processEnv = { PATH: '/bin', INHERITED_NAME: 'inherited-value' };
        const first = buildCodexAppServerLaunchConfig(config.configPath, processEnv);
        const second = buildCodexAppServerLaunchConfig(config.configPath, processEnv);
        const rendered = overrides(first.args).join('\n');

        expect(first).toEqual(second);
        expect(first.env).not.toBe(processEnv);
        expect(first.env).toMatchObject({ ZETA_TOKEN: 'stdio-secret' });
        expect(processEnv).toEqual({ PATH: '/bin', INHERITED_NAME: 'inherited-value' });
        expect(first.args).toEqual(['-c', rendered]);
        expect(rendered).toContain('mcp_servers={ "alpha" = { command = "bun" }');
        expect(rendered).toContain('"zeta" = { command = "node"');
        expect(rendered).toContain('args = ["server.js", "--stdio"]');
        expect(rendered).toContain('env_vars = ["INHERITED_NAME", "ZETA_TOKEN"]');
        expect(rendered).toContain('cwd = "/workspace/zeta"');
        expect(rendered).toContain('environment_id = "local"');
        expect(rendered).toContain('required = true');
        expect(rendered).toContain('supports_parallel_tool_calls = true');
        expect(rendered).toContain('startup_timeout_sec = 12.5');
        expect(rendered).toContain('tool_timeout_sec = 30');
        expect(rendered).toContain('enabled = false');
        expect(rendered).toContain('enabled_tools = ["read", "search"]');
        expect(rendered).toContain('disabled_tools = ["delete"]');
        expect(rendered).toContain('default_tools_approval_mode = "prompt"');
        expect(rendered).toContain(
          'tools = { "read" = { approval_mode = "auto" }, "search" = { approval_mode = "approve" } }'
        );
        expect(rendered).toContain('scopes = ["documents:read", "profile"]');
        expect(rendered).not.toContain('"mama"');
        expect(rendered).not.toContain('stdio-secret');
        expect(rendered).not.toContain('inherited-value');
        expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        config.cleanup();
      }
    });

    it('converts all supported HTTP fields and moves literal headers into child env', () => {
      const config = writeConfig({
        mcpServers: {
          remote: {
            url: 'https://mcp.example.test/rpc',
            auth: 'oauth',
            bearer_token_env_var: 'REMOTE_BEARER_TOKEN',
            http_headers: { Authorization: 'literal-header-secret', 'X-Api-Key': 'api-key-secret' },
            env_http_headers: { 'X-Trace-Token': 'TRACE_TOKEN' },
            required: true,
            supports_parallel_tool_calls: false,
            environment_id: 'remote-env',
            startup_timeout_ms: 2500,
            tool_timeout_sec: 9,
            enabled: true,
            enabled_tools: ['lookup'],
            disabled_tools: ['mutate'],
            default_tools_approval_mode: 'writes',
            tools: { lookup: { approval_mode: 'prompt' } },
            scopes: ['openid', 'email'],
            oauth_resource: 'https://mcp.example.test/',
          },
        },
      });

      try {
        const launch = buildCodexAppServerLaunchConfig(config.configPath, {
          REMOTE_BEARER_TOKEN: 'bearer-secret',
          TRACE_TOKEN: 'trace-secret',
        });
        const rendered = overrides(launch.args).join('\n');
        const generatedNames = Object.keys(launch.env).filter((name) =>
          name.startsWith('MAMA_MCP_REMOTE_HTTP_HEADER_')
        );

        expect(rendered).toContain('"remote" = { url = "https://mcp.example.test/rpc"');
        expect(rendered).toContain('auth = "oauth"');
        expect(rendered).toContain('bearer_token_env_var = "REMOTE_BEARER_TOKEN"');
        expect(rendered).toContain('environment_id = "remote-env"');
        expect(rendered).toContain('startup_timeout_sec = 2.5');
        expect(rendered).toContain('tool_timeout_sec = 9');
        expect(rendered).toContain('oauth_resource = "https://mcp.example.test/"');
        expect(rendered).toContain('env_http_headers =');
        expect(rendered).not.toMatch(/(?:^|[, {])http_headers =/);
        expect(generatedNames).toHaveLength(2);
        expect(generatedNames.every((name) => /^[A-Z_][A-Z0-9_]*$/.test(name))).toBe(true);
        expect(Object.values(launch.env)).toContain('literal-header-secret');
        expect(Object.values(launch.env)).toContain('api-key-secret');
        for (const secret of [
          'literal-header-secret',
          'api-key-secret',
          'bearer-secret',
          'trace-secret',
        ]) {
          expect(
            JSON.stringify({ args: launch.args, fingerprint: launch.fingerprint })
          ).not.toContain(secret);
        }
      } finally {
        config.cleanup();
      }
    });

    it('keeps simultaneous full and Code-Act-only launches isolated', async () => {
      const full = writeConfig({
        mcpServers: {
          search: { command: 'node', env: { SHARED_TOKEN: 'full-secret' } },
          'code-act': { command: 'node', env: { CODE_ACT_TOKEN: 'full-code-act-secret' } },
        },
      });
      const isolated = writeConfig({
        mcpServers: {
          'code-act': { command: 'node', env: { CODE_ACT_TOKEN: 'isolated-secret' } },
        },
      });

      try {
        const [fullLaunch, isolatedLaunch] = await Promise.all([
          Promise.resolve(buildCodexAppServerLaunchConfig(full.configPath, { BASE: 'full' })),
          Promise.resolve(
            buildCodexAppServerLaunchConfig(isolated.configPath, { BASE: 'isolated' })
          ),
        ]);
        fullLaunch.args.push('mutated');
        fullLaunch.env.CODE_ACT_TOKEN = 'mutated';

        expect(isolatedLaunch.args).not.toContain('mutated');
        expect(isolatedLaunch.env).toMatchObject({
          BASE: 'isolated',
          CODE_ACT_TOKEN: 'isolated-secret',
        });
        expect(isolatedLaunch.args.join(' ')).not.toContain('mcp_servers."search"');
      } finally {
        full.cleanup();
        isolated.cleanup();
      }
    });
  });

  describe('AC #5: strict validation and fingerprinting', () => {
    it('returns a stable empty policy for an absent config path', () => {
      const processEnv = { PATH: '/bin', TOKEN: 'inherited-secret' };
      const first = buildCodexAppServerLaunchConfig(undefined, processEnv);
      const second = buildCodexAppServerLaunchConfig(undefined, processEnv);

      expect(first).toEqual(second);
      expect(first.args).toEqual([]);
      expect(first.env).toEqual(processEnv);
      expect(first.env).not.toBe(processEnv);
      expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it('throws explicit redacted errors for missing, unreadable, and invalid JSON files', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mama-codex-files-'));
      const missing = path.join(directory, 'missing-sensitive-name.json');
      const invalid = path.join(directory, 'invalid.json');
      fs.writeFileSync(invalid, '{"mcpServers": TOKEN_SECRET');
      try {
        expect(() => buildCodexAppServerLaunchConfig(missing, {})).toThrow(
          'MCP config is unreadable file'
        );
        expect(() => buildCodexAppServerLaunchConfig(directory, {})).toThrow(
          'MCP config is unreadable file'
        );
        expect(() => buildCodexAppServerLaunchConfig(invalid, {})).toThrow(
          'MCP config is invalid JSON'
        );
        for (const target of [missing, directory, invalid]) {
          try {
            buildCodexAppServerLaunchConfig(target, {});
          } catch (error) {
            expect(String(error)).not.toContain('TOKEN_SECRET');
            expect(String(error)).not.toContain('missing-sensitive-name');
          }
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it.each(['oauth', 'chatgpt'])('accepts HTTP auth mode %s', (auth) => {
      const config = writeConfig({ mcpServers: { remote: { url: 'https://x.test', auth } } });
      try {
        expect(buildCodexAppServerLaunchConfig(config.configPath, {}).args.join(' ')).toContain(
          `auth = "${auth}"`
        );
      } finally {
        config.cleanup();
      }
    });

    it.each(['auto', 'prompt', 'writes', 'approve'])(
      'accepts default and per-tool approval mode %s',
      (approvalMode) => {
        const config = writeConfig({
          mcpServers: {
            tools: {
              command: 'node',
              default_tools_approval_mode: approvalMode,
              tools: { lookup: { approval_mode: approvalMode } },
            },
          },
        });
        try {
          const rendered = buildCodexAppServerLaunchConfig(config.configPath, {}).args.join(' ');
          expect(rendered).toContain(`default_tools_approval_mode = "${approvalMode}"`);
          expect(rendered).toContain(`approval_mode = "${approvalMode}"`);
        } finally {
          config.cleanup();
        }
      }
    );

    it('normalizes legacy denied tools and millisecond timeout fields', () => {
      const config = writeConfig({
        mcpServers: {
          test: {
            command: 'node',
            denied_tools: ['write', 'delete'],
            startup_timeout_ms: 1250,
            tool_timeout_ms: 2750,
          },
        },
      });
      try {
        const rendered = buildCodexAppServerLaunchConfig(config.configPath, {}).args.join(' ');
        expect(rendered).toContain('disabled_tools = ["delete", "write"]');
        expect(rendered).toContain('startup_timeout_sec = 1.25');
        expect(rendered).toContain('tool_timeout_sec = 2.75');
      } finally {
        config.cleanup();
      }
    });

    it('canonicalizes semantic sets while preserving process argument order', () => {
      const first = writeConfig({
        mcpServers: {
          test: {
            command: 'node',
            args: ['z', 'a'],
            enabled_tools: ['zeta', 'alpha', 'alpha'],
            disabled_tools: ['write', 'delete'],
            scopes: ['profile', 'email'],
          },
        },
      });
      const reordered = writeConfig({
        mcpServers: {
          test: {
            command: 'node',
            args: ['z', 'a'],
            enabled_tools: ['alpha', 'zeta'],
            disabled_tools: ['delete', 'write'],
            scopes: ['email', 'profile'],
          },
        },
      });
      try {
        const firstLaunch = buildCodexAppServerLaunchConfig(first.configPath, {});
        const reorderedLaunch = buildCodexAppServerLaunchConfig(reordered.configPath, {});
        expect(firstLaunch.args).toEqual(reorderedLaunch.args);
        expect(firstLaunch.fingerprint).toBe(reorderedLaunch.fingerprint);
        expect(firstLaunch.args.join(' ')).toContain('args = ["z", "a"]');
      } finally {
        first.cleanup();
        reordered.cleanup();
      }
    });

    it('preserves prototype-shaped keys as own data across policy accumulators', () => {
      const value = {
        mcpServers: {
          ['__proto__']: {
            command: 'node',
            env: {
              ['__proto__']: 'prototype-secret',
              constructor: 'constructor-secret',
              toString: 'to-string-secret',
            },
            tools: {
              ['__proto__']: { approval_mode: 'auto' },
              constructor: { approval_mode: 'auto' },
              toString: { approval_mode: 'auto' },
            },
          },
          constructor: {
            url: 'https://constructor.test',
            env_http_headers: {
              ['__proto__']: 'PROTOTYPE_HEADER',
              constructor: 'CONSTRUCTOR_HEADER',
              toString: 'TO_STRING_HEADER',
            },
          },
          toString: { command: 'bun' },
        },
      };
      const config = writeConfig(value);
      const withoutPrototypeServer = writeConfig({
        mcpServers: {
          constructor: {
            url: 'https://constructor.test',
            env_http_headers: { toString: 'SHARED_HEADER' },
          },
          toString: { command: 'bun' },
        },
      });
      try {
        const launch = buildCodexAppServerLaunchConfig(config.configPath, {});
        const comparison = buildCodexAppServerLaunchConfig(withoutPrototypeServer.configPath, {});
        expect(Object.getPrototypeOf(launch.env)).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(launch.env, '__proto__')).toBe(true);
        expect(launch.env['__proto__']).toBe('prototype-secret');
        expect(launch.env.constructor).toBe('constructor-secret');
        expect(launch.env.toString).toBe('to-string-secret');
        expect(launch.args.join(' ')).toContain('"__proto__" = { command = "node"');
        expect(launch.args.join(' ')).toContain(
          'env_vars = ["__proto__", "constructor", "toString"]'
        );
        expect(launch.args.join(' ')).toContain('"constructor" = { url =');
        expect(launch.args.join(' ')).toContain('"__proto__" = "PROTOTYPE_HEADER"');
        expect(launch.args.join(' ')).toContain('"constructor" = "CONSTRUCTOR_HEADER"');
        expect(launch.args.join(' ')).toContain('"tostring" = "TO_STRING_HEADER"');
        expect(launch.args.join(' ')).toContain('"__proto__" = { approval_mode = "auto" }');
        expect(launch.args.join(' ')).toContain('"constructor" = { approval_mode = "auto" }');
        expect(launch.args.join(' ')).toContain('"toString" = { approval_mode = "auto" }');
        expect(launch.args.join(' ')).toContain('"toString" = { command = "bun" }');
        expect(launch.fingerprint).not.toBe(comparison.fingerprint);
      } finally {
        config.cleanup();
        withoutPrototypeServer.cleanup();
      }
    });

    it.each([
      ['malformed URL', 'not-a-url'],
      ['unsupported URL scheme', 'ftp://mcp.example.test'],
      ['URL username', 'https://credential-user@mcp.example.test'],
      ['URL password', 'https://user:credential-password@mcp.example.test'],
      ['URL query', 'https://mcp.example.test/path?token=credential-query'],
      ['URL fragment', 'https://mcp.example.test/path#credential-fragment'],
    ])('rejects %s without echoing URL credentials', (_label, url) => {
      const config = writeConfig({ mcpServers: { remote: { url } } });
      try {
        expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(Error);
        try {
          buildCodexAppServerLaunchConfig(config.configPath, {});
        } catch (error) {
          expect(String(error)).not.toContain('credential-');
          expect(String(error)).not.toContain(url);
        }
      } finally {
        config.cleanup();
      }
    });

    it.each([
      ['server command', { mcpServers: { test: { command: `node\ud800` } } }],
      ['process argument', { mcpServers: { test: { command: 'node', args: [`arg\udc00`] } } }],
      [
        'environment value',
        { mcpServers: { test: { command: 'node', env: { TOKEN: `x\ud800` } } } },
      ],
      [
        'header value',
        {
          mcpServers: {
            test: { url: 'https://x.test', http_headers: { Authorization: `x\udc00` } },
          },
        },
      ],
      ['server name', { mcpServers: { [`bad\ud800`]: { command: 'node' } } }],
      [
        'tool name',
        {
          mcpServers: {
            test: { command: 'node', tools: { [`bad\udc00`]: { approval_mode: 'auto' } } },
          },
        },
      ],
    ])('rejects unpaired UTF-16 surrogate in %s', (_label, value) => {
      const config = writeConfig(value);
      try {
        expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(
          /Unicode scalar values/
        );
      } finally {
        config.cleanup();
      }
    });

    it.each([
      ['DEL', '\u007f'],
      ['NUL', '\u0000'],
      ['unit separator', '\u001f'],
    ])('rejects TOML-forbidden %s control characters before serialization', (_label, control) => {
      const config = writeConfig({
        mcpServers: { test: { command: `node${control}` } },
      });
      try {
        expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(
          /TOML control characters/
        );
      } finally {
        config.cleanup();
      }
    });

    it('keeps multiline PEM secrets in the child environment without TOML validation', () => {
      const pem = '-----BEGIN PRIVATE KEY-----\nline-one\r\n\tline-two\n-----END PRIVATE KEY-----';
      const config = writeConfig({
        mcpServers: { signer: { command: 'node', env: { SIGNING_KEY: pem } } },
      });
      try {
        const launch = buildCodexAppServerLaunchConfig(config.configPath, {});
        expect(launch.env.SIGNING_KEY).toBe(pem);
        expect(launch.args.join(' ')).not.toContain('BEGIN PRIVATE KEY');
        expect(launch.args.join(' ')).not.toContain('line-one');
        expect(launch.fingerprint).not.toContain('line-one');
      } finally {
        config.cleanup();
      }
    });

    it('rejects NUL in child-environment-only values without echoing the value', () => {
      const secret = 'prefix-sensitive\0suffix-sensitive';
      const config = writeConfig({
        mcpServers: { signer: { command: 'node', env: { SIGNING_KEY: secret } } },
      });
      try {
        expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(/NUL/);
        try {
          buildCodexAppServerLaunchConfig(config.configPath, {});
        } catch (error) {
          expect(String(error)).not.toContain('prefix-sensitive');
          expect(String(error)).not.toContain('suffix-sensitive');
        }
      } finally {
        config.cleanup();
      }
    });

    it('rejects CRLF in literal HTTP header values without echoing the value', () => {
      const injected = 'safe-prefix\r\nX-Injected: sensitive-value';
      const config = writeConfig({
        mcpServers: {
          remote: { url: 'https://x.test', http_headers: { Authorization: injected } },
        },
      });
      try {
        expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(
          /invalid HTTP header value/
        );
        try {
          buildCodexAppServerLaunchConfig(config.configPath, {});
        } catch (error) {
          expect(String(error)).not.toContain('safe-prefix');
          expect(String(error)).not.toContain('sensitive-value');
        }
      } finally {
        config.cleanup();
      }
    });

    it.each(['Bad Header', 'Bad:Header'])('rejects invalid HTTP header name %s', (name) => {
      const config = writeConfig({
        mcpServers: { remote: { url: 'https://x.test', env_http_headers: { [name]: 'TOKEN' } } },
      });
      try {
        expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(
          /invalid HTTP header name/
        );
      } finally {
        config.cleanup();
      }
    });

    it.each([
      ['missing mcpServers', {}],
      ['non-object mcpServers', { mcpServers: [] }],
      ['invalid server name', { mcpServers: { 'bad name': { command: 'node' } } }],
      ['non-object server', { mcpServers: { test: 'node' } }],
      ['missing transport', { mcpServers: { test: { enabled: true } } }],
      ['non-string command', { mcpServers: { test: { command: 42 } } }],
      ['non-string argument', { mcpServers: { test: { command: 'node', args: ['ok', 42] } } }],
      ['non-string env', { mcpServers: { test: { command: 'node', env: { TOKEN: 42 } } } }],
      ['invalid env name', { mcpServers: { test: { command: 'node', env: { 'BAD-NAME': 'x' } } } }],
      ['mixed transports', { mcpServers: { test: { command: 'node', url: 'https://x.test' } } }],
      ['invalid boolean', { mcpServers: { test: { command: 'node', required: 'yes' } } }],
      ['invalid timeout', { mcpServers: { test: { command: 'node', tool_timeout_sec: -1 } } }],
      ['invalid auth enum', { mcpServers: { test: { url: 'https://x.test', auth: 'token' } } }],
      [
        'invalid default approval enum',
        { mcpServers: { test: { command: 'node', default_tools_approval_mode: 'never' } } },
      ],
      [
        'invalid per-tool approval enum',
        {
          mcpServers: {
            test: { command: 'node', tools: { search: { approval_mode: 'never' } } },
          },
        },
      ],
      [
        'enabled and allowed alias conflict',
        { mcpServers: { test: { command: 'node', enabled_tools: [], allowed_tools: [] } } },
      ],
      [
        'disabled and denied alias conflict',
        { mcpServers: { test: { command: 'node', disabled_tools: [], denied_tools: [] } } },
      ],
      [
        'startup timeout unit conflict',
        {
          mcpServers: {
            test: { command: 'node', startup_timeout_sec: 1, startup_timeout_ms: 1000 },
          },
        },
      ],
      [
        'tool timeout unit conflict',
        {
          mcpServers: { test: { command: 'node', tool_timeout_sec: 1, tool_timeout_ms: 1000 } },
        },
      ],
      ['HTTP field on stdio', { mcpServers: { test: { command: 'node', auth: 'oauth' } } }],
      ['stdio field on HTTP', { mcpServers: { test: { url: 'https://x.test', cwd: '/tmp' } } }],
      [
        'unsupported field',
        { mcpServers: { test: { command: 'node', description: 'secret-description' } } },
      ],
      ['unsupported root', { mcpServers: { test: { command: 'node' } }, description: 'bad-root' }],
    ])('rejects %s with a redacted Error', (_label, value) => {
      const config = writeConfig(value);
      try {
        expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(Error);
        try {
          buildCodexAppServerLaunchConfig(config.configPath, {});
        } catch (error) {
          expect(String(error)).not.toContain('secret-description');
        }
      } finally {
        config.cleanup();
      }
    });

    it('rejects contradictory environment values without exposing secrets', () => {
      const config = writeConfig({
        mcpServers: {
          first: { command: 'node', env: { SHARED_TOKEN: 'first-conflict-secret' } },
          second: { command: 'node', env: { SHARED_TOKEN: 'second-conflict-secret' } },
        },
      });
      try {
        expect.assertions(4);
        try {
          buildCodexAppServerLaunchConfig(config.configPath, {});
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(String(error)).toContain('SHARED_TOKEN');
          expect(String(error)).not.toContain('first-conflict-secret');
          expect(String(error)).not.toContain('second-conflict-secret');
        }
      } finally {
        config.cleanup();
      }
    });

    it('rejects a literal producer that contradicts an inherited value', () => {
      const config = writeConfig({
        mcpServers: {
          service: { command: 'node', env: { SHARED_TOKEN: 'configured-secret' } },
        },
      });
      try {
        expect(() =>
          buildCodexAppServerLaunchConfig(config.configPath, {
            SHARED_TOKEN: 'inherited-secret',
          })
        ).toThrow(/SHARED_TOKEN/);
        try {
          buildCodexAppServerLaunchConfig(config.configPath, {
            SHARED_TOKEN: 'inherited-secret',
          });
        } catch (error) {
          expect(String(error)).not.toContain('configured-secret');
          expect(String(error)).not.toContain('inherited-secret');
        }
      } finally {
        config.cleanup();
      }
    });

    it('rejects generated header env collisions', () => {
      const config = writeConfig({
        mcpServers: {
          remote: { url: 'https://x.test', http_headers: { Authorization: 'header-secret' } },
        },
      });
      try {
        const baseline = buildCodexAppServerLaunchConfig(config.configPath, {});
        const generatedName = Object.keys(baseline.env).find((name) =>
          name.startsWith('MAMA_MCP_REMOTE_HTTP_HEADER_')
        );
        expect(generatedName).toBeDefined();
        expect(() =>
          buildCodexAppServerLaunchConfig(config.configPath, {
            [generatedName as string]: 'caller-secret',
          })
        ).toThrow(new RegExp(generatedName as string));
      } finally {
        config.cleanup();
      }
    });

    it('rejects case-insensitive duplicate HTTP header bindings', () => {
      const config = writeConfig({
        mcpServers: {
          remote: {
            url: 'https://x.test',
            http_headers: { Authorization: 'header-secret' },
            env_http_headers: { authorization: 'AUTH_TOKEN' },
          },
        },
      });
      try {
        expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(
          /authorization.*more than once/
        );
      } finally {
        config.cleanup();
      }
    });

    it('canonicalizes HTTP header names case-insensitively', () => {
      const upper = writeConfig({
        mcpServers: {
          remote: { url: 'https://x.test', http_headers: { Authorization: 'same-secret' } },
        },
      });
      const lower = writeConfig({
        mcpServers: {
          remote: { url: 'https://x.test', http_headers: { authorization: 'same-secret' } },
        },
      });
      try {
        const upperLaunch = buildCodexAppServerLaunchConfig(upper.configPath, {});
        const lowerLaunch = buildCodexAppServerLaunchConfig(lower.configPath, {});
        expect(upperLaunch.args).toEqual(lowerLaunch.args);
        expect(upperLaunch.fingerprint).toBe(lowerLaunch.fingerprint);
      } finally {
        upper.cleanup();
        lower.cleanup();
      }
    });

    it('allows repeated consumers and equal literal producers of one environment value', () => {
      const config = writeConfig({
        mcpServers: {
          alpha: {
            command: 'node',
            env: { SHARED_LITERAL: 'same-secret' },
            env_vars: ['SHARED_TOKEN'],
          },
          beta: {
            command: 'node',
            env: { SHARED_LITERAL: 'same-secret' },
            env_vars: ['SHARED_TOKEN'],
          },
          first: {
            url: 'https://one.test',
            bearer_token_env_var: 'SHARED_TOKEN',
            env_http_headers: { Authorization: 'SHARED_TOKEN' },
          },
          second: {
            url: 'https://two.test',
            bearer_token_env_var: 'SHARED_TOKEN',
            env_http_headers: { Authorization: 'SHARED_TOKEN' },
          },
        },
      });
      try {
        const launch = buildCodexAppServerLaunchConfig(config.configPath, {
          SHARED_TOKEN: 'inherited-secret',
          SHARED_LITERAL: 'same-secret',
        });
        expect(launch.env).toMatchObject({
          SHARED_TOKEN: 'inherited-secret',
          SHARED_LITERAL: 'same-secret',
        });
        expect(launch.args.join(' ')).not.toContain('inherited-secret');
        expect(launch.args.join(' ')).not.toContain('same-secret');
      } finally {
        config.cleanup();
      }
    });

    it('rejects user bindings that collide with generated header names in either server order', () => {
      const seed = writeConfig({
        mcpServers: {
          remote: { url: 'https://x.test', http_headers: { Authorization: 'header-secret' } },
        },
      });
      try {
        const generatedName = Object.keys(
          buildCodexAppServerLaunchConfig(seed.configPath, {}).env
        ).find((name) => name.startsWith('MAMA_MCP_REMOTE_HTTP_HEADER_')) as string;
        const configs = [
          writeConfig({
            mcpServers: {
              alpha: { command: 'node', env_vars: [generatedName] },
              remote: {
                url: 'https://x.test',
                http_headers: { Authorization: 'header-secret' },
              },
            },
          }),
          writeConfig({
            mcpServers: {
              remote: {
                url: 'https://x.test',
                http_headers: { Authorization: 'header-secret' },
              },
              zeta: { command: 'node', env_vars: [generatedName] },
            },
          }),
        ];
        try {
          for (const config of configs) {
            expect(() => buildCodexAppServerLaunchConfig(config.configPath, {})).toThrow(
              new RegExp(generatedName)
            );
          }
        } finally {
          for (const config of configs) {
            config.cleanup();
          }
        }
      } finally {
        seed.cleanup();
      }
    });

    it('fingerprints binding policy, not installer metadata or secret values', () => {
      const make = (secret: string, installedBy: string, required = false) =>
        writeConfig({
          _installedBy: installedBy,
          mcpServers: {
            service: {
              command: 'node',
              env: { TOKEN: secret },
              required,
              _installedBy: installedBy,
            },
          },
        });
      const first = make('secret-one', 'installer-a');
      const secretChanged = make('secret-two', 'installer-b');
      const policyChanged = make('secret-two', 'installer-b', true);
      try {
        const firstHash = buildCodexAppServerLaunchConfig(first.configPath, {}).fingerprint;
        const secretHash = buildCodexAppServerLaunchConfig(
          secretChanged.configPath,
          {}
        ).fingerprint;
        const policyHash = buildCodexAppServerLaunchConfig(
          policyChanged.configPath,
          {}
        ).fingerprint;
        expect(firstHash).toBe(secretHash);
        expect(firstHash).not.toBe(policyHash);
        expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        first.cleanup();
        secretChanged.cleanup();
        policyChanged.cleanup();
      }
    });

    it('changes the fingerprint for every effective non-secret field and binding', () => {
      const policies: unknown[] = [
        { mcpServers: { service: { command: 'bun' } } },
        { mcpServers: { service: { command: 'node', args: ['server.js'] } } },
        { mcpServers: { service: { command: 'node', env: { TOKEN_A: 'secret' } } } },
        { mcpServers: { service: { command: 'node', env_vars: ['TOKEN_B'] } } },
        { mcpServers: { service: { command: 'node', cwd: '/workspace' } } },
        { mcpServers: { service: { command: 'node', environment_id: 'local' } } },
        { mcpServers: { service: { command: 'node', required: true } } },
        { mcpServers: { service: { command: 'node', supports_parallel_tool_calls: true } } },
        { mcpServers: { service: { command: 'node', enabled: false } } },
        { mcpServers: { service: { command: 'node', startup_timeout_sec: 2 } } },
        { mcpServers: { service: { command: 'node', tool_timeout_sec: 3 } } },
        { mcpServers: { service: { command: 'node', enabled_tools: ['read'] } } },
        { mcpServers: { service: { command: 'node', disabled_tools: ['write'] } } },
        {
          mcpServers: {
            service: { command: 'node', default_tools_approval_mode: 'prompt' },
          },
        },
        {
          mcpServers: {
            service: { command: 'node', tools: { read: { approval_mode: 'auto' } } },
          },
        },
        { mcpServers: { service: { command: 'node', scopes: ['profile'] } } },
        { mcpServers: { service: { url: 'https://one.test' } } },
        { mcpServers: { service: { url: 'https://two.test' } } },
        { mcpServers: { service: { url: 'https://one.test', auth: 'oauth' } } },
        {
          mcpServers: {
            service: { url: 'https://one.test', bearer_token_env_var: 'BEARER_TOKEN' },
          },
        },
        {
          mcpServers: {
            service: { url: 'https://one.test', http_headers: { Authorization: 'secret' } },
          },
        },
        {
          mcpServers: {
            service: { url: 'https://one.test', env_http_headers: { Authorization: 'AUTH_TOKEN' } },
          },
        },
        {
          mcpServers: {
            service: { url: 'https://one.test', oauth_resource: 'https://resource.test' },
          },
        },
      ];
      const configs = policies.map(writeConfig);
      const baseline = writeConfig({ mcpServers: { service: { command: 'node' } } });
      try {
        const baselineHash = buildCodexAppServerLaunchConfig(baseline.configPath, {}).fingerprint;
        const hashes = configs.map(
          (config) => buildCodexAppServerLaunchConfig(config.configPath, {}).fingerprint
        );
        expect(hashes.every((hash) => hash !== baselineHash)).toBe(true);
        expect(new Set(hashes)).toHaveLength(hashes.length);
      } finally {
        baseline.cleanup();
        for (const config of configs) {
          config.cleanup();
        }
      }
    });
  });
});
