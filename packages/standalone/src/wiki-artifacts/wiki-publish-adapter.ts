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

type WikiPublishMode = 'legacy' | 'vnext';
const MAX_WIKI_PUBLISH_PAGES = 100;
const MAX_WIKI_PAGE_CONTENT_CHARS = 200_000;

export interface WikiPublishAdapter {
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
  return {
    publish(input: { pages: WikiPublishPageInput[] }): WikiPublishResult {
      const compiledAt = (options.now ?? (() => new Date()))().toISOString();
      if (!Array.isArray(input.pages)) {
        throw new Error('wiki_publish pages must be an array');
      }
      if (input.pages.length > MAX_WIKI_PUBLISH_PAGES) {
        throw new Error(`wiki_publish accepts at most ${MAX_WIKI_PUBLISH_PAGES} pages`);
      }
      if (options.mode === 'vnext' && !options.store) {
        throw new Error('Wiki artifact store not configured');
      }

      const pagePairs = normalizeAndDedupePages(input.pages, compiledAt, options.mode);
      const pages = pagePairs.map((pair) => pair.page);
      let artifactsStored = 0;

      if (options.mode === 'vnext') {
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
            nowMs: options.nowMs?.(),
          };
        });
        artifactsStored = options.store!.upsertArtifacts(artifacts).length;
        if (options.publisher) {
          options.publisher(pages);
        }
      } else if (options.publisher) {
        options.publisher(pages);
      } else {
        throw new Error('Wiki publisher not configured');
      }

      return {
        pagesPublished: options.publisher ? pages.length : 0,
        artifactsStored,
      };
    },
  };
}
