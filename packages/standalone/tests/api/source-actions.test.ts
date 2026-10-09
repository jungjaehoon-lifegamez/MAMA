import { describe, expect, it, vi } from 'vitest';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { sourceActionRegistrations } from '../../src/api/source-actions.js';
import { minimalWorkActionRegistrations } from '../../src/api/work-actions.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const access: ActionContext['access'] = {
  principalId: 'owner-test',
  agentId: 'agent-test',
  actions: ['source.search', 'source.read'],
  connectors: ['connector-test'],
  scopes: [],
};

describe('minimal source actions', () => {
  it('adds the configured timezone label to source.read display times', async () => {
    const setting = createTimeZoneSetting('America/Los_Angeles');
    const stored = {
      readObservation: () => ({
        sourceAt: Date.parse('2026-09-27T06:30:00Z'),
        observedAt: 1,
        content: 'source',
      }),
    };
    const dispatch = createDispatcher(
      createCatalog(sourceActionRegistrations({ stored: stored as never, timeZone: setting }))
    );
    const result = await dispatch(
      { action: 'source.read', input: { observationRef: 'obs' } },
      { access }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { sourceTime: expect.stringContaining('(America/Los_Angeles)') },
    });
  });

  it('registers source.read with single and batched bounded read fields', () => {
    const catalog = createCatalog(
      sourceActionRegistrations({ timeZone: createTimeZoneSetting('UTC') })
    );
    expect(
      catalog
        .list()
        .map((contract) => contract.name)
        .sort()
    ).toEqual(['source.read', 'source.search']);
    expect(catalog.describe('source.read').inputSchema.properties?.content_limit).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 4_000,
      description: 'Maximum characters returned by a read; at most 4000.',
    });
    const readSchema = catalog.describe('source.read').inputSchema;
    expect(readSchema.required).toEqual([]);
    expect(readSchema.properties?.observationRefs).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 500,
    });
    expect(readSchema.oneOf).toEqual([
      expect.objectContaining({ required: ['observationRef'] }),
      expect.objectContaining({ required: ['observationRefs'] }),
    ]);
  });

  it('dispatches a batch of source observation handles and rejects more than 500', async () => {
    const stored = {
      search: vi.fn().mockReturnValue({ hits: [], next_cursor: null }),
      read: vi.fn().mockReturnValue({ results: [] }),
      has: vi.fn().mockReturnValue(true),
    };
    const dispatch = createDispatcher(
      createCatalog(sourceActionRegistrations({ stored, timeZone: createTimeZoneSetting('UTC') }))
    );
    const refs = ['observation-a', 'observation-b'];

    const batch = await dispatch(
      {
        action: 'source.read',
        input: { source: 'connector-test', observationRefs: refs },
      },
      { access }
    );
    expect(batch).toMatchObject({ status: 'completed', data: { results: [] } });
    expect(stored.read).toHaveBeenCalledWith(
      'connector-test',
      { source: 'connector-test', observationRefs: refs },
      access
    );

    const tooMany = await dispatch(
      {
        action: 'source.read',
        input: {
          source: 'connector-test',
          observationRefs: Array.from({ length: 501 }, (_, index) => `observation-${index}`),
        },
      },
      { access }
    );
    expect(tooMany).toMatchObject({
      status: 'failed',
      error: { kind: 'invalid_input', code: 'invalid_input' },
    });
    expect(stored.read).toHaveBeenCalledTimes(1);
  });

  it('infers source for a single source.read ref and keeps search results compact', async () => {
    const stored = {
      search: vi.fn().mockReturnValue({
        hits: [
          {
            raw_id: 'obs-a',
            author_label: 'Writer',
            source_at: '2026-09-27T00:00:00.000Z',
            content_preview: 'x'.repeat(240),
            source_id: 'message-a',
            // The stored reader's compact hit carries the channel key only.
            channel_id: 'channel-a',
            score: 1,
          },
        ],
        next_cursor: null,
      }),
      read: vi.fn(),
      readObservation: vi
        .fn()
        .mockReturnValue({ source: 'connector-test', content: 'full original' }),
      has: vi.fn().mockReturnValue(true),
    };
    const dispatch = createDispatcher(
      createCatalog(sourceActionRegistrations({ stored, timeZone: createTimeZoneSetting('UTC') }))
    );
    const read = await dispatch(
      { action: 'source.read', input: { observationRef: 'obs-a' } },
      { access }
    );
    expect(read).toMatchObject({
      status: 'completed',
      data: { source: 'connector-test', content: 'full original' },
    });
    expect(stored.readObservation).toHaveBeenCalledWith('obs-a', access, undefined, {});
    await dispatch(
      {
        action: 'source.read',
        input: { observationRef: 'obs-a', content_offset: 7, content_limit: 3 },
      },
      { access }
    );
    expect(stored.readObservation).toHaveBeenLastCalledWith('obs-a', access, undefined, {
      content_offset: 7,
      content_limit: 3,
    });
    const search = await dispatch(
      { action: 'source.search', input: { source: 'connector-test', query: 'term' } },
      { access }
    );
    expect(search).toMatchObject({
      status: 'completed',
      data: {
        hits: [
          {
            author: 'Writer',
            channel: 'channel-a',
            text: 'x'.repeat(200),
            observationRef: 'obs-a',
          },
        ],
      },
    });
    expect(JSON.stringify(search).length).toBeLessThan(1_000);
  });

  it('infers each source for a batch of refs without a source and reports per-ref failures', async () => {
    const stored = {
      search: vi.fn(),
      read: vi.fn(),
      readObservation: vi.fn((ref: string) => {
        if (ref === 'obs-missing') throw new Error('observation_not_found');
        return { source: ref === 'obs-a' ? 'chatwork' : 'slack', content: `original ${ref}` };
      }),
      has: vi.fn().mockReturnValue(true),
    };
    const dispatch = createDispatcher(
      createCatalog(sourceActionRegistrations({ stored, timeZone: createTimeZoneSetting('UTC') }))
    );
    const read = await dispatch(
      { action: 'source.read', input: { observationRefs: ['obs-a', 'obs-b', 'obs-missing'] } },
      { access }
    );
    expect(read).toMatchObject({
      status: 'completed',
      data: {
        results: [
          { observationRef: 'obs-a', status: 'completed', data: { source: 'chatwork' } },
          { observationRef: 'obs-b', status: 'completed', data: { source: 'slack' } },
          { observationRef: 'obs-missing', status: 'failed', error: 'observation_not_found' },
        ],
      },
    });
    const bounded = await dispatch(
      {
        action: 'source.read',
        input: { observationRefs: ['obs-a'], content_offset: 4, content_limit: 2 },
      },
      { access }
    );
    expect(bounded).toMatchObject({ status: 'completed' });
    expect(stored.readObservation).toHaveBeenLastCalledWith('obs-a', access, undefined, {
      content_offset: 4,
      content_limit: 2,
    });
  });

  it('describes every source and work input field, including nested fields', () => {
    const knowledge = {
      createWork: vi.fn(),
      reviseWork: vi.fn(),
    };
    const catalog = createCatalog([
      ...sourceActionRegistrations({ timeZone: createTimeZoneSetting('UTC') }),
      ...minimalWorkActionRegistrations({ observationExists: () => true, knowledge }),
    ]);

    const visit = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
      const value = schema as {
        properties?: Record<string, unknown>;
        items?: unknown;
        oneOf?: unknown[];
      };
      for (const [name, property] of Object.entries(value.properties ?? {})) {
        const field = property as { description?: unknown };
        expect(field.description, `${path}.${name}`).toEqual(expect.any(String));
        expect(String(field.description).trim(), `${path}.${name}`).not.toBe('');
        visit(property, `${path}.${name}`);
      }
      visit(value.items, `${path}[]`);
      for (const [index, branch] of (value.oneOf ?? []).entries()) {
        visit(branch, `${path}.oneOf[${index}]`);
      }
    };

    for (const contract of catalog.list()) visit(contract.inputSchema, contract.name);
  });

  it('dispatches stored search/read and refuses an ungranted connector', async () => {
    const stored = {
      search: vi.fn().mockReturnValue({ hits: [], next_cursor: null }),
      read: vi.fn().mockReturnValue({ content: 'source-content' }),
      has: vi.fn().mockReturnValue(true),
    };
    const dispatch = createDispatcher(
      createCatalog(sourceActionRegistrations({ stored, timeZone: createTimeZoneSetting('UTC') }))
    );
    const searched = await dispatch(
      {
        action: 'source.search',
        input: { source: 'connector-test', query: 'term' },
      },
      { access }
    );
    expect(searched).toMatchObject({ status: 'completed', data: { hits: [] } });
    expect(stored.search).toHaveBeenCalledWith(
      'connector-test',
      { source: 'connector-test', query: 'term' },
      access
    );

    await dispatch(
      {
        action: 'source.search',
        input: { source: 'connector-test', query: 'replay-term' },
      },
      { access, session: { replaySourceEndMs: 1_500 } }
    );
    expect(stored.search).toHaveBeenLastCalledWith(
      'connector-test',
      { source: 'connector-test', query: 'replay-term' },
      access,
      { maxSourceMs: 1_500 }
    );

    const read = await dispatch(
      {
        action: 'source.read',
        input: {
          source: 'connector-test',
          observationRef: 'observation-test',
          content_offset: 0,
          content_limit: 100,
        },
      },
      { access }
    );
    expect(read).toMatchObject({ status: 'completed', data: { content: 'source-content' } });

    const deniedSearch = await dispatch(
      { action: 'source.search', input: { source: 'other-connector', query: 'term' } },
      { access }
    );
    expect(deniedSearch).toMatchObject({
      status: 'failed',
      error: { code: 'connector_out_of_scope' },
    });
    {
      const action = 'source.read';
      const denied = await dispatch(
        { action, input: { source: 'other-connector', observationRef: 'observation-test' } },
        { access }
      );
      expect(denied).toMatchObject({
        status: 'failed',
        error: { code: 'denied' },
      });
    }
    expect(stored.search).toHaveBeenCalledTimes(2);
    expect(stored.read).toHaveBeenCalledTimes(1);
  });
});
