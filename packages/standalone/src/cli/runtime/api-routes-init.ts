/**
 * API route registration.
 *
 * Extracted from start.ts (Task 11 Part B).
 * Registers ALL REST endpoints, middleware, static file serving,
 * and wires Dashboard + Wiki agents via AgentProcessManager.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
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
import type { MessageRouter } from '../../gateways/index.js';
import { ValidationSessionService } from '../../validation/session-service.js';
import type { ValidationSessionRow } from '../../validation/types.js';
import { getLatestVersion, logActivity } from '../../db/agent-store.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import { buildMemoryAgentDashboardPayload } from '../../memory/memory-agent-dashboard.js';
import type { ApiServer } from '../../api/index.js';
import { createUploadRouter } from '../../api/upload-handler.js';
import { registerOperatorTaskRoutes } from '../../api/operator-tasks-handler.js';
import { requireAuth, isAuthenticated, logUnauthorizedAttempt } from '../../api/auth-middleware.js';
import type { OAuthManager } from '../../auth/index.js';
import type { DiscordGateway } from '../../gateways/discord.js';
import type { SlackGateway } from '../../gateways/slack.js';
import type { MAMAConfig } from '../config/types.js';
import type { MAMAApiShape } from './types.js';
import type { AgentEventBus } from '../../multi-agent/agent-event-bus.js';
import { API_PORT, EMBEDDING_PORT } from './utilities.js';
import { runCodeAudit, type CodeAuditReport } from '../../observability/code-audit.js';
import {
  dispatchSecurityAlertDirect,
  hasSecurityAlertSender,
} from '../../security/security-monitor.js';

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
  /** Sessions DB for validation */
  sessionsDb?: SQLiteDatabase;
}

