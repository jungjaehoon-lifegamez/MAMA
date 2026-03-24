import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractFacts } from '../../src/fact-extractor.js';
import type { HaikuClient } from '../../src/haiku-client.js';

const mockHaiku = {
  available: vi.fn().mockReturnValue(true),
  complete: vi.fn(),
};

describe('FactExtractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should extract structured facts from Haiku response', async () => {
    mockHaiku.complete.mockResolvedValue(
      JSON.stringify([
        {
          topic: 'database_choice',
          decision: 'Use SQLite for local storage',
          reasoning: 'No network dependency needed',
          is_static: true,
          confidence: 0.9,
        },
      ])
    );

    const facts = await extractFacts(
      'We decided to use SQLite for local storage because it has no network dependency',
      mockHaiku as unknown as HaikuClient
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].topic).toBe('database_choice');
    expect(facts[0].is_static).toBe(true);
  });

  it('should return empty array when Haiku returns []', async () => {
    mockHaiku.complete.mockResolvedValue('[]');
    const facts = await extractFacts(
      'Hello, how are you? I am doing well and this is long enough to meet the minimum content length requirement for extraction.',
      mockHaiku as unknown as HaikuClient
    );
    expect(facts).toHaveLength(0);
  });

  it('should handle malformed JSON gracefully', async () => {
    mockHaiku.complete.mockResolvedValue('not valid json {{{');
    const facts = await extractFacts(
      'some content that is long enough to meet the minimum content length requirement for extraction processing',
      mockHaiku as unknown as HaikuClient
    );
    expect(facts).toHaveLength(0);
  });

  it('should handle Haiku throwing an error', async () => {
    mockHaiku.complete.mockRejectedValue(new Error('API error'));
    const facts = await extractFacts(
      'some content that is long enough to meet the minimum content length requirement for extraction processing',
      mockHaiku as unknown as HaikuClient
    );
    expect(facts).toHaveLength(0);
  });

  it('should truncate content exceeding max length', async () => {
    mockHaiku.complete.mockResolvedValue('[]');
    const longContent = 'a'.repeat(15000);
    await extractFacts(longContent, mockHaiku as unknown as HaikuClient);
    const callArg = mockHaiku.complete.mock.calls[0][1];
    expect(callArg.length).toBeLessThanOrEqual(10100);
  });

  it('should skip content shorter than min length', async () => {
    const facts = await extractFacts('hi', mockHaiku as unknown as HaikuClient);
    expect(facts).toHaveLength(0);
    expect(mockHaiku.complete).not.toHaveBeenCalled();
  });
});
