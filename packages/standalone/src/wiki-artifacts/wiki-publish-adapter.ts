import { serializeSourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { WikiPageType } from '../wiki/types.js';
import type { WikiArtifactStore } from './wiki-artifact-store.js';
import {
  normalizeWikiConfidence,
  normalizeWikiPageType,
  normalizeWikiPagePath,
  requiredWikiString,
} from './normalization.js';
import type {
  SourceLinkedWikiPage,
  WikiArtifactConfidence,
  WikiPagePublisher,
  WikiPublishPageInput,
  WikiPublishResult,
} from './types.js';

export type WikiPublishMode = 'legacy' | 'vnext';
export const MAX_WIKI_PUBLISH_PAGES = 100;
export const MAX_WIKI_PAGE_CONTENT_CHARS = 200_000;
const vNextWikiPublishAdapters = new WeakSet<WikiPublishAdapter>();

export interface WikiPublishAdapter {
  readonly mode: WikiPublishMode;
  publish(input: { pages: WikiPublishPageInput[] }): WikiPublishResult;
}

export interface WikiPublishAdapterOptions {
  mode: WikiPublishMode;
  publisher?: WikiPagePublisher | null;
  store?: WikiArtifactStore | null;
  now?: () => Date;
  nowMs?: () => number;
}

function normalizeType(value: string | undefined): WikiPageType {
  return normalizeWikiPageType(value, 'wiki_publish page');
}

function normalizeConfidence(value: string | undefined): WikiArtifactConfidence {
  return normalizeWikiConfidence(value, 'wiki_publish page');
}

function normalizeSourceIds(sourceIds: string[] | undefined, fallback: string[]): string[] {
  if (!sourceIds || sourceIds.length === 0) {
    return fallback;
  }
  return sourceIds.map((id) => requiredWikiString(id, 'sourceIds[]', 'wiki_publish page'));
}

function normalizePage(page: WikiPublishPageInput, compiledAt: string): SourceLinkedWikiPage {
  const sourceRefs = page.sourceRefs?.map((ref) => serializeSourceRef(ref)) ?? [];
  const content = requiredWikiString(page.content, 'content', 'wiki_publish page');
  if (content.length > MAX_WIKI_PAGE_CONTENT_CHARS) {
    throw new Error(
      `wiki_publish page content must not exceed ${MAX_WIKI_PAGE_CONTENT_CHARS} characters`
    );
  }
  return {
    path: normalizeWikiPagePath(page.path, 'wiki_publish page path'),
    title: requiredWikiString(page.title, 'title', 'wiki_publish page'),
    type: normalizeType(page.type),
    content,
    sourceIds: normalizeSourceIds(page.sourceIds, sourceRefs),
    sourceRefs,
    compiledAt,
    confidence: normalizeConfidence(page.confidence),
  };
}

function normalizeAndDedupePages(
  rawPages: WikiPublishPageInput[],
  compiledAt: string,
  mode: WikiPublishMode
): Array<{ page: SourceLinkedWikiPage; rawPage: WikiPublishPageInput }> {
  const byPath = new Map<string, { page: SourceLinkedWikiPage; rawPage: WikiPublishPageInput }>();
  for (const rawPage of rawPages) {
    if (mode === 'vnext' && (!rawPage.sourceRefs || rawPage.sourceRefs.length === 0)) {
      throw new Error('wiki_publish vNext pages must include source refs');
    }
    const page = normalizePage(rawPage, compiledAt);
    byPath.set(page.path, { page, rawPage });
  }
  return [...byPath.values()];
}

export function createWikiPublishAdapter(options: WikiPublishAdapterOptions): WikiPublishAdapter {
  const mode = options.mode;
  const publisher = options.publisher ?? null;
  const store = mode === 'vnext' ? (options.store ?? null) : null;
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs;
  const adapter: WikiPublishAdapter = {
    mode,
    publish(input: { pages: WikiPublishPageInput[] }): WikiPublishResult {
      const compiledAt = now().toISOString();
      if (!Array.isArray(input.pages)) {
        throw new Error('wiki_publish pages must be an array');
      }
      if (input.pages.length > MAX_WIKI_PUBLISH_PAGES) {
        throw new Error(`wiki_publish accepts at most ${MAX_WIKI_PUBLISH_PAGES} pages`);
      }
      if (mode === 'vnext' && !store) {
        throw new Error('Wiki artifact store not configured');
      }

      const pagePairs = normalizeAndDedupePages(input.pages, compiledAt, mode);
      const pages = pagePairs.map((pair) => pair.page);
      let artifactsStored = 0;

      if (mode === 'vnext') {
        if (!store) {
          throw new Error('Wiki artifact store not configured');
        }
        const artifacts = pagePairs.map(({ page, rawPage }) => {
          return {
            path: page.path,
            title: page.title,
            type: page.type,
            content: page.content,
            confidence: page.confidence,
            compiledAt: page.compiledAt,
            sourceRefs: rawPage.sourceRefs ?? [],
            sourceIds: page.sourceIds,
            nowMs: nowMs?.(),
          };
        });
        artifactsStored = store.upsertArtifacts(artifacts).length;
        if (publisher) {
          publisher(pages);
        }
      } else if (publisher) {
        publisher(pages);
      } else {
        throw new Error('Wiki publisher not configured');
      }

      return {
        pagesPublished: publisher ? pages.length : 0,
        artifactsStored,
      };
    },
  };
  if (mode === 'vnext') {
    vNextWikiPublishAdapters.add(adapter);
  }
  return Object.freeze(adapter);
}

export function isVNextWikiPublishAdapter(
  adapter: WikiPublishAdapter | null | undefined
): adapter is WikiPublishAdapter {
  return typeof adapter === 'object' && adapter !== null && vNextWikiPublishAdapters.has(adapter);
}
