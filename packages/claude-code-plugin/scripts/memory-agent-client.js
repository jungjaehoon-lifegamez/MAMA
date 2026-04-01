#!/usr/bin/env node
/**
 * Shared Memory Agent HTTP Client
 *
 * Used by all hooks to send events to MAMA OS memory agent.
 * Fire-and-forget: never blocks the hook response.
 */

const http = require('http');

const MAMA_PORT = 3847;
const HEALTH_CACHE_TTL_MS = 30_000;

let _healthOk = null;
let _healthExpiry = 0;

/**
 * Check if MAMA OS is running (cached for 30s).
 */
function isMamaOsRunning() {
  if (_healthOk !== null && Date.now() < _healthExpiry) {
    return Promise.resolve(_healthOk);
  }

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: MAMA_PORT,
        path: '/api/metrics/health',
        method: 'GET',
        timeout: 800,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          _healthOk = res.statusCode >= 200 && res.statusCode < 400;
          _healthExpiry = Date.now() + HEALTH_CACHE_TTL_MS;
          resolve(_healthOk);
        });
      }
    );
    req.on('error', () => {
      _healthOk = false;
      _healthExpiry = Date.now() + HEALTH_CACHE_TTL_MS;
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      _healthOk = false;
      _healthExpiry = Date.now() + HEALTH_CACHE_TTL_MS;
      resolve(false);
    });
    req.end();
  });
}

/**
 * Fire-and-forget POST to memory agent ingest endpoint.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} [projectPath]
 * @param {string} [sourceType] - hook name for tracking (e.g. 'posttooluse', 'precompact')
 */
function postToMemoryAgent(messages, projectPath, sourceType) {
  if (!messages || messages.length === 0) {
    return;
  }

  const body = JSON.stringify({
    messages,
    scopes: projectPath ? [{ kind: 'project', id: projectPath }] : [],
    sourceType: sourceType || 'hook',
  });

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: MAMA_PORT,
      path: '/api/memory-agent/ingest',
      method: 'POST',
      timeout: 3000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    () => {} // fire-and-forget
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.write(body);
  req.end();
}

module.exports = { isMamaOsRunning, postToMemoryAgent };
