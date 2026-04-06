import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRecallDecisionTool } from '../../src/tools/recall-decision.js';

describe('recall_decision v2: scopes + format', () => {
  let mockMama;
  let tool;

  beforeEach(() => {
    mockMama = {
      recall: vi.fn().mockResolvedValue('# Legacy recall result'),
      recallMemory: vi.fn().mockResolvedValue({
        memories: [
          {
            id: 'mem_1',
            topic: 'auth',
            summary: 'Use JWT',
            details: 'For stateless auth',
            confidence: 0.9,
            status: 'active',
            event_date: '2024-06-15',
          },
        ],
        profile: { static: [], dynamic: [], evidence: [] },
        graph_context: { primary: [], expanded: [], edges: [] },
        search_meta: { query: 'auth', scope_order: ['project'], retrieval_sources: ['vector'] },
      }),
    };
    tool = createRecallDecisionTool(mockMama);
  });

  // Schema tests
  it('has scopes in inputSchema', () => {
    expect(tool.inputSchema.properties.scopes).toBeDefined();
    expect(tool.inputSchema.properties.scopes.type).toBe('array');
  });

  it('has format in inputSchema', () => {
    expect(tool.inputSchema.properties.format).toBeDefined();
    expect(tool.inputSchema.properties.format.enum).toEqual(['markdown', 'json']);
  });

  it('topic is still required', () => {
    expect(tool.inputSchema.required).toContain('topic');
  });

  // Validation tests
  it('rejects empty topic', async () => {
    const result = await tool.handler({ topic: '' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Validation error');
  });

  it('rejects missing topic', async () => {
    const result = await tool.handler({});
    expect(result.success).toBe(false);
  });

  // Handler behavior: scopes → recallMemory v2
  it('calls recallMemory with scopes when scopes provided', async () => {
    const scopes = [{ kind: 'project', id: '/my/project' }];
    const result = await tool.handler({ topic: 'auth', scopes });

    expect(mockMama.recallMemory).toHaveBeenCalledWith('auth', {
      scopes,
      includeHistory: true,
    });
    expect(mockMama.recall).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain('auth');
  });

  it('returns json bundle when format=json and scopes provided', async () => {
    const scopes = [{ kind: 'project', id: '/p' }];
    const result = await tool.handler({ topic: 'auth', scopes, format: 'json' });

    expect(result.success).toBe(true);
    expect(result.history.memories).toHaveLength(1);
    expect(result.history.memories[0].id).toBe('mem_1');
  });

  it('includes event_date in markdown output', async () => {
    const scopes = [{ kind: 'project', id: '/p' }];
    const result = await tool.handler({ topic: 'auth', scopes });

    expect(result.message).toContain('Event: 2024-06-15');
  });

  // Handler behavior: no scopes → legacy recall
  it('falls back to legacy recall without scopes', async () => {
    const result = await tool.handler({ topic: 'auth' });

    expect(mockMama.recall).toHaveBeenCalledWith('auth', { format: 'markdown' });
    expect(mockMama.recallMemory).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.history).toBe('# Legacy recall result');
  });

  it('passes format to legacy recall', async () => {
    await tool.handler({ topic: 'auth', format: 'json' });

    expect(mockMama.recall).toHaveBeenCalledWith('auth', { format: 'json' });
  });

  // Backward compat: empty scopes = legacy path
  it('uses legacy recall when scopes is empty array', async () => {
    await tool.handler({ topic: 'auth', scopes: [] });

    expect(mockMama.recall).toHaveBeenCalled();
    expect(mockMama.recallMemory).not.toHaveBeenCalled();
  });
});
