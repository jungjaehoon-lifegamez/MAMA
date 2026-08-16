import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDir = join(process.cwd(), 'public');
const viewerDir = join(publicDir, 'viewer');

const source = readFileSync(join(viewerDir, 'viewer.html'), 'utf8');
const css = readFileSync(join(viewerDir, 'viewer.css'), 'utf8');
const sw = readFileSync(join(viewerDir, 'sw.js'), 'utf8');
const taskLinks = readFileSync(join(process.cwd(), 'ui', 'src', 'lib', 'task-links.ts'), 'utf8');

const RETIRED_MODULES = [
  'chat',
  'connector-feed',
  'agents',
  'dashboard',
  'settings',
  'entity-audit',
  'entity-review',
];

describe('Knowledge > Memory retained controls', () => {
  it('scopes Clear to the Graph module instance instead of a bare global', () => {
    expect(source).toContain('graph?.clearFilters?.()');
    expect(source).not.toContain('graph.clearFilters && graph.clearFilters()');
  });

  it('guards every control lookup so one missing input cannot break Clear', () => {
    const clearFilters = source.match(/function clearFilters\(\)[\s\S]*?\n {6}}/)?.[0];
    expect(clearFilters).toBeDefined();
    // No unguarded `getElementById(...).value` assignment survives.
    expect(clearFilters).not.toMatch(/getElementById\('[a-z-]+'\)\.value/);
    for (const id of ['topic-filter', 'outcome-filter', 'search-input']) {
      expect(clearFilters).toContain(`getElementById('${id}')`);
    }
  });

  it('drops the checkpoint list that no longer has a container', () => {
    expect(source).not.toContain('checkpoint-list container not found');
    expect(source).not.toContain('loadCheckpoints');
    expect(source).not.toContain('/api/checkpoints');
  });

  it('lets the control bar wrap rather than pinning three fixed-width inputs', () => {
    expect(source).toContain('class="memory-controls');
    // The old bar sized both inputs with an inline 160px width.
    expect(source).not.toContain('style="width: 160px"');

    const controlRules = css.slice(css.indexOf('.memory-controls'));
    expect(controlRules).toContain('flex-wrap: wrap');
    const searchRules = controlRules.slice(
      controlRules.indexOf('.memory-controls #search-input'),
      controlRules.indexOf('.memory-controls #search-input') + 200
    );
    expect(searchRules).toContain('min-width: 0');
    expect(searchRules).toContain('flex: 1 1 12rem');
  });
});

describe('retired console artifacts', () => {
  it('removes the retired Viewer module sources', () => {
    for (const name of RETIRED_MODULES) {
      expect(existsSync(join(viewerDir, 'src', 'modules', `${name}.ts`))).toBe(false);
    }
  });

  it('leaves no stale operator SPA build output at public/ui', () => {
    expect(existsSync(join(publicDir, 'ui'))).toBe(false);
  });

  it('versions the service worker and precaches only retained assets', () => {
    expect(sw).toContain("const CACHE_NAME = 'mama-viewer-v3'");
    for (const name of RETIRED_MODULES) {
      expect(sw).not.toContain(`/viewer/js/modules/${name}.js`);
    }
    for (const asset of [
      '/viewer/js/modules/memory.js',
      '/viewer/js/modules/graph.js',
      '/viewer/js/modules/wiki.js',
      '/viewer/js/modules/system.js',
      '/viewer/operator/operator.js',
      '/viewer/operator/operator.css',
    ]) {
      expect(sw).toContain(asset);
    }
  });

  it('orders the fetch handler: api/ws bypass, operator network-first, then static cache-first', () => {
    const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"));
    const apiBypass = fetchHandler.indexOf("startsWith('/api/')");
    const operatorMatch = fetchHandler.indexOf("startsWith('/viewer/operator/')");
    const staticMatch = fetchHandler.indexOf('STATIC_ASSETS.some');
    expect(apiBypass).toBeGreaterThan(-1);
    expect(operatorMatch).toBeGreaterThan(-1);
    expect(fetchHandler).toContain("startsWith('/ws')");
    // The static list is prefix-matched on '/viewer', so both the bypass and
    // the operator branch must be decided before it.
    expect(apiBypass).toBeLessThan(operatorMatch);
    expect(operatorMatch).toBeLessThan(staticMatch);
  });

  it('serves the operator bundle network-first with the cache as fallback', () => {
    const branch = sw.slice(
      sw.indexOf("startsWith('/viewer/operator/')"),
      sw.indexOf('STATIC_ASSETS.some')
    );
    // Stable filenames: the network must be tried first, the cache refreshed on
    // success, and the cached copy served only when the network fails.
    expect(branch).toMatch(/respondWith\(\s*fetch\(request\)/);
    expect(branch).toContain('cache.put(request, responseClone)');
    expect(branch).toContain('.catch(');
    expect(branch).toContain('caches.match(request)');
  });

  it('points task references at the unified Viewer operator route', () => {
    expect(taskLinks).toContain('/viewer#operator/tasks?task=');
    expect(taskLinks).not.toContain('/ui/tasks');
  });
});
