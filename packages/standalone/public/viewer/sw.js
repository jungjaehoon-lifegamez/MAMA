/**
 * @fileoverview Service Worker for the MAMA Viewer PWA
 * @version 3.0.0
 *
 * Provides offline caching for static assets using cache-first strategy.
 */

/* eslint-env serviceworker */

// Bumped for the unified Viewer: the retired chat/feed/agents/dashboard/settings
// modules no longer exist, so a client holding the old cache would keep serving
// 404-shaped entries for them. A new cache name is what evicts them.
const CACHE_NAME = 'mama-viewer-v3';
const STATIC_ASSETS = [
  '/viewer',
  '/viewer/viewer.css',
  '/viewer/manifest.json',
  '/viewer/js/modules/graph.js',
  '/viewer/js/modules/memory.js',
  '/viewer/js/modules/wiki.js',
  '/viewer/js/modules/system.js',
  '/viewer/js/utils/debug-logger.js',
  '/viewer/js/utils/dom.js',
  '/viewer/js/utils/format.js',
  '/viewer/js/utils/api.js',
  '/viewer/js/utils/markdown.js',
  '/viewer/js/utils/ui-commands.js',
  '/viewer/operator/operator.js',
  '/viewer/operator/operator.css',
  '/viewer/icons/icon-192.png',
  '/viewer/icons/icon-512.png',
  '/viewer/icons/mama-icon.svg',
];

/**
 * Install event - cache static assets
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching static assets (graceful)');
      // Graceful caching - 실패해도 계속 진행
      return Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          fetch(url)
            .then((res) => {
              if (res.ok) {
                return cache.put(url, res);
              }
              console.warn('[SW] Failed to cache:', url, res.status);
              return null;
            })
            .catch((err) => {
              console.warn('[SW] Cache fetch error:', url, err.message);
              return null;
            })
        )
      );
    })
  );
  // Activate immediately
  self.skipWaiting();
});

/**
 * Activate event - clean up old caches
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    })
  );
  // Take control of all pages immediately
  self.clients.claim();
});

/**
 * Fetch event - cache-first strategy for static assets
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip WebSocket and API requests
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/')) {
    return;
  }

  // Network-first for the operator bundle. It ships under stable filenames
  // (/viewer/operator/operator.js), so a cache-first hit would pin one build
  // forever until CACHE_NAME changes. The cache stays the offline fallback.
  // Must be checked before the generic '/viewer' prefix match below.
  if (url.pathname.startsWith('/viewer/operator/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            // The write is held open by the event, not by respondWith: the
            // response still returns immediately, but the worker may not be
            // killed mid-put, which would leave a truncated cache entry.
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone))
            );
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cachedResponse) => cachedResponse || caches.match('/viewer'))
        )
    );
    return;
  }

  // Cache-first for static assets
  if (STATIC_ASSETS.some((asset) => url.pathname.startsWith(asset.split('?')[0]))) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((response) => {
          // Cache successful responses. Same detached-put hazard as the
          // operator branch above, so it is held open the same way.
          if (response.ok) {
            const responseClone = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone))
            );
          }
          return response;
        });
      })
    );
    return;
  }

  // Network-first for everything else
  event.respondWith(
    fetch(request).catch(() => {
      // Return offline fallback if available
      return caches.match('/viewer');
    })
  );
});

/**
 * Message event - handle skip waiting message
 */
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
