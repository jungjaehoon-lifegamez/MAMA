import { describe, expect, it } from 'vitest';

import { buildAgentSituationCacheKey } from '../../src/agent-situation/cache-key.js';

const BASE_INPUT = {
  scopes: [
    { kind: 'project' as const, id: 'repo-b' },
    { kind: 'project' as const, id: 'repo-a' },
  ],
  connectors: ['slack', 'github'],
  project_refs: [
    { kind: 'project' as const, id: 'repo-b' },
    { kind: 'project' as const, id: 'repo-a' },
  ],
  tenant_id: 'default',
  range_start_ms: 1_800_000,
  range_end_ms: 2_800_000,
  focus: ['risks' as const, 'decisions' as const],
  limit: 7,
  as_of: '2026-04-29T00:00:00.000Z',
  ranking_policy_version: 'agent_situation.v0',
};

describe('Story M5: Agent situation cache key', () => {
  describe('AC #1: canonical effective filters', () => {
    it('keeps equivalent scope, connector, project, and focus order on the same key', () => {
      const left = buildAgentSituationCacheKey(BASE_INPUT);
      const right = buildAgentSituationCacheKey({
        ...BASE_INPUT,
        scopes: [...BASE_INPUT.scopes].reverse(),
        connectors: [...BASE_INPUT.connectors].reverse(),
        project_refs: [...BASE_INPUT.project_refs].reverse(),
        focus: [...BASE_INPUT.focus].reverse(),
      });

      expect(right.cacheKey).toBe(left.cacheKey);
      expect(right.scopeHash).toBe(left.scopeHash);
      expect(right.filtersHash).toBe(left.filtersHash);
    });

    it('deduplicates equivalent scopes and project refs before hashing', () => {
      const baseline = buildAgentSituationCacheKey(BASE_INPUT);
      const withDuplicates = buildAgentSituationCacheKey({
        ...BASE_INPUT,
        scopes: [
          ...BASE_INPUT.scopes,
          { kind: 'project' as const, id: 'repo-a' },
          { kind: 'project' as const, id: ' repo-b ' },
        ],
        project_refs: [
          ...BASE_INPUT.project_refs,
          { kind: 'project' as const, id: 'repo-a' },
          { kind: 'project' as const, id: ' repo-b ' },
        ],
      });

      expect(withDuplicates.cacheKey).toBe(baseline.cacheKey);
      expect(withDuplicates.scopeHash).toBe(baseline.scopeHash);
      expect(withDuplicates.filtersHash).toBe(baseline.filtersHash);
      expect(withDuplicates.canonicalInput.scopes).toEqual([
        { kind: 'project', id: 'repo-a' },
        { kind: 'project', id: 'repo-b' },
      ]);
      expect(withDuplicates.canonicalInput.project_refs).toEqual([
        { kind: 'project', id: 'repo-a' },
        { kind: 'project', id: 'repo-b' },
      ]);
    });
  });

  describe('AC #2: key dimensions', () => {
    it('changes when range, as_of, limit, or ranking policy changes', () => {
      const baseline = buildAgentSituationCacheKey(BASE_INPUT).cacheKey;

      expect(
        buildAgentSituationCacheKey({ ...BASE_INPUT, range_start_ms: 1_900_000 }).cacheKey
      ).not.toBe(baseline);
      expect(
        buildAgentSituationCacheKey({ ...BASE_INPUT, range_end_ms: 2_900_000 }).cacheKey
      ).not.toBe(baseline);
      expect(buildAgentSituationCacheKey({ ...BASE_INPUT, limit: 8 }).cacheKey).not.toBe(baseline);
      expect(
        buildAgentSituationCacheKey({
          ...BASE_INPUT,
          as_of: '2026-04-29T01:00:00.000Z',
        }).cacheKey
      ).not.toBe(baseline);
      expect(
        buildAgentSituationCacheKey({
          ...BASE_INPUT,
          ranking_policy_version: 'agent_situation.v1',
        }).cacheKey
      ).not.toBe(baseline);
    });

    it('includes envelope-effective filters in the canonical input', () => {
      const first = buildAgentSituationCacheKey(BASE_INPUT);
      const second = buildAgentSituationCacheKey({
        ...BASE_INPUT,
        connectors: ['slack'],
      });

      expect(second.cacheKey).not.toBe(first.cacheKey);
      expect(second.filtersHash).not.toBe(first.filtersHash);
      expect(first.canonicalInput).toMatchObject({
        connectors: ['github', 'slack'],
        focus: ['decisions', 'risks'],
        limit: 7,
        tenant_id: 'default',
      });
    });
  });
});
