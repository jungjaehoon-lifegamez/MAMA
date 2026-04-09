/**
 * API route registration.
 *
 * Extracted from start.ts (Task 11 Part B).
 * Registers ALL REST endpoints, middleware, static file serving,
 * and creates the Dashboard + Wiki agent loops.
 */

import {
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
import { homedir } from 'node:os';
import express from 'express';
import path from 'node:path';
import http from 'node:http';

import { AgentLoop } from '../../agent/index.js';
import { GatewayToolExecutor } from '../../agent/gateway-tool-executor.js';
import type { AgentContext, MAMAApiInterface } from '../../agent/types.js';
import type { MessageRouter } from '../../gateways/index.js';
import { buildMemoryAgentDashboardPayload } from '../../memory/memory-agent-dashboard.js';
import type { ApiServer } from '../../api/index.js';
import { createUploadRouter } from '../../api/upload-handler.js';
import { requireAuth, isAuthenticated, logUnauthorizedAttempt } from '../../api/auth-middleware.js';
import type { OAuthManager } from '../../auth/index.js';
import type { DiscordGateway } from '../../gateways/discord.js';
import type { SlackGateway } from '../../gateways/slack.js';
import type { MAMAConfig } from '../config/types.js';
import type { MAMAApiShape } from './types.js';
import type { AgentEventBus } from '../../multi-agent/agent-event-bus.js';
import { EMBEDDING_PORT } from './utilities.js';

import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const routesLogger = new DebugLogger('api-routes');

export interface RegisterApiRoutesParams {
  config: MAMAConfig;
  apiServer: ApiServer;
  eventBus: AgentEventBus;
  oauthManager: OAuthManager;
  mamaApi: MAMAApiShape;
  messageRouter: MessageRouter;
  agentLoop: AgentLoop;
  toolExecutor: GatewayToolExecutor;
  discordGateway: DiscordGateway | null;
  slackGateway: SlackGateway | null;
  graphHandler: (req: express.Request, res: express.Response) => Promise<boolean>;
  /** mama-core getAdapter() — used for DB queries */
  getAdapter: () => {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    exec: (sql: string) => void;
  };
}

export async function registerApiRoutes(params: RegisterApiRoutesParams): Promise<void> {
  const {
    config,
    apiServer,
    eventBus,
    oauthManager,
    mamaApi,
    messageRouter,
    agentLoop,
    toolExecutor,
    discordGateway,
    slackGateway,
    graphHandler,
    getAdapter,
  } = params;

  // Wire EventBus to tool executor for agent_notices tool
  toolExecutor.setAgentEventBus(eventBus);

  // ── Report Slots ──────────────────────────────────────────────────────
  {
    const { broadcastReportUpdate } = await import('../../api/report-handler.js');

    // Manual refresh endpoint (kept for compatibility)
    apiServer.app.post('/api/report/refresh', requireAuth, (_req, res) => {
      res.json({ ok: true, message: 'Viewer now renders data directly from Intelligence API' });
    });

    // Wire report_publish tool to OS agent — only briefing slot
    toolExecutor.setReportPublisher((slots) => {
      for (const [slotId, html] of Object.entries(slots)) {
        if (slotId !== 'briefing') continue; // only accept briefing slot
        apiServer.reportStore.update(slotId, html, 0);
      }
      broadcastReportUpdate(apiServer.reportSseClients, {
        slots: apiServer.reportStore.getAllSorted(),
      });
      console.log(`[Report] Agent published briefing slot`);
    });

    // ── Dashboard Agent ─────────────────────────────────────────────────
    const { ensureDashboardPersona } = await import('../../multi-agent/dashboard-agent-persona.js');
    const dashboardPersonaPath = ensureDashboardPersona();
    const dashboardPersona = readFileSync(dashboardPersonaPath, 'utf-8');
    console.log(`[Dashboard Agent] Persona loaded from ${dashboardPersonaPath}`);

    // Generate code-act-only MCP config for Dashboard Agent
    // This follows the same pattern as Kagemusha: stdio MCP server → HTTP /api/code-act
    const codeActMcpConfig = path.join(homedir(), '.mama', 'code-act-mcp-config.json');
    const codeActServerPath = path.join(__dirname, '../../mcp/code-act-server.js');
    writeFileSync(
      codeActMcpConfig,
      JSON.stringify(
        {
          mcpServers: {
            'code-act': {
              command: 'node',
              args: [codeActServerPath],
              env: { MAMA_SERVER_PORT: '3847' },
            },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    const dashboardAgentLoop = new AgentLoop(
      oauthManager,
      {
        useCodeAct: true,
        disallowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Grep',
          'Glob',
          'Agent',
          'WebSearch',
          'WebFetch',
        ],
        systemPrompt: dashboardPersona,
        model: 'claude-sonnet-4-6',
        maxTurns: 5,
        backend: 'claude' as const,
        toolsConfig: {
          gateway: ['mama_search', 'report_publish'],
          mcp: ['code_act'],
          mcp_config: codeActMcpConfig,
        },
      },
      undefined,
      { mamaApi: mamaApi as MAMAApiInterface }
    );
    dashboardAgentLoop.setSessionKey('dashboard-agent:shared');

    // Wire report_publish tool to Dashboard Agent's internal executor
    dashboardAgentLoop.setReportPublisher((slots) => {
      for (const [slotId, html] of Object.entries(slots)) {
        if (slotId !== 'briefing') continue; // only accept briefing slot
        apiServer.reportStore.update(slotId, html, 0);
      }
      broadcastReportUpdate(apiServer.reportSseClients, {
        slots: apiServer.reportStore.getAllSorted(),
      });
      console.log(`[Dashboard Agent] Published briefing slot via report_publish`);
      eventBus.emit({
        type: 'agent:action',
        agent: 'dashboard-agent',
        action: 'publish',
        target: 'briefing',
      });
    });

    // Run dashboard agent on startup (after data loads) + every 30 minutes
    const dashboardAgentContext: AgentContext = {
      source: 'dashboard-agent',
      platform: 'cli',
      roleName: 'dashboard_agent',
      role: {
        allowedTools: ['mama_search', 'report_publish'],
        blockedTools: ['Read', 'Write', 'Bash', 'Grep', 'Glob', 'Edit'],
        systemControl: false,
        sensitiveAccess: false,
      },
      session: {
        sessionId: 'dashboard-agent:shared',
        channelId: 'system',
        startedAt: new Date(),
      },
      capabilities: ['mama_search', 'report_publish'],
      limitations: ['No file or shell access'],
      tier: 2,
      backend: 'claude',
    };
    const runDashboardAgent = async () => {
      try {
        console.log('[Dashboard Agent] Starting briefing generation...');
        await dashboardAgentLoop.run(
          'Analyze current project data and write an executive briefing. Use mama_search to find recent decisions, then use report_publish to publish your briefing HTML in the "briefing" slot.',
          {
            source: 'dashboard-agent',
            channelId: 'system',
            agentContext: dashboardAgentContext,
            stopAfterSuccessfulTools: ['report_publish', 'code_act', 'mcp__code-act__code_act'],
          }
        );
        console.log('[Dashboard Agent] Briefing published');
      } catch (err) {
        console.error('[Dashboard Agent] Error:', err instanceof Error ? err.message : err);
      }
    };

    // First run after 10s (let connectors poll first), then every 30 min
    setTimeout(runDashboardAgent, 10_000);
    setInterval(runDashboardAgent, 30 * 60 * 1000);

    // Manual trigger
    apiServer.app.post('/api/report/agent-refresh', requireAuth, async (_req, res) => {
      runDashboardAgent().catch(() => {});
      res.json({ ok: true, message: 'Dashboard agent triggered' });
    });

    // ── Wiki Agent ──────────────────────────────────────────────────────
    const wikiConfig = config.wiki as
      | { enabled?: boolean; vaultPath?: string; wikiDir?: string }
      | undefined;

    if (wikiConfig?.enabled && wikiConfig.vaultPath) {
      const { ensureWikiPersona } = await import('../../multi-agent/wiki-agent-persona.js');
      const { ObsidianWriter } = await import('../../wiki/obsidian-writer.js');

      const wikiPersonaPath = ensureWikiPersona();
      const wikiPersona = readFileSync(wikiPersonaPath, 'utf-8');
      const obsWriter = new ObsidianWriter(wikiConfig.vaultPath, wikiConfig.wikiDir || 'wiki');
      obsWriter.ensureDirectories();
      console.log(`[Wiki Agent] Persona loaded from ${wikiPersonaPath}`);
      console.log(`[Wiki Agent] Vault: ${obsWriter.getWikiPath()}`);

      // Wire wiki_publish tool to gateway executor
      toolExecutor.setWikiPublisher((pages) => {
        for (const page of pages) {
          obsWriter.writePage(page as import('../../wiki/types.js').WikiPage);
        }
        if (pages.length > 0) {
          obsWriter.updateIndex(pages as import('../../wiki/types.js').WikiPage[]);
          obsWriter.appendLog('compile', `Published ${pages.length} pages`);
        }
        console.log(`[Wiki Agent] Published ${pages.length} pages to vault`);
      });

      const wikiAgentLoop = new AgentLoop(
        oauthManager,
        {
          useCodeAct: true,
          timeoutMs: 600_000, // 10 min — wiki compilation with MCP init takes time
          disallowedTools: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Grep',
            'Glob',
            'Agent',
            'WebSearch',
            'WebFetch',
          ],
          systemPrompt: wikiPersona,
          model: 'claude-sonnet-4-6',
          maxTurns: 5,
          backend: 'claude' as const,
          toolsConfig: {
            gateway: ['mama_search', 'wiki_publish'],
            mcp: ['code_act'],
            mcp_config: codeActMcpConfig,
          },
        },
        undefined,
        { mamaApi: mamaApi as MAMAApiInterface }
      );
      wikiAgentLoop.setSessionKey('wiki-agent:shared');

      // Wire wiki_publish tool to Wiki Agent's internal executor
      wikiAgentLoop.setWikiPublisher((pages) => {
        for (const page of pages) {
          obsWriter.writePage(page as import('../../wiki/types.js').WikiPage);
        }
        if (pages.length > 0) {
          obsWriter.updateIndex(pages as import('../../wiki/types.js').WikiPage[]);
          obsWriter.appendLog('compile', `Published ${pages.length} pages`);
        }
        console.log(`[Wiki Agent] Published ${pages.length} pages via wiki_publish`);

        eventBus.emit({
          type: 'wiki:compiled',
          pages: (pages as Array<{ path?: string }>).map((p) => p.path || ''),
        });
      });

      const wikiAgentContext: AgentContext = {
        source: 'wiki-agent',
        platform: 'cli',
        roleName: 'wiki_agent',
        role: {
          allowedTools: ['mama_search', 'wiki_publish'],
          blockedTools: ['Read', 'Write', 'Bash', 'Grep', 'Glob', 'Edit'],
          systemControl: false,
          sensitiveAccess: false,
        },
        session: {
          sessionId: 'wiki-agent:shared',
          channelId: 'system',
          startedAt: new Date(),
        },
        capabilities: ['mama_search', 'wiki_publish'],
        limitations: ['No file or shell access'],
        tier: 2,
        backend: 'claude',
      };

      const runWikiAgent = async () => {
        try {
          console.log('[Wiki Agent] Starting compilation...');
          // Build list of existing wiki pages so LLM reuses exact paths
          let existingPages: string[] = [];
          try {
            const { readdirSync, statSync } = await import('node:fs');
            const walkDir = (dir: string, prefix: string): string[] => {
              const entries: string[] = [];
              for (const f of readdirSync(dir)) {
                const full = path.join(dir, f);
                const rel = prefix ? `${prefix}/${f}` : f;
                if (statSync(full).isDirectory()) {
                  entries.push(...walkDir(full, rel));
                } else if (f.endsWith('.md') && f !== 'log.md') {
                  entries.push(rel);
                }
              }
              return entries;
            };
            existingPages = walkDir(obsWriter.getWikiPath(), '');
          } catch {
            /* non-fatal */
          }
          const existingPagesHint =
            existingPages.length > 0
              ? `\n\nExisting wiki pages (reuse these exact paths, do NOT create duplicates):\n${existingPages.map((p) => `- ${p}`).join('\n')}\n\nCRITICAL: Do NOT include frontmatter (--- blocks) or # Title heading in content. System adds both automatically.`
              : '\n\nCRITICAL: Do NOT include frontmatter (--- blocks) or # Title heading in content. System adds both automatically.';
          await wikiAgentLoop.run(
            `Search for recent decisions across all projects using mama_search, then compile them into wiki pages and publish with wiki_publish.${existingPagesHint}`,
            {
              source: 'wiki-agent',
              channelId: 'system',
              agentContext: wikiAgentContext,
              stopAfterSuccessfulTools: ['wiki_publish', 'code_act', 'mcp__code-act__code_act'],
            }
          );
          console.log('[Wiki Agent] Compilation complete');
        } catch (err) {
          console.error('[Wiki Agent] Error:', err instanceof Error ? err.message : err);
        }
      };

      // Event-driven: compile when extraction completes (debounced)
      eventBus.on('extraction:completed', () => runWikiAgent());

      // Emit agent:action notices when wiki pages are compiled
      eventBus.on('wiki:compiled', (event) => {
        if (event.type === 'wiki:compiled') {
          for (const page of event.pages) {
            eventBus.emit({
              type: 'agent:action',
              agent: 'Wiki Agent',
              action: 'compiled',
              target: page,
            });
          }
        }
      });

      // Manual trigger API
      apiServer.app.post('/api/wiki/compile', requireAuth, async (_req, res) => {
        runWikiAgent().catch(() => {});
        res.json({ ok: true, message: 'Wiki compilation triggered' });
      });

      // First run after 15s (let connectors and dashboard agent go first)
      setTimeout(runWikiAgent, 15_000);

      console.log(
        '[Wiki Agent] Ready — triggers: extraction:completed event, POST /api/wiki/compile'
      );
    }
  }

  // ── Conductor Audit — hourly system health check ──────────────────────
  {
    const AUDIT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    const AUDIT_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 min after startup

    const auditPrompt =
      'Perform a system audit. Read ~/.mama/skills/audit-checklist.md and execute each step. Classify findings as MINOR (auto-fix via delegate) or MAJOR (report to human). Save results to memory.';

    const runConductorAudit = async () => {
      try {
        console.log('[Conductor Audit] Starting hourly audit...');
        await messageRouter.process({
          source: 'viewer' as const,
          channelId: 'conductor-audit',
          userId: 'system',
          text: auditPrompt,
        });
        console.log('[Conductor Audit] Audit complete');
      } catch (err) {
        console.error(
          '[Conductor Audit] Failed:',
          err instanceof Error ? err.message : String(err)
        );
      }
    };

    setTimeout(() => {
      runConductorAudit();
      setInterval(runConductorAudit, AUDIT_INTERVAL_MS);
    }, AUDIT_INITIAL_DELAY_MS);

    // Manual trigger
    apiServer.app.post('/api/conductor/audit', requireAuth, async (_req, res) => {
      runConductorAudit().catch(() => {});
      res.json({ ok: true, message: 'Conductor audit triggered' });
    });

    console.log(
      '[Conductor Audit] Ready — runs every 60 min, POST /api/conductor/audit for manual trigger'
    );
  }

  // ── Memory Agent stats API ────────────────────────────────────────────
  apiServer.app.get('/api/memory-agent/stats', requireAuth, (_req, res) => {
    const stats = messageRouter.getMemoryAgentStats();
    res.json(stats);
  });

  // ── Memory Agent dashboard API ────────────────────────────────────────
  apiServer.app.get('/api/memory-agent/dashboard', requireAuth, async (_req, res) => {
    try {
      // 1. Memory agent runtime stats
      const agentStats = messageRouter.getMemoryAgentStats();

      // 2. Memory DB stats (decisions, checkpoints, outcomes, topics)
      const adapter = getAdapter();
      const now = Date.now();
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

      const totalRow = adapter.prepare('SELECT COUNT(*) as count FROM decisions').get() as
        | { count: number }
        | undefined;
      const weekRow = adapter
        .prepare('SELECT COUNT(*) as count FROM decisions WHERE created_at > ?')
        .get(weekAgo) as { count: number } | undefined;
      const monthRow = adapter
        .prepare('SELECT COUNT(*) as count FROM decisions WHERE created_at > ?')
        .get(monthAgo) as { count: number } | undefined;
      const checkpointRow = adapter.prepare('SELECT COUNT(*) as count FROM checkpoints').get() as
        | { count: number }
        | undefined;

      const outcomeRows = adapter
        .prepare(
          `SELECT outcome, COUNT(*) as count FROM decisions
           WHERE outcome IS NOT NULL GROUP BY outcome`
        )
        .all() as Array<{ outcome: string | null; count: number }>;
      const outcomes: Record<string, number> = {};
      for (const row of outcomeRows) {
        outcomes[row.outcome?.toLowerCase() ?? 'unknown'] = row.count;
      }

      const topTopics = adapter
        .prepare(
          `SELECT topic, COUNT(*) as count FROM decisions
           WHERE topic IS NOT NULL GROUP BY topic ORDER BY count DESC LIMIT 10`
        )
        .all() as Array<{ topic: string; count: number }>;

      // 3. Recent decisions (last 20)
      const recentDecisions = adapter
        .prepare(
          `SELECT id, topic, decision, outcome, confidence, created_at
           FROM decisions ORDER BY created_at DESC LIMIT 20`
        )
        .all() as Array<{
        id: string;
        topic: string;
        decision: string;
        outcome: string | null;
        confidence: number | null;
        created_at: number;
      }>;

      // 4. Channel summaries (from channel_summary_state table, if it exists)
      let channelSummaries: Array<{
        channelKey: string;
        updatedAt: number;
      }> = [];
      try {
        const rawSummaries = adapter
          .prepare(
            'SELECT channel_key, updated_at FROM channel_summary_state ORDER BY updated_at DESC LIMIT 20'
          )
          .all() as Array<{ channel_key: string; updated_at: number }>;
        channelSummaries = rawSummaries.map((r) => ({
          channelKey: r.channel_key,
          updatedAt: r.updated_at,
        }));
      } catch {
        // Table may not exist yet — not an error
      }

      const payload = buildMemoryAgentDashboardPayload({
        agentStats,
        channelSummaries,
        recentDecisions,
        generatedAt: new Date().toISOString(),
      });

      res.json({
        ...payload,
        agent: agentStats,
        memory: {
          total: totalRow?.count ?? 0,
          thisWeek: weekRow?.count ?? 0,
          thisMonth: monthRow?.count ?? 0,
          checkpoints: checkpointRow?.count ?? 0,
          outcomes,
          topTopics,
        },
        channelSummaries,
      });
    } catch (error) {
      routesLogger.error(
        '[memory-agent/dashboard] Error',
        error instanceof Error ? error : String(error)
      );
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── Session API endpoints ─────────────────────────────────────────────
  apiServer.app.get('/api/sessions/last-active', async (_req, res) => {
    try {
      const sessions = messageRouter.listSessions('viewer');
      if (sessions.length === 0) {
        res.json({ session: null });
        return;
      }
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

  // ── Discord send endpoint ─────────────────────────────────────────────
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

  // ── Slack send endpoint ───────────────────────────────────────────────
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

  // ── Discord cron endpoint ─────────────────────────────────────────────
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

  // ── Report (heartbeat) endpoint ───────────────────────────────────────
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

  // ── Screenshot endpoint ───────────────────────────────────────────────
  apiServer.app.post('/api/screenshot', requireAuth, async (req, res) => {
    const { spawn } = await import('child_process');

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

  // ── Discord image endpoint (4-layer path validation) ──────────────────
  apiServer.app.post('/api/discord/image', requireAuth, async (req, res) => {
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

  // ── Upload / download media endpoints ─────────────────────────────────
  apiServer.app.use('/api', createUploadRouter());

  // ── Auth gate for /graph/* write endpoints ────────────────────────────
  apiServer.app.use('/graph', (req, res, next) => {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isRead && !isAuthenticated(req)) {
      logUnauthorizedAttempt(req);
      res.status(401).json({
        error: true,
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      });
      return;
    }
    next();
  });

  // ── Graph handler middleware ───────────────────────────────────────────
  apiServer.app.use(async (req, res, next) => {
    const handled = await graphHandler(req, res);
    if (!handled) next();
  });

  // ── Session proxy middleware ───────────────────────────────────────────
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

  // ── Playground static serving + API ───────────────────────────────────
  const publicDir = path.join(__dirname, '..', '..', '..', 'public');
  const playgroundsDir = path.join(homedir(), '.mama', 'workspace', 'playgrounds');
  try {
    mkdirSync(playgroundsDir, { recursive: true });
  } catch (err) {
    routesLogger.warn(
      `Failed to create playgrounds dir, skipping seeding: ${err instanceof Error ? err.message : String(err)}`
    );
    // DO NOT return — continue with the rest of route registration
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
        routesLogger.warn(
          `[seedBuiltinPlaygrounds] Failed to parse index.json, rebuilding: ${err}`
        );
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

  // ── Daemon Log API ────────────────────────────────────────────────────
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

  // ── Playground CRUD endpoints ─────────────────────────────────────────
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

  // ── Workspace skills API ──────────────────────────────────────────────
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
      routesLogger.warn('[GET /api/workspace/skills/:name/content] Failed to read skill:', err);
      res.status(500).json({ error: 'Failed to read skill content' });
    }
  });
  console.log('✓ Workspace Skills API available at /api/workspace/skills');

  // ── Setup page + static assets ────────────────────────────────────────
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
}
