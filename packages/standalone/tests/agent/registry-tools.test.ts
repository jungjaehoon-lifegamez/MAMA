import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import { handleRegistryLookup, handleRegistryUpsert } from '../../src/agent/registry-tool-handlers.js';
import type { RegistryPort } from '../../src/agent/registry-tool-handlers.js';

/**
 * The agent reaches the registry through two tools: one that answers "what do I already
 * know this by", one that records what it decided. Neither guesses: an alias another node
 * holds comes back as a conflict for the agent to resolve, not a silent reassignment.
 */
function port(overrides: Partial<RegistryPort> = {}): RegistryPort {
  return {
    resolveAlias: vi.fn().mockReturnValue(null),
    createNode: vi.fn().mockReturnValue('reg_new'),
    addAlias: vi.fn(),
    listNodes: vi.fn().mockReturnValue([]),
    mergeNodes: vi.fn(),
    splitNode: vi.fn().mockReturnValue(['reg_a', 'reg_b']),
    ...overrides,
  };
}

describe('registry gateway tools', () => {
  it('advertises both tools with the fields the agent must supply', () => {
    const lookup = ToolRegistry.getTool('registry_lookup');
    const upsert = ToolRegistry.getTool('registry_upsert');
    expect(lookup?.params).toContain('name');
    expect(lookup?.params).toContain('kind');
    expect(upsert?.params).toContain('aliases');
    expect(upsert?.description).toMatch(/merge|병합|owner/i);
  });

  it('lookup reports a known node with every alias it answers to', async () => {
    const api = port({
      resolveAlias: vi.fn().mockReturnValue({
        id: 'reg_1',
        kind: 'item',
        name: 'alpha item',
        parentId: null,
        mergedInto: null,
      }),
      listNodes: vi.fn().mockReturnValue([]),
    });

    const result = await handleRegistryLookup(api, { name: 'a_0001', kind: 'item' });

    expect(result).toMatchObject({ success: true, found: true, node: { id: 'reg_1' } });
    expect(api.resolveAlias).toHaveBeenCalledWith('a_0001', 'item');
  });

  it('lookup says plainly that nothing is registered, so the agent creates instead of guessing', async () => {
    const result = await handleRegistryLookup(port(), { name: 'never seen', kind: 'person' });
    expect(result).toMatchObject({ success: true, found: false });
  });

  it('upsert creates a node with its aliases', async () => {
    const api = port();
    const result = await handleRegistryUpsert(api, {
      kind: 'item',
      name: 'alpha item',
      aliases: ['a_0001', 'b_0001'],
    });
    expect(result).toMatchObject({ success: true, id: 'reg_new', created: true });
    expect(api.createNode).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'item', name: 'alpha item', aliases: ['a_0001', 'b_0001'] })
    );
  });

  it('upsert on a known name adds the new aliases to the node that exists', async () => {
    const api = port({
      resolveAlias: vi
        .fn()
        .mockImplementation((alias: string) =>
          alias === 'alpha item'
            ? { id: 'reg_1', kind: 'item', name: 'alpha item', parentId: null, mergedInto: null }
            : null
        ),
    });

    const result = await handleRegistryUpsert(api, {
      kind: 'item',
      name: 'alpha item',
      aliases: ['c_0001'],
    });

    expect(result).toMatchObject({ success: true, id: 'reg_1', created: false });
    expect(api.addAlias).toHaveBeenCalledWith('reg_1', 'c_0001');
    expect(api.createNode).not.toHaveBeenCalled();
  });

  it('refuses to merge on its own when an alias belongs to another node', async () => {
    const api = port({
      addAlias: vi.fn().mockImplementation(() => {
        const error = new Error('Alias "c_0001" already resolves to item reg_9.');
        (error as { code?: string }).code = 'alias_taken';
        throw error;
      }),
      resolveAlias: vi
        .fn()
        .mockImplementation((alias: string) =>
          alias === 'alpha item'
            ? { id: 'reg_1', kind: 'item', name: 'alpha item', parentId: null, mergedInto: null }
            : null
        ),
    });

    const result = await handleRegistryUpsert(api, {
      kind: 'item',
      name: 'alpha item',
      aliases: ['c_0001'],
    });

    expect(result).toMatchObject({ success: false, code: 'alias_taken' });
    expect(api.mergeNodes).not.toHaveBeenCalled();
  });
});
