import { describe, it, expect } from 'vitest';
import { resolveMemoryEvolution } from '../../src/memory/evolution-engine.js';

describe('evolution engine', () => {
  it('should choose supersedes for same-topic replacement', () => {
    const result = resolveMemoryEvolution({
      incoming: { topic: 'auth_strategy', summary: 'Use sessions' },
      existing: [{ id: 'old', topic: 'auth_strategy', summary: 'Use JWT' }],
    });

    expect(result.edges[0]?.type).toBe('supersedes');
  });
});
