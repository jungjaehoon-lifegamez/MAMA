/**
 * Host-bound wiki page access for scheduled wiki workorders (TG-03/TG-06).
 *
 * The wiki turn never touches the Obsidian CLI: it reads the configured MAMA wiki root
 * directly through `wiki_read`, and `wiki_publish` compares each page's
 * `expectedContentVersion` against the same root immediately before writing. Both sides
 * share ONE path allowlist so a run bound to `ownerDate` can only see or change Home.md,
 * its own daily page, and lesson pages.
 */
import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';

import { normalizeWikiPagePath } from './path-safety.js';

export const WIKI_READ_MAX_PATHS = 20;
export const WIKI_READ_MAX_PAGE_CHARS = 20_000;
export const WIKI_READ_MAX_TOTAL_CHARS = 60_000;
export const WIKI_LESSON_ROOTS = ['lessons/clients', 'lessons/process', 'lessons/system'] as const;
export const WIKI_HUMAN_MARKER = '<!-- human -->';

const OWNER_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const normalized = normalizeWikiPagePath(raw);
  if (!normalized.endsWith('.md')) {
    throw new Error(`wiki page path must end with .md: ${raw}`);
  }
  return normalized;
}

/** Only Home.md, the exact daily page for `ownerDate`, and lesson pages are in scope. */
export function isAllowedWikiWorkorderPath(normalizedPath: string, ownerDate: string): boolean {
  if (!OWNER_DATE_RE.test(ownerDate)) {
    return false;
  }
  if (normalizedPath === 'Home.md') {
    return true;
  }
  if (normalizedPath === `daily/${ownerDate}.md`) {
    return true;
  }
  return WIKI_LESSON_ROOTS.some((root) => {
    if (!normalizedPath.startsWith(`${root}/`)) {
      return false;
    }
    const fileName = normalizedPath.slice(root.length + 1);
    return fileName.length > 3 && !fileName.includes('/');
  });
}

export function assertAllowedWikiWorkorderPath(raw: unknown, ownerDate: string): string {
  const normalized = normalizeWikiRelativePath(raw);
  if (!isAllowedWikiWorkorderPath(normalized, ownerDate)) {
    throw new Error(
      `wiki page ${normalized} is outside the bound wiki scope (Home.md, daily/${ownerDate}.md, lessons/{clients,process,system}/*.md)`
    );
  }
  return normalized;
}

function resolveInsideRoot(root: string, normalizedPath: string): string | null {
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

export function readWikiPages(input: {
  root: string;
  ownerDate: string;
  paths: unknown;
  contentOffset?: unknown;
  contentLimit?: unknown;
}): WikiReadResult {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new Error('wiki_read requires a non-empty paths array');
  }
  if (input.paths.length > WIKI_READ_MAX_PATHS) {
    throw new Error(`wiki_read accepts at most ${WIKI_READ_MAX_PATHS} paths`);
  }
  const contentOffset = input.contentOffset ?? 0;
  const contentLimit = input.contentLimit ?? WIKI_READ_MAX_PAGE_CHARS;
  if (!Number.isSafeInteger(contentOffset) || (contentOffset as number) < 0) {
    throw new Error('wiki_read content_offset must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(contentLimit) ||
    (contentLimit as number) < 1 ||
    (contentLimit as number) > WIKI_READ_MAX_PAGE_CHARS
  ) {
    throw new Error(
      `wiki_read content_limit must be an integer from 1 to ${WIKI_READ_MAX_PAGE_CHARS}`
    );
  }
  const seen = new Set<string>();
  const pages: WikiReadPage[] = [];
  let totalChars = 0;
  let truncatedAny = false;
  for (const raw of input.paths) {
    const normalized = assertAllowedWikiWorkorderPath(raw, input.ownerDate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const real = resolveInsideRoot(input.root, normalized);
    if (real === null) {
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
      contentVersion: wikiContentVersion(full),
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
 * Host gate for `wiki_publish` inside a bound wiki workorder: allowed paths only, exactly
 * the bound daily page present once, and every page carrying an `expectedContentVersion`
 * that matches the configured root RIGHT NOW (hash for existing, null for missing).
 */
export function assertWikiWorkorderPublish(input: {
  root: string;
  ownerDate: string;
  pages: readonly WikiWorkorderPublishPage[];
}): void {
  if (!OWNER_DATE_RE.test(input.ownerDate)) {
    throw new Error('wiki_publish is unavailable for legacy input without a host-issued ownerDate');
  }
  const dailyPath = `daily/${input.ownerDate}.md`;
  let dailyCount = 0;
  const seen = new Set<string>();
  for (const page of input.pages) {
    const normalized = assertAllowedWikiWorkorderPath(page.path, input.ownerDate);
    if (seen.has(normalized)) {
      throw new Error(`wiki_publish lists ${normalized} more than once`);
    }
    seen.add(normalized);
    if (normalized === dailyPath) {
      dailyCount += 1;
    }
    if (typeof page.content === 'string' && page.content.includes(WIKI_HUMAN_MARKER)) {
      throw new Error(
        `wiki_publish page ${normalized} content must omit ${WIKI_HUMAN_MARKER} and its owner-authored suffix`
      );
    }
    if (!('expectedContentVersion' in page)) {
      throw new Error(
        `wiki_publish page ${normalized} requires expectedContentVersion (hash or null)`
      );
    }
    const expected = page.expectedContentVersion;
    if (expected !== null && (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))) {
      throw new Error(
        `wiki_publish page ${normalized} expectedContentVersion must be the SHA-256 from wiki_read or null`
      );
    }
    const current = readWikiPageVersion(input.root, normalized);
    if (current !== expected) {
      throw new Error(
        `wiki_publish page ${normalized} is stale: expected ${expected ?? 'missing'} but the wiki root now has ${current ?? 'no page'}; re-read it with wiki_read`
      );
    }
  }
  if (dailyCount !== 1) {
    throw new Error(`wiki_publish in a wiki workorder must include exactly ${dailyPath} once`);
  }
}
