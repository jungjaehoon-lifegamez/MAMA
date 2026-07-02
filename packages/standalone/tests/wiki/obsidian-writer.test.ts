import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObsidianWriter } from '../../src/wiki/obsidian-writer.js';
import type { WikiPage } from '../../src/wiki/types.js';

let tempDir: string;
let wikiDir: string;

describe('ObsidianWriter', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'obsidian-writer-test-'));
    wikiDir = join(tempDir, 'wiki');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates wiki directory if not exists', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    expect(readFileSync(join(wikiDir, 'index.md'), 'utf8')).toContain('# Wiki Index');
  });

  it('writes a page with frontmatter', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: '## Current Status\n\nIn progress.',
      sourceIds: ['d_123', 'd_456'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };
    writer.writePage(page);

    const content = readFileSync(join(wikiDir, 'projects', 'ProjectAlpha.md'), 'utf8');
    expect(content).toContain('---');
    expect(content).toContain('title: "ProjectAlpha"');
    expect(content).toContain('type: "entity"');
    expect(content).toContain('confidence: "high"');
    expect(content).toContain('source_ids:');
    expect(content).toContain('  - "d_123"');
    expect(content).toContain('## Current Status');
  });

  it('quotes frontmatter scalars that YAML could otherwise reinterpret', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha: true # comment',
      type: 'entity',
      content: 'Content.',
      sourceIds: ['d_123: # comment'],
      sourceRefs: ['raw:slack:event-1'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };

    writer.writePage(page);

    const content = readFileSync(join(wikiDir, 'projects', 'ProjectAlpha.md'), 'utf8');
    expect(content).toContain('title: "ProjectAlpha: true # comment"');
    expect(content).toContain('  - "d_123: # comment"');
    expect(content).toContain('  - "raw:slack:event-1"');
  });

  it('rejects source refs that would inject frontmatter keys', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: 'Content.',
      sourceIds: ['d_123'],
      sourceRefs: ['decision:d_123\ninjected: true'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };

    expect(() => writer.writePage(page)).toThrow(/frontmatter/i);
  });

  it('rejects page paths that would escape the wiki directory', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: '../outside.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: 'Content.',
      sourceIds: ['d_123'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };

    expect(() => writer.writePage(page)).toThrow(/parent-directory/i);
  });

  it('rejects generated pages that would overwrite reserved wiki files', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'index.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: 'Content.',
      sourceIds: ['d_123'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };

    expect(() => writer.writePage(page)).toThrow(/reserved wiki files/i);
  });

  it('rejects generated pages that target reserved wiki directories', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'projects',
      title: 'ProjectAlpha',
      type: 'entity',
      content: 'Content.',
      sourceIds: ['d_123'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };

    expect(() => writer.writePage(page)).toThrow(/reserved wiki directories/i);
  });

  it('updates existing page preserving human sections', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: '## Status\n\nDraft.',
      sourceIds: ['d_123'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'medium',
    };
    writer.writePage(page);

    const filePath = join(wikiDir, 'projects', 'ProjectAlpha.md');
    const existing = readFileSync(filePath, 'utf8');
    writeFileSync(
      filePath,
      existing + '\n\n<!-- human -->\n## My Notes\n\nImportant context.\n',
      'utf8'
    );

    const updated: WikiPage = {
      ...page,
      content: '## Status\n\nCompleted!',
      compiledAt: '2026-04-08T14:00:00Z',
      confidence: 'high',
    };
    writer.writePage(updated);

    const result = readFileSync(filePath, 'utf8');
    expect(result).toContain('## Status\n\nCompleted!');
    expect(result).toContain('## My Notes');
    expect(result).toContain('Important context.');
  });

  it('appends to log.md', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    writer.appendLog('compile', 'Compiled 3 entity pages for ProjectAlpha');

    const log = readFileSync(join(wikiDir, 'log.md'), 'utf8');
    expect(log).toContain('compile');
    expect(log).toContain('Compiled 3 entity pages');
  });

  it('updates index.md', () => {
    const writer = new ObsidianWriter(tempDir, 'wiki');
    writer.ensureDirectories();
    const page: WikiPage = {
      path: 'projects/ProjectAlpha.md',
      title: 'ProjectAlpha',
      type: 'entity',
      content: 'Content.',
      sourceIds: ['d_1'],
      compiledAt: '2026-04-08T12:00:00Z',
      confidence: 'high',
    };
    writer.writePage(page);
    writer.updateIndex([page]);

    const index = readFileSync(join(wikiDir, 'index.md'), 'utf8');
    expect(index).toContain('[[projects/ProjectAlpha|ProjectAlpha]]');
    expect(index).toContain('entity');
  });
});
