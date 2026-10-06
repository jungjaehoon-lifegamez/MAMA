import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { createCatalog, coreActionRegistrations } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { boundReadScopesFor } from '../../src/memory/api.js';
import { canonicalizeContextScopes } from '../../src/memory/types.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const scope = { kind: 'project', id: 'scope-a' };
const access = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [scope],
  actions: ['memory.update', 'memory.checkpoint.save', 'source.ingest'],
};

describe('F3 authority and serialization contracts', () => {
  let dbPath: string;
  beforeAll(async () => {
    dbPath = await initTestDB('review-f3');
  });
  afterAll(async () => cleanupTestDB(dbPath));
  const dispatch = () =>
    createDispatcher(
      createCatalog(
        coreActionRegistrations(
          createKnowledge({ adapter: getAdapter(), embedder: null }),
          getAdapter()
        )
      )
    );

  it('F3.8 deduplicates overlapping admitted reads without scope-key collisions', () => {
    expect(boundReadScopesFor({ ...access, readScopes: [scope] })).toEqual([scope]);
    expect(() =>
      boundReadScopesFor({ ...access, scopes: [{ kind: 'ab', id: 'c' }] }, [
        { kind: 'a', id: 'bc' },
      ])
    ).toThrow('outside the admitted access');
    expect(
      boundReadScopesFor({
        ...access,
        scopes: [
          { kind: 'ab', id: 'c' },
          { kind: 'a', id: 'bc' },
        ],
      })
    ).toHaveLength(2);
  });

  it('F3.10 refuses a foreign-scoped outcome amendment even with read access', async () => {
    const db = getAdapter();
    const knowledge = createKnowledge({ adapter: db, embedder: null });
    const foreign = { kind: 'project', id: 'scope-b' };
    const saved = await knowledge.appendJudgment(
      {
        commandId: 'foreign-create',
        topic: 'outcome',
        summary: 'Scoped decision',
        recordKind: 'judgment',
        scopes: [foreign],
      },
      { ...access, scopes: [foreign] }
    );
    const result = await dispatch()(
      { action: 'memory.update', input: { id: saved.recordId, outcome: 'FAILED' } },
      { access: { ...access, readScopes: [foreign] } }
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'SCOPE_DENIED' } });
    expect(
      db.prepare('SELECT outcome FROM decisions WHERE id = ?').get(saved.recordId)
    ).toMatchObject({ outcome: null });
    const allowed = await dispatch()(
      { action: 'memory.update', input: { id: saved.recordId, outcome: 'SUCCESS' } },
      { access: { ...access, scopes: [foreign] } }
    );
    expect(allowed.status).toBe('completed');
  });

  it('F3.11 scans checkpoint strings before persistence', async () => {
    const before = getAdapter().prepare('SELECT COUNT(*) AS n FROM checkpoints').get();
    const result = await dispatch()(
      {
        action: 'memory.checkpoint.save',
        input: {
          summary: 'resume',
          open_files: ['gh' + 'p_' + 'a'.repeat(30)],
        },
      },
      { access }
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'secret_material_refused' } });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toEqual(before);
  });

  it.each(['owner-message:', 'owner-result:'])(
    'F3.14 refuses reserved source prefix %s',
    async (prefix) => {
      const result = await dispatch()(
        {
          action: 'source.ingest',
          operationId: `reserved-${prefix}`,
          input: {
            content: 'untrusted evidence',
            source: { connector: `${prefix}session`, id: 'external' },
          },
        },
        { access }
      );
      expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
      expect(
        getAdapter()
          .prepare('SELECT 1 FROM observation_versions WHERE source = ?')
          .get(`${prefix}session`)
      ).toBeUndefined();
    }
  );

  it('F3.17 canonicalizes custom kinds independently of input order', () => {
    const scopes = [{ kind: 'zeta', id: 'x' }, scope, { kind: 'alpha', id: 'x' }];
    expect(canonicalizeContextScopes(scopes).scopeHash).toBe(
      canonicalizeContextScopes([...scopes].reverse()).scopeHash
    );
  });

  it('F3.17 authorizes aliases by their canonical action', async () => {
    const call = createDispatcher(
      createCatalog(
        [
          {
            contract: {
              name: 'test.canonical',
              summary: 'alias grant test',
              inputSchema: { type: 'object' },
            },
            exec: () => 'executed',
          },
        ],
        { 'test.alias': 'test.canonical' }
      )
    );
    expect(
      await call(
        { action: 'test.alias', input: {} },
        { access: { ...access, actions: ['test.canonical'] } }
      )
    ).toMatchObject({ status: 'completed', data: 'executed' });
    expect(
      await call(
        { action: 'test.alias', input: {} },
        { access: { ...access, actions: ['test.alias'] } }
      )
    ).toMatchObject({ status: 'failed', error: { code: 'action_not_granted' } });
  });
});
