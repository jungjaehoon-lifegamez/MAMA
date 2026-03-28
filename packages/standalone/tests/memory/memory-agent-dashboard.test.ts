import { describe, expect, it } from 'vitest';

import { buildMemoryAgentDashboardPayload } from '../../src/memory/memory-agent-dashboard.js';

describe('Story: buildMemoryAgentDashboardPayload - Memory agent dashboard payload', () => {
  describe('AC #1: derives active and recent channels from recent extractions', () => {
    it('derives active and recent channels from recent extractions', () => {
      const payload = buildMemoryAgentDashboardPayload({
        agentStats: {
          turnsObserved: 1,
          factsExtracted: 0,
          factsSaved: 0,
          acksApplied: 0,
          acksSkipped: 1,
          acksFailed: 0,
          lastExtraction: 1234,
          recentExtractions: [
            {
              topic: 'redis_sqlite',
              timestamp: 1234,
              success: false,
              channelKey: 'telegram:7026976631',
            },
          ],
        },
        channelSummaries: [],
        recentDecisions: [],
        generatedAt: '2026-03-27T00:00:00.000Z',
      });

      expect(payload.status).toEqual(
        expect.objectContaining({
          label: 'Monitoring active',
        })
      );
      expect(payload.activeChannel).toEqual(
        expect.objectContaining({
          channelKey: 'telegram:7026976631',
          source: 'telegram',
          channelId: '7026976631',
        })
      );
      expect(payload.recentChannels).toEqual([
        expect.objectContaining({
          channelKey: 'telegram:7026976631',
        }),
      ]);
    });

    it('prefers newer channel summary timestamps over older extraction timestamps', () => {
      const payload = buildMemoryAgentDashboardPayload({
        agentStats: {
          turnsObserved: 1,
          factsExtracted: 0,
          factsSaved: 0,
          acksApplied: 0,
          acksSkipped: 1,
          acksFailed: 0,
          lastExtraction: 1234,
          recentExtractions: [
            {
              topic: 'redis_sqlite',
              timestamp: 1234,
              success: false,
              channelKey: 'telegram:7026976631',
            },
          ],
        },
        channelSummaries: [
          {
            channelKey: 'telegram:7026976631',
            updatedAt: 5678,
          },
        ],
        recentDecisions: [],
        generatedAt: '2026-03-27T00:00:00.000Z',
      });

      expect(payload.activeChannel).toEqual(
        expect.objectContaining({
          channelKey: 'telegram:7026976631',
          lastActive: 5678,
        })
      );
    });
  });

  describe('AC #2: falls back to idle state when there is no channel activity', () => {
    it('falls back to idle state when there is no channel activity', () => {
      const payload = buildMemoryAgentDashboardPayload({
        agentStats: {
          turnsObserved: 0,
          factsExtracted: 0,
          factsSaved: 0,
          acksApplied: 0,
          acksSkipped: 0,
          acksFailed: 0,
          lastExtraction: null,
          recentExtractions: [],
        },
        channelSummaries: [],
        recentDecisions: [],
        generatedAt: '2026-03-27T00:00:00.000Z',
      });

      expect(payload.status).toEqual(
        expect.objectContaining({
          label: 'Idle',
        })
      );
      expect(payload.activeChannel).toBeNull();
      expect(payload.recentChannels).toEqual([]);
    });
  });
});
