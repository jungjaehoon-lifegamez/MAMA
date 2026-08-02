/**
 * Setup Server - HTTP + WebSocket server for interactive setup wizard
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { createSetupWebSocketHandler } from './setup-websocket.js';

export interface SetupServer {
  close: () => Promise<void>;
}

const SETUP_NONCE_TTL_MS = 10 * 60_000;
const MAX_PENDING_SETUP_NONCES = 128;

export interface SetupNonceStore {
  issue(): string | null;
  consume(candidate: string): boolean;
}

export function createSetupNonceStore(now: () => number = Date.now): SetupNonceStore {
  const pendingNonces = new Map<string, number>();
  const removeExpired = () => {
    const currentTime = now();
    for (const [nonce, expiresAt] of pendingNonces) {
      if (expiresAt <= currentTime) pendingNonces.delete(nonce);
    }
  };
  return {
    issue() {
      removeExpired();
      if (pendingNonces.size >= MAX_PENDING_SETUP_NONCES) return null;
      const nonce = randomBytes(32).toString('base64url');
      pendingNonces.set(nonce, now() + SETUP_NONCE_TTL_MS);
      return nonce;
    },
    consume(candidate) {
      removeExpired();
      if (!pendingNonces.has(candidate)) return false;
      pendingNonces.delete(candidate);
      return true;
    },
  };
}

export async function startSetupServer(port: number = 3848): Promise<SetupServer> {
  const nonceStore = createSetupNonceStore();
  const httpServer = createServer(async (req, res) => {
    if (req.url === '/setup' || req.url === '/') {
      const htmlPaths = [
        join(__dirname, '../../public/setup-v3.html'),
        join(__dirname, '../../public/setup.html'),
      ];

      let html = '';
      for (const htmlPath of htmlPaths) {
        try {
          html = await readFile(htmlPath, 'utf-8');
          break;
        } catch {
          // Keep trying the next candidate
        }
      }

      if (!html) {
        console.error('Failed to load setup.html:', new Error('No setup HTML file found'));
        res.writeHead(404);
        res.end('setup.html not found');
        return;
      }

      const pageNonce = nonceStore.issue();
      if (!pageNonce) {
        res.writeHead(429);
        res.end('Too many pending setup pages; retry after older pages expire.');
        return;
      }
      html = html.replace('__MAMA_SETUP_NONCE__', pageNonce);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.url === '/setup-v3.css' || req.url === '/setup.css') {
      const cssPath = join(__dirname, '../../public/setup-v3.css');

      const cssPaths = [cssPath, join(__dirname, '../../public/setup.css')];

      let css = '';
      for (const path of cssPaths) {
        try {
          css = await readFile(path, 'utf-8');
          break;
        } catch {
          // Keep trying the next candidate
        }
      }

      if (!css) {
        console.error('Failed to load setup css:', new Error('No setup CSS file found'));
        res.writeHead(404);
        res.end('setup.css not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(css);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/setup-ws',
  });

  console.log('[Setup] WebSocket server created on path: /setup-ws');

  wss.on('error', (error) => {
    console.error('[Setup] WebSocketServer error:', error);
  });

  wss.on('listening', () => {
    console.log('[Setup] WebSocketServer is listening');
  });

  const websocketLifecycle = createSetupWebSocketHandler(wss, undefined, undefined, {
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    consumeNonce: (candidate) => nonceStore.consume(candidate),
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => {
      resolve();
    });
    httpServer.on('error', reject);
  });

  let closePromise: Promise<void> | null = null;
  return {
    close: () => {
      closePromise ??= (async () => {
        const websocketClosed = new Promise<void>((resolve) => wss.close(() => resolve()));
        await websocketLifecycle.close();
        await websocketClosed;
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      })();
      return closePromise;
    },
  };
}
