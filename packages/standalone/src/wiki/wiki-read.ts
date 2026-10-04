/** Bounded reads and content versions for the configured wiki root. */
import { createHash } from 'crypto';
import { existsSync, lstatSync, opendirSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, posix, resolve, sep } from 'path';

import { normalizeWikiReadPath } from './path-safety.js';

export const WIKI_READ_MAX_PATHS = 20;
export const WIKI_READ_MAX_PAGE_CHARS = 20_000;
export const WIKI_READ_MAX_TOTAL_CHARS = 60_000;
export const WIKI_LIST_MAX_PATHS = 100;
const WIKI_LIST_MAX_ENTRIES = 20_000;
export const WIKI_HUMAN_MARKER = '<!-- human -->';

export interface WikiReadPage {
  path: string;
  exists: boolean;
  content: string | null;
  contentVersion: string | null;
  totalContentChars: number;
  contentOffset: number;
  nextContentOffset: number | null;
  truncated: boolean;
}

export interface WikiReadResult {
  pages: WikiReadPage[];
  totalChars: number;
  truncated: boolean;
}

export function wikiContentVersion(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Exact normalized relative path (`a/b.md`); throws on traversal or malformed input. */
export function normalizeWikiRelativePath(raw: unknown): string {
  const normalized = normalizeWikiReadPath(raw);
  if (!normalized.endsWith('.md')) {
    throw new Error(`wiki page path must end with .md: ${raw}`);
  }
  return normalized;
}

/** List only actual Markdown files under the configured root, with a pinned path-set version. */
export function listWikiPages(input: {
  root: string;
  cursor?: unknown;
  limit?: unknown;
  version?: unknown;
}): {
  paths: string[];
  returned: number;
  total: number;
  nextCursor: string | null;
  readVersion: string;
} {
  const limit = input.limit ?? 50;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > WIKI_LIST_MAX_PATHS
  ) {
    throw new Error(
      `manage.wiki.read list_limit must be an integer from 1 to ${WIKI_LIST_MAX_PATHS}`
    );
  }
  const cursor = input.cursor === undefined ? null : normalizeWikiRelativePath(input.cursor);
  if (
    input.version !== undefined &&
    (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version))
  ) {
    throw new Error('manage.wiki.read list_version must be a SHA-256 string');
  }
  if (cursor && !input.version) {
    throw new Error('manage.wiki.read list_cursor requires list_version');
  }

  const root = realpathSync(resolve(input.root));
  const paths = collectWikiMarkdownPaths(root);
  const readVersion = createHash('sha256').update(JSON.stringify(paths)).digest('hex');
  if (input.version && input.version !== readVersion) {
    throw new Error('manage.wiki.read list changed; restart from the first page');
  }
  const start = cursor === null ? 0 : paths.indexOf(cursor) + 1;
  if (cursor !== null && start === 0) {
    throw new Error('manage.wiki.read list_cursor is not in the current list');
  }
  const page = paths.slice(start, start + (limit as number));
  return {
    paths: page,
    returned: page.length,
    total: paths.length,
    nextCursor: start + page.length < paths.length ? page[page.length - 1] : null,
    readVersion,
  };
}

/** Markdown files under the real root, sorted; dot entries and symlinks are not followed. */
function collectWikiMarkdownPaths(root: string): string[] {
  const paths: string[] = [];
  let inspected = 0;
  const visit = (absolute: string, relative: string, depth: number): void => {
    if (depth > 32) throw new Error('manage.wiki.read listing exceeds 32 directory levels');
    const directory = opendirSync(absolute);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) {
        inspected += 1;
        if (inspected > WIKI_LIST_MAX_ENTRIES) {
          throw new Error('manage.wiki.read listing exceeds 20000 entries');
        }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = `${relative}${entry.name}`;
        if (entry.isDirectory()) {
          visit(join(absolute, entry.name), `${path}/`, depth + 1);
        } else if (entry.isFile() && path.endsWith('.md')) {
          paths.push(normalizeWikiRelativePath(path));
        }
      }
    } finally {
      directory.closeSync();
    }
  };
  visit(root, '', 0);
  return paths.sort();
}

/** The day's daily pages: files named <day>.md under daily/, in a month folder or flat. */
export function findDailyPages(root: string, day: string): string[] {
  return collectWikiMarkdownPaths(realpathSync(resolve(root))).filter(
    (path) => path.startsWith('daily/') && posix.basename(path) === `${day}.md`
  );
}

