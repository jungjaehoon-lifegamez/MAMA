import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  copyFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'fs';
import { join, dirname, basename, posix, relative } from 'path';
import type { WikiPage } from './types.js';
import { normalizeWikiPagePath } from './path-safety.js';
import { readWikiPageVersion, WIKI_HUMAN_MARKER } from './wiki-read.js';

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
 * A daily journal page (`daily/YYYY-MM-DD.md`). Its identity is the exact
 * normalized path, never a fuzzy title match: date tokens overlap above the
 * title threshold (2026-08-09 vs 2026-09-04 share "2026" and "09"), which once
 * stored a 2026-09-04 note into daily/2026-08-09.md.
 */
const DAILY_PAGE_PATTERN = /^daily\/\d{4}-\d{2}-\d{2}\.md$/;

function isDailyPagePath(normalizedPath: string): boolean {
  return DAILY_PAGE_PATTERN.test(normalizedPath);
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
    // index.md/log.md are NOT bootstrapped here: in the v5 layout the agent owns
    // the root (Home.md). updateIndex()/appendLog() create them on demand when
    // the wiki_publish fallback path is actually used.
  }

  writePage(page: WikiPage, options?: { exactPath?: boolean }): string {
    const safePage = { ...page, path: normalizeWikiPagePath(page.path) };
    // Dedup: check if a similar page already exists in the same directory. A
    // daily journal page has identity by exact normalized path only - fuzzy
    // title/slug matching must never fold one date onto another.
    const existingPath =
      options?.exactPath || isDailyPagePath(safePage.path) ? null : this.findExistingPage(safePage);
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

    const incomingMarkerIdx = cleanContent.indexOf(WIKI_HUMAN_MARKER);
    if (incomingMarkerIdx !== -1) {
      cleanContent = cleanContent.slice(0, incomingMarkerIdx).trimEnd();
    }

    let humanSection = '';
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8');
      const markerIdx = existing.indexOf(WIKI_HUMAN_MARKER);
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

  /**
   * Stage every scheduled page before activation and roll back a failed activation.
   * This keeps a later page error from leaving an earlier daily/lesson page durable while
   * the workorder is retried.
   */
  writePagesAtomically(
    pages: readonly (WikiPage & { expectedContentVersion?: string | null })[]
  ): string[] {
    if (pages.length === 0) {
      return [];
    }
    const stagingRoot = mkdtempSync(join(this.wikiPath, '.mama-publish-'));
    const stagedWriter = new ObsidianWriter(stagingRoot, '.');
    const prepared: Array<{
      path: string;
      target: string;
      staged: string;
      backup: string;
      existed: boolean;
      expectedContentVersion: string | null;
    }> = [];
    const activated: typeof prepared = [];
    let preserveRecovery = false;
    try {
      stagedWriter.ensureDirectories();
      for (const page of pages) {
        const path = normalizeWikiPagePath(page.path);
        const target = join(this.wikiPath, path);
        const staged = join(stagingRoot, path);
        const backup = join(stagingRoot, '.backup', path);
        const existed = existsSync(target);
        if (page.expectedContentVersion === undefined) {
          throw new Error(`atomic wiki page ${path} requires expectedContentVersion`);
        }
        mkdirSync(dirname(staged), { recursive: true });
        if (existed) {
          copyFileSync(target, staged);
          mkdirSync(dirname(backup), { recursive: true });
          copyFileSync(target, backup);
        }
        stagedWriter.writePage({ ...page, path }, { exactPath: true });
        prepared.push({
          path,
          target,
          staged,
          backup,
          existed,
          expectedContentVersion: page.expectedContentVersion,
        });
      }

      for (const entry of prepared) {
        const currentVersion = readWikiPageVersion(this.wikiPath, entry.path);
        if (currentVersion !== entry.expectedContentVersion) {
          throw new Error(`atomic wiki page ${entry.path} changed before activation`);
        }
        mkdirSync(dirname(entry.target), { recursive: true });
        renameSync(entry.staged, entry.target);
        activated.push(entry);
      }
      return prepared.map((entry) => entry.path);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const entry of activated.reverse()) {
        try {
          if (entry.existed) {
            copyFileSync(entry.backup, entry.target);
          } else if (existsSync(entry.target)) {
            unlinkSync(entry.target);
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `${entry.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      if (rollbackErrors.length > 0) {
        preserveRecovery = true;
        const manifestPath = join(stagingRoot, 'RECOVERY.json');
        writeFileSync(
          manifestPath,
          JSON.stringify(
            {
              createdAt: new Date().toISOString(),
              publishError: error instanceof Error ? error.message : String(error),
              rollbackErrors,
              pages: prepared.map((entry) => ({
                path: entry.path,
                existed: entry.existed,
                backup: entry.existed ? relative(stagingRoot, entry.backup) : null,
              })),
            },
            null,
            2
          ),
          'utf8'
        );
        throw new Error(
          `Wiki publication rollback incomplete; recovery preserved at ${manifestPath}`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      if (!preserveRecovery) {
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    }
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
