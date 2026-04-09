import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getWikiTree,
  readWikiPage,
  writeWikiPage,
  deleteWikiPage,
} from '../../src/api/wiki-handler.js';

let wikiPath: string;

describe('Wiki handler', () => {
  beforeEach(() => {
    wikiPath = mkdtempSync(join(tmpdir(), 'wiki-handler-'));
    mkdirSync(join(wikiPath, 'projects'), { recursive: true });
    mkdirSync(join(wikiPath, 'lessons'), { recursive: true });
    writeFileSync(join(wikiPath, 'index.md'), '---\ntitle: Index\n---\n# Wiki Index\n', 'utf8');
    writeFileSync(
      join(wikiPath, 'projects', 'ProjectAlpha.md'),
      '---\ntitle: ProjectAlpha\ntype: entity\n---\n# ProjectAlpha\n\n## Status\n\nIn progress.',
      'utf8'
    );
  });

  afterEach(() => {
    rmSync(wikiPath, { recursive: true, force: true });
  });

  describe('getWikiTree', () => {
    it('returns directory tree with files', () => {
      const tree = getWikiTree(wikiPath);
      expect(tree).toContainEqual(expect.objectContaining({ name: 'index.md', type: 'file' }));
      const projects = tree.find((n) => n.name === 'projects');
      expect(projects?.type).toBe('directory');
      expect(projects?.children).toContainEqual(
        expect.objectContaining({ name: 'ProjectAlpha.md', type: 'file' })
      );
    });

    it('skips hidden directories', () => {
      mkdirSync(join(wikiPath, '.obsidian'));
      writeFileSync(join(wikiPath, '.obsidian', 'config.json'), '{}');
      const tree = getWikiTree(wikiPath);
      expect(tree.find((n) => n.name === '.obsidian')).toBeUndefined();
    });
  });

  describe('readWikiPage', () => {
    it('reads page content and parses frontmatter', () => {
      const result = readWikiPage(wikiPath, 'projects/ProjectAlpha.md');
      expect(result?.frontmatter.title).toBe('ProjectAlpha');
      expect(result?.frontmatter.type).toBe('entity');
      expect(result?.content).toContain('# ProjectAlpha');
      expect(result?.raw).toContain('---');
    });

    it('returns null for non-existent page', () => {
      expect(readWikiPage(wikiPath, 'nonexistent.md')).toBeNull();
    });

    it('rejects path traversal', () => {
      expect(() => readWikiPage(wikiPath, '../../../etc/passwd')).toThrow();
    });
  });

  describe('writeWikiPage', () => {
    it('writes new page', () => {
      writeWikiPage(wikiPath, 'projects/NewProject.md', '# New\n\nContent.');
      const content = readFileSync(join(wikiPath, 'projects', 'NewProject.md'), 'utf8');
      expect(content).toContain('# New');
    });

    it('creates intermediate directories', () => {
      writeWikiPage(wikiPath, 'knowledge/processes/deploy.md', '# Deploy');
      const content = readFileSync(join(wikiPath, 'knowledge', 'processes', 'deploy.md'), 'utf8');
      expect(content).toContain('# Deploy');
    });

    it('rejects path traversal', () => {
      expect(() => writeWikiPage(wikiPath, '../escape.md', 'bad')).toThrow();
    });
  });

  describe('deleteWikiPage', () => {
    it('deletes existing page', () => {
      deleteWikiPage(wikiPath, 'projects/ProjectAlpha.md');
      expect(readWikiPage(wikiPath, 'projects/ProjectAlpha.md')).toBeNull();
    });

    it('is no-op for non-existent page', () => {
      expect(() => deleteWikiPage(wikiPath, 'ghost.md')).not.toThrow();
    });
  });
});