/** The real path of a page inside the root, or null when absent; throws on symlinks and escapes. */
export function resolveInsideRoot(root: string, normalizedPath: string): string | null {
  const rootReal = realpathSync(resolve(root));
  const absolute = join(rootReal, ...normalizedPath.split('/'));
  let ancestor = dirname(absolute);
  while (ancestor !== rootReal) {
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) {
      throw new Error(`wiki page ${normalizedPath} crosses a symlinked directory`);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor || (!ancestor.startsWith(rootReal + sep) && ancestor !== rootReal)) {
      throw new Error(`wiki page ${normalizedPath} escapes the wiki root`);
    }
    ancestor = parent;
  }
  if (!existsSync(absolute)) {
    if (lstatSync(absolute, { throwIfNoEntry: false })) {
      throw new Error(`wiki page ${normalizedPath} is a dangling symlink`);
    }
    return null;
  }
  if (lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`wiki page ${normalizedPath} is a symlink`);
  }
  const real = realpathSync(absolute);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`wiki page ${normalizedPath} escapes the wiki root`);
  }
  if (!lstatSync(real).isFile()) {
    throw new Error(`wiki page ${normalizedPath} is not a file`);
  }
  return real;
}

/** Current content hash at the configured root, or null when the page does not exist. */
export function readWikiPageVersion(root: string, normalizedPath: string): string | null {
  const real = resolveInsideRoot(root, normalizedPath);
  if (real === null) {
    return null;
  }
  return wikiContentVersion(readFileSync(real, 'utf-8'));
}

/** A page's full content and version at the configured root, or null when it does not exist. */
export function readWikiPageContent(
  root: string,
  normalizedPath: string
): { content: string; version: string } | null {
  const real = resolveInsideRoot(root, normalizedPath);
  if (real === null) return null;
  const content = readFileSync(real, 'utf-8');
  return { content, version: wikiContentVersion(content) };
}

export function readWikiPages(input: {
  root: string;
  paths: unknown;
  contentOffset?: unknown;
  contentLimit?: unknown;
  contentVersions?: Record<string, string | null>;
}): WikiReadResult {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new Error('manage.wiki.read requires a non-empty paths array');
  }
  if (input.paths.length > WIKI_READ_MAX_PATHS) {
    throw new Error(`manage.wiki.read accepts at most ${WIKI_READ_MAX_PATHS} paths`);
  }
  const contentOffset = input.contentOffset ?? 0;
  const contentLimit = input.contentLimit ?? WIKI_READ_MAX_PAGE_CHARS;
  if (!Number.isSafeInteger(contentOffset) || (contentOffset as number) < 0) {
    throw new Error('manage.wiki.read content_offset must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(contentLimit) ||
    (contentLimit as number) < 1 ||
    (contentLimit as number) > WIKI_READ_MAX_PAGE_CHARS
  ) {
    throw new Error(
      `manage.wiki.read content_limit must be an integer from 1 to ${WIKI_READ_MAX_PAGE_CHARS}`
    );
  }
  const seen = new Set<string>();
  const pages: WikiReadPage[] = [];
  let totalChars = 0;
  let truncatedAny = false;
  for (const raw of input.paths) {
    const normalized = normalizeWikiRelativePath(raw);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const real = resolveInsideRoot(input.root, normalized);
    if (real === null) {
      if ((contentOffset as number) > 0) {
        throw new Error(`manage.wiki.read page ${normalized} disappeared; restart from offset 0`);
      }
      pages.push({
        path: normalized,
        exists: false,
        content: null,
        contentVersion: null,
        totalContentChars: 0,
        contentOffset: 0,
        nextContentOffset: null,
        truncated: false,
      });
      continue;
    }
    const full = readFileSync(real, 'utf-8');
    const contentVersion = wikiContentVersion(full);
    if ((contentOffset as number) > 0 && input.contentVersions?.[normalized] !== contentVersion) {
      throw new Error(
        `manage.wiki.read page ${normalized} requires its unchanged content_versions entry; restart from offset 0`
      );
    }
    const offset = Math.min(contentOffset as number, full.length);
    const remaining = Math.max(0, WIKI_READ_MAX_TOTAL_CHARS - totalChars);
    const limit = Math.min(contentLimit as number, remaining);
    const content = full.slice(offset, offset + limit);
    const nextContentOffset =
      offset + content.length < full.length ? offset + content.length : null;
    const truncated = offset > 0 || nextContentOffset !== null;
    truncatedAny = truncatedAny || truncated;
    totalChars += content.length;
    pages.push({
      path: normalized,
      exists: true,
      content,
      // The version always hashes the FULL file so a truncated read still names the exact
      // bytes a later publish must expect.
      contentVersion,
      totalContentChars: full.length,
      contentOffset: offset,
      nextContentOffset,
      truncated,
    });
  }
  return { pages, totalChars, truncated: truncatedAny };
}

export interface WikiWorkorderPublishPage {
  path: unknown;
  content?: unknown;
  expectedContentVersion?: unknown;
}

/**
 * Host gate for `manage.wiki.publish` inside a bound wiki workorder: allowed paths only, exactly
 * the bound daily page present once, and every page carrying an `expectedContentVersion`
 * that matches the configured root RIGHT NOW (hash for existing, null for missing).
 */
