import type { SourceRef } from '@jungjaehoon/mama-core/provenance/source-ref';

import type { WikiPage, WikiPageType } from '../wiki/types.js';
import type { WikiArtifactConfidence } from './normalization.js';

export type { WikiArtifactConfidence };

export interface WikiArtifactInput {
  artifactId?: string;
  path: string;
  title: string;
  type: WikiPageType | string;
  content: string;
  confidence?: WikiArtifactConfidence | string;
  compiledAt?: string;
  sourceRefs: readonly SourceRef[];
  sourceIds?: readonly string[];
  nowMs?: number;
}

export interface WikiArtifactRecord {
  artifactId: string;
  path: string;
  title: string;
  type: WikiPageType;
  content: string;
  confidence: WikiArtifactConfidence;
  compiledAt: string;
  sourceRefs: string[];
  sourceIds: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WikiPublishPageInput {
  path: string;
  title: string;
  type?: string;
  content: string;
  confidence?: string;
  sourceIds?: string[];
  sourceRefs?: SourceRef[];
}

export type SourceLinkedWikiPage = WikiPage & {
  sourceRefs: string[];
};

export type WikiPagePublisher = (pages: SourceLinkedWikiPage[]) => void;

export interface WikiPublishResult {
  pagesPublished: number;
  artifactsStored: number;
}

export interface WikiArtifactListOptions {
  limit?: number;
  offset?: number;
}

export type WikiArtifactPathListOptions = WikiArtifactListOptions;
