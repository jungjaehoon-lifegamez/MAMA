/**
 * mama start command
 *
 * Start MAMA agent daemon
 */

import { spawn, exec } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import Database from 'better-sqlite3';
import express from 'express';
import path, { join } from 'node:path';
import { WebSocketServer } from 'ws';

import {
  loadConfig,
  initConfig,
  configExists,
  expandPath,
  provisionDefaults,
} from '../config/config-manager.js';
import { writePid, isDaemonRunning } from '../utils/pid-manager.js';
import { killProcessesOnPorts, killAllMamaDaemons } from './stop.js';
import { OAuthManager } from '../../auth/index.js';
import { AgentLoop } from '../../agent/index.js';
import { GatewayToolExecutor } from '../../agent/gateway-tool-executor.js';
import { getSessionPool } from '../../agent/session-pool.js';
import {
  DiscordGateway,
  SlackGateway,
  SessionStore,
  MessageRouter,
  PluginLoader,
  initChannelHistory,
} from '../../gateways/index.js';
import type {
  Checkpoint,
  Decision,
  MamaApiClient,
  SearchResult,
} from '../../gateways/context-injector.js';
import {
  CronScheduler,
  CronWorker,
  CronResultRouter,
  TokenKeepAlive,
} from '../../scheduler/index.js';
import { HeartbeatScheduler } from '../../scheduler/heartbeat.js';
import { createApiServer, insertTokenUsage } from '../../api/index.js';
import { MetricsStore } from '../../observability/metrics-store.js';
import { MetricsCleanup } from '../../observability/metrics-cleanup.js';
import { HealthScoreService } from '../../observability/health-score.js';
import { HealthCheckService } from '../../observability/health-check.js';
import { createUploadRouter } from '../../api/upload-handler.js';
import { requireAuth, isAuthenticated, isLocalRequest } from '../../api/auth-middleware.js';
import { createSetupWebSocketHandler } from '../../setup/setup-websocket.js';
// Onboarding state imports removed — onboarding is handled by Setup Wizard only
import { createGraphHandler } from '../../api/graph-api.js';
import type { DelegationHistoryEntry, GraphHandlerOptions } from '../../api/graph-api-types.js';

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import { getEmbeddingDim, getModelName } from '@jungjaehoon/mama-core/config-loader';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const startLogger = new DebugLogger('start');
import { SkillRegistry } from '../../skills/skill-registry.js';
import http from 'node:http';

// Port configuration — single source of truth
/** Public-facing API server port (REST API, Viewer UI, Setup Wizard) */
const API_PORT = 3847;
/** Internal embedding server port (model inference, mobile chat, graph) */
const EMBEDDING_PORT = 3849;

// MAMA embedding server (keeps model in memory)
import type { Server as HttpServer } from 'node:http';
let embeddingServer: HttpServer | null = null;

/**
 * Normalize Discord guild config before passing to gateway.
 * Guards against null, unexpected types, and non-string keys.
 */
interface NormalizedDiscordGuildConfig {
  requireMention?: boolean;
  channels?: Record<string, { requireMention?: boolean }>;
}

function normalizeDiscordGuilds(
  raw: unknown
): Record<string, NormalizedDiscordGuildConfig> | undefined {
  // Reject arrays - they pass typeof 'object' check but get coerced to numeric keys
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const source = raw instanceof Map ? Object.fromEntries(raw) : raw;
  const normalized: Record<string, NormalizedDiscordGuildConfig> = {};

  for (const [guildId, guildConfig] of Object.entries(source as Record<string, unknown>)) {
    if (!guildId) {
      continue;
    }
    if (!guildConfig || typeof guildConfig !== 'object' || Array.isArray(guildConfig)) {
      continue;
    }

    const normalizedGuildConfig: NormalizedDiscordGuildConfig = {};
    if (typeof (guildConfig as Record<string, unknown>).requireMention === 'boolean') {
      normalizedGuildConfig.requireMention = (guildConfig as Record<string, unknown>)
        .requireMention as boolean;
    }

    const rawChannels = (guildConfig as Record<string, unknown>).channels;
    // Reject arrays for channels as well
    if (rawChannels && typeof rawChannels === 'object' && !Array.isArray(rawChannels)) {
      const normalizedChannels: Record<string, { requireMention?: boolean }> = {};
      for (const [channelId, channelConfig] of Object.entries(
        rawChannels as Record<string, unknown>
      )) {
        if (!channelId) {
          continue;
        }
        if (!channelConfig || typeof channelConfig !== 'object' || Array.isArray(channelConfig)) {
          continue;
        }
        const rawChannelRequireMention = (channelConfig as Record<string, unknown>).requireMention;
        if (typeof rawChannelRequireMention === 'boolean') {
          normalizedChannels[String(channelId)] = {
            requireMention: rawChannelRequireMention,
          };
        }
      }
      if (Object.keys(normalizedChannels).length > 0) {
        normalizedGuildConfig.channels = normalizedChannels;
      }
    }

    normalized[String(guildId)] = normalizedGuildConfig;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * SECURITY P1: Wait for port to become available after shutdown
 * Polls port availability instead of using fixed setTimeout
 */
async function waitForPortAvailable(port: number, maxWaitMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < maxWaitMs) {
    const isAvailable = await new Promise<boolean>((resolve) => {
      const testServer = http.createServer();
      testServer.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(false);
        } else {
          resolve(true);
        }
      });
      testServer.once('listening', () => {
        testServer.close(() => resolve(true));
      });
      testServer.listen(port, '127.0.0.1');
    });

    if (isAvailable) return true;
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return false;
}

/**
 * Check existing embedding server and request takeover if needed
 * Returns true if existing server has chat capability (no takeover needed)
 *
 * SECURITY P1: Uses authenticated shutdown with token
 * SECURITY P1: Validates health response before reuse
 * SECURITY P1: Uses port polling instead of fixed timeout
 */
