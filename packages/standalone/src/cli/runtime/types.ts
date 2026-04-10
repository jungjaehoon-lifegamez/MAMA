/**
 * MAMARuntime type definitions.
 *
 * Defines the master context object (MAMARuntime) that captures all the
 * major subsystem references assembled in runAgentLoop(). This file is
 * types-only — no runtime code.
 *
 * Will be imported by all runtime extraction modules (tasks 4-12).
 */

import type { MAMAConfig } from '../config/types.js';
import type { OAuthManager } from '../../auth/index.js';
import type { AgentLoop } from '../../agent/agent-loop.js';
import type { GatewayToolExecutor } from '../../agent/gateway-tool-executor.js';
import type { SessionStore } from '../../gateways/session-store.js';
import type { MessageRouter } from '../../gateways/message-router.js';
import type { DiscordGateway } from '../../gateways/discord.js';
import type { SlackGateway } from '../../gateways/slack.js';
import type { TelegramGateway } from '../../gateways/telegram.js';
import type { Gateway } from '../../gateways/types.js';
import type { MetricsStore } from '../../observability/metrics-store.js';
import type { HealthScoreService } from '../../observability/health-score.js';
import type { HealthCheckService } from '../../observability/health-check.js';
import type { ApiServer } from '../../api/index.js';
import type { MamaApiClient } from '../../gateways/context-injector.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import type { AgentLoopClient } from '../../gateways/message-router.js';

// Re-export AgentLoopClient so consumers can import it from this module
export type { AgentLoopClient };

/**
 * The shape of the raw MAMA Core API object loaded from mama-core.
 *
 * This is an inline type in start.ts around the `mamaApi` variable.
 * Extracted here so gateway/init modules can reference it by name.
 */
export interface MAMAApiShape {
  suggest?: (query: string, options?: { limit?: number }) => Promise<unknown>;
  search?: (query: string, limit?: number) => Promise<unknown>;
  save?: (input: unknown) => Promise<unknown>;
  update?: (decisionId: string, updates: unknown) => Promise<unknown>;
  updateOutcome?: (decisionId: string, updates: unknown) => Promise<unknown>;
  loadCheckpoint?: () => Promise<unknown>;
  list?: (options?: { limit?: number }) => Promise<unknown>;
  listDecisions?: (options?: { limit?: number }) => Promise<unknown>;
  recallMemory?: (
    query: string,
    options?: { scopes?: Array<{ kind: string; id: string }>; includeProfile?: boolean }
  ) => Promise<unknown>;
  ingestMemory?: (input: Record<string, unknown>) => Promise<unknown>;
  buildMemoryBootstrap?: (input: {
    scopes: Array<{ kind: string; id: string }>;
    channelKey?: string;
    currentGoal?: string;
    mainAgentState?: {
      active_goal?: string;
      active_channel?: string;
      active_user?: string;
    };
  }) => Promise<unknown>;
  getChannelSummary?: (channelKey: string) => Promise<unknown>;
  upsertChannelSummary?: (input: {
    channelKey: string;
    summaryMarkdown: string;
    deltaHash?: string;
  }) => Promise<unknown>;
  buildProfile?: (
    scopes?: Array<{ kind: string; id: string }>,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
}

/**
 * Master runtime context assembled by runAgentLoop().
 *
 * Captures every major subsystem reference in one place so that extracted
 * init modules can accept/return a partial or full MAMARuntime instead of
 * taking/returning individual parameters.
 *
 * Fields are nullable where the subsystem may not be initialised (e.g.
 * optional gateways, or services that require optional configuration).
 */
export interface MAMARuntime {
  // ── Foundational ──────────────────────────────────────────────────────────

  /** Loaded MAMA configuration */
  config: MAMAConfig;

  /** Sessions SQLite database */
  db: SQLiteDatabase;

  /** OAuth token manager for Claude CLI auth */
  oauthManager: OAuthManager;

  // ── Observability ─────────────────────────────────────────────────────────

  /** Time-series metrics store */
  metricsStore: MetricsStore | null;

  /** Health score computation service */
  healthService: HealthScoreService | null;

  /** Connection-based health check service */
  healthCheckService: HealthCheckService | null;

  // ── Session / Tool ────────────────────────────────────────────────────────

  /** In-memory session store for gateway conversations */
  sessionStore: SessionStore;

  /** Gateway tool executor (Gateway mode, not MCP) */
  toolExecutor: GatewayToolExecutor;

  /** Main agent loop instance */
  agentLoop: AgentLoop;

  /**
   * Thin wrapper around agentLoop that normalises the result to
   * `{ response: string }` and adds reasoning headers.
   */
  agentLoopClient: AgentLoopClient;

  // ── MAMA Core ─────────────────────────────────────────────────────────────

  /** Raw MAMA Core API object (loaded from mama-core module) */
  mamaApi: MAMAApiShape;

  /**
   * High-level MAMA API client used by MessageRouter and context injectors.
   * Wraps mamaApi with normalised return types.
   */
  mamaApiClient: MamaApiClient;

  /**
   * Optional extraction function wired up when a connector process is
   * available. Used by the connector pipeline to extract structured facts.
   */
  connectorExtractionFn: ((prompt: string) => Promise<string>) | null;

  // ── Routing ───────────────────────────────────────────────────────────────

  /** Cross-platform message router */
  messageRouter: MessageRouter;

  /**
   * Memory agent loop for async fact extraction.
   * Null until the memory persona is loaded successfully.
   */
  memoryAgentLoop: AgentLoop | null;

  // ── Gateways ──────────────────────────────────────────────────────────────

  /** Discord gateway instance (null if Discord not configured/enabled) */
  discordGateway: DiscordGateway | null;

  /** Slack gateway instance (null if Slack not configured/enabled) */
  slackGateway: SlackGateway | null;

  /** Telegram gateway instance (null if Telegram not configured/enabled) */
  telegramGateway: TelegramGateway | null;

  /**
   * Flat list of all active gateways.
   * Useful for iterating over all platforms uniformly (e.g. at shutdown).
   */
  gateways: Gateway[];

  // ── API ───────────────────────────────────────────────────────────────────

  /** HTTP API server (REST + Viewer UI + Setup Wizard) */
  apiServer: ApiServer | null;

  /**
   * Agent event bus for cross-agent notifications (notices, extractions, etc.).
   * Typed as `unknown` here to avoid a hard import on the dynamic-import class;
   * callers that need the full interface should import AgentEventBus directly.
   */
  eventBus: unknown | null;
}
