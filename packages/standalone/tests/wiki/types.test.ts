import { describe, expect, it } from 'vitest';
import type { WikiPage, WikiConfig } from '../../src/wiki/types.js';
import { WIKI_PAGE_TYPES, isValidPageType } from '../../src/wiki/types.js';

describe('Wiki types', () => {
  it('defines page types', () => {
    expect(WIKI_PAGE_TYPES).toContain('entity');
    expect(WIKI_PAGE_TYPES).toContain('lesson');
    expect(WIKI_PAGE_TYPES).toContain('synthesis');
    expect(WIKI_PAGE_TYPES).toContain('process');
  });

  it('validates page types', () => {
    expect(isValidPageType('entity')).toBe(true);
    expect(isValidPageType('garbage')).toBe(false);
  });

  it('WikiPage interface is assignable', () => {
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: '# ProjectAlpha\n\nProject page.',
      sourceIds: ['decision_123'],
      compiledAt: new Date().toISOString(),
      confidence: 'high',
    };
    expect(page.title).toBe('ProjectAlpha');
  });

  it('WikiConfig interface is assignable', () => {
    const config: WikiConfig = {
      vaultPath: '/Users/test/vault',
      wikiDir: 'wiki',
      enabled: true,
    };
    expect(config.vaultPath).toBe('/Users/test/vault');
  });
});
