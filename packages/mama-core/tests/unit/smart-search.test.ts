import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rerankResults } from '../../src/smart-search.js';
import type { HaikuClient } from '../../src/haiku-client.js';

const mockHaiku = {
  available: vi.fn().mockReturnValue(true),
  complete: vi.fn(),
};

describe('SmartSearch rerank', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should rerank candidates based on Haiku response', async () => {
    mockHaiku.complete.mockResolvedValue(JSON.stringify([2, 0, 1]));
    const candidates = [
      { id: 'a', topic: 'auth', decision: 'Use JWT', score: 0.9 },
      { id: 'b', topic: 'db', decision: 'Use SQLite', score: 0.85 },
      { id: 'c', topic: 'cache', decision: 'Use Redis', score: 0.8 },
    ];
    const result = await rerankResults(
      'caching strategy',
      candidates,
      mockHaiku as unknown as HaikuClient
    );
    expect(result[0].id).toBe('c'); // index 2 first
    expect(result[1].id).toBe('a'); // index 0 second
    expect(result[2].id).toBe('b'); // index 1 third
  });

  it('should return original order on Haiku error', async () => {
    mockHaiku.complete.mockRejectedValue(new Error('API error'));
    const candidates = [
      { id: 'a', topic: 'auth', decision: 'Use JWT', score: 0.9 },
      { id: 'b', topic: 'db', decision: 'Use SQLite', score: 0.85 },
      { id: 'c', topic: 'cache', decision: 'Use Redis', score: 0.8 },
    ];
    const result = await rerankResults('auth', candidates, mockHaiku as unknown as HaikuClient);
    expect(result).toEqual(candidates);
  });

  it('should skip rerank when fewer than 3 candidates', async () => {
    const candidates = [{ id: 'a', topic: 'auth', decision: 'Use JWT', score: 0.9 }];
    const result = await rerankResults('auth', candidates, mockHaiku as unknown as HaikuClient);
    expect(result).toEqual(candidates);
    expect(mockHaiku.complete).not.toHaveBeenCalled();
  });

  it('should handle malformed Haiku response', async () => {
    mockHaiku.complete.mockResolvedValue('I cannot provide rankings');
    const candidates = [
      { id: 'a', topic: 'auth', decision: 'Use JWT', score: 0.9 },
      { id: 'b', topic: 'db', decision: 'Use SQLite', score: 0.85 },
      { id: 'c', topic: 'cache', decision: 'Use Redis', score: 0.8 },
    ];
    const result = await rerankResults('auth', candidates, mockHaiku as unknown as HaikuClient);
    expect(result).toEqual(candidates); // Falls back to original
  });

  it('should handle partial indices (fills missing)', async () => {
    mockHaiku.complete.mockResolvedValue('[1]'); // Only says index 1 is best
    const candidates = [
      { id: 'a', topic: 'auth', decision: 'Use JWT', score: 0.9 },
      { id: 'b', topic: 'db', decision: 'Use SQLite', score: 0.85 },
      { id: 'c', topic: 'cache', decision: 'Use Redis', score: 0.8 },
    ];
    const result = await rerankResults('db', candidates, mockHaiku as unknown as HaikuClient);
    expect(result[0].id).toBe('b'); // index 1 first
    expect(result.length).toBe(3); // all candidates present
  });
});
