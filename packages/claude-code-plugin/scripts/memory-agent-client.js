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
 * POST to memory agent ingest endpoint.
 * Returns a promise that resolves when the request socket is flushed,
 * allowing callers to await it before exiting if needed.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} [projectPath]
 * @param {string} [sourceType] - hook name for tracking (e.g. 'posttooluse', 'precompact')
 * @returns {Promise<void>}
 */
function postToMemoryAgent(messages, projectPath, sourceType) {
  if (!messages || messages.length === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
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
      () => resolve()
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

/**
 * Save a checkpoint to MAMA OS.
 * @returns {Promise<number|null>} Checkpoint ID or null on failure
 */
function saveCheckpointToMamaOs(summary, openFiles, nextSteps) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      summary: summary || '',
      open_files: openFiles || [],
      next_steps: nextSteps || '',
    });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: MAMA_PORT,
        path: '/api/checkpoint/save',
        method: 'POST',
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.id || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Search MAMA OS for relevant context (decisions + checkpoints).
 * @returns {Promise<{results: Array, checkpoint: object|null}>}
 */
function searchMamaOs(query, limit) {
  return new Promise((resolve) => {
    const q = encodeURIComponent(query || '');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: MAMA_PORT,
        path: `/api/mama/search?q=${q}&limit=${limit || 5}`,
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ results: [] });
          }
        });
      }
    );
    req.on('error', () => resolve({ results: [] }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ results: [] });
    });
    req.end();
  });
}

/**
 * Load the latest checkpoint from MAMA OS.
 * @returns {Promise<object|null>}
 */
function loadCheckpointFromMamaOs() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: MAMA_PORT,
        path: '/api/checkpoint/load',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.checkpoint || parsed.data?.checkpoint || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Parse JSONL transcript content into conversation messages.
 * Handles both Claude Code format (type=user/assistant, content as array of blocks)
 * and simple format (role + content string).
 *
 * @param {string} content - Raw JSONL content
 * @param {number} maxPairs - Maximum user+assistant pairs to return
 * @returns {Array<{role: string, content: string}>}
 */
function parseTranscriptMessages(content, maxPairs) {
  if (!content) {
    return [];
  }

  const messages = [];
  const lines = content.trim().split('\n');

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Normalize: prefer entry.message envelope when present, fallback to entry itself
    const envelope = entry.message || entry;
    const type = envelope.type || envelope.role;

    if (type !== 'user' && type !== 'assistant') {
      continue;
    }

    // Normalize content: string or array of blocks → plain string
    let text = '';
    const rawContent = envelope.content;
    if (typeof rawContent === 'string') {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      const textParts = [];
      for (const block of rawContent) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
      }
      text = textParts.join('\n');
    }

    const minLen = type === 'user' ? 3 : 6;
    if (text.length >= minLen) {
      messages.push({ role: type, content: text.slice(0, 2000) });
    }
  }

  const limit = maxPairs * 2;
  return messages.slice(-limit);
}

module.exports = {
  isMamaOsRunning,
  postToMemoryAgent,
  parseTranscriptMessages,
  saveCheckpointToMamaOs,
  searchMamaOs,
  loadCheckpointFromMamaOs,
};
