/**
 * Unit tests for YAML Frontmatter Parser
 *
 * Story: YAML frontmatter parsing and context-based rule filtering
 */

import { describe, it, expect } from 'vitest';
import { parseFrontmatter, matchesContext } from '../../src/agent/yaml-frontmatter.js';
import type { AppliesTo } from '../../src/agent/yaml-frontmatter.js';

describe('parseFrontmatter()', () => {
  it('should extract applies_to from valid frontmatter', () => {
    const markdown = `---
applies_to:
  agent_id: [dev, reviewer]
  tier: [1, 2]
---
# Rule Content

Some rule text here.
`;
    const result = parseFrontmatter(markdown);
    expect(result.appliesTo).not.toBeNull();
    expect(result.appliesTo!.agentId).toEqual(['dev', 'reviewer']);
    expect(result.appliesTo!.tier).toEqual([1, 2]);
  });

  it('should return appliesTo=null and full content for file without frontmatter', () => {
    const markdown = '# Just a regular markdown file\n\nNo frontmatter here.';
    const result = parseFrontmatter(markdown);
    expect(result.appliesTo).toBeNull();
    expect(result.content).toBe(markdown);
  });

  it('should return appliesTo=null when frontmatter has no applies_to', () => {
    const markdown = `---
title: Some Rule
version: 1.0
---
# Rule Content
`;
    const result = parseFrontmatter(markdown);
    expect(result.appliesTo).toBeNull();
    expect(result.content).toBe('# Rule Content\n');
  });

  it('should return appliesTo=null and log warning for malformed YAML', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const markdown = `---
applies_to: [invalid: yaml: {broken
---
# Content
`;
    const result = parseFrontmatter(markdown);
    expect(result.appliesTo).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[yaml-frontmatter] Malformed YAML frontmatter:')
    );

    warnSpy.mockRestore();
  });

  it('should map snake_case applies_to fields to camelCase (agent_id → agentId)', () => {
    const markdown = `---
applies_to:
  agent_id: [sisyphus]
  channel: [general]
  keywords: [deploy]
---
Content here
`;
    const result = parseFrontmatter(markdown);
    expect(result.appliesTo).not.toBeNull();
    expect(result.appliesTo!.agentId).toEqual(['sisyphus']);
    expect(result.appliesTo!.channel).toEqual(['general']);
    expect(result.appliesTo!.keywords).toEqual(['deploy']);
  });

  it('should strip frontmatter from content', () => {
    const markdown = `---
applies_to:
  agent_id: [dev]
---
# Actual Content

Body text.
`;
    const result = parseFrontmatter(markdown);
    expect(result.content).toBe('# Actual Content\n\nBody text.\n');
    expect(result.content).not.toContain('---');
    expect(result.content).not.toContain('applies_to');
  });

  it('should preserve original content in rawContent', () => {
    const markdown = `---
applies_to:
  agent_id: [dev]
---
# Content
`;
    const result = parseFrontmatter(markdown);
    expect(result.rawContent).toBe(markdown);
    expect(result.rawContent).toContain('---');
    expect(result.rawContent).toContain('applies_to');
  });

  it('should return appliesTo=null when applies_to has only empty arrays', () => {
    const markdown = `---
applies_to:
  agent_id: []
  tier: []
---
# Content
`;
    const result = parseFrontmatter(markdown);
    // Empty arrays are filtered out, so no valid fields → null
    expect(result.appliesTo).toBeNull();
  });

  it('should handle frontmatter with all applies_to fields', () => {
    const markdown = `---
applies_to:
  agent_id: [dev, pm]
  tier: [1, 2, 3]
  channel: [general, dev-chat]
  keywords: [auth, api, deploy]
---
# Full Rule
`;
    const result = parseFrontmatter(markdown);
    expect(result.appliesTo).toEqual({
      agentId: ['dev', 'pm'],
      tier: [1, 2, 3],
      channel: ['general', 'dev-chat'],
      keywords: ['auth', 'api', 'deploy'],
    });
  });
});

