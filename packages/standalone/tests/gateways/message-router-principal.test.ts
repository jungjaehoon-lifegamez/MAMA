import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import Database from '../../src/sqlite.js';
import { createMockMamaApi } from '../../src/gateways/context-injector.js';
import { MessageRouter, createMockAgentLoop } from '../../src/gateways/message-router.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';
import { withOwnerPrincipal } from './helpers/principal-fixture.js';

const securityEvents = vi.hoisted(() => ({
  logSecurityEventOnly: vi.fn(),
}));

vi.mock('../../src/security/security-monitor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/security-monitor.js')>()),
  logSecurityEventOnly: securityEvents.logSecurityEventOnly,
}));

const originalHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'mama-router-principal-'));
const testMamaHome = join(testHome, '.mama');

beforeAll(() => {
  mkdirSync(join(testMamaHome, 'briefs'), { recursive: true });
  writeFileSync(join(testMamaHome, 'SOUL.md'), '# Synthetic test persona\n', { mode: 0o600 });
  process.env.HOME = testHome;
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(testHome, { recursive: true, force: true });
});

function connectorMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    source: 'telegram',
    channelId: 'synthetic-channel',
    userId: 'synthetic-user',
    text: 'hello',
    ...overrides,
  };
}

describe('MessageRouter principal admission gate', () => {
  let sessionStore: SessionStore;
  let router: MessageRouter;

  beforeEach(() => {
    securityEvents.logSecurityEventOnly.mockReset();
    sessionStore = new SessionStore(new Database(':memory:'));
    router = new MessageRouter(
      sessionStore,
      createMockAgentLoop(() => 'processed'),
      createMockMamaApi([])
    );
  });

  it('diverts a principal-absent connector message before session creation', async () => {
    const getOrCreate = vi.spyOn(sessionStore, 'getOrCreate');

    await expect(router.processTurn(connectorMessage())).resolves.toMatchObject({
      outcome: 'external_divert',
      delivery: 'silent',
      sessionId: 'external-divert',
      duration: expect.any(Number),
    });
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it('diverts an external principal and records the security event', async () => {
    const message = connectorMessage({
      principal: {
        class: 'external',
        lane: 'divert',
        canonicalId: 'telegram:global:synthetic-external',
        consoleEligible: false,
      },
    });

    await expect(router.process(message)).resolves.toMatchObject({ outcome: 'external_divert' });
    expect(securityEvents.logSecurityEventOnly).toHaveBeenCalledOnce();
    expect(securityEvents.logSecurityEventOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'external_sender_diverted',
        details: expect.objectContaining({ source: 'telegram', lane: 'divert' }),
      })
    );
  });

  it('TG-04 diverts the impossible member owner-lane pair before session creation', async () => {
    const getOrCreate = vi.spyOn(sessionStore, 'getOrCreate');
    const message = connectorMessage({
      principal: {
        class: 'member',
        lane: 'owner',
        canonicalId: 'telegram:global:contradictory-member',
        consoleEligible: false,
      },
    });

    await expect(router.process(message)).resolves.toMatchObject({
      outcome: 'external_divert',
      delivery: 'silent',
      sessionId: 'external-divert',
    });
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(securityEvents.logSecurityEventOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'external_sender_diverted',
        details: expect.objectContaining({
          source: 'telegram',
          principalClass: 'member',
          lane: 'owner',
        }),
      })
    );
  });

  it('allows an owner principal through to normal processing', async () => {
    await expect(router.process(withOwnerPrincipal(connectorMessage()))).resolves.toMatchObject({
      outcome: 'completed',
      response: 'processed',
    });
  });

  it('allows a public principal through to normal processing', async () => {
    await expect(
      router.process(
        connectorMessage({
          principal: {
            class: 'external',
            lane: 'public',
            canonicalId: 'telegram:global:synthetic-public',
            consoleEligible: false,
          },
        })
      )
    ).resolves.toMatchObject({ outcome: 'completed', response: 'processed' });
  });

  it.each([
    {
      surface: 'native tools',
      mcp: [] as string[],
      builtinTools: undefined,
    },
    {
      surface: 'MCP tools',
      mcp: ['synthetic-mcp-tool'],
      builtinTools: '',
    },
  ])(
    'diverts the public lane before a real Claude AgentLoop with $surface can run',
    async ({ mcp, builtinTools }) => {
      const capableLoop = new AgentLoop(null, {
        backend: 'claude',
        systemPrompt: 'Synthetic public containment test',
        toolsConfig: { gateway: ['*'], mcp },
        builtinTools,
      });
      const run = vi.spyOn(capableLoop, 'run').mockResolvedValue({ response: 'must not run' });
      const capableSessionStore = new SessionStore(new Database(':memory:'));
      const capableRouter = new MessageRouter(
        capableSessionStore,
        capableLoop,
        createMockMamaApi([])
      );
      const getOrCreate = vi.spyOn(capableSessionStore, 'getOrCreate');

      expect(capableLoop.childRuntimeToolCapable).toBe(true);
      await expect(
        capableRouter.process(
          connectorMessage({
            principal: {
              class: 'external',
              lane: 'public',
              canonicalId: 'telegram:global:synthetic-public',
              consoleEligible: false,
            },
          })
        )
      ).resolves.toMatchObject({ outcome: 'external_divert', delivery: 'silent' });
      expect(run).not.toHaveBeenCalled();
      expect(getOrCreate).not.toHaveBeenCalled();
      expect(securityEvents.logSecurityEventOnly).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'public_lane_requires_gateway_only_runtime' })
      );

      capableSessionStore.close();
    }
  );

  it('processes the public lane through a real gateway-only Claude AgentLoop construction', async () => {
    const gatewayOnlyLoop = new AgentLoop(null, {
      backend: 'claude',
      systemPrompt: 'Synthetic gateway-only test',
      toolsConfig: { gateway: ['*'], mcp: [] },
      builtinTools: '',
    });
    const run = vi.spyOn(gatewayOnlyLoop, 'run').mockResolvedValue({ response: 'gateway-only' });
    const gatewaySessionStore = new SessionStore(new Database(':memory:'));
    const gatewayRouter = new MessageRouter(
      gatewaySessionStore,
      gatewayOnlyLoop,
      createMockMamaApi([])
    );

    expect(gatewayOnlyLoop.childRuntimeToolCapable).toBe(false);
    await expect(
      gatewayRouter.process(
        connectorMessage({
          principal: {
            class: 'external',
            lane: 'public',
            canonicalId: 'telegram:global:synthetic-public',
            consoleEligible: false,
          },
        })
      )
    ).resolves.toMatchObject({ outcome: 'completed', response: 'gateway-only' });
    expect(run).toHaveBeenCalledOnce();

    gatewaySessionStore.close();
  });

  it('reports no construction-wide child tool capability for a real Cline AgentLoop', () => {
    const clineLoop = new AgentLoop(null, {
      backend: 'cline',
      systemPrompt: 'Synthetic Cline capability test',
      clineCwd: testHome,
      toolsConfig: { gateway: ['*'], mcp: ['synthetic-mcp-tool'] },
    });

    expect(clineLoop.childRuntimeToolCapable).toBe(false);
  });

  it('leaves no channel-tail entry after a diverted turn', async () => {
    await router.process(connectorMessage());

    const channelTails = (router as unknown as { channelTails: Map<string, Promise<void>> })
      .channelTails;
    expect(channelTails.size).toBe(0);
  });

  it('attaches a host principal to a viewer message and processes it', async () => {
    const getOrCreate = vi.spyOn(sessionStore, 'getOrCreate');

    await expect(
      router.process(
        connectorMessage({
          source: 'viewer',
          channelId: 'synthetic-viewer',
          userId: 'synthetic-host-user',
        })
      )
    ).resolves.toMatchObject({ outcome: 'completed', response: 'processed' });
    expect(getOrCreate).toHaveBeenCalledOnce();
  });
});
