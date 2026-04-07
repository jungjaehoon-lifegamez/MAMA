import { describe, expect, it, vi } from 'vitest';

import { ConnectorRegistry } from '../../../src/connectors/framework/connector-registry.js';
import type { ConnectorHealth, IConnector } from '../../../src/connectors/framework/types.js';

function makeMockConnector(name: string, healthy = true): IConnector {
  return {
    name,
    type: 'api',
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({
      healthy,
      lastPollTime: null,
      lastPollCount: 0,
    } satisfies ConnectorHealth),
    getAuthRequirements: vi.fn().mockReturnValue([]),
    authenticate: vi.fn().mockResolvedValue(true),
    poll: vi.fn().mockResolvedValue([]),
  };
}

describe('ConnectorRegistry', () => {
  describe('register and get', () => {
    it('registers a connector and retrieves it by name', () => {
      const registry = new ConnectorRegistry();
      const connector = makeMockConnector('slack');
      registry.register('slack', connector);

      expect(registry.get('slack')).toBe(connector);
    });

    it('returns undefined for unknown connector names', () => {
      const registry = new ConnectorRegistry();
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('overwrites a connector if registered again with the same name', () => {
      const registry = new ConnectorRegistry();
      const first = makeMockConnector('slack');
      const second = makeMockConnector('slack');

      registry.register('slack', first);
      registry.register('slack', second);

      expect(registry.get('slack')).toBe(second);
    });
  });

  describe('getActive', () => {
    it('returns all registered connectors', () => {
      const registry = new ConnectorRegistry();
      registry.register('slack', makeMockConnector('slack'));
      registry.register('notion', makeMockConnector('notion'));

      const active = registry.getActive();
      expect(active.size).toBe(2);
      expect(active.has('slack')).toBe(true);
      expect(active.has('notion')).toBe(true);
    });

    it('returns an empty map when no connectors are registered', () => {
      const registry = new ConnectorRegistry();
      expect(registry.getActive().size).toBe(0);
    });

    it('returns a snapshot — mutation does not affect the registry', () => {
      const registry = new ConnectorRegistry();
      registry.register('slack', makeMockConnector('slack'));

      const active = registry.getActive();
      active.delete('slack');

      // Original registry still has it
      expect(registry.get('slack')).toBeDefined();
    });
  });

  describe('disposeAll', () => {
    it('calls dispose on all registered connectors', async () => {
      const registry = new ConnectorRegistry();
      const slack = makeMockConnector('slack');
      const notion = makeMockConnector('notion');

      registry.register('slack', slack);
      registry.register('notion', notion);

      await registry.disposeAll();

      expect(slack.dispose).toHaveBeenCalledOnce();
      expect(notion.dispose).toHaveBeenCalledOnce();
    });

    it('clears the registry after disposing', async () => {
      const registry = new ConnectorRegistry();
      registry.register('slack', makeMockConnector('slack'));

      await registry.disposeAll();

      expect(registry.getActive().size).toBe(0);
    });

    it('resolves even when no connectors are registered', async () => {
      const registry = new ConnectorRegistry();
      await expect(registry.disposeAll()).resolves.toBeUndefined();
    });
  });

  describe('healthCheckAll', () => {
    it('returns health for all connectors', async () => {
      const registry = new ConnectorRegistry();
      registry.register('slack', makeMockConnector('slack', true));
      registry.register('broken', makeMockConnector('broken', false));

      const health = await registry.healthCheckAll();

      expect(health['slack']?.healthy).toBe(true);
      expect(health['broken']?.healthy).toBe(false);
    });

    it('marks connector as unhealthy if healthCheck throws', async () => {
      const registry = new ConnectorRegistry();
      const connector = makeMockConnector('crash');
      (connector.healthCheck as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

      registry.register('crash', connector);

      const health = await registry.healthCheckAll();
      expect(health['crash']?.healthy).toBe(false);
      expect(health['crash']?.error).toBe('timeout');
    });

    it('returns empty object when no connectors are registered', async () => {
      const registry = new ConnectorRegistry();
      const health = await registry.healthCheckAll();
      expect(Object.keys(health)).toHaveLength(0);
    });
  });
});
