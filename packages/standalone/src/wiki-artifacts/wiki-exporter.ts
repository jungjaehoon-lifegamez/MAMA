import type { ObsidianWriter } from '../wiki/obsidian-writer.js';
import type { WikiPage } from '../wiki/types.js';
import type { WikiArtifactRecord } from './types.js';
import type { WikiArtifactStore } from './wiki-artifact-store.js';

export interface WikiArtifactExportInput {
  store: WikiArtifactStore;
  writer: ObsidianWriter;
  batchSize?: number;
}

export interface WikiArtifactExportResult {
  exported: number;
  paths: string[];
}

function artifactToPage(record: WikiArtifactRecord): WikiPage {
  return {
    path: record.path,
    title: record.title,
    type: record.type,
    content: record.content,
    sourceIds: record.sourceIds,
    sourceRefs: record.sourceRefs,
    compiledAt: record.compiledAt,
    confidence: record.confidence,
  };
}

export function exportWikiArtifactsToObsidian(
  input: WikiArtifactExportInput
): WikiArtifactExportResult {
  const batchSize = input.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Wiki artifact export batchSize must be a positive integer');
  }

  input.writer.ensureDirectories();
  const indexPages: WikiPage[] = [];
  const paths: string[] = [];
  const artifactPaths = input.store.listArtifactPaths();
  for (let offset = 0; offset < artifactPaths.length; offset += batchSize) {
    const batch = artifactPaths.slice(offset, offset + batchSize);
    for (const artifactPath of batch) {
      const record = input.store.getByPath(artifactPath);
      if (!record) {
        continue;
      }
      const page = artifactToPage(record);
      input.writer.writePage(page);
      paths.push(page.path);
      indexPages.push(page);
    }
  }
  if (indexPages.length > 0) {
    input.writer.updateIndex(indexPages);
    input.writer.appendLog(
      'compile',
      `Published ${indexPages.length} source-linked wiki artifacts`
    );
  }

  return {
    exported: paths.length,
    paths,
  };
}
