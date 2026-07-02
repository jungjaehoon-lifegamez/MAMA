/**
 * Tests for agent result publication.
 *
 * Verifies that report_publish and wiki_publish publish operational output
 * without polluting the long-term decision memory.
 */

import { describe, it, expect, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';
import Database from '../../src/sqlite.js';
import { WikiArtifactStore } from '../../src/wiki-artifacts/wiki-artifact-store.js';
import { createWikiPublishAdapter } from '../../src/wiki-artifacts/wiki-publish-adapter.js';

describe('STORY-AGENT-RESULT-MEMORY: Agent result publication - AC operational outputs stay out of long-term memory', () => {
  const createMockApi = (): MAMAApiInterface => ({
    save: vi.fn().mockResolvedValue({
      success: true,
      id: 'decision_auto',
      type: 'decision',
      message: 'Decision saved',
    }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    listDecisions: vi.fn().mockResolvedValue([]),
    suggest: vi.fn().mockResolvedValue({ success: true, results: [], count: 0 }),
    updateOutcome: vi.fn().mockResolvedValue({ success: true }),
    loadCheckpoint: vi.fn().mockResolvedValue({ success: true }),
    recallMemory: vi.fn().mockResolvedValue({
      profile: { static: [], dynamic: [], evidence: [] },
      memories: [],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: '', scope_order: [], retrieval_sources: [] },
    }),
    ingestMemory: vi.fn().mockResolvedValue({ success: true }),
  });

  const createAgentContext = () => ({
    source: 'viewer',
    platform: 'viewer' as const,
    roleName: 'os_agent',
    role: {
      allowedTools: ['*'],
      systemControl: true,
      sensitiveAccess: true,
    },
    session: {
      sessionId: 'test-session',
      startedAt: new Date(),
    },
    capabilities: ['All tools'],
    limitations: [],
  });

  describe('report_publish', () => {
    it('publishes dashboard output without saving dashboard_briefing as a decision', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      const publisherFn = vi.fn();
      executor.setReportPublisher(publisherFn);

      const result = await executor.execute('report_publish', {
        slots: { summary: '<b>Revenue up 15%</b>', details: 'Q4 results look strong' },
      });

      expect(result).toMatchObject({ success: true });
      expect(publisherFn).toHaveBeenCalledOnce();
      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('should not crash when reportPublisher is not set', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      // No setReportPublisher call

      await expect(
        executor.execute('report_publish', {
          slots: { summary: 'test' },
        })
      ).rejects.toThrow('Report publisher not configured');

      // save should NOT have been called since publisher wasn't set
      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('does not autosave long report content', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      executor.setReportPublisher(vi.fn());

      const longContent = 'A'.repeat(2000);
      await executor.execute('report_publish', {
        slots: { summary: longContent },
      });

      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('does not call memory save when report publishing succeeds', async () => {
      const mockApi = createMockApi();
      (mockApi.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB write failed'));
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      executor.setReportPublisher(vi.fn());

      // Should succeed even though save rejects
      const result = await executor.execute('report_publish', {
        slots: { summary: 'test content' },
      });

      expect(result).toMatchObject({ success: true });
      expect(mockApi.save).not.toHaveBeenCalled();
    });
  });

  describe('wiki_publish', () => {
    it('publishes wiki pages without saving wiki_compilation as a decision', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      const publisherFn = vi.fn();
      executor.setWikiPublisher(publisherFn);

      const pages = [
        { path: 'wiki/api', title: 'API Reference', type: 'entity', content: '# API' },
        { path: 'wiki/arch', title: 'Architecture', type: 'entity', content: '# Arch' },
      ];

      const result = await executor.execute('wiki_publish', { pages });

      expect(result).toMatchObject({ success: true });
      expect(publisherFn).toHaveBeenCalledOnce();
      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('preserves supplied source IDs when delegating wiki_publish pages', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      const publisherFn = vi.fn();
      executor.setWikiPublisher(publisherFn);

      await executor.execute('wiki_publish', {
        pages: [
          {
            path: 'wiki/api',
            title: 'API Reference',
            type: 'entity',
            content: '# API',
            sourceIds: ['decision:d_1'],
          },
        ],
      });

      expect(publisherFn).toHaveBeenCalledWith([
        expect.objectContaining({ sourceIds: ['decision:d_1'] }),
      ]);
      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('uses injected vNext wiki adapter to store source-linked artifacts', async () => {
      const mockApi = createMockApi();
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);
      const executor = new GatewayToolExecutor({
        mamaApi: mockApi,
        wikiPublishAdapter: createWikiPublishAdapter({
          mode: 'vnext',
          store,
          now: () => new Date('2026-07-02T00:00:00.000Z'),
          nowMs: () => 1000,
        }),
      });
      executor.setAgentContext(createAgentContext());

      const result = await executor.execute('wiki_publish', {
        pages: [
          {
            path: 'wiki/api.md',
            title: 'API Reference',
            type: 'entity',
            content: '# API',
            sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          },
        ],
      });

      expect(result).toEqual({
        success: true,
        message: 'Wiki published: 0 pages',
        artifactsStored: 1,
      });
      expect(store.getByPath('wiki/api.md')).toMatchObject({
        sourceRefs: ['raw:slack:event-1'],
      });
      expect(mockApi.save).not.toHaveBeenCalled();
      db.close();
    });

    it('should handle empty pages array', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      executor.setWikiPublisher(vi.fn());

      const result = await executor.execute('wiki_publish', { pages: [] });

      expect(result).toMatchObject({ success: true, message: 'Wiki published: 0 pages' });
      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('should not crash when wikiPublisher is not set', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());

      await expect(
        executor.execute('wiki_publish', {
          pages: [{ path: 'wiki/test', title: 'Test', type: 'entity', content: 'x' }],
        })
      ).rejects.toThrow('Wiki publisher not configured');

      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('should not propagate handleSave failure', async () => {
      const mockApi = createMockApi();
      (mockApi.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB write failed'));
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      executor.setWikiPublisher(vi.fn());

      const result = await executor.execute('wiki_publish', {
        pages: [{ path: 'wiki/test', title: 'Test', type: 'entity', content: 'Content' }],
      });

      expect(result).toMatchObject({ success: true });
      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('does not autosave page summaries for large compilations', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      executor.setWikiPublisher(vi.fn());

      const pages = Array.from({ length: 30 }, (_, i) => ({
        path: `wiki/page-${i}`,
        title: `Page ${i}`,
        type: 'entity',
        content: `Content ${i}`,
      }));

      await executor.execute('wiki_publish', { pages });

      expect(mockApi.save).not.toHaveBeenCalled();
    });
  });

  describe('mama_save operational summary guard', () => {
    it('skips operational audit summaries instead of saving them as decisions', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());

      const result = await executor.execute('mama_save', {
        type: 'decision',
        topic: 'system-audit-20260502',
        decision: 'Audit complete. 2 MINOR fixes applied.',
        reasoning: 'Full audit run on 2026-05-02',
      });

      expect(result).toMatchObject({
        success: true,
        skipped: true,
        code: 'operational_memory_skipped',
      });
      expect(mockApi.save).not.toHaveBeenCalled();
    });

    it('still saves durable remediation lessons as decisions', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());

      const result = await executor.execute('mama_save', {
        type: 'decision',
        topic: 'security-alert-channel-policy',
        decision: 'Daemon launches must set MAMA_SECURITY_ALERT_CHANNELS when public tunnels run.',
        reasoning:
          'Repeated audits found the same exposure risk; the durable policy is useful beyond a single audit run.',
      });

      expect(result).toMatchObject({ success: true });
      expect(mockApi.save).toHaveBeenCalledOnce();
    });

    it('still saves legitimate long-term audit topics', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());

      const result = await executor.execute('mama_save', {
        type: 'decision',
        topic: 'audit-log-retention',
        decision: 'Audit completed records should be retained for 30 days.',
        reasoning: 'This is a durable retention policy, not an operational run summary.',
      });

      expect(result).toMatchObject({ success: true });
      expect(mockApi.save).toHaveBeenCalledOnce();
    });
  });
});
