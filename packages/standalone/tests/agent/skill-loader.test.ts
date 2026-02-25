/**
 * Unit tests for SkillLoader — section-based truncation (STORY-010)
 *
 * Uses forceFallbackMode() for deterministic token counts.
 * Fallback: countTokens(text) = Math.ceil(byteLength * 0.4)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseSkillSections,
  truncateSkillBySections,
  parseSkillFrontmatter,
} from '../../src/agent/skill-loader.js';
import { forceFallbackMode, resetTokenEstimator } from '../../src/agent/token-estimator.js';

describe('SkillLoader', () => {
  beforeEach(() => {
    resetTokenEstimator();
    forceFallbackMode();
  });

  describe('parseSkillFrontmatter()', () => {
    it('should parse name and description', () => {
      const content = '---\nname: my-skill\ndescription: A test skill\n---\n# Body';
      const fm = parseSkillFrontmatter(content);
      expect(fm.name).toBe('my-skill');
      expect(fm.description).toBe('A test skill');
    });

    it('should parse keywords list', () => {
      const content = '---\nname: test\ndescription: desc\nkeywords:\n  - foo\n  - bar\n---\n';
      const fm = parseSkillFrontmatter(content);
      expect(fm.keywords).toEqual(['foo', 'bar']);
    });

    it('should return empty values for no frontmatter', () => {
      const fm = parseSkillFrontmatter('# Just a heading\nSome content');
      expect(fm.name).toBe('');
      expect(fm.keywords).toEqual([]);
    });
  });

  describe('parseSkillSections()', () => {
    it('should extract frontmatter as priority 1', () => {
      const content = '---\nname: test\n---\n\n## Overview\nSome content';
      const sections = parseSkillSections(content);
      expect(sections[0].name).toBe('frontmatter');
      expect(sections[0].priority).toBe(1);
    });

    it('should split on ## headings', () => {
      const content = '## Overview\nFirst section\n\n## Examples\nSecond section';
      const sections = parseSkillSections(content);
      expect(sections).toHaveLength(2);
      expect(sections[0].name).toBe('Overview');
      expect(sections[1].name).toBe('Examples');
    });

    it('should classify core sections as priority 2', () => {
      const content = '## Usage\nHow to use\n\n## API Reference\nEndpoints';
      const sections = parseSkillSections(content);
      expect(sections[0].priority).toBe(2); // usage = core
    });

    it('should classify example sections as priority 3', () => {
      const content = '## Examples\nSome examples\n\n## Demo\nDemo content';
      const sections = parseSkillSections(content);
      expect(sections[0].priority).toBe(3); // examples
      expect(sections[1].priority).toBe(3); // demo
    });

    it('should classify appendix sections as priority 4', () => {
      const content = '## Appendix\nExtra info\n\n## Troubleshooting\nFix stuff';
      const sections = parseSkillSections(content);
      expect(sections[0].priority).toBe(4); // appendix
      expect(sections[1].priority).toBe(4); // troubleshooting
    });

    it('should handle content without headings', () => {
      const content = 'Just plain text without any headings.';
      const sections = parseSkillSections(content);
      expect(sections.length).toBeGreaterThan(0);
      expect(sections[0].name).toBe('content');
    });

    it('should count tokens per section', () => {
      // 'Hello' = 5 bytes → Math.ceil(5 * 0.4) = 2 tokens
      const content = '## Intro\nHello';
      const sections = parseSkillSections(content);
      expect(sections[0].tokens).toBeGreaterThan(0);
    });
  });

  describe('truncateSkillBySections()', () => {
    it('should return content unchanged when under budget', () => {
      const content = '## Overview\nShort content';
      const result = truncateSkillBySections(content, 1000);
      expect(result.truncated).toBe(false);
      expect(result.omittedSections).toEqual([]);
      expect(result.content).toContain('Short content');
    });

    it('should omit lowest priority sections first', () => {
      // Build a skill that's over budget
      // Each 'x'.repeat(100) → 40 tokens in fallback
      const content = [
        '---\nname: test\n---',
        '## Overview',
        'x'.repeat(100), // core (priority 2) → 40 tokens
        '## Examples',
        'y'.repeat(100), // examples (priority 3) → 40 tokens
        '## Troubleshooting',
        'z'.repeat(100), // appendix (priority 4) → 40 tokens
      ].join('\n\n');

      // Budget of 80 tokens: frontmatter + overview fit, troubleshooting should be dropped first
      const result = truncateSkillBySections(content, 80);
      expect(result.truncated).toBe(true);
      expect(result.omittedSections).toContain('Troubleshooting');
    });

    it('should preserve frontmatter (priority 1)', () => {
      const content = [
        '---\nname: keep-me\n---',
        '## Appendix',
        'z'.repeat(200), // big low-priority section
      ].join('\n\n');

      const result = truncateSkillBySections(content, 50);
      expect(result.content).toContain('name: keep-me');
    });

    it('should append [Omitted: ...] marker', () => {
      const content = ['## Overview', 'x'.repeat(100), '## FAQ', 'y'.repeat(100)].join('\n\n');

      const result = truncateSkillBySections(content, 50);
      expect(result.truncated).toBe(true);
      expect(result.content).toContain('[Omitted:');
    });

    it('should never cut mid-section', () => {
      const sectionContent = 'This is a complete paragraph that should not be split.';
      const content = ['## Overview', sectionContent, '## Examples', 'y'.repeat(200)].join('\n\n');

      const result = truncateSkillBySections(content, 50);
      // Either the section is fully included or fully omitted
      if (result.content.includes('complete paragraph')) {
        expect(result.content).toContain(sectionContent);
      }
    });

    it('should report omitted section names', () => {
      const content = [
        '## Usage',
        'x'.repeat(100),
        '## Demo',
        'y'.repeat(100),
        '## Changelog',
        'z'.repeat(100),
      ].join('\n\n');

      const result = truncateSkillBySections(content, 80);
      expect(result.omittedSections.length).toBeGreaterThan(0);
      // Changelog (priority 4) and Demo (priority 3) more likely to be omitted before Usage (priority 2)
      if (result.omittedSections.length >= 2) {
        expect(result.omittedSections).toContain('Changelog');
      }
    });

    it('should track originalChars', () => {
      const content = 'x'.repeat(500);
      const result = truncateSkillBySections(content, 50);
      expect(result.originalChars).toBe(500);
    });
  });
});