async function checkAndTakeoverExistingServer(port: number): Promise<boolean> {
  const targetModel = getModelName();
  const targetDim = getEmbeddingDim();
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', async () => {
          try {
            const health = JSON.parse(data);
            const healthModel = typeof health.model === 'string' ? health.model : null;
            const healthDim = typeof health.dim === 'number' ? health.dim : null;
            const metadataMismatch =
              healthModel !== targetModel || (healthDim !== null && healthDim !== targetDim);
            const metadataMissing = healthModel === null || healthDim === null;
            // SECURITY P1: Validate health response before reuse
            if (
              health.chatEnabled &&
              health.status === 'ok' &&
              health.modelLoaded &&
              !metadataMismatch &&
              !metadataMissing
            ) {
              // Fully functional server, reuse it
              console.log('✓ Fully functional embedding server (reusing)');
              resolve(true);
              return;
            }

            if (health.status === 'ok') {
              // Server healthy but incomplete features
              if (!health.modelLoaded) {
                console.warn('[EmbeddingServer] Warning: Model not loaded');
              }
              if (metadataMismatch || metadataMissing) {
                console.warn(
                  `[EmbeddingServer] Metadata mismatch -> replacing. ` +
                    `Expected ${targetModel}/${targetDim}, got ${healthModel ?? 'unknown'}/${healthDim ?? 'unknown'}`
                );
              }
              // MCP server running without chat, request shutdown
              console.log('[EmbeddingServer] MCP server detected, requesting takeover...');
              const shutdownReq = http.request(
                {
                  hostname: '127.0.0.1',
                  port,
                  path: '/shutdown',
                  method: 'POST',
                  timeout: 2000,
                  // SECURITY P1: Pass shutdown token
                  headers: {
                    'X-Shutdown-Token': process.env.MAMA_SHUTDOWN_TOKEN || '',
                  },
                },
                async () => {
                  console.log('[EmbeddingServer] MCP server shutdown requested');
                  // SECURITY P1: Use port polling instead of fixed timeout
                  const portAvailable = await waitForPortAvailable(port, 10000);
                  if (portAvailable) {
                    console.log('[EmbeddingServer] Port available, proceeding');
                  } else {
                    console.warn(
                      `[EmbeddingServer] Warning: Port ${port} still in use after 10s. ` +
                        'Proceeding anyway — Watchdog will retry if needed.'
                    );
                  }
                  resolve(false);
                }
              );
              shutdownReq.on('error', () => resolve(false));
              shutdownReq.end();
            } else {
              // Server unhealthy
              console.warn('[EmbeddingServer] Server unhealthy, starting fresh');
              resolve(false);
            }
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function startEmbeddingServerIfAvailable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messageRouter?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionStore?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphHandler?: any
): Promise<void> {
  const port = EMBEDDING_PORT;

  try {
    // Check if server already running
    const existingHasChat = await checkAndTakeoverExistingServer(port);
    if (existingHasChat) {
      // Another Standalone is running with chat, no need to start
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const embeddingServerModule = require('@jungjaehoon/mama-core/embedding-server');
    embeddingServer = await embeddingServerModule.startEmbeddingServer(port, {
      messageRouter,
      sessionStore,
      graphHandler,
    });
    if (embeddingServer) {
      console.log(`✓ Embedding server started (port ${EMBEDDING_PORT})`);
      if (messageRouter && sessionStore) {
        console.log('✓ Mobile Chat integrated with MessageRouter');
      }
      await embeddingServerModule.warmModel();
      console.log('✓ Embedding model preloaded');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[EmbeddingServer] Failed to start: ${message}\n` +
        `  ⚠️  Semantic search (decision recall) UNAVAILABLE this session`
    );
  }
}

/**
 * Open URL in default browser (cross-platform)
 */
function openBrowser(url: string): void {
  const os = platform();
  let command: string;

  switch (os) {
    case 'darwin':
      command = `open "${url}"`;
      break;
    case 'win32':
      command = `start "" "${url}"`;
      break;
    default:
      command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.warn(`[Browser] Failed to open: ${error.message}`);
      console.log(`\n🌐 Open MAMA OS manually: ${url}\n`);
    }
  });
}

/**
 * Check if onboarding is complete (persona files exist)
 */
function isOnboardingComplete(): boolean {
  const mamaHome = join(homedir(), '.mama');
  return existsSync(join(mamaHome, 'USER.md')) && existsSync(join(mamaHome, 'SOUL.md'));
}

/**
 * Sync built-in skills from templates to user's skills directory.
 * Only copies files that don't already exist (never overwrites user modifications).
 */
function syncBuiltinSkills(): void {
  const skillsDir = join(homedir(), '.mama', 'skills');
  const templatesDir = join(__dirname, '..', '..', '..', 'templates', 'skills');

  if (!existsSync(templatesDir)) {
    return;
  }

  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch (err) {
    console.warn('[syncBuiltinSkills] Failed to create skills directory (non-fatal):', err);
    return;
  }

  try {
    const entries = readdirSync(templatesDir);
    let synced = 0;
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const dest = join(skillsDir, file);
      if (existsSync(dest)) continue;
      copyFileSync(join(templatesDir, file), dest);
      synced++;
    }
    if (synced > 0) {
      console.log(`✓ Synced ${synced} built-in skill(s)`);
    }
  } catch (err) {
    // Non-blocking: skills are optional, but surface failures for observability
    console.warn('[syncBuiltinSkills] Skill sync failed (non-fatal):', err);
  }
}

function shouldAutoOpenBrowser(): boolean {
  return process.env.MAMA_NO_AUTO_OPEN_BROWSER !== '1';
}

function isExecutable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableInPath(commandName: string): string | null {
  const pathValue = process.env.PATH || '';
  if (!pathValue) {
    return null;
  }

  const pathEntries = pathValue
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = join(dir, commandName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCodexCommandForStartup(): string {
  const candidates = [process.env.MAMA_CODEX_COMMAND, process.env.CODEX_COMMAND];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed && isExecutable(trimmed)) {
      return trimmed;
    }
  }

  const fromPath = findExecutableInPath('codex');
  if (fromPath) {
    return fromPath;
  }

  throw new Error(
    'Codex command not found. Set MAMA_CODEX_COMMAND or CODEX_COMMAND to an executable path, ' +
      'or install codex and ensure PATH includes the binary.'
  );
}

function hasCodexBackendConfigured(config: Awaited<ReturnType<typeof loadConfig>>): boolean {
  if (config.agent.backend === 'codex-mcp') {
    return true;
  }

  const agents = config.multi_agent?.agents;
  if (!agents || typeof agents !== 'object') {
    return false;
  }

  for (const raw of Object.values(agents)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const agentBackend = (raw as { backend?: string }).backend;
      if (agentBackend === 'codex-mcp') {
        return true;
      }
    }
  }

  return false;
}

/**
 * Options for start command
 */
export interface StartOptions {
  /** Run in foreground (not as daemon) */
  foreground?: boolean;
}

/**
 * Execute start command
 */
export async function startCommand(options: StartOptions = {}): Promise<void> {
  console.log('\n🚀 Starting MAMA Standalone\n');

  // Check if already running
  const runningInfo = await isDaemonRunning();
  if (runningInfo) {
    console.log(`⚠️  MAMA is already running. (PID: ${runningInfo.pid})`);
    console.log('   To stop it: mama stop\n');
    process.exit(1);
  }

  // Clean up ALL stale mama daemon processes (not just port holders).
  // Zombie daemons may stay alive via Slack Socket Mode without holding any port.
  await killAllMamaDaemons();
  await killProcessesOnPorts([3847, 3849]);

  // Check config exists
  if (!configExists()) {
    console.log('⚠️  Config file not found.');
    console.log('   Initialize first: mama init\n');
    process.exit(1);
  }

  // Load config
  let config;
  try {
    config = await initConfig();
  } catch (error) {
    console.error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  const backend = config.agent.backend;
  process.env.MAMA_BACKEND = backend;

  if (backend === 'codex-mcp') {
    console.log('✓ Codex-MCP backend (OAuth handled by Codex login)');
  } else {
    console.log('✓ Claude CLI mode (OAuth token not needed)');
  }

  if (options.foreground) {
    // Run in foreground
    console.log('Starting agent loop (foreground)... ✓\n');
    console.log('MAMA is running in foreground.');
    console.log('Press Ctrl+C to stop.\n');

    // Auto-open browser (after a delay for server to start)
    const needsOnboarding = !isOnboardingComplete();
    const targetUrl = needsOnboarding
      ? `http://localhost:${API_PORT}/setup`
      : `http://localhost:${API_PORT}/viewer`;
    if (shouldAutoOpenBrowser()) {
      setTimeout(() => {
        if (needsOnboarding) {
          console.log('🎭 First-time setup - Opening onboarding wizard...\n');
        } else {
          console.log('🌐 Opening MAMA OS...\n');
        }
        openBrowser(targetUrl);
      }, 3000); // Wait for embedding server
    }

    await writePid(process.pid);
    await runAgentLoop(config);
  } else {
    // Run as daemon
    process.stdout.write('Starting agent loop... ');

    try {
      const daemonPid = await startDaemon();
      console.log('✓');
      console.log(`\nMAMA is running in the background.`);
      console.log(`PID: ${daemonPid}\n`);
      console.log('Check status: mama status');
      console.log('Stop: mama stop\n');

      // Auto-open browser after server is ready
      const needsOnboarding = !isOnboardingComplete();
      const targetUrl = needsOnboarding
        ? `http://localhost:${API_PORT}/setup`
        : `http://localhost:${API_PORT}/viewer`;

      // Wait for server to be ready
      if (shouldAutoOpenBrowser()) {
        setTimeout(() => {
          if (needsOnboarding) {
            console.log('🎭 First-time setup - Opening onboarding wizard...\n');
          } else {
            console.log('🌐 Opening MAMA OS...\n');
          }
          openBrowser(targetUrl);
        }, 2000); // Wait 2 seconds for embedding server to start
      }
    } catch (error) {
      console.log('❌');
      console.error(
        `\nFailed to start daemon: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  }
}

/**
 * Watchdog configuration
 */
const WATCHDOG = {
  /** Health check interval (ms) */
  CHECK_INTERVAL: 30_000,
  /** Max consecutive failures before restart */
  MAX_FAILURES: 3,
  /** Health check HTTP timeout (ms) */
  HEALTH_TIMEOUT: 5_000,
  /** Max auto-restarts before giving up */
  MAX_RESTARTS: 10,
  /** Backoff multiplier per restart (ms) */
  BACKOFF_BASE: 2_000,
  /** Max backoff delay (ms) */
  BACKOFF_MAX: 60_000,
};

/**
 * Spawn a daemon child process and return its PID
 */
function spawnDaemonChild(): number {
  const logDir = `${homedir()}/.mama/logs`;
  mkdirSync(logDir, { recursive: true });

  const logFile = `${logDir}/daemon.log`;
  const out = openSync(logFile, 'a');

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  delete cleanEnv.CLAUDE_CODE_SSE_PORT;

  const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: homedir(),
    env: {
      ...cleanEnv,
      MAMA_DAEMON: '1',
      MAMA_LOG_LEVEL: process.env.MAMA_LOG_LEVEL || 'INFO',
    },
  });

  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn daemon process');
  }

  return child.pid;
}

/**
 * Start daemon process with watchdog auto-restart
 */
async function startDaemon(): Promise<number> {
  const pid = spawnDaemonChild();

  // Give daemon a moment to start
  await new Promise((resolve) => setTimeout(resolve, 500));
  await writePid(pid);

  // Start watchdog in background (detached)
  startWatchdog(pid);

  return pid;
}

/**
 * Watchdog: monitors daemon health and auto-restarts on failure.
 * Runs as a background interval in the parent process (which exits shortly after).
 * To survive parent exit, we spawn a separate watchdog process.
 */
function startWatchdog(initialPid: number): void {
  const logDir = `${homedir()}/.mama/logs`;
  mkdirSync(logDir, { recursive: true });
  const logFile = `${logDir}/daemon.log`;
  const out = openSync(logFile, 'a');

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  delete cleanEnv.CLAUDE_CODE_SSE_PORT;

  const watchdogScript = `
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const os = require('node:os');

const API_PORT = ${API_PORT};
const CHECK_INTERVAL = ${WATCHDOG.CHECK_INTERVAL};
const MAX_FAILURES = ${WATCHDOG.MAX_FAILURES};
const HEALTH_TIMEOUT = ${WATCHDOG.HEALTH_TIMEOUT};
const MAX_RESTARTS = ${WATCHDOG.MAX_RESTARTS};
const BACKOFF_BASE = ${WATCHDOG.BACKOFF_BASE};
const BACKOFF_MAX = ${WATCHDOG.BACKOFF_MAX};
const DAEMON_CMD = ${JSON.stringify(process.argv[1])};
const NODE_PATH = ${JSON.stringify(process.execPath)};
const pidPath = require('node:path').join(os.homedir(), '.mama', 'mama.pid');

let currentPid = ${initialPid};
let failures = 0;
let restartCount = 0;

function log(msg) {
  const ts = new Date().toISOString();
  const line = '[' + ts + '] [Watchdog] ' + msg + '\\n';
  try { fs.appendFileSync(${JSON.stringify(logFile)}, line); } catch {}
}

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:' + API_PORT + '/health', { timeout: HEALTH_TIMEOUT }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).status === 'ok'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function spawnDaemon() {
  const logDir = require('node:path').join(os.homedir(), '.mama', 'logs');
  const out = fs.openSync(require('node:path').join(logDir, 'daemon.log'), 'a');
  const env = Object.assign({}, process.env, { MAMA_DAEMON: '1' });
  const child = spawn(NODE_PATH, [DAEMON_CMD, 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: os.homedir(),
    env,
  });
  child.unref();
  return child.pid;
}

async function tick() {
  // If our tracked PID is dead, check if another daemon is alive via PID file.
  // This handles the case where a Watchdog-spawned daemon failed (e.g. port conflict)
  // but the original daemon is still running fine.
  let alive = isRunning(currentPid);
  if (!alive) {
    try {
      const pidData = JSON.parse(fs.readFileSync(pidPath, 'utf-8'));
      if (pidData.pid && pidData.pid !== currentPid && isRunning(pidData.pid)) {
        log('Tracked PID ' + currentPid + ' is dead, but PID file daemon ' + pidData.pid + ' is alive. Adopting.');
        currentPid = pidData.pid;
        alive = true;
        failures = 0;
      }
    } catch {}
  }
  if (!alive) {
    // Also check if port 3847 is responding — another daemon instance may be serving
    const healthy = await checkHealth();
    if (healthy) {
      log('Tracked PID ' + currentPid + ' is dead, but health check passed. Skipping restart.');
      failures = 0;
      return;
    }
    log('Daemon process ' + currentPid + ' not found (dead)');
    failures = MAX_FAILURES; // trigger immediate restart
  } else {
    const healthy = await checkHealth();
    if (healthy) {
      failures = 0;
      return;
    }
    failures++;
    log('Health check failed (' + failures + '/' + MAX_FAILURES + ')');
  }

  if (failures >= MAX_FAILURES) {
    if (restartCount >= MAX_RESTARTS) {
      log('Max restarts (' + MAX_RESTARTS + ') reached. Watchdog giving up.');
      process.exit(1);
    }

    const backoff = Math.min(BACKOFF_BASE * Math.pow(2, restartCount), BACKOFF_MAX);
    log('Restarting daemon (attempt ' + (restartCount + 1) + '/' + MAX_RESTARTS + ', backoff ' + backoff + 'ms)');

    // Kill old process if still lingering — wait 5s for graceful shutdown
    // (Discord/Slack disconnect + session cleanup can take several seconds)
    if (isRunning(currentPid)) {
      try { process.kill(currentPid, 'SIGTERM'); } catch {}
      await new Promise(r => setTimeout(r, 5000));
      if (isRunning(currentPid)) {
        try { process.kill(currentPid, 'SIGKILL'); } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await new Promise(r => setTimeout(r, backoff));

    const newPid = spawnDaemon();
    if (!newPid) {
      log('Failed to spawn new daemon');
      restartCount++;
      return;
    }

    currentPid = newPid;
    restartCount++;
    failures = 0;

    // Update PID file
    const pidInfo = JSON.stringify({ pid: newPid, startedAt: Date.now() }, null, 2);
    try { fs.writeFileSync(pidPath, pidInfo, 'utf-8'); } catch {}

    log('Daemon restarted with PID ' + newPid);

    // Wait for startup
    await new Promise(r => setTimeout(r, 5000));
  }
}

// Reset restart count if daemon stays healthy for 10 minutes
setInterval(() => {
  if (failures === 0 && restartCount > 0) {
    log('Daemon stable — resetting restart counter');
    restartCount = 0;
  }
}, 10 * 60 * 1000);

log('Started (monitoring PID ' + currentPid + ', check every ' + (CHECK_INTERVAL / 1000) + 's)');

setInterval(() => tick(), CHECK_INTERVAL);

// Initial check after 10s (give daemon time to boot)
setTimeout(() => tick(), 10000);
`;

  // Spawn watchdog as a separate detached process
  const child = spawn(process.execPath, ['-e', watchdogScript], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: homedir(),
    env: {
      ...cleanEnv,
      MAMA_WATCHDOG: '1',
    },
  });

  child.unref();

  // Save watchdog PID alongside daemon PID
  const watchdogPidPath = `${homedir()}/.mama/watchdog.pid`;
  writeFileSync(
    watchdogPidPath,
    JSON.stringify({ pid: child.pid, startedAt: Date.now() }, null, 2)
  );
}

/**
 * Run agent loop (for foreground and daemon mode)
 */
export async function runAgentLoop(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: { osAgentMode?: boolean } = {}
): Promise<void> {
  const startupBackend = config.agent.backend;
  const usesCodexBackend = startupBackend === 'codex-mcp' || hasCodexBackendConfigured(config);

  if (usesCodexBackend) {
    const codexCommand = resolveCodexCommandForStartup();
    process.env.MAMA_CODEX_COMMAND = codexCommand;
    console.log(`✓ Codex CLI backend (command: ${codexCommand})`);
  }

  // Claude CLI is always used (Pi Agent removed for ToS compliance)
  console.log('✓ Claude CLI mode (ToS compliance)');

  // Provision default persona templates and multi-agent config on first start
  try {
    await provisionDefaults();
  } catch (error) {
    console.warn(`[Provision] Warning: ${error instanceof Error ? error.message : String(error)}`);
  }

  const oauthManager = new OAuthManager();

  // Initialize database for session storage
  const dbPath = expandPath(config.database.path).replace('mama-memory.db', 'mama-sessions.db');
  const db = new Database(dbPath);

  // Initialize metrics store (respects config.metrics.enabled)
  const metricsEnabled = config.metrics?.enabled !== false;
  let metricsStore: MetricsStore | null = null;
  let metricsCleanup: MetricsCleanup | null = null;
  let healthService: HealthScoreService | null = null;
  let metricsInterval: ReturnType<typeof setInterval> | null = null;
  let healthWarningInterval: ReturnType<typeof setInterval> | null = null;

  if (metricsEnabled) {
    const metricsDbPath = expandPath(config.database.path).replace(
      'mama-memory.db',
      'mama-metrics.db'
    );
    metricsStore = MetricsStore.getInstance(metricsDbPath);
    metricsCleanup = new MetricsCleanup(metricsStore, {
      retentionMs: (config.metrics?.retention_days ?? 7) * 24 * 60 * 60 * 1000,
    });
    metricsCleanup.start();
    healthService = new HealthScoreService(metricsStore);
    console.log('✓ Metrics store initialized');

    // Periodic metrics summary log (every 5 minutes)
    const METRICS_LOG_INTERVAL = 5 * 60 * 1000;
    metricsInterval = setInterval(() => {
      try {
        const count = metricsStore!.countSince(Date.now() - METRICS_LOG_INTERVAL);
        const health = healthService!.compute();
        startLogger.info(
          `[Metrics] ${count} recorded (5m), health: ${health.score}/100 (${health.status})`
        );
      } catch {
        /* ignore */
      }
    }, METRICS_LOG_INTERVAL);
  } else {
    console.log('ℹ Metrics disabled via config');
  }

  // Initialize connection-based health check service (always active, regardless of metrics config)
  const healthCheckDbPath = expandPath(config.database.path);
  const healthCheckService = new HealthCheckService({
    embeddingPort: EMBEDDING_PORT,
    db,
    sessionPool: getSessionPool(),
    metricsCleanup: metricsCleanup ?? undefined,
    healthScoreService: healthService ?? undefined,
    dbPath: healthCheckDbPath,
    watchdogPidPath: `${homedir()}/.mama/watchdog.pid`,
  });

  // Wire token budget check (daily usage vs config limit)
  const tokenBudgetConfig = config.token_budget;
  if (tokenBudgetConfig && tokenBudgetConfig.daily_limit > 0) {
    const alertThreshold = tokenBudgetConfig.alert_threshold ?? 0.9;
    healthCheckService.setGetTokenUsage(() => {
      try {
        const result = db
          .prepare(
            `
          SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
          FROM token_usage
          WHERE created_at >= ?
        `
          )
          .get(Date.now() - 86_400_000) as { total_tokens: number };
        return { used: result.total_tokens, limit: tokenBudgetConfig.daily_limit, alertThreshold };
      } catch {
        return null;
      }
    });
  }

  // Ensure swarm_tasks table exists (used by Graph API delegations endpoint)
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS swarm_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      wave INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      claimed_by TEXT,
      claimed_at INTEGER,
      completed_at INTEGER,
      result TEXT,
      files_owned TEXT,
      depends_on TEXT,
      retry_count INTEGER DEFAULT 0
    )
  `
  ).run();

  const sessionStore = new SessionStore(db);

  // Initialize channel history with SQLite persistence (Sprint 3 F5)
  initChannelHistory(db);

  const mamaDbPath = expandPath(config.database.path);
  const toolExecutor = new GatewayToolExecutor({
    mamaDbPath: mamaDbPath,
    sessionStore: sessionStore,
    rolesConfig: config.roles, // Pass roles from config.yaml
  });

  // Reasoning collector for Discord display
  let reasoningLog: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let turnCount = 0;
  let autoRecallUsed = false;
  const mamaHome = join(homedir(), '.mama');

  // Sync built-in skills on every start (non-destructive — skips existing files)
  syncBuiltinSkills();

  const personaComplete =
    existsSync(join(mamaHome, 'USER.md')) && existsSync(join(mamaHome, 'SOUL.md'));

  const systemPrompt = '';
  let osCapabilities = '';

  if (!personaComplete) {
    // Onboarding is handled exclusively by the Setup Wizard (/setup).
    // OS agent runs in normal mode — no onboarding prompt injection.
    console.log('⚙️  Onboarding incomplete (use /setup wizard to complete)');
  } else {
    console.log('✓ Persona loaded (chat mode)');
  }

  // OS Agent mode (Viewer context only)
  if (options.osAgentMode === true) {
    const osAgentPath = join(__dirname, '../../agent/os-agent-capabilities.md');
    if (existsSync(osAgentPath)) {
      osCapabilities = readFileSync(osAgentPath, 'utf-8');
      console.log('[start] ✓ OS Agent mode enabled (system control capabilities)');
    }
  }

  const validBackends = ['claude', 'codex-mcp'] as const;
  const rawBackend = config.agent.backend;
  const isValidBackend = validBackends.includes(rawBackend as (typeof validBackends)[number]);
  const runtimeBackend: 'claude' | 'codex-mcp' = isValidBackend
    ? (rawBackend as 'claude' | 'codex-mcp')
    : 'claude';
  if (rawBackend && !isValidBackend) {
    console.warn(`[Config] Unknown backend "${rawBackend}", falling back to "claude"`);
    process.env.MAMA_BACKEND = 'claude';
  }

  // Initialize agent loop with lane-based concurrency and reasoning collection
  // Inherit useCodeAct from Conductor agent config (webchat uses main agentLoop)
  const conductorConfig =
    config.multi_agent?.agents?.conductor || config.multi_agent?.agents?.Conductor;
  const useCodeAct = conductorConfig?.useCodeAct === true;

  const agentLoop = new AgentLoop(oauthManager, {
    backend: runtimeBackend,
    model: config.agent.model,
    timeoutMs: config.agent.timeout,
    maxTurns: config.agent.max_turns,
    useCodeAct,
    toolsConfig: config.agent.tools, // Gateway + MCP hybrid mode
    useLanes: true, // Enable lane-based concurrency for Discord
    // SECURITY MODEL: MAMA OS is a headless daemon — no TTY for interactive permission prompts.
    // Permission enforcement is handled by MAMA's own RoleManager layer:
    //   - config.yaml roles.definitions.*.allowedTools / blockedTools / allowedPaths
    //   - Multi-agent ToolPermissionManager (tier-based tool access)
    //   - Source-based role mapping (viewer=os_agent, discord=chat_bot, etc.)
    // Headless daemon — no TTY for interactive permission prompts.
    // Security is enforced at the API/network layer (auth-middleware), not Claude CLI permissions.
    dangerouslySkipPermissions: config.multi_agent?.dangerouslySkipPermissions ?? true,
    sessionKey: 'default', // Will be updated per message
    systemPrompt: systemPrompt + (osCapabilities ? '\n\n---\n\n' + osCapabilities : ''),
    // Collect reasoning for Discord display
    onTurn: (turn) => {
      turnCount++;
      if (Array.isArray(turn.content)) {
        for (const block of turn.content) {
          if (block.type === 'tool_use') {
            reasoningLog.push(`🔧 ${block.name}`);
          }
        }
      }
    },
    onToolUse: (toolName, _input, result) => {
      // Track tool name (for Code-Act sandbox calls that bypass onTurn)
      if (!reasoningLog.includes(`🔧 ${toolName}`)) {
        reasoningLog.push(`🔧 ${toolName}`);
      }
      // Add tool result summary
      const resultObj = result as { success?: boolean; results?: unknown[]; error?: string };
      if (resultObj?.error) {
        reasoningLog.push(`  ❌ ${resultObj.error}`);
      } else if (resultObj?.results && Array.isArray(resultObj.results)) {
        reasoningLog.push(`  ✓ ${resultObj.results.length} items`);
      } else if (resultObj?.success !== undefined) {
        reasoningLog.push(`  ✓ ${resultObj.success ? 'success' : 'failed'}`);
      }
      console.log(`[Tool] ${toolName} → ${JSON.stringify(result).slice(0, 80)}`);
    },
    onTokenUsage: (record) => {
      try {
        insertTokenUsage(db, record);
      } catch {
        /* ignore */
      }
    },
    onMetric: (name, value, labels) => {
      metricsStore?.record({ name, value, labels });
    },
  });
  console.log('✓ Lane-based concurrency enabled (reasoning collection)');

  // Build reasoning header for Discord
  const buildReasoningHeader = (turns: number, toolsUsed: string[]): string => {
    const parts: string[] = [];
    if (autoRecallUsed) parts.push('📚 Memory');
    if (toolsUsed.length > 0) parts.push(toolsUsed.join(', '));
    parts.push(`⏱️ ${turns} turns`);
    return `||${parts.join(' | ')}||`;
  };

  // Create AgentLoopClient wrapper (adapts AgentLoopResult -> { response })
  // Also sets session key for lane-based concurrency and includes reasoning
  const agentLoopClient = {
    run: async (
      prompt: string,
      options?: {
        userId?: string;
        source?: string;
        channelId?: string;
        systemPrompt?: string;
        model?: string;
      }
    ) => {
      // Reset reasoning log for new request
      reasoningLog = [];
      turnCount = 0;
      autoRecallUsed = false;

      // Set session key for lane-based concurrency
      if (options?.source && options?.channelId) {
        const sessionKey = `${options.source}:${options.channelId}:${options.userId || 'unknown'}`;
        agentLoop.setSessionKey(sessionKey);
      }

      if (runtimeBackend === 'codex-mcp' && options) {
        // Override role-based model selection for Codex-MCP backend
        options.model = config.agent.model;
      }
      const result = await agentLoop.run(prompt, options);

      // Check if auto-recall was used (by checking if relevant-memories was in the history)
      if (result.history && result.history.length > 0) {
        const firstMsg = result.history[0];
        if (firstMsg && Array.isArray(firstMsg.content)) {
          const textContent = firstMsg.content.find((b: { type: string }) => b.type === 'text');
          if (
            textContent &&
            typeof (textContent as { text?: string }).text === 'string' &&
            (textContent as { text: string }).text.includes('<relevant-memories>')
          ) {
            autoRecallUsed = true;
          }
        }
      }

      // Always prepend reasoning header
      const header = buildReasoningHeader(
        result.turns,
        reasoningLog.filter((l) => l.startsWith('🔧'))
      );
      const response = `${header}\n${result.response}`;
      return { response };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runWithContent: async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: any[],
      options?: {
        userId?: string;
        source?: string;
        channelId?: string;
        systemPrompt?: string;
        model?: string;
      }
    ) => {
      // Reset reasoning log for new request
      reasoningLog = [];
      turnCount = 0;
      autoRecallUsed = false;

      // Set session key for lane-based concurrency
      if (options?.source && options?.channelId) {
        const sessionKey = `${options.source}:${options.channelId}:${options.userId || 'unknown'}`;
        agentLoop.setSessionKey(sessionKey);
      }

      console.log(`[AgentLoop] runWithContent called with ${content.length} blocks`);
      if (runtimeBackend === 'codex-mcp' && options) {
        // Override role-based model selection for Codex-MCP backend
        options.model = config.agent.model;
      }
      const result = await agentLoop.runWithContent(content, options);

      // Check if auto-recall was used
      if (result.history && result.history.length > 0) {
        const firstMsg = result.history[0];
        if (firstMsg && Array.isArray(firstMsg.content)) {
          const textContent = firstMsg.content.find((b: { type: string }) => b.type === 'text');
          if (
            textContent &&
            typeof (textContent as { text?: string }).text === 'string' &&
            (textContent as { text: string }).text.includes('<relevant-memories>')
          ) {
            autoRecallUsed = true;
          }
        }
      }

      // Always prepend reasoning header
      const header = buildReasoningHeader(
        result.turns,
        reasoningLog.filter((l) => l.startsWith('🔧'))
      );
      const response = `${header}\n${result.response}`;
      return { response };
    },
  };

  // Initialize message router with MAMA database
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initDB } = require('@jungjaehoon/mama-core/db-manager');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mamaCore = require('@jungjaehoon/mama-core');
  const mamaApi = (
    mamaCore && typeof mamaCore === 'object' && 'mama' in mamaCore ? mamaCore.mama : mamaCore
  ) as {
    suggest?: (query: string, options?: { limit?: number }) => Promise<unknown>;
    search?: (query: string, limit?: number) => Promise<unknown>;
    save?: (input: unknown) => Promise<unknown>;
    update?: (decisionId: string, updates: unknown) => Promise<unknown>;
    updateOutcome?: (decisionId: string, updates: unknown) => Promise<unknown>;
    loadCheckpoint?: () => Promise<unknown>;
    list?: (options?: { limit?: number }) => Promise<unknown>;
    listDecisions?: (options?: { limit?: number }) => Promise<unknown>;
  };
  const suggest = (mamaApi.suggest ?? mamaApi.search) as
    | ((query: string, options?: { limit?: number }) => Promise<unknown>)
    | ((query: string, limit?: number) => Promise<unknown>)
    | undefined;
  const loadCheckpoint = mamaApi.loadCheckpoint;
  const listDecisions = mamaApi.list ?? mamaApi.listDecisions;
  if (!suggest) {
    throw new Error('MAMA API shape is incompatible; failed to initialize memory helpers');
  }

  // Initialize MAMA database first
  await initDB();

  console.log('✓ MAMA memory API available (loaded directly in auto-recall)');

  const search = async (query: string, limit?: number): Promise<unknown> => {
    if (!suggest) {
      throw new Error('MAMA search/suggest API is unavailable');
    }

    try {
      return await (suggest as (q: string, options?: { limit?: number }) => Promise<unknown>)(
        query,
        limit !== undefined ? { limit } : undefined
      );
    } catch (error) {
      const shouldFallback = error instanceof TypeError && /object/i.test(error.message);
      if (!shouldFallback) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      return await (suggest as (q: string, limit?: number) => Promise<unknown>)(query, limit);
    }
  };

  const searchForContext = async (query: string, limit?: number): Promise<SearchResult[]> => {
    const result = await search(query, limit);

    if (!result) {
      return [];
    }

    if (Array.isArray(result)) {
      return result as SearchResult[];
    }

    const wrapped = result as { results?: unknown };
    if (wrapped.results && Array.isArray(wrapped.results)) {
      return wrapped.results as SearchResult[];
    }

    return [];
  };

  const loadCheckpointForContext =
    loadCheckpoint !== undefined
      ? async (): Promise<Checkpoint | null> => {
          const result = await loadCheckpoint();
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return null;
          }

          const checkpointRow = result as {
            id?: unknown;
            timestamp?: unknown;
            summary?: unknown;
            next_steps?: unknown;
            open_files?: unknown;
          };

          if (
            typeof checkpointRow.timestamp !== 'number' &&
            typeof checkpointRow.timestamp !== 'string'
          ) {
            return null;
          }

          const timestamp =
            typeof checkpointRow.timestamp === 'number'
              ? checkpointRow.timestamp
              : Date.parse(checkpointRow.timestamp);
          if (!Number.isFinite(timestamp)) {
            return null;
          }

          const parsedOpenFiles = Array.isArray(checkpointRow.open_files)
            ? checkpointRow.open_files.filter((item): item is string => typeof item === 'string')
            : [];

          return {
            id:
              typeof checkpointRow.id === 'number'
                ? checkpointRow.id
                : Number.isFinite(Number(checkpointRow.id))
                  ? Number(checkpointRow.id)
                  : 0,
            timestamp,
            summary: typeof checkpointRow.summary === 'string' ? checkpointRow.summary : '',
            next_steps:
              typeof checkpointRow.next_steps === 'string' ? checkpointRow.next_steps : undefined,
            open_files: parsedOpenFiles,
          };
        }
      : undefined;

  const listDecisionsForContext =
    listDecisions !== undefined
      ? async (options?: { limit?: number }): Promise<Decision[]> => {
          const result = await listDecisions(options);
          if (!Array.isArray(result)) {
            return [];
          }

          return result as Decision[];
        }
      : undefined;

  // Create MAMA API client for context injection
  // Provides both SessionStart (checkpoint + recent decisions) and UserPromptSubmit (related decisions) functionality
  const mamaApiClient: MamaApiClient = {
    search: searchForContext, // mama-core exports 'suggest' for semantic search
    loadCheckpoint: loadCheckpointForContext,
    listDecisions: listDecisionsForContext,
  };

  const messageRouter = new MessageRouter(sessionStore, agentLoopClient, mamaApiClient, {
    backend: runtimeBackend,
  });

  // Prepare graph handler options (will be populated after gateways init)
  const graphHandlerOptions: GraphHandlerOptions = {
    healthService: healthService ?? undefined,
    healthCheckService,
  };

  // Wire up Code-Act executor for POST /api/code-act endpoint
  // Only register when useCodeAct is enabled; otherwise graph-api returns 501
  if (useCodeAct) {
    // Tier 1: all gateway tools (Codex already has direct Bash/Write access)
    graphHandlerOptions.executeCodeAct = async (code: string) => {
      const { CodeActSandbox, HostBridge } = await import('../../agent/code-act/index.js');
      const sandbox = new CodeActSandbox();
      const bridge = new HostBridge(toolExecutor);
      const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
      bridge.onToolUse = (toolName, input, result) => {
        if (result !== undefined) {
          toolCalls.push({ name: toolName, input });
        }
      };
      bridge.injectInto(sandbox, 1);
      const result = await sandbox.execute(code);
      return {
        success: result.success,
        value: result.value,
        logs: result.logs,
        error: result.error?.message,
        metrics: result.metrics,
        toolCalls,
      };
    };

    // Pre-warm Code-Act WASM module for fast first execution
    (async () => {
      try {
        const { CodeActSandbox } = await import('../../agent/code-act/index.js');
        await CodeActSandbox.warmup();
      } catch (err: unknown) {
        console.warn('[CodeAct] WASM warmup failed (non-fatal):', err);
      }
    })();
  }

  const graphHandler = createGraphHandler(graphHandlerOptions);

  await startEmbeddingServerIfAvailable(messageRouter, sessionStore, graphHandler);

  // Initialize cron scheduler with dedicated CronWorker (isolated from OS agent)
  const cronEmitter = new EventEmitter();
  const cronWorker = new CronWorker({ emitter: cronEmitter });
  const scheduler = new CronScheduler();
  scheduler.setExecuteCallback(async (prompt, job) => {
    console.log(`[Cron] Executing: ${prompt.substring(0, 50)}...`);
    const result = await cronWorker.execute(prompt, {
      jobId: job.id,
      jobName: job.name,
      channel: job.channel,
    });
    console.log(`[Cron] Completed: ${result.substring(0, 100)}...`);
    return result;
  });

  // Load cron jobs from config.yaml scheduling.jobs
  const schedulingConfig = (config as Record<string, unknown>).scheduling as
    | {
        jobs?: Array<{
          id: string;
          name: string;
          cron: string;
          prompt: string;
          enabled?: boolean;
          channel?: string;
          description?: string;
        }>;
      }
    | undefined;
  if (schedulingConfig?.jobs?.length) {
    let loaded = 0;
    for (const job of schedulingConfig.jobs) {
      try {
        scheduler.addJob({
          id: job.id,
          name: job.name,
          cronExpr: job.cron,
          prompt: job.prompt,
          enabled: job.enabled ?? true,
          channel: job.channel,
        });
        loaded++;
      } catch (err) {
        console.warn(
          `[Cron] Failed to load job "${job.id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (loaded > 0) {
      console.log(`✓ Loaded ${loaded} cron job(s) from config`);
    }
  }

  // Track active gateways for cleanup
  const gateways: { stop: () => Promise<void> }[] = [];

  const gatewayMultiAgentConfig = config.multi_agent;
  const gatewayMultiAgentRuntime = {
    backend: runtimeBackend,
    model: config.agent.model,
    effort: config.agent.effort,
    requestTimeout: config.agent.timeout,
    codexCommand: process.env.MAMA_CODEX_COMMAND || process.env.CODEX_COMMAND,
    codexCwd: config.agent.codex_cwd,
    codexSandbox: config.agent.codex_sandbox,
  };

  // Initialize Discord gateway if enabled (before API server for reference)
  let discordGateway: DiscordGateway | null = null;
  if (config.discord?.enabled && config.discord?.token) {
    console.log('Initializing Discord gateway...');
    try {
      const normalizedGuilds = normalizeDiscordGuilds(config.discord.guilds);

      const guildKeys = normalizedGuilds ? Object.keys(normalizedGuilds) : [];
      startLogger.info(
        `Discord config guild keys: ${guildKeys.length ? guildKeys.join(', ') : '(none)'}.`
      );
      startLogger.info(
        `Discord config loaded keys: ${Object.keys(config.discord || {}).join(', ')}`
      );

      discordGateway = new DiscordGateway({
        token: config.discord.token,
        messageRouter,
        defaultChannelId: config.discord.default_channel_id,
        config: normalizedGuilds
          ? {
              guilds: normalizedGuilds,
            }
          : undefined,
        multiAgentConfig: gatewayMultiAgentConfig,
        multiAgentRuntime: gatewayMultiAgentRuntime,
      });

      const gatewayInterface = {
        sendMessage: async (channelId: string, message: string) =>
          discordGateway!.sendMessage(channelId, message),
        sendFile: async (channelId: string, filePath: string, caption?: string) =>
          discordGateway!.sendFile(channelId, filePath, caption),
        sendImage: async (channelId: string, imagePath: string, caption?: string) =>
          discordGateway!.sendFile(channelId, imagePath, caption),
      };

      agentLoop.setDiscordGateway(gatewayInterface);

      // Wire gateway tool executor to multi-agent handler
      const multiAgentDiscord = discordGateway.getMultiAgentHandler();
      if (multiAgentDiscord) {
        toolExecutor.setDiscordGateway(gatewayInterface);
        multiAgentDiscord.setGatewayToolExecutor(toolExecutor);
        console.log('[start] ✓ Gateway tool executor wired to multi-agent handler');
      }

      await discordGateway.start();
      gateways.push(discordGateway);
      console.log('✓ Discord connected');
    } catch (error) {
      console.error(
        `Failed to connect Discord: ${error instanceof Error ? error.message : String(error)}`
      );
      discordGateway = null;
    }
  }

  // Initialize Slack gateway if enabled (native, like Discord)
  let slackGateway: SlackGateway | null = null;
  if (config.slack?.enabled && config.slack?.bot_token && config.slack?.app_token) {
    console.log('Initializing Slack gateway...');
    try {
      slackGateway = new SlackGateway({
        botToken: config.slack.bot_token,
        appToken: config.slack.app_token,
        messageRouter,
        multiAgentConfig: gatewayMultiAgentConfig,
        multiAgentRuntime: gatewayMultiAgentRuntime,
      });

      await slackGateway.start();
      gateways.push(slackGateway);

      // Wire Slack gateway tool executor
      const slackGatewayInterface = {
        sendMessage: async (channelId: string, message: string) =>
          slackGateway!.sendMessage(channelId, message),
        sendFile: async (channelId: string, filePath: string, caption?: string) =>
          slackGateway!.sendFile(channelId, filePath, caption),
        sendImage: async (channelId: string, imagePath: string, caption?: string) =>
          slackGateway!.sendFile(channelId, imagePath, caption),
      };
      toolExecutor.setSlackGateway(slackGatewayInterface);

      const multiAgentSlack = slackGateway.getMultiAgentHandler();
      if (multiAgentSlack) {
        multiAgentSlack.setGatewayToolExecutor(toolExecutor);
        console.log('[start] ✓ Gateway tool executor wired to Slack multi-agent handler');
      }

      console.log('✓ Slack connected');
    } catch (error) {
      console.error(
        `Failed to connect Slack: ${error instanceof Error ? error.message : String(error)}`
      );
      slackGateway = null;
    }
  }

  // Wire gateways into health check service
  if (discordGateway) {
    healthCheckService.addGateway('discord', discordGateway);
  }
  if (slackGateway) {
    healthCheckService.addGateway('slack', slackGateway);
  }

  // Wire cron results directly to gateways (bypasses OS agent entirely)
  // Instantiated for side effects: subscribes to cronEmitter events
  new CronResultRouter({
    emitter: cronEmitter,
    gateways: {
      discord: discordGateway ?? undefined,
      slack: slackGateway ?? undefined,
    },
  });

  // Populate graph handler options with runtime dependencies (F4)
  if (discordGateway || slackGateway) {
    const discordHandler = discordGateway?.getMultiAgentHandler();
    const slackHandler = slackGateway?.getMultiAgentHandler();
    const multiAgentHandler = discordHandler || slackHandler;

    if (multiAgentHandler) {
      // getAgentStates: merge real-time process states from ALL gateways
      graphHandlerOptions.getAgentStates = () => {
        try {
          const merged = new Map<string, string>();
          const priority: Record<string, number> = {
            busy: 3,
            starting: 2,
            idle: 1,
            online: 0,
            dead: -1,
          };

          // Collect from Discord
          if (discordHandler) {
            for (const [id, state] of discordHandler.getProcessManager().getAgentStates()) {
              const existing = merged.get(id);
              if (!existing || (priority[state] ?? 0) > (priority[existing] ?? 0)) {
                merged.set(id, state);
              }
            }
          }
          // Collect from Slack
          if (slackHandler) {
            for (const [id, state] of slackHandler.getProcessManager().getAgentStates()) {
              const existing = merged.get(id);
              if (!existing || (priority[state] ?? 0) > (priority[existing] ?? 0)) {
                merged.set(id, state);
              }
            }
          }

          return merged;
        } catch (err) {
          console.error('[GraphAPI] Failed to get agent states:', err);
          return new Map();
        }
      };

      // Share getAgentStates with health check service
      healthCheckService.setGetAgentStates(graphHandlerOptions.getAgentStates);

      // getSwarmTasks: recent delegations from swarm-db
      graphHandlerOptions.getSwarmTasks = (limit = 20) => {
        try {
          // Query swarm_tasks table directly from mama-sessions.db
          const stmt = db.prepare(`
            SELECT
              id, description, category, wave, status,
              claimed_by, claimed_at, completed_at, result
            FROM swarm_tasks
            WHERE status IN ('completed', 'claimed')
            ORDER BY completed_at DESC, claimed_at DESC
            LIMIT ?
          `);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return stmt.all(limit) as Array<any>;
        } catch (err) {
          console.error('[GraphAPI] Failed to fetch swarm tasks:', err);
          return [];
        }
      };

      // getRecentDelegations: in-memory delegation history from DelegationManager
      graphHandlerOptions.getRecentDelegations = (limit = 20): DelegationHistoryEntry[] => {
        try {
          const delegationManager = multiAgentHandler.getDelegationManager();
          if (!delegationManager) {
            const logger = new DebugLogger('GraphAPI');
            logger.warn('[GraphAPI] DelegationManager not available');
            return [];
          }
          return delegationManager.getRecentDelegations(limit);
        } catch (err) {
          const logger = new DebugLogger('GraphAPI');
          logger.error('[GraphAPI] Failed to fetch recent delegations:', err);
          throw new Error(
            `Failed to fetch recent delegations: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      };

      // Wire delegation chain count into health check
      healthCheckService.setGetActiveDelegationCount(() => {
        try {
          const dm = multiAgentHandler.getDelegationManager();
          return dm ? dm.getActiveDelegationCount() : 0;
        } catch {
          return 0;
        }
      });

      // Apply updated multi-agent config at runtime without full daemon restart.
      graphHandlerOptions.applyMultiAgentConfig = async (rawConfig: Record<string, unknown>) => {
        // Type assertion to MultiAgentConfig (rawConfig comes from validated YAML)
        const nextConfig =
          rawConfig as unknown as import('../../cli/config/types.js').MultiAgentConfig;
        if (discordGateway) {
          await discordGateway.setMultiAgentConfig(nextConfig);
        }
        if (slackGateway) {
          await slackGateway.setMultiAgentConfig(nextConfig);
        }
      };

      // Restart a single agent runtime (rolling restart) after per-agent config updates.
      graphHandlerOptions.restartMultiAgentAgent = async (agentId: string) => {
        const discordHandler = discordGateway?.getMultiAgentHandler();
        const slackHandler = slackGateway?.getMultiAgentHandler();
        discordHandler?.getProcessManager().reloadPersona(agentId);
        slackHandler?.getProcessManager().reloadPersona(agentId);
      };

      // Stop a single agent's processes without restart.
      graphHandlerOptions.stopMultiAgentAgent = async (agentId: string) => {
        const discordHandler = discordGateway?.getMultiAgentHandler();
        const slackHandler = slackGateway?.getMultiAgentHandler();
        discordHandler?.getProcessManager().stopAgentProcesses(agentId);
        slackHandler?.getProcessManager().stopAgentProcesses(agentId);
      };
    }
  }

  // Initialize gateway plugin loader (for additional gateways like Chatwork)
  const pluginLoader = new PluginLoader({
    gatewayConfigs: {
      // Pass gateway configs from main config
      ...(config.chatwork
        ? {
            'chatwork-gateway': {
              enabled: config.chatwork.enabled,
              apiToken: config.chatwork.api_token,
              roomIds: config.chatwork.room_ids,
              pollInterval: config.chatwork.poll_interval,
              mentionRequired: config.chatwork.mention_required,
            },
          }
        : {}),
    },
    agentLoop: {
      run: async (prompt: string) => {
        const result = await agentLoop.run(prompt);
        return { response: result.response };
      },
      runWithContent: async (content) => {
        // Cast to match the expected type (both use same structure)
        console.log(`[AgentLoop] runWithContent called with ${content.length} blocks`);
        const result = await agentLoop.runWithContent(
          content as Parameters<typeof agentLoop.runWithContent>[0]
        );
        return { response: result.response };
      },
    },
  });

  // Discover and load gateway plugins
  try {
    const discoveredPlugins = await pluginLoader.discover();
    if (discoveredPlugins.length > 0) {
      console.log(`Plugins discovered: ${discoveredPlugins.map((p) => p.name).join(', ')}`);
      const pluginGateways = await pluginLoader.loadAll();
      for (const gateway of pluginGateways) {
        try {
          await gateway.start();
          gateways.push(gateway);
          console.log(`✓ Plugin gateway connected: ${gateway.source}`);
        } catch (error) {
          console.error(`Plugin gateway failed (${gateway.source}):`, error);
        }
      }
    }
  } catch (error) {
    console.warn('Plugin loading warning:', error);
  }

  // Initialize heartbeat scheduler
  const heartbeatConfig = config.heartbeat || {};
  const heartbeatScheduler = new HeartbeatScheduler(
    agentLoop,
    {
      interval: heartbeatConfig.interval || 30 * 60 * 1000, // 30 minutes default
      quietStart: heartbeatConfig.quiet_start || 23,
      quietEnd: heartbeatConfig.quiet_end || 8,
      notifyChannelId: heartbeatConfig.notify_channel_id || config.discord?.default_channel_id,
    },
    discordGateway
      ? async (channelId, message) => {
          await discordGateway!.sendMessage(channelId, message);
        }
      : undefined
  );

  if (heartbeatConfig.enabled !== false) {
    heartbeatScheduler.start();
    console.log('✓ Heartbeat scheduler started');
  }

  // Wire scheduler and heartbeat into health check service
  healthCheckService.setCronScheduler(scheduler);
  healthCheckService.setHeartbeat(heartbeatScheduler);

  // Periodic health check warning log (every 5 minutes)
  healthWarningInterval = setInterval(
    async () => {
      try {
        const report = await healthCheckService.check();
        const criticalFails = report.checks.filter(
          (c) => c.severity === 'critical' && c.status === 'fail'
        );
        if (criticalFails.length > 0) {
          startLogger.warn(
            `[Health] ⚠ ${criticalFails.length} critical issue(s): ${criticalFails.map((c) => c.name).join(', ')}`
          );
        }
      } catch {
        /* ignore */
      }
    },
    5 * 60 * 1000
  );

  // Initialize token keep-alive (prevents OAuth token expiration)
  const tokenKeepAlive = new TokenKeepAlive({
    intervalMs: 6 * 60 * 60 * 1000, // 6 hours
    onRefresh: () => {
      console.log('✓ OAuth token kept alive');
    },
    onError: (error) => {
      console.warn(`⚠️ Token refresh warning: ${error.message}`);
    },
  });
  tokenKeepAlive.start();

  // Start API server
  const skillRegistry = new SkillRegistry();
  // Migrate existing plugin .mcp.json into global config (one-time)
  skillRegistry
    .migrateExistingMcpConfigs()
    .catch((err: unknown) => console.warn('[start] MCP config migration warning:', err));
  const apiServer = createApiServer({
    scheduler,
    port: API_PORT,
    db,
    skillRegistry,
    healthService: healthService ?? undefined,
    healthCheckService,
    onHeartbeat: async (prompt) => {
      try {
        await agentLoop.run(prompt);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
    enableAutoKillPort: config.enable_auto_kill_port,
  });

  // Session API endpoints
  apiServer.app.get('/api/sessions/last-active', async (_req, res) => {
    try {
      // Return the most recently active session from the session store
      const sessions = messageRouter.listSessions('viewer');
      if (sessions.length === 0) {
        res.json({ session: null });
        return;
      }
      // Sort by lastActive descending and return the most recent
      const sorted = sessions.sort((a, b) => b.lastActive - a.lastActive);
      res.json({ session: sorted[0] });
    } catch (error) {
      console.error('[Sessions API] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  apiServer.app.get('/api/sessions', async (_req, res) => {
    try {
      const viewerSessions = messageRouter.listSessions('viewer');
      const discordSessions = messageRouter.listSessions('discord');
      const telegramSessions = messageRouter.listSessions('telegram');
      const slackSessions = messageRouter.listSessions('slack');
      res.json({
        viewer: viewerSessions,
        discord: discordSessions,
        telegram: telegramSessions,
        slack: slackSessions,
      });
    } catch (error) {
      console.error('[Sessions API] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Add Discord message sending endpoint
  apiServer.app.post('/api/discord/send', requireAuth, async (req, res) => {
    try {
      const { channelId, message } = req.body;
      if (!channelId || !message) {
        res.status(400).json({ error: 'channelId and message are required' });
        return;
      }
      if (!discordGateway) {
        res.status(503).json({ error: 'Discord gateway not connected' });
        return;
      }
      console.log(`[Discord Send] Sending to ${channelId}: ${message.substring(0, 50)}...`);
      await discordGateway.sendMessage(channelId, message);
      console.log(`[Discord Send] Success`);
      res.json({ success: true });
    } catch (error) {
      console.error('[Discord Send] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Add Slack message/file sending endpoint
  apiServer.app.post('/api/slack/send', requireAuth, async (req, res) => {
    try {
      const { channelId, message, filePath, caption } = req.body;
      if (!channelId || (!message && !filePath)) {
        res.status(400).json({ error: 'channelId and (message or filePath) are required' });
        return;
      }
      if (!slackGateway) {
        res.status(503).json({ error: 'Slack gateway not connected' });
        return;
      }
      if (filePath) {
        // SECURITY: Path traversal prevention (same pattern as /api/discord/image)
        const fsMod = await import('fs/promises');
        const workspacePath =
          config.workspace?.path?.replace('~', process.env.HOME || '') ||
          `${process.env.HOME}/.mama/workspace`;
        const tempPath = path.join(workspacePath, 'temp');
        const tmpPath = '/tmp';

        const resolvedFilePath = path.isAbsolute(filePath)
          ? path.resolve(filePath)
          : path.resolve(workspacePath, filePath);
        const normalizedWorkspace = path.resolve(workspacePath);
        const normalizedTemp = path.resolve(tempPath);

        const isInWorkspace = resolvedFilePath.startsWith(normalizedWorkspace + path.sep);
        const isInTemp = resolvedFilePath.startsWith(normalizedTemp + path.sep);
        const isInTmp = resolvedFilePath.startsWith(tmpPath + '/');

        if (!isInWorkspace && !isInTemp && !isInTmp) {
          console.warn(
            `[Slack Send] SECURITY: Path traversal blocked: ${filePath} -> ${resolvedFilePath}`
          );
          res
            .status(400)
            .json({ error: 'File path must be within workspace, workspace/temp, or /tmp' });
          return;
        }

        // Block sensitive file types
        const deniedExtensions = ['.db', '.key', '.pem', '.env', '.sqlite', '.sqlite3'];
        const ext = path.extname(resolvedFilePath).toLowerCase();
        if (deniedExtensions.includes(ext)) {
          console.warn(`[Slack Send] SECURITY: Denied file type blocked: ${ext}`);
          res.status(400).json({ error: 'File type not allowed' });
          return;
        }

        try {
          await fsMod.access(resolvedFilePath);
        } catch {
          res.status(404).json({ error: 'File not found' });
          return;
        }

        console.log(`[Slack Send] Sending file to ${channelId}: ${resolvedFilePath}`);
        await slackGateway.sendFile(channelId, resolvedFilePath, caption);
      }
      if (message) {
        console.log(`[Slack Send] Sending to ${channelId}: ${message.substring(0, 50)}...`);
        await slackGateway.sendMessage(channelId, message);
      }
      console.log(`[Slack Send] Success`);
      res.json({ success: true });
    } catch (error) {
      console.error('[Slack Send] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Add Discord cron job endpoint (run prompt and send result to Discord)
  apiServer.app.post('/api/discord/cron', requireAuth, async (req, res) => {
    try {
      const { channelId, prompt } = req.body;
      if (!channelId || !prompt) {
        res.status(400).json({ error: 'channelId and prompt are required' });
        return;
      }
      if (!discordGateway) {
        res.status(503).json({ error: 'Discord gateway not connected' });
        return;
      }
      console.log(`[Discord Cron] Executing: ${prompt.substring(0, 50)}...`);
      const result = await agentLoop.run(prompt);
      await discordGateway.sendMessage(channelId, result.response);
      console.log(`[Discord Cron] Sent to Discord channel ${channelId}`);
      res.json({ success: true, response: result.response.substring(0, 100) + '...' });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Report endpoint - collect data and generate report (OpenClaw migration)
  apiServer.app.post('/api/report', requireAuth, async (req, res) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const fs = await import('fs/promises');

    try {
      const { channelId, reportType = 'delta' } = req.body;
      if (!channelId) {
        res.status(400).json({ error: 'channelId is required' });
        return;
      }
      if (!discordGateway) {
        res.status(503).json({ error: 'Discord gateway not connected' });
        return;
      }

      console.log(`[Heartbeat] Starting ${reportType} report...`);

      // Get paths from config (with fallbacks)
      const workspacePath =
        config.workspace?.path?.replace('~', process.env.HOME || '') ||
        `${process.env.HOME}/.mama/workspace`;
      const collectScript =
        config.integrations?.heartbeat?.collect_script?.replace('~', process.env.HOME || '') ||
        `${workspacePath}/scripts/heartbeat-collect.sh`;
      const dataFile =
        config.integrations?.heartbeat?.data_file?.replace('~', process.env.HOME || '') ||
        `${workspacePath}/data/heartbeat-report.json`;
      const templateFile =
        config.integrations?.heartbeat?.template_file?.replace('~', process.env.HOME || '') ||
        `${workspacePath}/HEARTBEAT.md`;

      // 1. Run heartbeat-collect.sh
      console.log('[Heartbeat] Collecting data...');
      await execAsync(`bash ${collectScript}`, {
        timeout: 60000,
        cwd: workspacePath,
      });

      // 2. Read collected data (limit to 50KB to fit in prompt)
      let jsonData = await fs.readFile(dataFile, 'utf-8');
      if (jsonData.length > 50000) {
        console.log(`[Heartbeat] JSON too large (${jsonData.length}), truncating to 50KB`);
        jsonData = jsonData.substring(0, 50000) + '\n... (truncated)';
      }
      const heartbeatMd = await fs.readFile(templateFile, 'utf-8');

      // 3. Generate report with Claude
      console.log('[Heartbeat] Generating report...');
      const prompt = `Here is the collected work data. Please write a ${reportType === 'full' ? 'comprehensive report' : 'delta report'} following the report format in HEARTBEAT.md.

## HEARTBEAT.md (Report Format)
${heartbeatMd}

## Collected Data (JSON)
${jsonData}

${
  reportType === 'full'
    ? '📋 Write a comprehensive report. Include all project status.'
    : '🔔 Write a delta report. If there are no new messages, respond with HEARTBEAT_OK only.'
}

Keep the report under 2000 characters as it will be sent to Discord.`;

      const result = await agentLoop.run(prompt);
      console.log(`[Heartbeat] Claude response length: ${result.response?.length || 0}`);
      console.log(`[Heartbeat] Response preview: ${result.response?.substring(0, 100) || 'EMPTY'}`);

      // 4. Send to Discord
      if (!result.response || result.response.trim() === '') {
        console.error('[Heartbeat] Empty response from Claude');
        res.status(500).json({ error: 'Empty response from Claude' });
        return;
      }
      console.log('[Heartbeat] Sending to Discord...');
      await discordGateway.sendMessage(channelId, result.response);

      console.log('[Heartbeat] Complete');
      res.json({ success: true, reportType, response: result.response.substring(0, 200) + '...' });
    } catch (error) {
      console.error('[Heartbeat] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Screenshot endpoint - take HTML screenshot and send to Discord
  apiServer.app.post('/api/screenshot', requireAuth, async (req, res) => {
    const { spawn } = await import('child_process');
    const path = await import('path');

    try {
      const { channelId, htmlFile, caption } = req.body;
      if (!channelId || !htmlFile) {
        res.status(400).json({ error: 'channelId and htmlFile are required' });
        return;
      }
      if (!discordGateway) {
        res.status(503).json({ error: 'Discord gateway not connected' });
        return;
      }

      const workspacePath =
        config.workspace?.path?.replace('~', process.env.HOME || '') ||
        `${process.env.HOME}/.mama/workspace`;

      // SECURITY P0: Path traversal prevention
      if (path.isAbsolute(htmlFile)) {
        res.status(400).json({ error: 'Absolute paths not allowed' });
        return;
      }

      const resolvedPath = path.resolve(workspacePath, htmlFile);
      const normalizedWorkspace = path.resolve(workspacePath);

      if (!resolvedPath.startsWith(normalizedWorkspace + path.sep)) {
        res.status(400).json({ error: 'Path traversal detected' });
        return;
      }

      const fs = await import('fs/promises');
      try {
        await fs.access(resolvedPath);
      } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const allowedExtensions = ['.html', '.htm'];
      if (!allowedExtensions.some((ext) => resolvedPath.toLowerCase().endsWith(ext))) {
        res.status(400).json({ error: 'Only HTML files allowed' });
        return;
      }

      const htmlPath = resolvedPath;
      const outputPath = `${workspacePath}/temp/screenshot-${Date.now()}.png`;

      console.log(`[Screenshot] Taking screenshot of: ${htmlPath}`);

      // SECURITY P0: never shell out. Use spawn with args to avoid injection.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'node',
          [`${workspacePath}/scripts/html-screenshot.mjs`, htmlPath, outputPath],
          {
            cwd: workspacePath,
            stdio: 'ignore',
          }
        );

        let settled = false;
        const timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error('Screenshot script timed out after 30000ms'));
        }, 30000);

        child.on('error', (err) => {
          clearTimeout(timeoutId);
          if (settled) return;
          settled = true;
          reject(err);
        });

        child.on('exit', (code, signal) => {
          clearTimeout(timeoutId);
          if (settled) return;
          settled = true;

          if (code === 0) {
            resolve();
            return;
          }

          reject(
            new Error(`Screenshot script failed: code=${code ?? 'null'} signal=${signal ?? 'null'}`)
          );
        });
      });

      // Send to Discord
      console.log(`[Screenshot] Sending to Discord: ${outputPath}`);
      await discordGateway.sendFile(channelId, outputPath, caption);

      console.log('[Screenshot] Complete');
      res.json({ success: true, screenshot: outputPath });
    } catch (error) {
      console.error('[Screenshot] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Send image endpoint
  // SECURITY P0: Path traversal prevention with 4-layer validation
  apiServer.app.post('/api/discord/image', requireAuth, async (req, res) => {
    const path = await import('path');
    const fs = await import('fs/promises');
    try {
      const { channelId, imagePath, caption } = req.body;
      if (!channelId || !imagePath) {
        res.status(400).json({ error: 'channelId and imagePath are required' });
        return;
      }
      if (!discordGateway) {
        res.status(503).json({ error: 'Discord gateway not connected' });
        return;
      }

      // SECURITY P0: 4-layer path validation
      const workspacePath =
        config.workspace?.path?.replace('~', process.env.HOME || '') ||
        `${process.env.HOME}/.mama/workspace`;
      const tempPath = path.join(workspacePath, 'temp');
      const tmpPath = '/tmp';

      // Layer 1: Reject absolute paths (unless in allowed directories)
      if (path.isAbsolute(imagePath)) {
        const normalizedInput = path.normalize(imagePath);
        const isInWorkspace = normalizedInput.startsWith(path.resolve(workspacePath) + path.sep);
        const isInTemp = normalizedInput.startsWith(path.resolve(tempPath) + path.sep);
        const isInTmp = normalizedInput.startsWith(tmpPath + path.sep);
        if (!isInWorkspace && !isInTemp && !isInTmp) {
          console.warn(`[Discord Image] SECURITY: Absolute path blocked: ${imagePath}`);
          res
            .status(400)
            .json({ error: 'Absolute paths only allowed in workspace, workspace/temp, or /tmp' });
          return;
        }
      }

      // Layer 2: Resolve and verify within allowed directories
      const resolvedImagePath = path.isAbsolute(imagePath)
        ? path.resolve(imagePath)
        : path.resolve(workspacePath, imagePath);
      const normalizedWorkspace = path.resolve(workspacePath);
      const normalizedTemp = path.resolve(tempPath);

      const isInWorkspace = resolvedImagePath.startsWith(normalizedWorkspace + path.sep);
      const isInTemp = resolvedImagePath.startsWith(normalizedTemp + path.sep);
      const isInTmp = resolvedImagePath.startsWith(tmpPath + path.sep);

      if (!isInWorkspace && !isInTemp && !isInTmp) {
        console.warn(
          `[Discord Image] SECURITY: Path traversal blocked: ${imagePath} -> ${resolvedImagePath}`
        );
        res.status(400).json({ error: 'Path traversal detected' });
        return;
      }

      // Layer 3: Verify file exists
      try {
        await fs.access(resolvedImagePath);
      } catch {
        res.status(404).json({ error: 'Image file not found' });
        return;
      }

      // Layer 4: Whitelist extensions
      const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
      if (!allowedExtensions.some((ext) => resolvedImagePath.toLowerCase().endsWith(ext))) {
        console.warn(`[Discord Image] SECURITY: Invalid extension blocked: ${resolvedImagePath}`);
        res
          .status(400)
          .json({ error: 'Only image files allowed (.png, .jpg, .jpeg, .gif, .webp)' });
        return;
      }

      console.log(`[Discord Image] Sending: ${resolvedImagePath}`);
      await discordGateway.sendFile(channelId, resolvedImagePath, caption);

      console.log('[Discord Image] Complete');
      res.json({ success: true });
    } catch (error) {
      console.error('[Discord Image] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Upload/download media endpoints
  apiServer.app.use('/api', createUploadRouter());

  // Auth gate for /graph/* write endpoints (not covered by /api middleware)
  apiServer.app.use('/graph', (req, res, next) => {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isRead && !isAuthenticated(req)) {
      res.status(401).json({
        error: true,
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      });
      return;
    }
    next();
  });

  apiServer.app.use(async (req, res, next) => {
    const handled = await graphHandler(req, res);
    if (!handled) next();
  });

  apiServer.app.use((req, res, next) => {
    if (req.path.startsWith('/api/session')) {
      const bodyData = req.body ? JSON.stringify(req.body) : '';
      const options = {
        hostname: 'localhost',
        port: EMBEDDING_PORT,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `localhost:${EMBEDDING_PORT}`,
          'content-length': Buffer.byteLength(bodyData),
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proxy = http.request(options, (proxyRes: any) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });
      if (bodyData) {
        proxy.write(bodyData);
      }
      proxy.end();
      proxy.on('error', (error: Error) => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to proxy session API', details: error.message });
        }
      });
    } else {
      next();
    }
  });
  console.log(`✓ Session API proxied to port ${EMBEDDING_PORT}`);

  const publicDir = path.join(__dirname, '..', '..', '..', 'public');

  // Playground static serving + API
  const playgroundsDir = path.join(homedir(), '.mama', 'workspace', 'playgrounds');
  try {
    mkdirSync(playgroundsDir, { recursive: true });
  } catch (err) {
    startLogger.warn(
      `Failed to create playgrounds dir, skipping seeding: ${err instanceof Error ? err.message : String(err)}`
    );
    // DO NOT return — continue with the rest of runAgentLoop
  }

  // Seed built-in playgrounds from templates
  try {
    const pgTemplatesDir = path.join(__dirname, '..', '..', '..', 'templates', 'playgrounds');
    if (existsSync(pgTemplatesDir)) {
      const pgEntries = readdirSync(pgTemplatesDir);
      let pgSynced = 0;
      const indexPath = path.join(playgroundsDir, 'index.json');
      let index: Array<{ name: string; slug: string; description: string; created_at: string }> =
        [];
      try {
        if (existsSync(indexPath)) {
          const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
          if (!Array.isArray(parsed)) {
            throw new Error(`index.json must be an array, got ${typeof parsed}`);
          }
          index = parsed;
        }
      } catch (err) {
        startLogger.warn(`[seedBuiltinPlaygrounds] Failed to parse index.json, rebuilding: ${err}`);
        index = [];
      }
      const existingSlugs = new Set(index.map((e) => e.slug));
      let indexRepaired = false;

      for (const file of pgEntries) {
        if (!file.endsWith('.html')) continue;
        const dest = path.join(playgroundsDir, file);
        const slug = file.replace('.html', '');

        // Copy file if it doesn't exist
        if (!existsSync(dest)) {
          copyFileSync(path.join(pgTemplatesDir, file), dest);
          pgSynced++;
        }

        // Add to index if slug doesn't exist (decouple from file copy)
        if (!existingSlugs.has(slug)) {
          const name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          index.push({
            name,
            slug,
            description: `Built-in ${name}`,
            created_at: new Date().toISOString(),
          });
          existingSlugs.add(slug);
          indexRepaired = true;
        }
      }

      if (pgSynced > 0 || indexRepaired) {
        writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
        if (pgSynced > 0 && indexRepaired) {
          console.log(`✓ Seeded ${pgSynced} built-in playground(s) and repaired index`);
        } else if (pgSynced > 0) {
          console.log(`✓ Seeded ${pgSynced} built-in playground(s)`);
        } else {
          console.log('✓ Repaired built-in playground index');
        }
      }
    }
  } catch (err) {
    // Non-blocking: playground seeding is optional
    console.warn('[seedBuiltinPlaygrounds] Playground seeding failed (non-fatal):', err);
  }

  // === Daemon Log API ===
  apiServer.app.get('/api/logs/daemon', (req, res) => {
    const logPath = path.join(homedir(), '.mama', 'logs', 'daemon.log');
    if (!existsSync(logPath)) {
      res.status(404).json({ error: 'daemon.log not found' });
      return;
    }
    try {
      const stat = statSync(logPath);
      const since = parseInt(req.query.since as string, 10) || 0;
      if (since > 0 && stat.mtimeMs <= since) {
        res.status(304).end();
        return;
      }
      const requestedTail = parseInt(req.query.tail as string, 10);
      const tail = Math.min(Math.max(isNaN(requestedTail) ? 200 : requestedTail, 1), 5000);

      const chunkSize = Math.min(stat.size, tail * 300);
      const buffer = Buffer.alloc(chunkSize);
      const fd = openSync(logPath, 'r');
      try {
        readSync(fd, buffer, 0, chunkSize, Math.max(0, stat.size - chunkSize));
      } finally {
        closeSync(fd);
      }
      const raw = buffer.toString('utf-8');

      const allLines = raw.split('\n').filter((l) => l.trim());
      const lines = allLines.slice(-tail);
      const isFullFile = chunkSize >= stat.size;
      res.json({
        lines,
        total: isFullFile ? allLines.length : undefined,
        totalBytes: stat.size,
        mtime: stat.mtimeMs,
        truncated: !isFullFile,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  apiServer.app.use('/playgrounds', express.static(playgroundsDir));

  apiServer.app.get('/api/playgrounds', (_req, res) => {
    const indexPath = path.join(playgroundsDir, 'index.json');
    try {
      if (!existsSync(indexPath)) {
        // Self-heal: rebuild index from existing HTML files
        const htmlFiles = readdirSync(playgroundsDir)
          .filter((f) => f.endsWith('.html'))
          .map((f) => {
            const slug = f.replace('.html', '');
            const name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
            return {
              name,
              slug,
              description: `Playground: ${name}`,
              created_at: new Date().toISOString(),
            };
          });
        if (htmlFiles.length > 0) {
          writeFileSync(indexPath, JSON.stringify(htmlFiles, null, 2), 'utf-8');
          res.json(htmlFiles);
        } else {
          res.json([]);
        }
        return;
      }
      const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
      res.json(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn('[GET /api/playgrounds] Failed to read playground index (non-fatal):', err);
      res.json([]);
    }
  });

  apiServer.app.delete('/api/playgrounds/:slug', requireAuth, (req, res) => {
    const slug = req.params.slug as string;
    if (!slug || /[^a-z0-9-]/.test(slug)) {
      res.status(400).json({ error: 'Invalid slug' });
      return;
    }
    const htmlPath = path.join(playgroundsDir, `${slug}.html`);
    const indexPath = path.join(playgroundsDir, 'index.json');
    try {
      if (existsSync(htmlPath)) unlinkSync(htmlPath);
      if (existsSync(indexPath)) {
        const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
        const updated = Array.isArray(index)
          ? index.filter((e: { slug: string }) => e.slug !== slug)
          : [];
        writeFileSync(indexPath, JSON.stringify(updated, null, 2), 'utf-8');
      }
      res.json({ success: true });
    } catch (err) {
      const safeMsg = (err instanceof Error ? err.message : String(err))
        .replace(/\/home\/[^/]+/g, '~') // Linux
        .replace(/\/Users\/[^/]+/g, '~') // macOS
        .replace(/C:\\Users\\[^\\]+/gi, '~'); // Windows
      res.status(500).json({ error: `Failed to delete playground: ${safeMsg}` });
    }
  });
  console.log('✓ Playground API available at /api/playgrounds');

  // Workspace skill file read API
  const skillsWorkDir = path.join(homedir(), '.mama', 'workspace', 'skills');
  apiServer.app.get('/api/workspace/skills', (_req, res) => {
    try {
      if (!existsSync(skillsWorkDir)) {
        res.json({ skills: [] });
        return;
      }
      const dirs = readdirSync(skillsWorkDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const mdPath = path.join(skillsWorkDir, d.name, 'SKILL.md');
          const exists = existsSync(mdPath);
          return { id: d.name, exists };
        })
        .filter((s) => s.exists)
        .map(({ id }) => ({ id }));
      res.json({ skills: dirs });
    } catch (err) {
      console.warn('[GET /api/workspace/skills] Failed to read skills directory (non-fatal):', err);
      res.json({ skills: [] });
    }
  });

  apiServer.app.get('/api/workspace/skills/:name/content', (req, res) => {
    const name = req.params.name as string;
    if (!name || /[^a-zA-Z0-9_-]/.test(name)) {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }
    const mdPath = path.join(skillsWorkDir, name, 'SKILL.md');
    try {
      if (!existsSync(mdPath)) {
        res.status(404).json({ error: 'Skill not found' });
        return;
      }
      const content = readFileSync(mdPath, 'utf-8');
      res.json({ content });
    } catch (err) {
      startLogger.warn('[GET /api/workspace/skills/:name/content] Failed to read skill:', err);
      res.status(500).json({ error: 'Failed to read skill content' });
    }
  });
  console.log('✓ Workspace Skills API available at /api/workspace/skills');

  // Serve setup page at /setup route
  apiServer.app.get('/setup', (_req, res) => {
    res.sendFile(path.join(publicDir, 'setup.html'));
  });

  apiServer.app.use(
    express.static(publicDir, {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      },
    })
  );
  console.log('✓ Viewer UI available at /viewer');
  console.log('✓ Setup wizard available at /setup');

  // Wait for API port to become available (previous daemon may still be shutting down).
  // DO NOT kill processes on this port — that causes restart loops when Watchdog spawns
  // a new daemon while the old one is still releasing the port. Port cleanup is the
  // responsibility of `mama stop`, not daemon startup.
  const apiPortAvailable = await waitForPortAvailable(API_PORT, 20000);
  if (!apiPortAvailable) {
    console.error(
      `[API] Port ${API_PORT} still in use after 20s. Previous daemon may still be shutting down. ` +
        `Exiting — ${process.env.MAMA_DAEMON ? 'Watchdog will retry automatically.' : 'Run "mama stop" first, then retry.'}`
    );
    process.exit(1);
  }

  await apiServer.start();
  console.log(`API server started: http://localhost:${apiServer.port}`);

  if (apiServer.server) {
    // Setup WebSocket - use noServer mode to avoid conflict
    const setupWss = new WebSocketServer({ noServer: true });
    createSetupWebSocketHandler(setupWss);
    console.log('✓ Setup WebSocket handler ready for /setup-ws');

    // Handle ALL WebSocket upgrades manually
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiServer.server.on('upgrade', (request: any, socket: any, head: any) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);

      // WebSocket auth: require token for non-localhost connections
      // Browsers can't set Authorization headers on WebSocket, so localhost is allowed
      const adminToken = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
      if (adminToken && !isLocalRequest(request) && !isAuthenticated(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (url.pathname === '/setup-ws') {
        // Handle setup WebSocket locally
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setupWss.handleUpgrade(request, socket, head, (ws: any) => {
          setupWss.emit('connection', ws, request);
        });
      } else if (url.pathname === '/ws') {
        // Proxy chat WebSocket to embedding server
        const options = {
          hostname: '127.0.0.1',
          port: EMBEDDING_PORT,
          path: request.url,
          method: 'GET',
          headers: {
            ...request.headers,
            host: `127.0.0.1:${EMBEDDING_PORT}`,
          },
        };

        const proxyReq = http.request(options);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proxyReq.on('upgrade', (proxyRes: any, proxySocket: any, _proxyHead: any) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n` +
              `Sec-WebSocket-Accept: ${proxyRes.headers['sec-websocket-accept']}\r\n` +
              `\r\n`
          );
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });
        proxyReq.on('error', (err: Error) => {
          console.error('[WS Proxy] Error:', err.message);
          socket.destroy();
        });
        proxyReq.end();
      } else {
        // Unknown WebSocket path - close connection
        socket.destroy();
      }
    });
    console.log(
      `✓ WebSocket upgrade handler registered (/ws → ${EMBEDDING_PORT}, /setup-ws local)`
    );
  }

  gateways.push(apiServer);

  // Handle graceful shutdown with timeout
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // Prevent double shutdown
    shuttingDown = true;
    console.log('\n\n🛑 Shutting down MAMA...');

    // Clear periodic intervals
    if (metricsInterval) {
      clearInterval(metricsInterval);
    }
    if (healthWarningInterval) {
      clearInterval(healthWarningInterval);
    }

    // Force exit after 5 seconds if graceful shutdown hangs
    // exit(0) = intentional stop; systemd Restart=on-failure should NOT restart
    setTimeout(() => {
      console.error('[MAMA] Graceful shutdown timed out, forcing exit');
      process.exit(0);
    }, 5000);

    try {
      // Stop schedulers and cron worker first
      scheduler.shutdown();
      await cronWorker.stop();
      heartbeatScheduler.stop();
      tokenKeepAlive.stop();

      // Close embedding server (port 3849) - drain connections first
      if (embeddingServer) {
        embeddingServer.closeAllConnections();
        embeddingServer.close();
      }

      // Stop all gateways with per-gateway 2s timeout
      const withTimeout = (p: Promise<void>, ms: number) =>
        Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
      await Promise.allSettled(gateways.map((g) => withTimeout(g.stop(), 2000)));

      // Stop plugin gateways
      await withTimeout(
        pluginLoader.stopAll().catch(() => {}),
        1000
      );

      // Stop agent loop
      agentLoop.stop();

      // Release all CLI sessions
      getSessionPool().dispose();

      // Close session database
      sessionStore.close();

      // Stop metrics cleanup
      metricsCleanup?.stop();

      const { deletePid } = await import('../utils/pid-manager.js');
      await deletePid();
    } catch (error) {
      // Best effort cleanup
      console.warn('[MAMA] Cleanup error during shutdown:', error);
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Ignore SIGHUP (sent when terminal closes) - daemon should keep running
  process.on('SIGHUP', () => {
    console.log('[MAMA] Received SIGHUP - ignoring (daemon mode)');
  });

  // Handle uncaught errors to prevent crashes
  process.on('uncaughtException', (error) => {
    console.error('[MAMA] Uncaught exception:', error);
    // Don't exit - try to keep running
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[MAMA] Unhandled rejection:', reason);
    // Don't exit - try to keep running
  });

  console.log('MAMA agent is waiting...\n');

  // Keep process alive using setInterval
  // This ensures the Node.js event loop stays active
  setInterval(() => {
    // Heartbeat - keeps the process running
  }, 30000); // Every 30 seconds
}
