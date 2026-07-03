import type { GatewayToolExecutorOptions } from '../../agent/types.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import { WikiArtifactStore } from '../../wiki-artifacts/wiki-artifact-store.js';
import { createWikiPublishAdapter } from '../../wiki-artifacts/wiki-publish-adapter.js';

export function initVNextWikiPublishAdapter(
  db: SQLiteDatabase,
  options: { enabled: boolean }
): GatewayToolExecutorOptions['wikiPublishAdapter'] {
  if (!options.enabled) {
    return null;
  }

  return createWikiPublishAdapter({
    mode: 'vnext',
    store: new WikiArtifactStore(db),
  });
}
