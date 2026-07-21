import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MAMAConfig } from '../../../src/cli/config/types.js';
import type {
  MemoryAgentProcessManagerLike,
  MessageRouter,
} from '../../../src/gateways/message-router.js';

const mocks = vi.hoisted(() => ({
  personaPath: '',
  run: vi.fn(),
  setSessionKey: vi.fn(),
  agentLoopOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/agent/index.js', () => ({
  AgentLoop: vi.fn().mockImplementation((_oauthManager, options: Record<string, unknown>) => {
    mocks.agentLoopOptions.push(options);
    return {
      run: mocks.run,
      setSessionKey: mocks.setSessionKey,
    };
  }),
}));

vi.mock('../../../src/multi-agent/memory-agent-persona.js', () => ({
  ensureMemoryPersona: vi.fn(() => mocks.personaPath),
}));

vi.mock('../../../src/memory/bootstrap-context.js', () => ({
  buildStandaloneMemoryBootstrap: vi.fn(async () => ({})),
  formatMemoryBootstrap: vi.fn(() => 'memory bootstrap'),
}));

vi.mock('../../../src/memory/memory-agent-ack.js', () => ({
  buildMemoryAuditAckFromAgentResult: vi.fn(() => ({ status: 'ignored' })),
}));

import { initMemoryAgent } from '../../../src/cli/runtime/memory-agent-init.js';

const require = createRequire(import.meta.url);

describe('Story M2.1: Memory Agent Runtime Provenance', () => {
  let tempDir: string;
  let processManager: MemoryAgentProcessManagerLike | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-agent-init-'));
    mocks.personaPath = join(tempDir, 'MEMORY_AGENT.md');
    writeFileSync(mocks.personaPath, 'Memory agent persona', 'utf-8');
    mocks.run.mockResolvedValue({ response: 'ack' });
    mocks.setSessionKey.mockClear();
    mocks.agentLoopOptions.length = 0;
    processManager = undefined;
  });

  afterEach(async () => {
    const { closeDB } = require('@jungjaehoon/mama-core/db-manager');
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('Acceptance Criteria', () => {
    async function initialize(
      runtimeBackend: string,
      memoryBackend?: string
    ): Promise<MemoryAgentProcessManagerLike | undefined> {
      const config = {
        agent: { model: runtimeBackend === 'codex' ? 'gpt-5-codex' : 'claude-sonnet-4-6' },
        workspace: { path: tempDir },
        multi_agent: {
          agents: {
            memory: memoryBackend
              ? {
                  backend: memoryBackend,
                }
              : {},
          },
        },
      } as unknown as MAMAConfig;
      process.env.MAMA_DB_PATH = join(tempDir, 'mama-memory.db');
      const { initDB } = require('@jungjaehoon/mama-core/db-manager');
      await initDB();
      const messageRouter = {
        setMemoryAgent(manager: MemoryAgentProcessManagerLike) {
          processManager = manager;
        },
      } as unknown as MessageRouter;

      await initMemoryAgent(
        {} as never,
        config,
        {} as never,
        {} as never,
        messageRouter,
        runtimeBackend,
        {} as never
      );

      return processManager;
    }

    async function runMemoryAudit(manager: MemoryAgentProcessManagerLike | undefined) {
      const memoryProcess = await manager?.getSharedProcess('memory');
      await memoryProcess?.sendMessage('Audit this turn');
    }

    describe('AC #1: provider selection is inherited consistently', () => {
      it('inherits the Codex daemon backend for the loop and memory-agent context', async () => {
        const manager = await initialize('codex');

        await runMemoryAudit(manager);

        expect(mocks.agentLoopOptions[0]).toEqual(expect.objectContaining({ backend: 'codex' }));
        expect(mocks.run).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            agentContext: expect.objectContaining({ backend: 'codex' }),
          })
        );
      });

      it('keeps the Claude daemon backend for the loop and memory-agent context', async () => {
        const manager = await initialize('claude');

        await runMemoryAudit(manager);

        expect(mocks.agentLoopOptions[0]).toEqual(expect.objectContaining({ backend: 'claude' }));
        expect(mocks.run).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            agentContext: expect.objectContaining({ backend: 'claude' }),
          })
        );
      });

      it('uses an explicit memory-agent backend before the daemon backend', async () => {
        const manager = await initialize('codex', 'claude');

        await runMemoryAudit(manager);

        expect(mocks.agentLoopOptions[0]).toEqual(expect.objectContaining({ backend: 'claude' }));
        expect(mocks.run).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            agentContext: expect.objectContaining({ backend: 'claude' }),
          })
        );
      });

      it('falls back to Claude when an unvalidated runtime value crosses the boundary', async () => {
        const manager = await initialize('legacy-backend');

        await runMemoryAudit(manager);

        expect(mocks.agentLoopOptions[0]).toEqual(expect.objectContaining({ backend: 'claude' }));
        expect(mocks.run).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            agentContext: expect.objectContaining({ backend: 'claude' }),
          })
        );
      });
    });

    describe('AC #2: parent model run provenance is forwarded', () => {
      it('forwards parent model run id into the memory agent loop run options', async () => {
        const config = {
          agent: { model: 'claude-sonnet-4-6' },
          workspace: { path: tempDir },
          multi_agent: {
            agents: {
              memory: {
                backend: 'claude',
                model: 'claude-sonnet-4-6',
              },
            },
          },
        } as unknown as MAMAConfig;
        process.env.MAMA_DB_PATH = join(tempDir, 'mama-memory.db');
        const { initDB } = require('@jungjaehoon/mama-core/db-manager');
        await initDB();
        const messageRouter = {
          setMemoryAgent(manager: MemoryAgentProcessManagerLike) {
            processManager = manager;
          },
        } as unknown as MessageRouter;

        await initMemoryAgent(
          {} as never,
          config,
          {} as never,
          {} as never,
          messageRouter,
          'claude',
          {} as never
        );

        const memoryProcess = await processManager?.getSharedProcess('memory');
        await memoryProcess?.sendMessage('Audit this turn', {
          sourceTurnId: 'turn-1',
          sourceMessageRef: 'telegram:abc:turn-1',
          parentModelRunId: 'parent-model-run-1',
        });

        expect(mocks.run).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            sourceTurnId: 'turn-1',
            sourceMessageRef: 'telegram:abc:turn-1',
            parentModelRunId: 'parent-model-run-1',
          })
        );
      });
    });
  });
});
