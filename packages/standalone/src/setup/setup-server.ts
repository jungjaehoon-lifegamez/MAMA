/**
 * Setup Server - HTTP + WebSocket server for interactive setup wizard
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { createSetupWebSocketHandler } from './setup-websocket.js';

export interface SetupServer {
  close: (callback?: () => void) => void;
}

export async function startSetupServer(port: number = 3848): Promise<SetupServer> {
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

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.url === '/setup-v3.css' || req.url === '/setup.css') {
      const cssPath = join(__dirname, '../../public/setup-v3.css');

      const cssPaths = [
        cssPath,
        join(__dirname, '../../public/setup.css'),
      ];

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

  createSetupWebSocketHandler(wss);

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => {
      resolve();
    });
    httpServer.on('error', reject);
  });

  return {
    close: (callback) => {
      wss.close(() => {
        httpServer.close(callback);
      });
    },
  };
}
