import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import Database from '../../src/sqlite.js';
import { SessionStore } from '../../src/gateways/session-store.js';
import { MessageRouter, createMockAgentLoop } from '../../src/gateways/message-router.js';

const TEST_DB = '/tmp/test-standalone-memory-v2-e2e.db';
const require = createRequire(import.meta.url);

async function waitForMemoryIngestion(mamaApi: {
  recallMemory: (
    query: string,
    options?: { scopes?: Array<{ kind: string; id: string }>; includeProfile?: boolean }
  ) => Promise<{ memories?: unknown[] }>;
}) {
  await vi.waitFor(async () => {
    const bundle = await mamaApi.recallMemory('pnpm', {
      scopes: [{ kind: 'project', id: process.cwd() }],
      includeProfile: true,
    });
    expect(bundle.memories?.length ?? 0).toBeGreaterThan(0);
  });
}

describe('Memory V2 standalone e2e', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });

    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterAll(async () => {
    const dbManager = await import('@jungjaehoon/mama-core/db-manager');
    await dbManager.closeDB();
    delete process.env.MAMA_DB_PATH;

    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('should ingest first-turn memory but avoid default per-turn reinjection on the next turn', async () => {
    const mamaApi = require('@jungjaehoon/mama-core/mama-api');

    let lastPrompt = '';
    const agentLoop = createMockAgentLoop((prompt) => {
      lastPrompt = prompt;
      return 'Agent response';
    });

    const mamaApiClient = {
      search: async (query: string, limit?: number) => {
        const result = await mamaApi.suggest(query, limit !== undefined ? { limit } : undefined);
        return result?.results || [];
      },
      recallMemory: mamaApi.recallMemory.bind(mamaApi),
      ingestMemory: mamaApi.ingestMemory.bind(mamaApi),
      save: mamaApi.save.bind(mamaApi),
    };

    const sessionStore = new SessionStore(new Database(':memory:'));
    const router = new MessageRouter(sessionStore, agentLoop, mamaApiClient);

    router.setMemoryAgent({
      getSharedProcess: async () => ({
        sendMessage: async (content: string) => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          await mamaApi.ingestMemory({
            content,
            scopes: [{ kind: 'project', id: process.cwd() }],
            source: {
              package: 'standalone',
              source_type: 'memory-agent-e2e',
              project_id: process.cwd(),
            },
          });
          return { response: 'ingested' };
        },
      }),
    } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager);

    await router.process({
      source: 'discord',
      channelId: 'channel-e2e',
      userId: 'user-e2e',
      text: 'We decided to use pnpm in this repository, keep answers concise, and reuse this convention for all follow-up tasks in the current project.',
    });

    await waitForMemoryIngestion(mamaApi);

    await router.process({
      source: 'discord',
      channelId: 'channel-e2e',
      userId: 'user-e2e',
      text: 'Should we keep using pnpm here?',
    });

    expect(lastPrompt).not.toContain('[MAMA Profile]');
    expect(lastPrompt).not.toContain('[MAMA Memories]');

    sessionStore.close();
  });
});
