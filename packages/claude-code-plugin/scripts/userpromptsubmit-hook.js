#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — Memory Agent Ingestion
 *
 * Sends the user prompt (and last assistant response if available) to the
 * MAMA OS memory agent for background ingestion.
 *
 * Fire-and-forget: we never block on the response. The hook checks whether
 * MAMA OS is running on port 3847 (with a cached health check) before
 * attempting the POST.
 *
 * stdin:  { user_prompt, ... }
 * stdout: { continue: true }
 */

const path = require('path');
const http = require('http');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(PLUGIN_ROOT, 'src', 'core');
const { getEnabledFeatures } = require(path.join(CORE_PATH, 'hook-features'));

// --- Health check cache ---
let _healthCacheResult = null; // true | false | null
let _healthCacheExpiry = 0;
const HEALTH_CACHE_TTL_MS = 30_000; // Cache health result for 30 seconds

/**
 * Check if MAMA OS is running on port 3847.
 * Caches the result for HEALTH_CACHE_TTL_MS to avoid per-prompt overhead.
 */
function isMamaOsRunning() {
  if (_healthCacheResult !== null && Date.now() < _healthCacheExpiry) {
    return Promise.resolve(_healthCacheResult);
  }

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3847,
        path: '/api/metrics/health',
        method: 'GET',
        timeout: 1500,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          _healthCacheResult = ok;
          _healthCacheExpiry = Date.now() + HEALTH_CACHE_TTL_MS;
          resolve(ok);
        });
      }
    );
    req.on('error', () => {
      _healthCacheResult = false;
      _healthCacheExpiry = Date.now() + HEALTH_CACHE_TTL_MS;
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      _healthCacheResult = false;
      _healthCacheExpiry = Date.now() + HEALTH_CACHE_TTL_MS;
      resolve(false);
    });
    req.end();
  });
}

/**
 * Fire-and-forget POST to MAMA OS memory agent ingest endpoint.
 * Does not throw; errors are silently ignored.
 */
function postToMemoryAgent(userPrompt, lastAssistantResponse, projectPath) {
  const messages = [{ role: 'user', content: userPrompt }];
  if (lastAssistantResponse) {
    messages.push({ role: 'assistant', content: lastAssistantResponse });
  }

  const body = JSON.stringify({
    messages,
    scopes: projectPath ? [{ kind: 'project', id: projectPath }] : [],
  });

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 3847,
      path: '/api/memory-agent/ingest',
      method: 'POST',
      timeout: 3000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    () => {
      // Response intentionally ignored (fire-and-forget)
    }
  );
  req.on('error', () => {
    // Silently ignore — MAMA OS may not be running
  });
  req.on('timeout', () => {
    req.destroy();
  });
  req.write(body);
  req.end();
}

/**
 * Read input from stdin (Claude Code hook format).
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timeout = setTimeout(() => resolve({}), 2000);

    process.stdin.on('data', (chunk) => {
      clearTimeout(timeout);
      data += chunk;
    });

    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });

    process.stdin.on('error', () => {
      clearTimeout(timeout);
      resolve({});
    });
  });
}

async function main() {
  const features = getEnabledFeatures();
  if (features.size === 0) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const input = await readStdin();
  const userPrompt = input.user_prompt || input.prompt || '';

  // Always allow the prompt to proceed
  const response = { continue: true };

  if (!userPrompt) {
    console.log(JSON.stringify(response));
    process.exit(0);
  }

  // Check if MAMA OS is running (cached)
  const running = await isMamaOsRunning();
  if (!running) {
    console.log(JSON.stringify(response));
    process.exit(0);
  }

  // Derive project path from cwd or env
  const projectPath = process.env.CLAUDE_PROJECT_PATH || process.cwd();
  const lastAssistantResponse = input.last_assistant_response || input.assistant_response || '';

  // Fire-and-forget: send to memory agent
  postToMemoryAgent(userPrompt, lastAssistantResponse, projectPath);

  console.log(JSON.stringify(response));
  // Give the POST request a moment to flush before exit
  setTimeout(() => process.exit(0), 100);
}

// Handle signals gracefully
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

if (require.main === module) {
  main().catch(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = { main, isMamaOsRunning, postToMemoryAgent };
