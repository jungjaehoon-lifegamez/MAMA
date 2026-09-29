import { describe, expect, it } from 'vitest';
import type { DatabaseInstance, Knowledge } from '@jungjaehoon/mama-core';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

describe('W1 action surface', () => {
  it('grants calendar reads and memory scopes to the owner by default', () => {
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: {} as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
    });
    expect(surface.ownerAccess.connectors).toContain('calendar');
    expect(surface.ownerAccess.connectorWideRead).toContain('calendar');
    expect(surface.ownerAccess.scopes).toEqual(
      expect.arrayContaining([
        { kind: 'channel', id: 'calendar' },
        { kind: 'project', id: 'calendar' },
      ])
    );
  });

  it('exposes the read-only viewer action and derives host tools from the catalog', () => {
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: {} as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      connectors: ['chatwork', 'slack', 'trello', 'kagemusha'],
      scopes: [{ kind: 'project', id: 'workspace-test' }],
      judge: { ask: async () => ({}) },
      ownerMessages: { exchanges: () => [], retentionMs: 1 },
    });
    const expected = [
      'code_act',
      'deliver.discord.file',
      'deliver.slack.file',
      'deliver.telegram.file',
      'graph.query',
      'help',
      'judge',
      'manage.wiki.publish',
      'manage.wiki.read',
      'manage.wiki.update',
      'memory.checkpoint.list',
      'memory.checkpoint.save',
      'memory.read:provenance',
      'memory.read:record',
      'memory.retire',
      'memory.save',
      'memory.search',
      'owner.messages',
      'owner.timezone.set',
      'report.publish',
      'report.read',
      'schedule.upcoming',
      'source.attachment.download',
      'source.attachment.list',
      'source.read',
      'source.recent',
      'source.search',
      'work.create',
      'work.list',
      'work.no_update',
      'work.revise',
      'work.show',
    ];

    expect(
      surface.catalog
        .list()
        .map((contract) => contract.name)
        .sort()
    ).toEqual(expected);
    expect(surface.ownerAccess.actions.slice().sort()).toEqual(expected);
    // Codex calls actions from its own exec; code_act is for Claude.
    expect(
      surface
        .hostToolDefinitions()
        .map((definition) => definition.name)
        .sort()
    ).toEqual(expected.filter((name) => name !== 'code_act'));
    expect(surface.catalog.list().filter((contract) => contract.name === 'work.list')).toHaveLength(
      1
    );
  });

  it('lets the owner read every channel of its connectors in the graph', () => {
    const connectors = ['chatwork', 'slack', 'trello', 'kagemusha'];
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: {} as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      connectors,
    });
    expect(surface.ownerAccess.connectorWideRead).toEqual(connectors);
  });

  it('rejects a work status outside the shared vocabulary before it reaches knowledge', async () => {
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: {} as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      connectors: ['slack'],
    });
    const result = await surface.dispatch(
      {
        action: 'work.create',
        input: {
          topic: 'work topic',
          summary: 'what the work means',
          set: { title: 'Item', status: 'in progress (free text)' },
        },
      },
      { access: surface.ownerAccess }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: expect.stringMatching(/status/) },
    });
  });
});