describe('matchesContext()', () => {
  it('should return true when appliesTo is null (universal rule)', () => {
    expect(matchesContext(null, { agentId: 'dev' })).toBe(true);
  });

  it('should return true when context is undefined (no filtering)', () => {
    const appliesTo: AppliesTo = { agentId: ['dev'] };
    expect(matchesContext(appliesTo, undefined)).toBe(true);
  });

  it('should match agentId with OR logic', () => {
    const appliesTo: AppliesTo = { agentId: ['dev', 'reviewer'] };
    expect(matchesContext(appliesTo, { agentId: 'dev' })).toBe(true);
    expect(matchesContext(appliesTo, { agentId: 'reviewer' })).toBe(true);
  });

  it('should not match when agentId is not in list', () => {
    const appliesTo: AppliesTo = { agentId: ['dev'] };
    expect(matchesContext(appliesTo, { agentId: 'reviewer' })).toBe(false);
  });

  it('should not match when agentId is required but context has none', () => {
    const appliesTo: AppliesTo = { agentId: ['dev'] };
    expect(matchesContext(appliesTo, {})).toBe(false);
  });

  it('should match tier with OR logic', () => {
    const appliesTo: AppliesTo = { tier: [1, 2] };
    expect(matchesContext(appliesTo, { tier: 1 })).toBe(true);
    expect(matchesContext(appliesTo, { tier: 2 })).toBe(true);
  });

  it('should not match when tier is not in list', () => {
    const appliesTo: AppliesTo = { tier: [1] };
    expect(matchesContext(appliesTo, { tier: 3 })).toBe(false);
  });

  it('should not match when tier is required but context has none', () => {
    const appliesTo: AppliesTo = { tier: [1, 2] };
    expect(matchesContext(appliesTo, {})).toBe(false);
  });

  it('should match channel with OR logic', () => {
    const appliesTo: AppliesTo = { channel: ['ch1', 'ch2'] };
    expect(matchesContext(appliesTo, { channelId: 'ch1' })).toBe(true);
  });

  it('should not match when channelId is not in list', () => {
    const appliesTo: AppliesTo = { channel: ['ch1'] };
    expect(matchesContext(appliesTo, { channelId: 'ch99' })).toBe(false);
  });

  it('should match keywords with OR logic (at least one)', () => {
    const appliesTo: AppliesTo = { keywords: ['auth', 'api'] };
    expect(matchesContext(appliesTo, { keywords: ['auth'] })).toBe(true);
    expect(matchesContext(appliesTo, { keywords: ['api', 'deploy'] })).toBe(true);
  });

  it('should not match when no keywords overlap', () => {
    const appliesTo: AppliesTo = { keywords: ['auth', 'api'] };
    expect(matchesContext(appliesTo, { keywords: ['deploy'] })).toBe(false);
  });

  it('should not match when keywords required but context has none', () => {
    const appliesTo: AppliesTo = { keywords: ['auth'] };
    expect(matchesContext(appliesTo, {})).toBe(false);
    expect(matchesContext(appliesTo, { keywords: [] })).toBe(false);
  });

  it('should use AND across fields — all must match', () => {
    const appliesTo: AppliesTo = { agentId: ['dev'], tier: [1] };

    // Both match
    expect(matchesContext(appliesTo, { agentId: 'dev', tier: 1 })).toBe(true);

    // agentId matches but tier doesn't
    expect(matchesContext(appliesTo, { agentId: 'dev', tier: 2 })).toBe(false);

    // tier matches but agentId doesn't
    expect(matchesContext(appliesTo, { agentId: 'reviewer', tier: 1 })).toBe(false);
  });

  it('should skip fields not present in appliesTo (treat as universal for that field)', () => {
    // Only agentId specified — tier/channel/keywords not checked
    const appliesTo: AppliesTo = { agentId: ['dev'] };
    expect(matchesContext(appliesTo, { agentId: 'dev', tier: 99, channelId: 'any' })).toBe(true);
  });

  it('should return true for both null appliesTo and undefined context', () => {
    expect(matchesContext(null, undefined)).toBe(true);
  });
});
