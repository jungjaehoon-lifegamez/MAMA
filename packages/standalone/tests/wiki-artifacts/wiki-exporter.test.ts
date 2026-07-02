import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import Database from '../../src/sqlite.js';
import { ObsidianWriter } from '../../src/wiki/obsidian-writer.js';
import { WikiArtifactStore } from '../../src/wiki-artifacts/wiki-artifact-store.js';
import { exportWikiArtifactsToObsidian } from '../../src/wiki-artifacts/wiki-exporter.js';

let tempDir: string;

describe('STORY-VNEXT-PR4-WIKI-ARTIFACTS: wiki artifact exporter', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wiki-artifact-exporter-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exports stored artifacts to Obsidian with source refs preserved in frontmatter', () => {
    const db = new Database(':memory:');
    const store = new WikiArtifactStore(db);
    store.upsertArtifact({
      path: 'projects/api.md',
      title: 'API',
      type: 'entity',
      content: '## API\n\nContract notes.',
      confidence: 'high',
      compiledAt: '2026-07-02T00:00:00.000Z',
      sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
      nowMs: 1000,
    });
    store.upsertArtifact({
      path: 'projects/queue.md',
      title: 'Queue',
      type: 'entity',
      content: '## Queue\n\nAsync work notes.',
      confidence: 'high',
      compiledAt: '2026-07-02T00:00:00.000Z',
      sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-2' }],
      nowMs: 2000,
    });
    const writer = new ObsidianWriter(tempDir, 'wiki');
    const getByPathSpy = vi.spyOn(store, 'getByPath');

    const result = exportWikiArtifactsToObsidian({ store, writer, batchSize: 1 });

    expect(result).toEqual({ exported: 2, paths: ['projects/queue.md', 'projects/api.md'] });
    expect(getByPathSpy).not.toHaveBeenCalled();
    const content = readFileSync(join(tempDir, 'wiki', 'projects', 'api.md'), 'utf8');
    expect(content).toContain('source_refs:');
    expect(content).toContain('  - "raw:slack:event-1"');
    expect(content).toContain('source_ids:');
    const queueContent = readFileSync(join(tempDir, 'wiki', 'projects', 'queue.md'), 'utf8');
    expect(queueContent).toContain('  - "raw:slack:event-2"');
    expect(queueContent).toContain('source_ids:');

    db.close();
  });
});
