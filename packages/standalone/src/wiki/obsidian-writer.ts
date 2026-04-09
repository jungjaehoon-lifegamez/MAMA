import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import type { WikiPage } from './types.js';

const HUMAN_MARKER = '<!-- human -->';

/** Word overlap ratio between two titles. Returns 0-1. */
function titleWordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(/[\s/\-_,]+/).filter(Boolean));
  const wordsB = new Set(b.split(/[\s/\-_,]+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/**
 * Normalize a page path for dedup: lowercase, strip accents, collapse separators.
 * "Project-Name.md" and "project-name.md" won't match by slug alone,
 * so we also do title-based matching in findExistingPage().
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u3000-\u9fff\uac00-\ud7af]+/g, '-')
    .replace(/^-|-$/g, '');
}

export class ObsidianWriter {
  private readonly wikiPath: string;

  constructor(vaultPath: string, wikiDir: string = 'wiki') {
    this.wikiPath = join(vaultPath, wikiDir);
  }

  /**
   * Find an existing page with a matching title in the same directory.
   * Prevents duplicates when LLM generates different filenames for the same entity.
   */
  private findExistingPage(page: WikiPage): string | null {
    const dir = join(this.wikiPath, dirname(page.path));
    if (!existsSync(dir)) return null;

    const targetSlug = slugify(basename(page.path, '.md'));
    const targetTitle = page.title.toLowerCase();

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const fileSlug = slugify(basename(file, '.md'));

      // Exact slug match (case-insensitive)
      if (fileSlug === targetSlug) {
        return join(dirname(page.path), file);
      }

      // Title match: read frontmatter and compare
      try {
        const content = readFileSync(join(dir, file), 'utf8');
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        if (titleMatch) {
          const existingTitle = titleMatch[1].trim().toLowerCase();
          // Loose match: one title contains the other, or they share >60% of words
          if (
            existingTitle.includes(targetTitle) ||
            targetTitle.includes(existingTitle) ||
            titleWordOverlap(existingTitle, targetTitle) > 0.6
          ) {
            return join(dirname(page.path), file);
          }
        }
      } catch {
        // Can't read file, skip
      }
    }
    return null;
  }

  ensureDirectories(): void {
    for (const sub of ['', 'projects', 'lessons', 'synthesis']) {
      const dir = join(this.wikiPath, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const indexPath = join(this.wikiPath, 'index.md');
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, '# Wiki Index\n\nAuto-compiled by MAMA.\n\n## Pages\n\n', 'utf8');
    }
    const logPath = join(this.wikiPath, 'log.md');
    if (!existsSync(logPath)) {
      writeFileSync(logPath, '# Compilation Log\n\n', 'utf8');
    }
  }

  writePage(page: WikiPage): void {
    // Dedup: check if a similar page already exists in the same directory
    const existingPath = this.findExistingPage(page);
    const effectivePath = existingPath || page.path;

    const filePath = join(this.wikiPath, effectivePath);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let humanSection = '';
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8');
      const markerIdx = existing.indexOf(HUMAN_MARKER);
      if (markerIdx !== -1) {
        humanSection = existing.slice(markerIdx);
      }
    }

    const frontmatter = [
      '---',
      `title: ${page.title}`,
      `type: ${page.type}`,
      `confidence: ${page.confidence}`,
      `compiled_at: ${page.compiledAt}`,
      `source_ids:`,
      ...page.sourceIds.map((id) => `  - ${id}`),
      '---',
    ].join('\n');

    let body = `${frontmatter}\n\n# ${page.title}\n\n${page.content}`;
    if (humanSection) {
      body += '\n\n' + humanSection;
    }

    writeFileSync(filePath, body, 'utf8');
  }

  appendLog(action: string, message: string): void {
    const logPath = join(this.wikiPath, 'log.md');
    const date = new Date().toISOString().split('T')[0];
    const entry = `## [${date}] ${action} | ${message}\n\n`;
    appendFileSync(logPath, entry, 'utf8');
  }

  updateIndex(pages: WikiPage[]): void {
    const indexPath = join(this.wikiPath, 'index.md');
    const lines = ['# Wiki Index\n', 'Auto-compiled by MAMA.\n', '## Pages\n'];

    const byType = new Map<string, WikiPage[]>();
    for (const p of pages) {
      const list = byType.get(p.type) || [];
      list.push(p);
      byType.set(p.type, list);
    }

    for (const [type, typePages] of byType) {
      lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}\n`);
      for (const p of typePages) {
        const link = p.path.replace(/\.md$/, '');
        lines.push(`- [[${link}|${p.title}]] — ${p.type}, confidence: ${p.confidence}`);
      }
      lines.push('');
    }

    writeFileSync(indexPath, lines.join('\n'), 'utf8');
  }

  getWikiPath(): string {
    return this.wikiPath;
  }
}
