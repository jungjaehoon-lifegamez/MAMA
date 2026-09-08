import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoop } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { getRoleManager, resetRoleManager } from '../../src/agent/role-manager.js';
import {
  getGlobalLaneManager,
  resetGlobalLaneManager,
} from '../../src/concurrency/lane-manager.js';
import { DEFAULT_ROLES, type MAMAConfig } from '../../src/cli/config/types.js';
import { initMainAgentLoop } from '../../src/cli/runtime/agent-loop-init.js';
import type { OAuthManager } from '../../src/auth/index.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';
import { MessageRouter } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import Database from '../../src/sqlite.js';
import { OwnerActionEffectLedger } from '../../src/operator/owner-action-effects.js';
import { getSessionPool } from '../../src/agent/session-pool.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';
import { installReportCodexServer } from '../helpers/report-codex-server.js';
import { TELEGRAM_FORMAT_GUIDE } from '../../src/gateways/telegram-format.js';
import { projectOwnerRuntimeRole } from '../../src/operator/owner-runtime.js';

// Only Telegram transport and the external model protocol are replaced.
const transport = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown) => Promise<void>>(),
  sent: [] as string[],
  hold: undefined as Promise<void> | undefined,
}));
vi.mock('grammy', () => ({
  Bot: class {
    botInfo = { id: 123, username: 'fixture_bot' };
    api = {
      sendMessage: async (_chat: number, text: string) => {
        transport.sent.push(text);
        if (text.startsWith('batch:') && transport.hold) await transport.hold;
        return { message_id: transport.sent.length };
      },
      editMessageText: async () => {},
      deleteMessage: async () => {},
      sendChatAction: async () => {},
    };
    on(event: string, callback: (ctx: unknown) => Promise<void>) {
      transport.handlers.set(event, callback);
    }
    catch() {}
    async init() {}
    start() {}
    async stop() {}
  },
  InputFile: class {},
}));

const roots: string[] = [];
let root: string;
let loop: AgentLoop | undefined;
let gateway: TelegramGateway | undefined;
let db: Database | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mama-owner-queue-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  vi.stubEnv('MAMA_TELEGRAM_MESSAGE_LEDGER_PATH', join(root, 'telegram-ledger.json'));
  vi.stubEnv('MAMA_WORKSPACE', join(root, '.mama', 'workspace'));
  vi.stubEnv('PATH', `${join(root, 'bin')}:${process.env.PATH ?? ''}`);
  mkdirSync(join(root, '.mama', 'workspace'), { recursive: true });
  resetGlobalLaneManager();
  resetRoleManager();
  getSessionPool().dispose();
  transport.sent.length = 0;
  transport.hold = undefined;
  transport.handlers.clear();
});
afterEach(async () => {
  getGlobalLaneManager().clearLane('session:owner:runtime');
  await gateway?.stop();
  await loop?.stop();
  db?.close();
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
});

