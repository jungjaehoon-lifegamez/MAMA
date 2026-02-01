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
      const htmlPath = join(__dirname, '../../public/setup-v3.html');
      try {
        const html = await readFile(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch (err) {
        console.error('Failed to load setup-v3.html:', err);
        res.writeHead(404);
        res.end('setup-v3.html not found');
      }
      return;
    }

    if (req.url === '/setup-v3.css') {
      const cssPath = join(__dirname, '../../public/setup-v3.css');
      try {
        const css = await readFile(cssPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end(css);
      } catch (err) {
        console.error('Failed to load setup-v3.css:', err);
        res.writeHead(404);
        res.end('setup-v3.css not found');
      }
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
