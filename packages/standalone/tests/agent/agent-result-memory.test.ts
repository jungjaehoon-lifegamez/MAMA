/**
 * Tests for agent result memory persistence.
 *
 * Verifies that report_publish and wiki_publish tool executions
 * automatically save summaries to mama memory so Conductor can
 * query them via mama_search.
 */

import { describe, it, expect, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface } from '../../src/agent/types.js';

describe('Agent result memory persistence', () => {
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

  describe('report_publish → memory save', () => {
    it('should call handleSave with topic dashboard_briefing after publishing', async () => {
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

      // Allow fire-and-forget promise to settle
      await vi.waitFor(() => {
        expect(mockApi.save).toHaveBeenCalledOnce();
      });

      const saveCall = (mockApi.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saveCall.topic).toBe('dashboard_briefing');
      expect(saveCall.decision).toContain('Dashboard briefing');
      expect(saveCall.decision).toContain('Revenue up 15%'); // HTML stripped
      expect(saveCall.decision).not.toContain('<b>'); // HTML tags removed
      expect(saveCall.reasoning).toBe('Auto-saved by dashboard agent after report_publish');
      expect(saveCall.scopes).toEqual([{ kind: 'global', id: 'system' }]);
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

    it('should truncate long report content to 1500 chars', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      executor.setReportPublisher(vi.fn());

      const longContent = 'A'.repeat(2000);
      await executor.execute('report_publish', {
        slots: { summary: longContent },
      });

      await vi.waitFor(() => {
        expect(mockApi.save).toHaveBeenCalledOnce();
      });

      const saveCall = (mockApi.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // 1500 chars + "..." suffix after the date prefix
      expect(saveCall.decision.length).toBeLessThan(1600);
      expect(saveCall.decision).toContain('...');
    });

    it('should not propagate handleSave failure', async () => {
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

      // Give the fire-and-forget promise time to settle
      await new Promise((r) => setTimeout(r, 50));
      // No unhandled rejection — the .catch() suppresses it
    });
  });

  describe('wiki_publish → memory save', () => {
    it('should call handleSave with topic wiki_compilation after publishing', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      const publisherFn = vi.fn();
      executor.setWikiPublisher(publisherFn);

      const pages = [
        { path: '/wiki/api', title: 'API Reference', type: 'entity', content: '# API' },
        { path: '/wiki/arch', title: 'Architecture', type: 'entity', content: '# Arch' },
      ];

      const result = await executor.execute('wiki_publish', { pages });

      expect(result).toMatchObject({ success: true });
      expect(publisherFn).toHaveBeenCalledOnce();

      await vi.waitFor(() => {
        expect(mockApi.save).toHaveBeenCalledOnce();
      });

      const saveCall = (mockApi.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saveCall.topic).toBe('wiki_compilation');
      expect(saveCall.decision).toContain('Wiki compilation');
      expect(saveCall.decision).toContain('2 pages');
      expect(saveCall.decision).toContain('API Reference');
      expect(saveCall.decision).toContain('Architecture');
      expect(saveCall.reasoning).toBe('Auto-saved by wiki agent after wiki_publish');
      expect(saveCall.scopes).toEqual([{ kind: 'global', id: 'system' }]);
    });

    it('should handle empty pages array', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      executor.setWikiPublisher(vi.fn());

      const result = await executor.execute('wiki_publish', { pages: [] });

      expect(result).toMatchObject({ success: true, message: 'Wiki published: 0 pages' });

      await vi.waitFor(() => {
        expect(mockApi.save).toHaveBeenCalledOnce();
      });

      const saveCall = (mockApi.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saveCall.decision).toContain('0 pages');
    });

    it('should not crash when wikiPublisher is not set', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());

      await expect(
        executor.execute('wiki_publish', {
          pages: [{ path: '/wiki/test', title: 'Test', type: 'entity', content: 'x' }],
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
        pages: [{ path: '/wiki/test', title: 'Test', type: 'entity', content: 'Content' }],
      });

      expect(result).toMatchObject({ success: true });

      // Give the fire-and-forget promise time to settle
      await new Promise((r) => setTimeout(r, 50));
      // No unhandled rejection — the .catch() suppresses it
    });

    it('should limit page summary to first 20 pages', async () => {
      const mockApi = createMockApi();
      const executor = new GatewayToolExecutor({ mamaApi: mockApi });
      executor.setAgentContext(createAgentContext());
      executor.setWikiPublisher(vi.fn());

      const pages = Array.from({ length: 30 }, (_, i) => ({
        path: `/wiki/page-${i}`,
        title: `Page ${i}`,
        type: 'entity',
        content: `Content ${i}`,
      }));

      await executor.execute('wiki_publish', { pages });

      await vi.waitFor(() => {
        expect(mockApi.save).toHaveBeenCalledOnce();
      });

      const saveCall = (mockApi.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saveCall.decision).toContain('30 pages');
      // Should list first 20 pages
      expect(saveCall.decision).toContain('Page 19');
      // Should NOT list page 20+
      expect(saveCall.decision).not.toContain('Page 20');
    });
  });
});
