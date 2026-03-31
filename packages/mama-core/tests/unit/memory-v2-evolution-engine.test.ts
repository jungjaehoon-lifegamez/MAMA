import { describe, it, expect } from 'vitest';
import { resolveMemoryEvolution } from '../../src/memory/evolution-engine.js';

describe('evolution engine', () => {
  it('should supersede when same topic and high summary overlap', () => {
    const result = resolveMemoryEvolution({
      incoming: {
        topic: 'auth_strategy',
        summary: 'Use JWT with refresh tokens and 1h expiry',
        kind: 'decision',
      },
      existing: [
        {
          id: 'old',
          topic: 'auth_strategy',
          summary: 'Use JWT with refresh tokens',
          kind: 'decision',
        },
      ],
    });

    expect(result.edges[0]?.type).toBe('supersedes');
  });

  it('should builds_on when same topic but different content', () => {
    const result = resolveMemoryEvolution({
      incoming: { topic: 'auth_strategy', summary: 'Use sessions for web app', kind: 'decision' },
      existing: [
        { id: 'old', topic: 'auth_strategy', summary: 'Use JWT for mobile API', kind: 'decision' },
      ],
    });

    expect(result.edges[0]?.type).toBe('builds_on');
  });

  it('should supersede when raw conversation replaced by extracted fact', () => {
    const result = resolveMemoryEvolution({
      incoming: { topic: 'user_cat_luna', summary: 'User has a cat named Luna', kind: 'fact' },
      existing: [
        {
          id: 'raw',
          topic: 'user_cat_luna',
          summary: 'user: I have a cat named Luna\nassistant: Nice!',
          kind: 'fact',
        },
      ],
    });

    expect(result.edges[0]?.type).toBe('supersedes');
  });
});