describe('TG-01/TG-04/TG-06 real owner ingress and background tool delivery', () => {
  it.each(['background-first', 'inbound-first'] as const)(
    'delivers a receipted background tool send with %s owner admission',
    async (order) => {
      const capture = installReportCodexServer(root, order === 'inbound-first' ? 2 : 1);
      const ownerRole = projectOwnerRuntimeRole({
        ...DEFAULT_ROLES.definitions.owner_console,
        model: 'gpt-5.6-sol',
      });
      getRoleManager({
        rolesConfig: {
          ...DEFAULT_ROLES,
          definitions: { ...DEFAULT_ROLES.definitions, owner_console: ownerRole },
        },
      });
      const executor = new GatewayToolExecutor();
      db = new Database(':memory:');
      executor.setOwnerActionEffectLedger(new OwnerActionEffectLedger(db));
      const runtime = initMainAgentLoop(
        {
          version: 1,
          agent: {
            backend: 'codex',
            model: 'gpt-5.6-sol',
            timeout: 5_000,
            max_turns: 2,
            tools: {},
          },
          database: { path: ':memory:' },
          multi_agent: { agents: { 'os-agent': { useCodeAct: true } } },
        } as unknown as MAMAConfig,
        null as unknown as OAuthManager,
        db,
        null,
        'codex',
        executor
      );
      loop = runtime.agentLoop;
      const router = new MessageRouter(
        new SessionStore(db),
        runtime.agentLoopClient,
        createMockMamaApi([]),
        { backend: 'codex' }
      );
      gateway = new TelegramGateway({
        token: 'synthetic-token',
        turnProcessor: router,
        config: { allowedChats: ['7777'] },
      });
      executor.setTelegramGateway(gateway);
      await gateway.start();
      const handler = transport.handlers.get('message');
      expect(handler).toBeDefined();
      const message = (id: number) => ({
        message: {
          message_id: id,
          date: 1,
          chat: { id: 7777, type: 'private' },
          from: { id: 7777, is_bot: false, first_name: 'Owner' },
          text: 'follow up',
        },
      });
      const initial = order === 'inbound-first' ? handler!(message(1)) : null;
      if (initial)
        await vi.waitFor(() => expect(existsSync(join(root, 'initial-started'))).toBe(true));
      const report = loop.run('background report', {
        sessionKey: 'owner:runtime',
        source: 'operator',
        channelId: 'report',
        disableAutoRecall: true,
        sourceMessageRef: 'owner-report:fixture',
        sessionPolicyRole: ownerRole,
        envelope: makeSignedEnvelope({
          source: 'operator',
          channel_id: 'report',
          scope: {
            project_refs: [],
            memory_scopes: [],
            raw_connectors: ['telegram'],
            allowed_destinations: [{ kind: 'telegram', id: '7777' }],
          },
        }),
        agentContext: {
          source: 'operator',
          platform: 'cli',
          roleName: 'owner_console',
          role: ownerRole,
          tier: 1,
          backend: 'codex',
          session: {
            sessionId: 'synthetic',
            channelId: 'report',
            userId: 'owner',
            startedAt: new Date(),
          },
          capabilities: ownerRole.allowedTools,
          limitations: [],
        },
      });
      // Attach immediately so cleanup of a failed RED run cannot leak a rejection.
      const reportResult = report.catch((error) => error as Error);
      if (initial) {
        await vi.waitFor(() =>
          expect(getGlobalLaneManager().getQueueSize('session:owner:runtime')).toBe(2)
        );
        writeFileSync(join(root, 'initial-release'), '1');
        await initial;
      }
      await vi.waitFor(() => expect(existsSync(join(root, 'background-started'))).toBe(true), {
        timeout: 4_000,
      });
      const inbound = handler!(message(2)).catch((error) => error as Error);
      await vi.waitFor(() =>
        expect(getGlobalLaneManager().getQueueSize('session:owner:runtime')).toBe(2)
      );
      let releaseBatch!: () => void;
      transport.hold = new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      const batchText = 'batch:' + 'A'.repeat(5000);
      const batch = gateway.sendSystemMessage('7777', batchText, 'fixture-complete-report');
      try {
        await vi.waitFor(() =>
          expect(transport.sent.some((text) => text.startsWith('batch:'))).toBe(true)
        );
        writeFileSync(join(root, 'release-send'), '1');
        await vi.waitFor(() =>
          expect(
            db!
              .prepare(
                "SELECT count(*) AS count FROM owner_action_effects WHERE effect_kind = 'telegram_send' AND status = 'transmitting'"
              )
              .get()
          ).toEqual({ count: 1 })
        );
        expect(transport.sent).not.toContain('background effect');
        releaseBatch();
        await batch;
        await vi.waitFor(() => expect(transport.sent).toContain('background effect'), {
          timeout: 1_500,
        });
        expect(await reportResult).not.toBeInstanceOf(Error);
        expect(await inbound).not.toBeInstanceOf(Error);
        const requests = readFileSync(capture, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as { method?: string; params?: { baseInstructions?: string } }
          );
        const starts = requests.filter((request) => request.method === 'thread/start');
        expect(starts).toHaveLength(1);
        expect(starts[0].params?.baseInstructions?.split(TELEGRAM_FORMAT_GUIDE)).toHaveLength(2);
        for (const request of requests.filter((request) => request.method === 'turn/start')) {
          expect(JSON.stringify(request)).not.toContain('Telegram message formatting');
        }
        expect(transport.sent.filter((text) => text === 'background effect')).toHaveLength(1);
        const firstChunk = transport.sent.findIndex((text) => text.startsWith('batch:'));
        expect(transport.sent[firstChunk + 1]).toBe('A'.repeat(910));
        expect(transport.sent.indexOf('background effect')).toBeGreaterThan(firstChunk + 1);
        expect(gateway.readOutboundDeliveryReceipt('fixture-complete-report', 'text')?.state).toBe(
          'delivered'
        );
        expect(
          db
            .prepare(
              "SELECT count(*) AS count FROM owner_action_effects WHERE effect_kind = 'telegram_send' AND status = 'confirmed'"
            )
            .get()
        ).toEqual({ count: 1 });
      } finally {
        releaseBatch();
        writeFileSync(join(root, 'release-send'), '1');
        getGlobalLaneManager().clearLane('session:owner:runtime');
        await Promise.all([reportResult, inbound, batch]);
      }
    },
    15_000
  );
});
