/**
 * mama start command
 *
 * Start MAMA agent daemon
 */

import { spawn, exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import Database from 'better-sqlite3';
import express from 'express';
import path, { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { loadConfig, configExists, expandPath } from '../config/config-manager.js';
import { writePid, isDaemonRunning } from '../utils/pid-manager.js';
import { OAuthManager } from '../../auth/index.js';
import { AgentLoop } from '../../agent/index.js';
import { GatewayToolExecutor } from '../../agent/gateway-tool-executor.js';
import { DiscordGateway, SessionStore, MessageRouter, PluginLoader } from '../../gateways/index.js';
import { CronScheduler, TokenKeepAlive } from '../../scheduler/index.js';
import { HeartbeatScheduler } from '../../scheduler/heartbeat.js';
import { createApiServer } from '../../api/index.js';
import { createSetupWebSocketHandler } from '../../setup/setup-websocket.js';
import { getResumeContext, isOnboardingInProgress } from '../../onboarding/onboarding-state.js';

const { createGraphHandler } = require('../../api/graph-api.js');
import http from 'node:http';

// MAMA embedding server (keeps model in memory)
let embeddingServer: any = null;

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
            // SECURITY P1: Validate health response before reuse
            if (health.chatEnabled && health.status === 'ok' && health.modelLoaded) {
              // Fully functional server, reuse it
              console.log('✓ Fully functional embedding server (reusing)');
              resolve(true);
            } else if (health.status === 'ok') {
              // Server healthy but incomplete features
              if (!health.modelLoaded) {
                console.warn('[EmbeddingServer] Warning: Model not loaded');
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
                  const portAvailable = await waitForPortAvailable(port, 5000);
                  if (portAvailable) {
                    console.log('[EmbeddingServer] Port available, proceeding');
                  } else {
                    console.warn('[EmbeddingServer] Port still in use after 5s, proceeding anyway');
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
  messageRouter?: any,
  sessionStore?: any,
  graphHandler?: any
): Promise<void> {
  const port = 3847;

  try {
    // Check if server already running
    const existingHasChat = await checkAndTakeoverExistingServer(port);
    if (existingHasChat) {
      // Another Standalone is running with chat, no need to start
      return;
    }

    const embeddingServerModule = require('@jungjaehoon/mama-core/embedding-server');
    embeddingServer = await embeddingServerModule.startEmbeddingServer(port, {
      messageRouter,
      sessionStore,
      graphHandler,
    });
    if (embeddingServer) {
      console.log('✓ Embedding server started (port 3847)');
      if (messageRouter && sessionStore) {
        console.log('✓ Mobile Chat integrated with MessageRouter');
      }
      await embeddingServerModule.warmModel();
      console.log('✓ Embedding model preloaded');
    }
  } catch (err: any) {
    console.warn('[EmbeddingServer] Failed to start (optional):', err.message);
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

  // Check config exists
  if (!configExists()) {
    console.log('⚠️  Config file not found.');
    console.log('   Initialize first: mama init\n');
    process.exit(1);
  }

  // Load config
  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    console.error(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  if (!config.use_claude_cli) {
    process.stdout.write('Checking OAuth token... ');
    try {
      const oauthManager = new OAuthManager();
      await oauthManager.getToken();
      console.log('✓');
    } catch (error) {
      console.log('❌');
      console.error(
        `\nOAuth token error: ${error instanceof Error ? error.message : String(error)}`
      );
      console.error('Please log in again to Claude Code.\n');
      process.exit(1);
    }
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
      ? 'http://localhost:3847/setup'
      : 'http://localhost:3847/viewer';
    setTimeout(() => {
      if (needsOnboarding) {
        console.log('🎭 First-time setup - Opening onboarding wizard...\n');
      } else {
        console.log('🌐 Opening MAMA OS...\n');
      }
      openBrowser(targetUrl);
    }, 3000); // Wait for embedding server

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
        ? 'http://localhost:3847/setup'
        : 'http://localhost:3847/viewer';

      // Wait for server to be ready
      setTimeout(() => {
        if (needsOnboarding) {
          console.log('🎭 First-time setup - Opening onboarding wizard...\n');
        } else {
          console.log('🌐 Opening MAMA OS...\n');
        }
        openBrowser(targetUrl);
      }, 2000); // Wait 2 seconds for embedding server to start
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
 * Start daemon process
 */
async function startDaemon(): Promise<number> {
  const { mkdirSync, openSync } = await import('node:fs');
  const { homedir } = await import('node:os');

  // Ensure log directory exists
  const logDir = `${homedir()}/.mama/logs`;
  mkdirSync(logDir, { recursive: true });

  const logFile = `${logDir}/daemon.log`;
  const out = openSync(logFile, 'a');

  // Spawn daemon process directly
  const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: homedir(),
    env: {
      ...process.env,
      MAMA_DAEMON: '1',
    },
  });

  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn daemon process');
  }

  // Give daemon a moment to start
  await new Promise((resolve) => setTimeout(resolve, 500));

  await writePid(child.pid);
  return child.pid;
}

/**
 * Run agent loop (for foreground and daemon mode)
 */
export async function runAgentLoop(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: { osAgentMode?: boolean } = {}
): Promise<void> {
  // Claude CLI is always used (Pi Agent removed for ToS compliance)
  console.log('✓ Claude CLI mode (ToS compliance)');

  const oauthManager = new OAuthManager();

  // Initialize database for session storage
  const dbPath = expandPath(config.database.path).replace('mama-memory.db', 'mama-sessions.db');
  const db = new Database(dbPath);
  const sessionStore = new SessionStore(db);

  const mamaDbPath = expandPath(config.database.path);
  const toolExecutor = new GatewayToolExecutor({
    mamaDbPath: mamaDbPath,
    sessionStore: sessionStore,
  });
  void toolExecutor;

  // Reasoning collector for Discord display
  let reasoningLog: string[] = [];
  let turnCount = 0;
  let autoRecallUsed = false;

  const mamaHome = join(homedir(), '.mama');
  const personaComplete =
    existsSync(join(mamaHome, 'USER.md')) && existsSync(join(mamaHome, 'SOUL.md'));

  let systemPrompt = '';
  let osCapabilities = '';

  if (!personaComplete) {
    console.log('⚙️  Onboarding mode (persona not found)');
    const {
      COMPLETE_AUTONOMOUS_PROMPT,
    } = require('../../onboarding/complete-autonomous-prompt.js');
    systemPrompt = COMPLETE_AUTONOMOUS_PROMPT;

    // Check for resume context (interrupted onboarding)
    if (isOnboardingInProgress()) {
      const resumeContext = getResumeContext();
      if (resumeContext) {
        console.log('📋 Resuming previous onboarding session...');
        systemPrompt += '\n\n---\n\n' + resumeContext;
      }
    }
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

  // Initialize agent loop with lane-based concurrency and reasoning collection
  const agentLoop = new AgentLoop(oauthManager, {
    model: config.agent.model,
    maxTurns: config.agent.max_turns,
    useLanes: true, // Enable lane-based concurrency for Discord
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
      // Add tool result summary
      const resultObj = result as { success?: boolean; results?: unknown[]; error?: string };
      if (resultObj.error) {
        reasoningLog.push(`  ❌ ${resultObj.error}`);
      } else if (resultObj.results && Array.isArray(resultObj.results)) {
        reasoningLog.push(`  ✓ ${resultObj.results.length} items`);
      } else if (resultObj.success !== undefined) {
        reasoningLog.push(`  ✓ ${resultObj.success ? 'success' : 'failed'}`);
      }
      console.log(`[Tool] ${toolName} → ${JSON.stringify(result).slice(0, 80)}`);
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
      options?: { userId?: string; source?: string; channelId?: string; systemPrompt?: string }
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
      content: any[],
      options?: { userId?: string; source?: string; channelId?: string; systemPrompt?: string }
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
  const { initDB } = require('@jungjaehoon/mama-core/db-manager');
  const {
    suggest,
    save,
    update,
    loadCheckpoint,
    list: listDecisions,
  } = require('@jungjaehoon/mama-core');

  // Initialize MAMA database first
  await initDB();

  console.log('✓ MAMA memory API available (loaded directly in auto-recall)');

  // Create MAMA API client for context injection
  // Provides both SessionStart (checkpoint + recent decisions) and UserPromptSubmit (related decisions) functionality
  const mamaApiClient = {
    search: suggest, // mama-core exports 'suggest' for semantic search
    save,
    update,
    loadCheckpoint,
    listDecisions, // For SessionStart-like functionality
  };

  const messageRouter = new MessageRouter(sessionStore, agentLoopClient, mamaApiClient);

  const graphHandler = createGraphHandler();

  await startEmbeddingServerIfAvailable(messageRouter, sessionStore, graphHandler);

  // Initialize cron scheduler
  const scheduler = new CronScheduler();
  scheduler.setExecuteCallback(async (prompt: string) => {
    console.log(`[Cron] Executing: ${prompt.substring(0, 50)}...`);
    try {
      const result = await agentLoop.run(prompt);
      console.log(`[Cron] Completed: ${result.response.substring(0, 100)}...`);
      return result.response;
    } catch (error) {
      console.error(`[Cron] Error: ${error}`);
      throw error;
    }
  });

  // Track active gateways for cleanup
  const gateways: { stop: () => Promise<void> }[] = [];

  // Initialize Discord gateway if enabled (before API server for reference)
  let discordGateway: DiscordGateway | null = null;
  if (config.discord?.enabled && config.discord?.token) {
    console.log('Initializing Discord gateway...');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const discordConfig = config.discord as any;

      discordGateway = new DiscordGateway({
        token: config.discord.token,
        messageRouter,
        config: discordConfig.guilds ? { guilds: discordConfig.guilds } : undefined,
      });

      const gatewayInterface = {
        sendMessage: async (channelId: string, message: string) =>
          discordGateway!.sendMessage(channelId, message),
        sendFile: async (channelId: string, filePath: string, caption?: string) =>
          discordGateway!.sendFile(channelId, filePath, caption),
        sendImage: async (channelId: string, imagePath: string, caption?: string) =>
          discordGateway!.sendImage(channelId, imagePath, caption),
      };

      agentLoop.setDiscordGateway(gatewayInterface);

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

  // Initialize gateway plugin loader (for additional gateways like Slack, Chatwork)
  const pluginLoader = new PluginLoader({
    gatewayConfigs: {
      // Pass gateway configs from main config
      ...(config.slack
        ? {
            'slack-gateway': {
              enabled: config.slack.enabled,
              botToken: config.slack.bot_token,
              appToken: config.slack.app_token,
            },
          }
        : {}),
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
  const apiServer = createApiServer({
    scheduler,
    port: 3848,
    onHeartbeat: async (prompt) => {
      try {
        await agentLoop.run(prompt);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  });

  // Add Discord message sending endpoint
  apiServer.app.post('/api/discord/send', async (req, res) => {
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

  // Add Discord cron job endpoint (run prompt and send result to Discord)
  apiServer.app.post('/api/discord/cron', async (req, res) => {
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
  apiServer.app.post('/api/report', async (req, res) => {
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
  apiServer.app.post('/api/screenshot', async (req, res) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const path = await import('path');
    const execAsync = promisify(exec);

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

      // Run screenshot script
      await execAsync(
        `node ${workspacePath}/scripts/html-screenshot.mjs "${htmlPath}" "${outputPath}"`,
        {
          timeout: 30000,
          cwd: workspacePath,
        }
      );

      // Send to Discord
      console.log(`[Screenshot] Sending to Discord: ${outputPath}`);
      await discordGateway.sendImage(channelId, outputPath, caption);

      console.log('[Screenshot] Complete');
      res.json({ success: true, screenshot: outputPath });
    } catch (error) {
      console.error('[Screenshot] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Send image endpoint
  // SECURITY P0: Path traversal prevention with 4-layer validation
  apiServer.app.post('/api/discord/image', async (req, res) => {
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
      await discordGateway.sendImage(channelId, resolvedImagePath, caption);

      console.log('[Discord Image] Complete');
      res.json({ success: true });
    } catch (error) {
      console.error('[Discord Image] Error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  apiServer.app.use(async (req, res, next) => {
    const handled = await graphHandler(req, res);
    if (!handled) next();
  });

  apiServer.app.use((req, res, next) => {
    if (req.path.startsWith('/api/session')) {
      const http = require('http');
      const bodyData = req.body ? JSON.stringify(req.body) : '';
      const options = {
        hostname: 'localhost',
        port: 3847,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: 'localhost:3847',
          'content-length': Buffer.byteLength(bodyData),
        },
      };
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
  console.log('✓ Session API proxied to port 3847');

  const publicDir = path.resolve(process.cwd(), 'public');

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

  await apiServer.start();
  console.log(`API server started: http://localhost:${apiServer.port}`);

  if (apiServer.server) {
    // Setup WebSocket - use noServer mode to avoid conflict
    const setupWss = new WebSocketServer({ noServer: true });
    createSetupWebSocketHandler(setupWss);
    console.log('✓ Setup WebSocket handler ready for /setup-ws');

    // Handle ALL WebSocket upgrades manually
    apiServer.server.on('upgrade', (request: any, socket: any, head: any) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);

      if (url.pathname === '/setup-ws') {
        // Handle setup WebSocket locally
        setupWss.handleUpgrade(request, socket, head, (ws: any) => {
          setupWss.emit('connection', ws, request);
        });
      } else if (url.pathname === '/ws') {
        // Proxy chat WebSocket to embedding server (port 3847)
        const http = require('http');
        const options = {
          hostname: '127.0.0.1',
          port: 3847,
          path: request.url,
          method: 'GET',
          headers: {
            ...request.headers,
            host: '127.0.0.1:3847',
          },
        };

        const proxyReq = http.request(options);
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
    console.log('✓ WebSocket upgrade handler registered (/ws → 3847, /setup-ws local)');
  }

  gateways.push(apiServer);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\n\n🛑 Shutting down MAMA...');

    // Stop all gateways
    for (const gateway of gateways) {
      try {
        await gateway.stop();
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Stop plugin gateways
    try {
      await pluginLoader.stopAll();
    } catch {
      // Ignore errors during shutdown
    }

    // Stop schedulers
    scheduler.shutdown();
    heartbeatScheduler.stop();
    tokenKeepAlive.stop();

    // Close session database
    sessionStore.close();

    const { deletePid } = await import('../utils/pid-manager.js');
    await deletePid();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('MAMA agent is waiting...\n');

  // Keep process alive using setInterval
  // This ensures the Node.js event loop stays active
  setInterval(() => {
    // Heartbeat - keeps the process running
  }, 30000); // Every 30 seconds
}
