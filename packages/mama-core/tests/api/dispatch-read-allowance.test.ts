/**
 * The read window dispatch states when the caller states none.
 *
 * "A citation must not out-read reading" used to hold only where a host assembled
 * the window from a verified envelope. A program calling over the socket carries
 * no envelope, so it got no window -- and the rule held only by the action's own
 * fail-closed default. The principal's grant already says what it may read.
 */
import { describe, expect, it } from 'vitest';

import { createCatalog, createDispatcher, type ActionContext } from '../../src/index.js';

function catalogSeeingItsContext() {
  let seen: ActionContext | undefined;
  const dispatch = createDispatcher(
    createCatalog([
      {
        contract: {
          name: 'test.context',
          summary: 'test-only: returns the context the dispatcher built.',
          inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        },
        exec: (_input, context) => {
          seen = context;
          return {};
        },
      },
    ])
  );
  return { dispatch, read: () => seen };
}

const baseAccess = {
  principalId: 'p',
  agentId: 'a',
  scopes: [],
  actions: ['test.context'],
};

describe('connector refusal explains only the calling principal grant', () => {
  const dispatch = createDispatcher(
    createCatalog(
      ['source.search', 'source.read'].map((name) => ({
        contract: {
          name,
          summary: 'Read a synthetic source.',
          readsConnector: { fromInput: 'source' },
          inputSchema: {
            type: 'object' as const,
            properties: { source: { type: 'string' as const } },
          },
        },
        exec: () => {
          throw new Error('An ungranted source must not execute');
        },
      }))
    )
  );

  it.each(['source.search', 'source.read'])(
    '%s returns the caller grant, not another principal grant',
    async (action) => {
      for (const [principalId, connectors, readable] of [
        ['owner', ['fixture-b', 'fixture-a'], 'fixture-a, fixture-b'],
        ['member', ['fixture-c'], 'fixture-c'],
      ] as const) {
        const result = await dispatch(
          { action, input: { source: 'fixture-family' } },
          {
            access: { ...baseAccess, principalId, actions: [action], connectors },
            readAllowance: { connectors: ['fixture-unrelated'], tenantId: 'fixture-tenant' },
          }
        );
        expect(result).toMatchObject({
          status: 'failed',
          error: {
            kind: 'denied',
            code: 'connector_out_of_scope',
            message: `principal ${principalId} may not read fixture-family; readable connectors: ${readable}`,
          },
        });
      }
    }
  );

  it.each([{ connectors: undefined }, { connectors: [] }])(
    'states none for an absent or empty connector grant ($connectors)',
    async ({ connectors }) => {
      const result = await dispatch(
        { action: 'source.read', input: { source: 'fixture-family' } },
        { access: { ...baseAccess, actions: ['source.read'], connectors } }
      );
      expect(result).toMatchObject({
        status: 'failed',
        error: {
          code: 'connector_out_of_scope',
          message: 'principal p may not read fixture-family; readable connectors: none',
        },
      });
    }
  );
});

describe('dispatch composes a read window from the principal grant', () => {
  it('carries the grant connectors, channels, projects and tenant', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: {
          ...baseAccess,
          connectors: ['trello'],
          channels: { trello: ['board-1'] },
          projectRefs: [{ kind: 'project', id: 'proj-1' }],
          tenantId: 'default',
        },
      }
    );
    expect(read()?.readAllowance).toEqual({
      connectors: ['trello'],
      channels: { trello: ['board-1'] },
      projectIds: ['proj-1'],
      tenantId: 'default',
      maxObservedMs: null,
    });
  });

  it('carries the grant observation clamp, so a citation cannot out-read reading in time', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: {
          ...baseAccess,
          connectors: ['trello'],
          tenantId: 'default',
          maxObservedMs: 1_700_000_000_000,
        },
      }
    );
    expect(read()?.readAllowance?.maxObservedMs).toBe(1_700_000_000_000);
  });

  it('derives the replay source ceiling from host session facts', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: { ...baseAccess, connectors: ['trello'], tenantId: 'default' },
        session: { replaySourceEndMs: 1_700_000_000_000 },
      }
    );
    expect(read()?.readAllowance?.maxSourceMs).toBe(1_700_000_000_000);
  });

  it('a grant naming connectors without a tenant reads nothing, not everything', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      { access: { ...baseAccess, connectors: ['trello'] } }
    );
    expect(read()?.readAllowance).toEqual({ connectors: [], tenantId: null });
  });

  it('keeps granted channels as the only window when no tenant is stated', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: {
          ...baseAccess,
          connectors: ['chat', 'trello'],
          channels: { chat: ['telegram:1001'], trello: ['board-1'] },
        },
      }
    );
    expect(read()?.readAllowance).toEqual({
      connectors: [],
      tenantId: null,
      channels: { chat: ['telegram:1001'], trello: ['board-1'] },
    });
  });

  it('keeps only an explicit connector-wide read when no tenant is stated', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: {
          ...baseAccess,
          connectors: ['chatwork', 'trello'],
          connectorWideRead: ['chatwork'],
          projectRefs: [{ kind: 'project', id: 'owner-workspace' }],
        },
      }
    );
    expect(read()?.readAllowance).toEqual({
      connectors: ['chatwork'],
      wideConnectors: ['chatwork'],
      projectIds: ['owner-workspace'],
      tenantId: null,
      maxObservedMs: null,
    });
  });

  it('a grant naming no connectors reads no raw events', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch({ action: 'test.context', input: {} }, { access: { ...baseAccess } });
    expect(read()?.readAllowance?.connectors).toEqual([]);
  });

  it('a window the host composed wins over the derived one', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    const hostWindow = { connectors: ['slack'], tenantId: 'default' };
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: { ...baseAccess, connectors: ['trello'], tenantId: 'default' },
        readAllowance: hostWindow,
      }
    );
    expect(read()?.readAllowance).toBe(hostWindow);
  });
});
