/**
 * @fileoverview Service Worker for MAMA Mobile PWA
 * @version 1.5.0
 *
 * Provides offline caching for static assets using cache-first strategy.
 */

/* eslint-env serviceworker */

const CACHE_NAME = 'mama-mobile-v1.5.0';
const STATIC_ASSETS = [
  '/viewer',
  '/viewer/viewer.css',
  '/viewer/viewer.js',
  '/viewer/manifest.json',
];

/**
 * Install event - cache static assets
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
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

  // Cache-first for static assets
  if (STATIC_ASSETS.some((asset) => url.pathname.startsWith(asset.split('?')[0]))) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((response) => {
          // Cache successful responses
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
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
