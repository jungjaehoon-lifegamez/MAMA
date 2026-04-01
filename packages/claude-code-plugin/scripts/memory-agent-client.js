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

    // Claude Code transcript format: type field
    const type = entry.type || entry.role;

    if (type === 'user') {
      const text = typeof entry.content === 'string' ? entry.content : entry.message?.content || '';
      if (text && text.length > 2) {
        messages.push({ role: 'user', content: text.slice(0, 2000) });
      }
    } else if (type === 'assistant') {
      // Content may be: plain string, array of blocks (Claude Code), or nested in message
      if (typeof entry.content === 'string') {
        if (entry.content.length > 5) {
          messages.push({ role: 'assistant', content: entry.content.slice(0, 2000) });
        }
      } else {
        const blocks = Array.isArray(entry.content) ? entry.content : entry.message?.content || [];
        if (Array.isArray(blocks)) {
          const textParts = [];
          for (const block of blocks) {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
          }
          const text = textParts.join('\n');
          if (text && text.length > 5) {
            messages.push({ role: 'assistant', content: text.slice(0, 2000) });
          }
        }
      }
    }
    // Skip: system, thinking, tool_use, tool_result, file-history-snapshot
  }

  const limit = maxPairs * 2;
  return messages.slice(-limit);
}

module.exports = { isMamaOsRunning, postToMemoryAgent, parseTranscriptMessages };
