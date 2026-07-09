import { serializeSourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { WikiPageType } from '../wiki/types.js';
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

export const MAX_WIKI_PUBLISH_PAGES = 100;
export const MAX_WIKI_PAGE_CONTENT_CHARS = 200_000;

export interface WikiPublishAdapter {
  publish(input: { pages: WikiPublishPageInput[] }): WikiPublishResult;
}

export interface WikiPublishAdapterOptions {
  publisher?: WikiPagePublisher | null;
  now?: () => Date;
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
  compiledAt: string
): SourceLinkedWikiPage[] {
  const byPath = new Map<string, SourceLinkedWikiPage>();
  for (const rawPage of rawPages) {
    const page = normalizePage(rawPage, compiledAt);
    byPath.set(page.path, page);
  }
  return [...byPath.values()];
}

export function createWikiPublishAdapter(options: WikiPublishAdapterOptions): WikiPublishAdapter {
  const publisher = options.publisher ?? null;
  const now = options.now ?? (() => new Date());
  const adapter: WikiPublishAdapter = {
    publish(input: { pages: WikiPublishPageInput[] }): WikiPublishResult {
      const compiledAt = now().toISOString();
      if (!Array.isArray(input.pages)) {
        throw new Error('wiki_publish pages must be an array');
      }
      if (input.pages.length > MAX_WIKI_PUBLISH_PAGES) {
        throw new Error(`wiki_publish accepts at most ${MAX_WIKI_PUBLISH_PAGES} pages`);
      }

      const pages = normalizeAndDedupePages(input.pages, compiledAt);

      if (!publisher) {
        throw new Error('Wiki publisher not configured');
      }
      publisher(pages);

      return {
        pagesPublished: pages.length,
        artifactsStored: 0,
      };
    },
  };
  return Object.freeze(adapter);
}