export async function registerApiRoutes(params: RegisterApiRoutesParams): Promise<void> {
  const {
    config,
    apiServer,
    eventBus,
    oauthManager: _oauthManager,
    mamaApi: _mamaApi,
    messageRouter,
    agentLoop,
    toolExecutor,
    discordGateway,
    slackGateway,
    graphHandler,
    getAdapter,
    sessionsDb,
  } = params;

  // ── Validation Session Service ────────────────────────────────────────
  const validationService = sessionsDb ? new ValidationSessionService(sessionsDb) : null;

  /**
   * executeValidatedRun — wraps pm.getSharedProcess().sendMessage()
   * with validation session lifecycle (before → execute → after → classify).
   */
  async function executeValidatedRun(
    agentId: string,
    prompt: string,
    opts?: { requestTimeout?: number }
  ): Promise<{ response?: string; noUpdate?: boolean }> {
    const pm = toolExecutor.getAgentProcessManager();
    if (!pm) throw new Error(`AgentProcessManager not available`);

    let agentVersion = 0;
    let session: ValidationSessionRow | null = null;
    const startTime = Date.now();

    try {
      const ver = sessionsDb ? getLatestVersion(sessionsDb, agentId) : null;
      agentVersion = ver?.version ?? 0;
      session = validationService?.startSession(agentId, agentVersion, 'system_run') ?? null;
    } catch (bootstrapErr) {
      routesLogger.warn(
        '[executeValidatedRun] Failed to initialize validation bootstrap:',
        bootstrapErr
      );
      agentVersion = 0;
      session = null;
    }

    if (sessionsDb) {
      try {
        const startRow = logActivity(sessionsDb, {
          agent_id: agentId,
          agent_version: agentVersion,
          type: 'task_start',
          input_summary: prompt.slice(0, 200),
          run_id: session?.id,
          execution_status: 'started',
          trigger_reason: 'system_run',
        });
        if (session) {
          try {
            validationService?.recordRun(session.id, { activityId: startRow.id });
          } catch (telemetryErr) {
            routesLogger.warn(
              '[executeValidatedRun] Failed to link startup activity to validation session:',
              telemetryErr
            );
          }
        }
      } catch (telemetryErr) {
        routesLogger.warn('[executeValidatedRun] Failed to write startup telemetry:', telemetryErr);
      }
    }

    try {
      const process = await pm.getSharedProcess(agentId, opts);
      const result = await process.sendMessage(prompt);
      const durationMs = Date.now() - startTime;
      const noUpdate = result?.response?.includes('NO_UPDATE');
      const usage = result?.usage;
      const tokensUsed = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : 0;
      try {
        if (sessionsDb) {
          const completeRow = logActivity(sessionsDb, {
            agent_id: agentId,
            agent_version: agentVersion,
            type: noUpdate ? 'task_skipped' : 'task_complete',
            input_summary: prompt.slice(0, 200),
            output_summary: result?.response?.slice(0, 500),
            duration_ms: durationMs,
            tokens_used: tokensUsed,
            run_id: session?.id,
            execution_status: 'completed',
            trigger_reason: 'system_run',
          });
          if (session) {
            validationService?.recordRun(session.id, {
              activityId: completeRow.id,
              duration_ms: durationMs,
              tokens_used: tokensUsed,
            });
          }
        }
      } catch (telemetryErr) {
        routesLogger.warn(
          '[executeValidatedRun] Failed to write completion telemetry:',
          telemetryErr
        );
      }

      try {
        if (session && validationService) {
          validationService.finalizeSession(session.id, {
            execution_status: 'completed',
            metrics: {
              duration_ms: durationMs,
              token_cost: tokensUsed,
            },
          });
        }
      } catch (telemetryErr) {
        routesLogger.warn(
          '[executeValidatedRun] Failed to finalize validation session:',
          telemetryErr
        );
      }

      return { response: result?.response, noUpdate };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const originalError = err;
      try {
        if (sessionsDb) {
          const errorRow = logActivity(sessionsDb, {
            agent_id: agentId,
            agent_version: agentVersion,
            type: 'task_error',
            input_summary: prompt.slice(0, 200),
            error_message: err instanceof Error ? err.message : String(err),
            duration_ms: durationMs,
            run_id: session?.id,
            execution_status: 'failed',
            trigger_reason: 'system_run',
          });
          if (session) {
            validationService?.recordRun(session.id, {
              activityId: errorRow.id,
              duration_ms: durationMs,
            });
          }
        }
      } catch (telemetryErr) {
        routesLogger.warn('[executeValidatedRun] Failed to write error telemetry:', telemetryErr);
      }

      try {
        if (session && validationService) {
          validationService.finalizeSession(session.id, {
            execution_status: 'failed',
            error_message: err instanceof Error ? err.message : String(err),
            metrics: { duration_ms: durationMs },
          });
        }
      } catch (telemetryErr) {
        routesLogger.warn(
          '[executeValidatedRun] Failed to finalize failed validation session:',
          telemetryErr
        );
      }

      throw originalError;
    }
  }

  // Wire EventBus to tool executor for agent_notices tool
  toolExecutor.setAgentEventBus(eventBus);

  registerOperatorTaskRoutes(apiServer.app, {
    getTaskLedger: () => toolExecutor.getTaskLedger(),
  });

  const hasEnabledAgentConfig = (agentId: string): boolean => {
    const agentConfig = config.multi_agent?.agents?.[agentId];
    return Boolean(agentConfig && agentConfig.enabled !== false);
  };

  // ── Report Slots + legacy dashboard/wiki fanout ───────────────────────
  const dashboardAgentConfigured = hasEnabledAgentConfig('dashboard-agent');
  const wikiAgentConfigured = hasEnabledAgentConfig('wiki-agent');

  // Manual refresh endpoint (kept for compatibility)
  apiServer.app.post('/api/report/refresh', requireAuth, (_req, res) => {
    res.json({ ok: true, message: 'Viewer now renders data directly from Intelligence API' });
  });

  // ── Conductor Persona (section injection — non-destructive) ────────
  const { ensureConductorPersona } = await import('../../multi-agent/conductor-persona.js');
  ensureConductorPersona();

  if (dashboardAgentConfigured || wikiAgentConfigured) {
    // Merge code-act MCP server into mama-mcp-config.json.
    // Makes code_act available to configured legacy self-paced agents.
    const codeActServerPath = path.join(__dirname, '../../mcp/code-act-server.js');
    try {
      const mamaMcpConfigPath = path.join(homedir(), '.mama', 'mama-mcp-config.json');
      let existing: {
        mcpServers?: Record<string, unknown>;
        [key: string]: unknown;
      } = { mcpServers: {} };
      if (existsSync(mamaMcpConfigPath)) {
        try {
          const parsedConfig = JSON.parse(readFileSync(mamaMcpConfigPath, 'utf-8')) as unknown;
          if (parsedConfig && typeof parsedConfig === 'object' && !Array.isArray(parsedConfig)) {
            existing = parsedConfig as typeof existing;
          }
        } catch (parseErr) {
          routesLogger.warn(
            '[api-routes-init] Invalid MCP config JSON; recreating code-act entry:',
            parseErr
          );
        }
      }
      if (
        !existing.mcpServers ||
        typeof existing.mcpServers !== 'object' ||
        Array.isArray(existing.mcpServers)
      ) {
        existing.mcpServers = {};
      }
      existing.mcpServers['code-act'] = {
        command: 'node',
        args: [codeActServerPath],
        env: { MAMA_SERVER_PORT: String(API_PORT) },
      };
      writeFileSync(mamaMcpConfigPath, JSON.stringify(existing, null, 2), 'utf-8');
      routesLogger.debug('[api-routes-init] code-act MCP merged into mama-mcp-config.json');
    } catch (err) {
      routesLogger.warn('[api-routes-init] Failed to merge code-act into MCP config:', err);
    }
  }

  // report_publish is a core surface (feeds the /ui operator board), not a
  // multi-agent feature: wire it unconditionally. All slot ids are accepted;
  // size/count caps and loud logging live in createReportPublisher.
  {
    const { createReportPublisher } = await import('../../api/report-handler.js');
    toolExecutor.setReportPublisher(
      createReportPublisher(apiServer.reportStore, apiServer.reportSseClients)
    );
  }

  if (dashboardAgentConfigured) {
    // ── Dashboard Agent ───────────────────────────────────────────────
    const { ensureDashboardPersona } = await import('../../multi-agent/dashboard-agent-persona.js');
    ensureDashboardPersona();
    routesLogger.debug('[Dashboard Agent] Persona ensured at ~/.mama/personas/dashboard.md');

    // Dashboard cron: 30-min interval via AgentProcessManager
    // Built PER RUN: the tracker's D-day arithmetic needs today's date, and a
    // module-const prompt would freeze it (#134 lesson).
    const buildDashboardPrompt =
      () => `You are triggered on a schedule. Today is ${new Date().toISOString().slice(0, 10)}. Before writing anything, determine if an update is needed:

1. Use agent_notices({limit: 50}) to find the most recent dashboard-agent publish/task_complete notice. Treat that as the last briefing boundary.
2. Use context_compile first to find recent substantive decisions (limit 20, max_tool_calls 2, strictness "balanced").
   Use this exact task text for context_compile: "recent substantive project decisions, task progress, agent alerts, and major changes".
   Do not include dashboard_briefing, wiki_compilation, system-audit, or audit-log labels in the context_compile task text; filter those operational summaries after the packet returns.
   If context_compile is unavailable because there is no active worker envelope, fall back to mama_search once (limit 20).
3. If NO substantive decisions or agent alerts exist since the last dashboard publish → respond "NO_UPDATE" and stop. Do NOT call report_publish.
4. If new substantive information exists -> analyze it and publish ALL FOUR board slots (briefing, action_required, decisions, pipeline) in a SINGLE report_publish call, using the board HTML vocabulary from your persona. The pipeline slot is the item tracker projected from task_list (see your persona); compute D-day from today's date above.
5. Do NOT call mama_save for the briefing; report_publish and agent_activity are the durable operational record.

This saves resources. Only publish when there is genuinely new information to report.`;

    // Owner-initiated refresh skips the NO_UPDATE delta gate: an explicit
    // request means "rebuild the board now", not "tell me nothing changed".
    const buildForcedDashboardPrompt = () =>
      buildDashboardPrompt().replace(
        /3\. If NO substantive decisions[^\n]*\n/,
        '3. The owner explicitly requested a fresh board: do NOT reply NO_UPDATE. Rebuild and publish even if nothing changed since the last publish.\n'
      );

    const doDashboardRun = async (opts?: { force?: boolean }) => {
      const pm = toolExecutor.getAgentProcessManager();
      if (!pm) {
        routesLogger.warn('[Dashboard Agent] AgentProcessManager not available yet');
        return;
      }
      try {
        // console.log on run outcomes: the DebugLogger only surfaces warn/error in the
        // daemon log, and a silent outcome reads as a hang from the outside.
        console.log(
          `[Dashboard Agent] run started${opts?.force ? ' (owner-forced, delta gate bypassed)' : ''}`
        );
        const { noUpdate } = await executeValidatedRun(
          'dashboard-agent',
          opts?.force ? buildForcedDashboardPrompt() : buildDashboardPrompt()
        );
        console.log(
          noUpdate
            ? '[Dashboard Agent] no changes detected, publish skipped'
            : '[Dashboard Agent] board published'
        );
      } catch (err) {
        routesLogger.error('[Dashboard Agent] Error:', err instanceof Error ? err.message : err);
      }
    };

    // ONE board-writer queue: dashboard cron, manual refresh, AND reconcile runs
    // all serialize here -- the shared agent process rejects concurrent requests
    // ('Process is busy' class). Per-job rejection propagates to the caller
    // while the chain itself survives (M8 review: a caller must be able to
    // distinguish its own job's failure).
    let boardWriterChain: Promise<void> = Promise.resolve();
    const boardWriterQueue = {
      push(job: () => Promise<void>): Promise<void> {
        const jobPromise = boardWriterChain.then(job);
        boardWriterChain = jobPromise.catch(() => {});
        return jobPromise;
      },
    };
    const runDashboardAgent = (opts?: { force?: boolean }): Promise<void> =>
      boardWriterQueue.push(() => doDashboardRun(opts)).catch(() => {});

    // First run after 10s (let connectors poll first), then every 30 min
    setTimeout(runDashboardAgent, 10_000);
    setInterval(runDashboardAgent, 30 * 60 * 1000);

    // Manual trigger (owner-forced: bypasses the delta gate)
    apiServer.app.post('/api/report/agent-refresh', requireAuth, async (_req, res) => {
      runDashboardAgent({ force: true }).catch(() => {});
      res.json({ ok: true, message: 'Dashboard agent triggered (forced refresh)' });
    });

    // -- M8 board reconcile leg (freshness layer; default OFF, opt-in like
    // MAMA_TRIGGER_LOOP). The trigger loop emits operator:channel-delta after
    // committing its cursor; the 30-min cron above remains the repair pass.
    if (process.env.MAMA_BOARD_RECONCILE === '1') {
      const { buildReconcilePrompt, ReconcileScheduler } =
        await import('../../operator/board-reconcile.js');
      const { captureSnapshot, verifyAfterRun, OBLIGATED_TOOLS } =
        await import('../../operator/action-verifier.js');
      const kagemushaContext =
        (process.env.MAMA_RECONCILE_TASK_CONTEXT ?? 'native') === 'kagemusha';

      // Verifier deps (M8 Phase 2): run-bound signals only -- trace rows from
      // the dashboard agent's gateway_tool_call activity, notes from the
      // operator ledger. Observe, never block.
      const reconcileLedger = toolExecutor.getTaskLedger();
      // gateway_tool_call rows now populate normalized_tool_name at the logging
      // site; the input_summary fallback covers rows written before that fix.
      const traceToolList = OBLIGATED_TOOLS.map((t) => `'${t}'`).join(',');
      const verifierDeps = {
        getSlots: () => apiServer.reportStore.getAllSorted(),
        getLedgerHash: () => reconcileLedger?.payloadHash() ?? '',
        getScopedNoteMaxId: (scope: string) => reconcileLedger?.maxNoUpdateId(scope) ?? 0,
        getTraceMaxId: () => {
          if (!sessionsDb) return 0;
          const row = sessionsDb
            .prepare(
              `SELECT MAX(id) AS max_id FROM agent_activity
               WHERE type = 'gateway_tool_call' AND agent_id = 'dashboard-agent'`
            )
            .get() as { max_id: number | null };
          return row.max_id ?? 0;
        },
        countObligatedTraceRowsSince: (maxId: number) => {
          if (!sessionsDb) return 0;
          const row = sessionsDb
            .prepare(
              `SELECT COUNT(*) AS n FROM agent_activity
               WHERE type = 'gateway_tool_call' AND agent_id = 'dashboard-agent'
                 AND id > ? AND (normalized_tool_name IN (${traceToolList}) OR input_summary IN (${traceToolList}))`
            )
            .get(maxId) as { n: number };
          return row.n;
        },
      };

      const reconcileScheduler = new ReconcileScheduler({
        debounceMs: Number(process.env.MAMA_RECONCILE_DEBOUNCE_MS) || undefined,
        maxWaitMs: Number(process.env.MAMA_RECONCILE_MAX_WAIT_MS) || undefined,
        globalMaxPerHour: Number(process.env.MAMA_RECONCILE_MAX_PER_HOUR) || undefined,
        log: (line) => console.log(line),
        run: (channelKey, deltaLines) =>
          boardWriterQueue.push(async () => {
            const scope = `reconcile:${channelKey}`;
            const before = captureSnapshot(verifierDeps, scope);
            const prompt = buildReconcilePrompt({
              channelKey,
              deltaLines,
              todayIso: new Date().toISOString().slice(0, 10),
              kagemushaContext,
            });
            await executeValidatedRun('dashboard-agent', prompt, {
              requestTimeout: 300_000,
            });
            const verdict = verifyAfterRun(verifierDeps, before, scope);
            const outcome = verdict.verified ? 'reconcile_verified' : 'reconcile_unverified';
            console.log(
              `[reconcile] ${outcome} channel=${channelKey}${verdict.effects.length > 0 ? ` (${verdict.effects.join('; ')})` : ''}`
            );
            try {
              if (sessionsDb) {
                logActivity(sessionsDb, {
                  agent_id: 'dashboard-agent',
                  agent_version: 0,
                  type: outcome,
                  input_summary: `reconcile ${channelKey}`,
                  output_summary: verdict.effects.join('; '),
                  execution_status: 'completed',
                  trigger_reason: 'reconcile',
                });
              }
            } catch {
              /* telemetry only */
            }
            if (!verdict.verified) {
              // Loud, never blocking (observability over restriction).
              eventBus.emit({
                type: 'agent:action',
                agent: 'Dashboard Agent',
                action: 'reconcile_unverified',
                target: channelKey,
              });
            }
          }),
      });
      eventBus.on('operator:channel-delta', (event) => {
        if (event.type === 'operator:channel-delta') {
          reconcileScheduler.enqueue(event.channelKey, event.lines);
        }
      });

      // Manual reconcile: lines from the body, or the caller must supply them
      // (no silent alternate data path -- M8 review #17).
      apiServer.app.post('/api/operator/reconcile', requireAuth, (req, res) => {
        const { channelKey, lines } = (req.body ?? {}) as {
          channelKey?: string;
          lines?: string[];
        };
        if (!channelKey || !Array.isArray(lines) || lines.length === 0) {
          res.status(400).json({
            ok: false,
            error: 'channelKey and non-empty lines[] are required',
          });
          return;
        }
        reconcileScheduler.enqueue(channelKey, lines);
        res.json({ ok: true, message: 'Reconcile queued (async; runs after debounce)' });
      });
      console.log('[reconcile] Board reconcile leg enabled (MAMA_BOARD_RECONCILE=1)');
    }
  } else {
    routesLogger.debug('[Dashboard Agent] Skipped; dashboard-agent is not configured');
  }

  // ── Wiki Agent ──────────────────────────────────────────────────────
  const wikiConfig = config.wiki as
    | { enabled?: boolean; vaultPath?: string; wikiDir?: string }
    | undefined;

  if (wikiAgentConfigured && wikiConfig?.enabled && wikiConfig.vaultPath) {
    const { ensureWikiPersona } = await import('../../multi-agent/wiki-agent-persona.js');
    const { ObsidianWriter } = await import('../../wiki/obsidian-writer.js');

    ensureWikiPersona();
    const obsWriter = new ObsidianWriter(wikiConfig.vaultPath, wikiConfig.wikiDir || 'wiki');
    obsWriter.ensureDirectories();
    routesLogger.debug(`[Wiki Agent] Persona ensured, vault: ${obsWriter.getWikiPath()}`);

    // Wire Obsidian vault path for CLI tool. The wiki directory itself is what
    // gets registered as an Obsidian vault (agent-facing paths like daily/... are
    // relative to it), so the CLI vault name is the wiki path's basename.
    const fullWikiPath = obsWriter.getWikiPath();
    const obsidianVaultName = path.basename(fullWikiPath);
    toolExecutor.setObsidianVaultPath(fullWikiPath, obsidianVaultName);
    routesLogger.debug(
      `[Wiki Agent] Obsidian CLI vault: ${fullWikiPath} (vault=${obsidianVaultName})`
    );

    // Ensure Obsidian is running with the wiki vault open (macOS only).
    // NOTE: obsidian://open?vault= only opens vaults ALREADY registered in
    // Obsidian; registering the wiki directory as a vault is a one-time manual
    // setup step. If it is not registered, the CLI reports unavailable and the
    // agent falls back to wiki_publish (direct file writes still work).
    if (process.platform === 'darwin') {
      try {
        const { execFile: execFileChild } = await import('child_process');
        execFileChild(
          'open',
          [`obsidian://open?vault=${encodeURIComponent(obsidianVaultName)}`],
          { timeout: 5000 },
          () => {
            /* non-fatal: CLI will return error, agent falls back to wiki_publish */
          }
        );
      } catch {
        /* non-fatal */
      }
    }

    // Wire wiki_publish tool to shared gateway executor (used by code-act path)
    toolExecutor.setWikiPublisher((pages) => {
      for (const page of pages) {
        obsWriter.writePage(page as import('../../wiki/types.js').WikiPage);
      }
      if (pages.length > 0) {
        obsWriter.updateIndex(pages as import('../../wiki/types.js').WikiPage[]);
        obsWriter.appendLog('compile', `Published ${pages.length} pages`);
      }
      routesLogger.debug(`[Wiki Agent] Published ${pages.length} pages to vault`);

      eventBus.emit({
        type: 'wiki:compiled',
        pages: (pages as Array<{ path?: string }>).map((p) => p.path || ''),
      });
    });

    // Wiki trigger via executeValidatedRun
    const doWikiRun = async () => {
      if (!toolExecutor.getAgentProcessManager()) {
        routesLogger.warn('[Wiki Agent] AgentProcessManager not available yet');
        return;
      }
      try {
        routesLogger.debug('[Wiki Agent] Checking for updates...');

        const wikiPrompt = `You are triggered on a schedule. Before writing anything, determine if an update is needed:

1. Use agent_notices({limit: 100}) to find the most recent wiki-agent compiled/publish/task_complete notice. Treat that as the last compilation boundary.
2. NOVELTY CHECK by recency, not semantics: call mama_search({limit: 30}) with NO query -- that returns the newest decisions in creation order regardless of language or wording (semantic/lexical search misses cross-language items, which caused missed compilations). Compare created_at against the boundary.
3. If NO substantive decisions are newer than the boundary -> respond "NO_UPDATE" and stop. Do NOT call obsidian or wiki_publish.
4. If new items exist, use context_compile first to gather supporting context (limit 30, max_tool_calls 3, strictness "balanced").
   Use this exact task text for context_compile: "recent substantive project decisions, task progress, agent alerts, and major changes".
   Do not include dashboard_briefing, wiki_compilation, system-audit, or audit-log labels in the context_compile task text; filter those operational summaries after the packet returns.
   If the packet misses some of the new items from step 2 (it often will for cross-language content), write from the step-2 items directly -- the recency list is authoritative for WHAT is new; the packet only enriches.
   If context_compile is unavailable because there is no active worker envelope, fall back to ONE queried mama_search for enrichment and continue from the step-2 recency list.
5. Then follow your persona: APPEND today's daily note (daily/YYYY-MM-DD.md, create with the section skeleton on first write of the day), then promote qualifying lesson candidates into lessons/ pages (search before create; update, never duplicate). Do NOT write per-task status pages.
6. Do NOT call mama_save for the compilation; Obsidian/wiki files plus agent_activity are the durable operational record.

This saves resources. Only compile when there is genuinely new information to document.`;

        const { noUpdate } = await executeValidatedRun('wiki-agent', wikiPrompt, {
          requestTimeout: 600_000,
        });
        if (noUpdate) {
          routesLogger.debug('[Wiki Agent] No changes detected, skipped');
        } else {
          routesLogger.debug('[Wiki Agent] Compilation complete');
        }
      } catch (err) {
        routesLogger.error('[Wiki Agent] Error:', err instanceof Error ? err.message : err);
      }
    };

    // Serialize ALL wiki runs (boot, event-driven, manual) on one chain -- the
    // shared agent process rejects concurrent requests, so the boot run and a
    // manual trigger raced into 'Process is busy' (same pattern as the
    // dashboard agent's runDashboardAgent chain above).
    let wikiRunChain: Promise<void> = Promise.resolve();
    const runWikiAgent = (): Promise<void> => {
      wikiRunChain = wikiRunChain.then(doWikiRun).catch(() => {});
      return wikiRunChain;
    };

    // Event-driven: compile when extraction completes. Trailing-edge debounce so
    // bursts of extraction:completed events coalesce into one wiki compile run.
    eventBus.onDebounced('extraction:completed', () => runWikiAgent(), 30_000);

    // Promotion feeds the wiki: freshly promoted decisions are exactly the
    // material daily notes and lessons compile from.
    eventBus.onDebounced('memory:promoted', () => runWikiAgent(), 30_000);

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

    routesLogger.info(
      '[Wiki Agent] Ready — triggers: extraction:completed event, POST /api/wiki/compile'
    );
  }

  // -- Memory Promotion: scheduled observation->decision curation --
  // Owner directive 2026-07-11: the decision layer starved after the 07-03/04
  // backfill because nothing periodically judges connector-ingested business
  // data (the M0 kill switch removed direct LLM extraction, and the memory
  // agent only audits owner conversation turns). This pass has the memory
  // agent promote DURABLE judgments only -- task states stay on the board.
  const memoryAgentConfigured = hasEnabledAgentConfig('memory');
  if (memoryAgentConfigured) {
    const PROMOTION_INTERVAL_MS =
      Math.max(1, Number(process.env.MAMA_MEMORY_PROMOTION_HOURS) || 6) * 60 * 60 * 1000;
    const PROMOTION_INITIAL_DELAY_MS = 10 * 60 * 1000; // let connectors poll first

    const buildPromotionPrompt = (nowIso: string): string =>
      'PROMOTION RUN. You are curating durable business memory from recent data. ' +
      `The current time is ${nowIso}.\n` +
      '1. agent_notices({limit: 100}): find your latest promotion notice (action "promoted" ' +
      'or "no_update") and treat it as the boundary; default to the last 24h when absent.\n' +
      '2. kagemusha_entities({activeOnly: true}) to find the rooms active since the boundary, ' +
      'then kagemusha_messages({channelId, since: <boundary ISO>}) on the busiest 3-4 rooms.\n' +
      '3. For each candidate judgment, mama_search first to find the existing topic; reuse it ' +
      'so the evolution chain stays intact.\n' +
      '4. Promote at most 5 durable judgments per run via mama_save, following the PROMOTION RUN ' +
      'rules in your persona (pricing/scope agreements, standing client preferences, process ' +
      'rules, recurring risk patterns; NEVER task lifecycle states, greetings, or logistics). ' +
      'Include scopes (the source channel, and the project when identifiable) and event_date.\n' +
      '5. Finish with exactly PROMOTED <n> or NO_UPDATE.';

    const doPromotionRun = async () => {
      if (!toolExecutor.getAgentProcessManager()) {
        routesLogger.warn('[Memory Promotion] AgentProcessManager not available yet');
        return;
      }
      try {
        const { response, noUpdate } = await executeValidatedRun(
          'memory',
          buildPromotionPrompt(new Date().toISOString()),
          { requestTimeout: 600_000 }
        );
        const promotedMatch = response?.match(/PROMOTED\s+(\d+)/);
        const saved = promotedMatch ? Number(promotedMatch[1]) : 0;
        eventBus.emit({
          type: 'agent:action',
          agent: 'Memory Agent',
          action: noUpdate || saved === 0 ? 'no_update' : 'promoted',
          target: `promotion run: ${saved} saved`,
        });
        if (saved > 0) {
          eventBus.emit({ type: 'memory:promoted', saved });
          console.log(`[Memory Promotion] Promoted ${saved} durable judgments`);
        } else {
          routesLogger.debug('[Memory Promotion] Nothing qualified for promotion');
        }
      } catch (err) {
        routesLogger.error('[Memory Promotion] Error:', err instanceof Error ? err.message : err);
      }
    };

    // Serialize all promotion runs on one chain (same 'Process is busy' class
    // as the dashboard and wiki agents).
    let promotionRunChain: Promise<void> = Promise.resolve();
    const runMemoryPromotion = (): Promise<void> => {
      promotionRunChain = promotionRunChain.then(doPromotionRun).catch(() => {});
      return promotionRunChain;
    };

    setTimeout(runMemoryPromotion, PROMOTION_INITIAL_DELAY_MS);
    setInterval(runMemoryPromotion, PROMOTION_INTERVAL_MS);

    apiServer.app.post('/api/memory/promote', requireAuth, (_req, res) => {
      runMemoryPromotion().catch(() => {});
      res.json({ ok: true, message: 'Memory promotion run triggered' });
    });

    console.log(
      `[Memory Promotion] Ready: every ${PROMOTION_INTERVAL_MS / 3_600_000}h, POST /api/memory/promote`
    );
  }

  // -- System Audit: hourly deterministic code checks ---------------------
  // Owner decision 2026-04-22 (mama_conductor_audit_code_based_read_only),
  // landed 2026-07-17: the audit is fact collection and recording executed by
  // CODE - no LLM invocation, no auto-fix, no broad filesystem access. The
  // prior hourly LLM audit violated that decision and the 2026-05-14
  // no-shell-autofix rule, and lost its tools entirely to the persona
  // lockdown (--tools ""). The 24h alert-dedup contract (owner verdict
  // 2026-07-11) is preserved inside runCodeAudit; MAJOR findings flow through
  // dispatchSecurityAlertDirect to the configured security alert sender.
  const AUDIT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const AUDIT_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 min after startup

  const runSystemAudit = async (): Promise<CodeAuditReport | null> => {
    try {
      const report = await runCodeAudit({
        config: {
          telegram: config.telegram,
          multi_agent: config.multi_agent,
        },
        // Evaluated at audit time: gateway-wiring registers the sender only
        // for ACTIVE gateways, so a configured target on a dead gateway must
        // not report a false PASS.
        securityAlertConfigured: hasSecurityAlertSender(),
        // Direct dispatch, NOT recordSecurityEvent: audit findings are
        // self-generated and must not fabricate incident/denylist/RDAP
        // artifacts for a pseudo client. dispatchSecurityAlertDirect awaits
        // delivery and throws on failure, so runCodeAudit keeps
        // last_alerted_at null and retries on the next run (fail loud).
        alert: async (finding, reason) => {
          await dispatchSecurityAlertDirect({
            type: 'system_audit_finding',
            severity: 'critical',
            message: `[Audit/${reason}] ${finding.summary}`,
            // path carries the finding id so the alert-cooldown fingerprint
            // distinguishes findings instead of collapsing them all into one.
            path: finding.id,
            details: { findingId: finding.id, detail: finding.detail ?? null },
          });
        },
      });
      const majors = report.findings.filter((f) => f.severity === 'MAJOR').length;
      const minors = report.findings.filter((f) => f.severity === 'MINOR').length;
      routesLogger.info(
        `[System Audit] ${report.pass_items.length} pass, ${majors} MAJOR, ${minors} MINOR, ` +
          `alerted=[${report.alerted.join(',')}] in ${report.duration_ms}ms`
      );
      if (report.alert_delivery_failures.length > 0) {
        routesLogger.error(
          '[System Audit] Alert delivery failures:',
          report.alert_delivery_failures.join('; ')
        );
      }
      return report;
    } catch (err) {
      routesLogger.error(
        '[System Audit] Failed:',
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  };

  setTimeout(() => {
    void runSystemAudit();
    setInterval(() => void runSystemAudit(), AUDIT_INTERVAL_MS);
  }, AUDIT_INITIAL_DELAY_MS);

  // Manual trigger returns the full report (read-only, no LLM, fast)
  apiServer.app.post('/api/conductor/audit', requireAuth, async (_req, res) => {
    const report = await runSystemAudit();
    if (report) {
      res.json({ ok: true, mode: 'code', report });
    } else {
      res.status(500).json({ ok: false, error: 'audit failed - see daemon.log' });
    }
  });

  routesLogger.info(
    '[System Audit] Ready - deterministic code checks every 60 min, POST /api/conductor/audit for manual run'
  );

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
  apiServer.app.get('/api/sessions/last-active', requireAuth, async (_req, res) => {
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

  apiServer.app.get('/api/sessions', requireAuth, async (_req, res) => {
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

  // ── Kagemusha Tasks endpoint ───────────────────────────────────────────
  apiServer.app.get('/api/kagemusha/tasks', requireAuth, async (req, res) => {
    try {
      const { queryTasks } = await import('../../connectors/kagemusha/query-tools.js');
      const tasks = queryTasks({
        status: (req.query.status as string) || undefined,
        priority: (req.query.priority as string) || undefined,
        search: (req.query.search as string) || undefined,
        sourceRoom: (req.query.sourceRoom as string) || undefined,
        limit: req.query.limit ? Number(req.query.limit) : 30,
      });

      // Filter for overdue if requested
      if (req.query.filter === 'overdue') {
        const now = Date.now();
        const overdue = tasks.filter(
          (t: { deadline: string | null }) => t.deadline && new Date(t.deadline).getTime() < now
        );
        res.json({ success: true, tasks: overdue, total: overdue.length });
        return;
      }

      res.json({ success: true, tasks, total: tasks.length });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── Agent Notices endpoint ────────────────────────────────────────────
  apiServer.app.get('/api/agent-notices', requireAuth, async (_req, res) => {
    try {
      const limit = Number(_req.query.limit) || 20;
      const notices = eventBus.getRecentNotices(limit);
      res.json({
        success: true,
        notices: notices.map(
          (n: { agent: string; action: string; target?: string; timestamp: number }) => ({
            agent: n.agent,
            action: n.action,
            target: n.target,
            timestamp: new Date(n.timestamp).toISOString(),
          })
        ),
        total: notices.length,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
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

  // ── Daemon Log API ────────────────────────────────────────────────────
  apiServer.app.get('/api/logs/daemon', requireAuth, (req, res) => {
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

  // ── Workspace skills API ──────────────────────────────────────────────
  const skillsWorkDir = path.join(homedir(), '.mama', 'workspace', 'skills');
  apiServer.app.get('/api/workspace/skills', requireAuth, (_req, res) => {
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

  apiServer.app.get('/api/workspace/skills/:name/content', requireAuth, (req, res) => {
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
  const publicDir = path.join(__dirname, '..', '..', '..', 'public');
  apiServer.app.get('/setup', (_req, res) => {
    res.sendFile(path.join(publicDir, 'setup.html'));
  });

  apiServer.app.use(
    express.static(publicDir, {
      setHeaders: (res, _filePath) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      },
    })
  );
  console.log('✓ Viewer UI available at /viewer');
  console.log('✓ Setup wizard available at /setup');
}
