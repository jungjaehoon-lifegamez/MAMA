/**
 * Which model this library opens: none.
 *
 * `memory/api.ts` imported `ollama-client` and called it when a search asked
 * for LLM re-ranking — a model opened by the library, decided for every host
 * that installs it (§2.1 — one place opens the model). The host states a
 * runner now; the runtime carries it and the catalog reads it at call time.
 *
 * Measured while moving it: the re-ranking branch is unreachable through
 * `suggest` today. It runs only when memory_v2 returns nothing AND the legacy
 * vector search returns something, and memory_v2 answers wherever that search
 * would (probed at cosine 0.9, 0.62 and 0.2 — memory_v2 answered the first
 * two and both paths were empty for the third). So what this pins is the
 * import boundary, which is the part that was real.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import { coreActionRegistrations, createCatalog } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import type { TextCompletion } from '../../src/runtime/text-completion.js';

const ACCESS = {
  principalId: 'principal-runner',
  agentId: 'agent-runner',
  scopes: [{ kind: 'project' as const, id: 'scope-runner' }],
  actions: ['memory.save', 'memory.search'],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('the model this library opens', () => {
  let dbPath = '';

  beforeAll(async () => {
    dbPath = await initTestDB('search-runner');
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('is none: no module outside the client itself reaches one', () => {
    const openers = sourceFiles('src')
      .filter((path) => !path.endsWith(join('src', 'ollama-client.ts')))
      .filter((path) => !path.endsWith(join('src', 'index.ts')))
      .filter((path) => /from '[^']*ollama-client/.test(readFileSync(path, 'utf8')));

    // `index.ts` re-exports the client for a host that wants to wire it as its
    // runner; nothing else may reach it, or the library is opening a model on
    // the host's behalf again.
    expect(openers).toEqual([]);
  });

  it('answers a search under a stated runner, and under none', async () => {
    const dispatchWith = (runner?: TextCompletion) =>
      createDispatcher(
        createCatalog(
          coreActionRegistrations(
            createKnowledge({ adapter: getAdapter(), embedder: null }),
            getAdapter(),
            {
              ...(runner ? { runner: () => runner } : {}),
            }
          )
        )
      );

    const saved = await dispatchWith()(
      {
        action: 'memory.save',
        operationId: 'op-runner-1',
        input: {
          kind: 'decision',
          topic: 'runner_topic',
          summary: 'rerankertoken a decision to find',
          details: 'why',
          source: { package: 'mama-core', source_type: 'test' },
          scopes: ACCESS.scopes,
        },
      },
      { access: ACCESS }
    );
    expect(saved.status).toBe('completed');

    let asked = 0;
    const runner: TextCompletion = async () => {
      asked += 1;
      return JSON.stringify({ ranking: [0] });
    };

    for (const dispatch of [dispatchWith(runner), dispatchWith()]) {
      const result = await dispatch(
        {
          action: 'memory.search',
          input: { query: 'rerankertoken', limit: 5, useReranking: true },
        },
        { access: ACCESS }
      );
      expect(result.status).toBe('completed');
      expect((result.data as { results?: unknown[] }).results?.length).toBe(1);
    }
    // The stated runner is never asked, because the branch that would ask it
    // is unreachable through this path. A host that states one is not charged
    // for a model this library decided to use.
    expect(asked).toBe(0);
  });
});
