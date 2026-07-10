import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from 'fs';
import { join, dirname, basename, posix } from 'path';
import type { WikiPage } from './types.js';
import { normalizeWikiPagePath } from './path-safety.js';

const HUMAN_MARKER = '<!-- human -->';
const FRONTMATTER_LIST_UNSAFE_PATTERN = /[\r\n]/;

function frontmatterScalar(value: string, field: string): string {
  if (value.includes('\0')) {
    throw new Error(`${field} contains characters that cannot be safely written to frontmatter`);
  }
  return JSON.stringify(value);
}

function frontmatterListItem(value: string, field: string): string {
  if (value.includes('\0') || FRONTMATTER_LIST_UNSAFE_PATTERN.test(value)) {
    throw new Error(`${field} contains characters that cannot be safely written to frontmatter`);
  }
  return JSON.stringify(value);
}

function parseFrontmatterScalar(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch {
    // Legacy wiki pages wrote unquoted scalars. Keep matching those pages.
  }
  return value;
}

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
    const pageDir = posix.dirname(page.path);
    const dir = join(this.wikiPath, pageDir);
    if (!existsSync(dir)) return null;

    const targetSlug = slugify(posix.basename(page.path, '.md'));
    const targetTitle = page.title.toLowerCase();

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const fileSlug = slugify(basename(file, '.md'));

      // Exact slug match (case-insensitive)
      if (fileSlug === targetSlug) {
        return posix.join(pageDir, file);
      }

      // Title match: read frontmatter and compare
      try {
        const content = readFileSync(join(dir, file), 'utf8');
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        if (titleMatch) {
          const existingTitle = parseFrontmatterScalar(titleMatch[1].trim()).toLowerCase();
          // Loose match: one title contains the other, or they share >60% of words
          if (
            existingTitle.includes(targetTitle) ||
            targetTitle.includes(existingTitle) ||
            titleWordOverlap(existingTitle, targetTitle) > 0.6
          ) {
            return posix.join(pageDir, file);
          }
        }
      } catch {
        // Can't read file, skip
      }
    }
    return null;
  }

  ensureDirectories(): void {
    // v5 wiki layout: daily journal + lesson subfolders. writePage() still
    // accepts any relative path, so legacy pages keep working.
    for (const sub of [
      '',
      'daily',
      'lessons',
      'lessons/clients',
      'lessons/process',
      'lessons/system',
    ]) {
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

  writePage(page: WikiPage): string {
    const safePage = { ...page, path: normalizeWikiPagePath(page.path) };
    // Dedup: check if a similar page already exists in the same directory
    const existingPath = this.findExistingPage(safePage);
    const effectivePath = existingPath || safePage.path;

    const filePath = join(this.wikiPath, effectivePath);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Strip duplicate frontmatter from LLM-generated content
    let cleanContent = safePage.content;
    if (cleanContent.trimStart().startsWith('---')) {
      cleanContent = cleanContent.replace(/^[\s]*---[\s\S]*?---[\s]*/, '').trimStart();
    }
    // Strip duplicate title heading if it matches page title
    const titlePrefix = `# ${safePage.title}`;
    if (cleanContent.startsWith(titlePrefix)) {
      cleanContent = cleanContent.slice(titlePrefix.length).trimStart();
    }

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
      `title: ${frontmatterScalar(safePage.title, 'title')}`,
      `type: ${frontmatterScalar(safePage.type, 'type')}`,
      `confidence: ${frontmatterScalar(safePage.confidence, 'confidence')}`,
      `compiled_at: ${frontmatterScalar(safePage.compiledAt, 'compiledAt')}`,
      ...(safePage.sourceRefs && safePage.sourceRefs.length > 0
        ? [
            'source_refs:',
            ...safePage.sourceRefs.map((ref) => `  - ${frontmatterListItem(ref, 'sourceRefs')}`),
          ]
        : []),
      `source_ids:`,
      ...safePage.sourceIds.map((id) => `  - ${frontmatterListItem(id, 'sourceIds')}`),
      '---',
    ].join('\n');

    let body = `${frontmatter}\n\n# ${safePage.title}\n\n${cleanContent}`;
    if (humanSection) {
      body += '\n\n' + humanSection;
    }

    writeFileSync(filePath, body, 'utf8');
    return effectivePath;
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
      const safePage = { ...p, path: normalizeWikiPagePath(p.path) };
      const list = byType.get(safePage.type) || [];
      list.push(safePage);
      byType.set(safePage.type, list);
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
