import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createConnectorRouter,
  type ConnectorHandlerDeps,
} from '../../src/api/connector-handler.js';
import { ConnectorEventLog } from '../../src/api/connector-event-log.js';
import { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import type { IConnector, ConnectorHealth } from '../../src/connectors/framework/types.js';

function createMockConnector(name: string): IConnector {
  return {
    name,
    type: 'api',
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi
      .fn()
      .mockResolvedValue({
        healthy: true,
        lastPollTime: new Date(),
        lastPollCount: 5,
      } as ConnectorHealth),
    getAuthRequirements: vi.fn().mockReturnValue([]),
    authenticate: vi.fn().mockResolvedValue(true),
    poll: vi.fn().mockResolvedValue([]),
  };
}

describe('Connector API Handler', () => {
  let app: express.Express;
  let eventLog: ConnectorEventLog;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    eventLog = new ConnectorEventLog();
    registry = new ConnectorRegistry();
    registry.register('slack', createMockConnector('slack'));

    const deps: ConnectorHandlerDeps = {
      registry,
      scheduler: null,
      eventLog,
      channelConfigs: {
        slack: { '#general': { role: 'hub' } },
      },
    };

    app = express();
    app.use(express.json());
    app.use('/api/connectors', createConnectorRouter(deps));
  });

  describe('GET /api/connectors/status', () => {
    it('returns all connectors with status', async () => {
      const res = await request(app).get('/api/connectors/status');
      expect(res.status).toBe(200);
      expect(res.body.connectors).toBeInstanceOf(Array);

      const slack = res.body.connectors.find((c: { name: string }) => c.name === 'slack');
      expect(slack).toBeDefined();
      expect(slack.enabled).toBe(true);
      expect(slack.healthy).toBe(true);
      expect(slack.channelCount).toBe(1);
    });

    it('includes disabled connectors', async () => {
      const res = await request(app).get('/api/connectors/status');
      const telegram = res.body.connectors.find((c: { name: string }) => c.name === 'telegram');
      expect(telegram).toBeDefined();
      expect(telegram.enabled).toBe(false);
    });
  });

  describe('GET /api/connectors/events', () => {
    it('returns empty events initially', async () => {
      const res = await request(app).get('/api/connectors/events');
      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
      expect(res.body.stats.total).toBe(0);
    });

    it('returns events after push', async () => {
      eventLog.push({
        timestamp: '2026-04-07T10:00:00Z',
        source: 'slack',
        channel: '#project',
        memoriesExtracted: 5,
      });

      const res = await request(app).get('/api/connectors/events');
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].memoriesExtracted).toBe(5);
      expect(res.body.stats.totalMemories).toBe(5);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        eventLog.push({
          timestamp: `2026-04-07T${i}:00:00Z`,
          source: 'slack',
          channel: '#ch',
          memoriesExtracted: i,
        });
      }

      const res = await request(app).get('/api/connectors/events?limit=3');
      expect(res.body.events).toHaveLength(3);
    });
  });

  describe('POST /api/connectors/:name/poll', () => {
    it('returns 404 for unknown connector', async () => {
      const res = await request(app).post('/api/connectors/unknown/poll');
      expect(res.status).toBe(404);
    });

    it('triggers poll for active connector', async () => {
      const triggerPoll = vi.fn().mockResolvedValue(undefined);

      const depsWithPoll: ConnectorHandlerDeps = {
        registry,
        scheduler: null,
        eventLog,
        channelConfigs: {},
        triggerPoll,
      };

      const app2 = express();
      app2.use(express.json());
      app2.use('/api/connectors', createConnectorRouter(depsWithPoll));

      const res = await request(app2).post('/api/connectors/slack/poll');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(triggerPoll).toHaveBeenCalled();
    });
  });
});
