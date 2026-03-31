import { describe, it, expect } from 'vitest';
import { isNoise, checkNoise, filterNoiseFromUnits } from '../../src/memory/noise-filter.js';
import type { ExtractedMemoryUnit } from '../../src/memory/types.js';

describe('isNoise', () => {
  // ---------- too short ----------
  describe('very short content', () => {
    it('rejects empty string', () => {
      expect(isNoise('')).toBe(true);
      expect(checkNoise('').reason).toBe('too_short');
    });

    it('rejects content under 10 chars', () => {
      expect(isNoise('ok')).toBe(true);
      expect(isNoise('yes')).toBe(true);
      expect(isNoise('   hi   ')).toBe(true); // trimmed = "hi" (2 chars)
    });

    it('allows content at 10+ chars', () => {
      expect(isNoise('some facts here')).toBe(false);
    });
  });

  // ---------- greetings ----------
  describe('greetings', () => {
    it('rejects short English greetings', () => {
      expect(isNoise('hi there')).toBe(true);
      expect(isNoise('Hello!')).toBe(true);
      expect(isNoise('hey whats up')).toBe(true);
      expect(checkNoise('hello world!').reason).toBe('greeting');
    });

    it('rejects short Korean greetings', () => {
      expect(isNoise('안녕 루나')).toBe(true);
      expect(isNoise('하이 반가워')).toBe(true);
      expect(isNoise('ㅎㅇ 뭐해?')).toBe(true);
    });

    it('rejects good morning/afternoon/evening', () => {
      expect(isNoise('good morning!')).toBe(true);
      expect(isNoise('Good Afternoon')).toBe(true);
      expect(isNoise('Good Evening!')).toBe(true);
    });

    it('allows long messages that start with greeting', () => {
      const longGreeting =
        'hello, I wanted to discuss the architecture decision we made last week about the database migration strategy';
      expect(isNoise(longGreeting)).toBe(false);
    });
  });

  // ---------- internal prompts ----------
  describe('internal prompts', () => {
    it('rejects content with INSTRUCTION:', () => {
      expect(isNoise('INSTRUCTION: Call mama_search to find relevant context')).toBe(true);
      expect(checkNoise('INSTRUCTION: do something').reason).toBe('internal_prompt');
    });

    it('rejects content containing mama_search', () => {
      expect(isNoise('use mama_search to find the decision')).toBe(true);
    });

    it('rejects content containing mama_save', () => {
      expect(isNoise('then call mama_save with the topic')).toBe(true);
    });

    it('rejects content containing tool_call', () => {
      expect(isNoise('executing tool_call for memory lookup')).toBe(true);
    });

    it('rejects content containing pendingResolve', () => {
      expect(isNoise('state is pendingResolve waiting for callback')).toBe(true);
    });
  });

  // ---------- duplicate detection ----------
  describe('duplicate detection', () => {
    it('rejects exact duplicate summary (case-insensitive)', () => {
      const existing = new Set(['The project uses SQLite for storage']);
      expect(isNoise('the project uses sqlite for storage', existing)).toBe(true);
      expect(checkNoise('the project uses sqlite for storage', existing).reason).toBe('duplicate');
    });

    it('allows non-duplicate content', () => {
      const existing = new Set(['The project uses SQLite for storage']);
      expect(isNoise('The project also uses Redis for caching', existing)).toBe(false);
    });

    it('works with empty existing set', () => {
      expect(isNoise('some valid content here', new Set())).toBe(false);
    });
  });

  // ---------- valid content passes ----------
  describe('valid content passes through', () => {
    it('allows meaningful decisions', () => {
      expect(isNoise('We decided to use pnpm workspaces for the monorepo')).toBe(false);
    });

    it('allows technical facts', () => {
      expect(
        isNoise('The embedding model is Xenova/multilingual-e5-small with 384 dimensions')
      ).toBe(false);
    });

    it('allows user preferences', () => {
      expect(isNoise('User prefers dark mode and compact layout')).toBe(false);
    });

    it('allows Korean content that is not a greeting', () => {
      expect(isNoise('프로젝트 구조를 모노레포로 변경하기로 결정했습니다')).toBe(false);
    });
  });
});

describe('filterNoiseFromUnits', () => {
  const makeUnit = (summary: string, details = ''): ExtractedMemoryUnit => ({
    kind: 'fact',
    topic: 'test_topic',
    summary,
    details: details || summary,
    confidence: 0.8,
  });

  it('removes noise units from the array', () => {
    const units = [
      makeUnit('We decided to use TypeScript for type safety'),
      makeUnit('hi there'),
      makeUnit('INSTRUCTION: Call mama_search for context'),
      makeUnit('Database uses SQLite with FTS5 indexing'),
    ];

    const filtered = filterNoiseFromUnits(units);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].summary).toBe('We decided to use TypeScript for type safety');
    expect(filtered[1].summary).toBe('Database uses SQLite with FTS5 indexing');
  });

  it('returns all units when none are noise', () => {
    const units = [
      makeUnit('Architecture uses event sourcing pattern'),
      makeUnit('Deploy target is Fly.io with auto-scaling'),
    ];

    const filtered = filterNoiseFromUnits(units);
    expect(filtered).toHaveLength(2);
  });

  it('returns empty array when all are noise', () => {
    const units = [makeUnit('hi'), makeUnit('ok'), makeUnit('mama_save called')];

    const filtered = filterNoiseFromUnits(units);
    expect(filtered).toHaveLength(0);
  });

  it('supports existing summaries for dedup', () => {
    const units = [makeUnit('We use pnpm workspaces'), makeUnit('Deploy to Fly.io')];
    const existing = new Set(['We use pnpm workspaces']);

    const filtered = filterNoiseFromUnits(units, existing);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].summary).toBe('Deploy to Fly.io');
  });
});
