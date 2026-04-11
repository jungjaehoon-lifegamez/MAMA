/**
 * Agent CRUD API Handlers
 *
 * REST endpoints aligned with Claude Managed Agents pattern:
 * - Optimistic concurrency (version required on update)
 * - No-op detection (skip version bump on identical config)
 * - Partial updates (omitted fields preserved)
 */

import type { ServerResponse } from 'node:http';
import type { SQLiteDatabase } from '../sqlite.js';
// Use loose config type to match graph-api's loadMAMAConfig() return type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseConfig = Record<string, any>;
import {
  createAgentVersion,
  getLatestVersion,
  listVersions,
  getMetrics,
  getActivity,
  getActivitySummary,
  compareVersionMetrics,
  type AgentVersionRow,
} from '../db/agent-store.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function agentConfigToResponse(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cfg: Record<string, any>,
  latest: AgentVersionRow | null
) {
  return {
    id,
    name: cfg.name ?? id,
    display_name: cfg.display_name ?? cfg.name ?? id,
    model: cfg.model ?? null,
    backend: cfg.backend ?? 'claude',
    tier: cfg.tier ?? 1,
    enabled: cfg.enabled !== false,
    can_delegate: cfg.can_delegate ?? false,
    effort: cfg.effort ?? null,
    trigger_prefix: cfg.trigger_prefix ?? null,
    cooldown_ms: cfg.cooldown_ms ?? 5000,
    auto_continue: cfg.auto_continue ?? false,
    persona_file: cfg.persona_file ?? null,
    tool_permissions: cfg.tool_permissions ?? null,
    system: latest?.persona_text ?? null,
    description: null,
    tools: [],
    metadata: {},
    version: latest?.version ?? 0,
    created_at: latest?.created_at ?? null,
    updated_at: latest?.created_at ?? null,
    archived_at: null,
  };
}

// ── Handlers ────────────────────────────────────────────────────────────────

/** GET /api/agents — list all agents with latest version */
export function handleGetAgents(
  res: ServerResponse,
  config: LooseConfig,
  db: SQLiteDatabase
): void {
  const agents = (config.multi_agent?.agents ?? {}) as Record<string, Record<string, unknown>>;
  const list = Object.entries(agents).map(([id, cfg]) => {
    const latest = getLatestVersion(db, id);
    const lastActivity = getActivity(db, id, 1);
    return {
      ...agentConfigToResponse(id, cfg, latest),
      last_activity: lastActivity[0] ?? null,
    };
  });
  json(res, 200, { agents: list });
}

/** GET /api/agents/:id — single agent detail */
export function handleGetAgent(
  res: ServerResponse,
  agentId: string,
  config: LooseConfig,
  db: SQLiteDatabase
): void {
  const agentCfg = (
    config.multi_agent?.agents as Record<string, Record<string, unknown>> | undefined
  )?.[agentId];
  if (!agentCfg) {
    json(res, 404, { error: `Agent '${agentId}' not found` });
    return;
  }
  const latest = getLatestVersion(db, agentId);
  json(res, 200, agentConfigToResponse(agentId, agentCfg, latest));
}

/** POST /api/agents — create new agent */
export function handleCreateAgent(
  res: ServerResponse,
  body: Record<string, unknown>,
  db: SQLiteDatabase
): void {
  const id = body.id as string;
  if (!id || typeof id !== 'string' || !/^[a-z0-9_-]+$/i.test(id)) {
    json(res, 400, { error: 'Invalid agent id. Use lowercase alphanumeric, dash, underscore.' });
    return;
  }
  const existing = getLatestVersion(db, id);
  if (existing) {
    json(res, 409, { error: `Agent '${id}' already exists` });
    return;
  }
  const snapshot = {
    model: body.model ?? null,
    tier: body.tier ?? 1,
    backend: body.backend ?? 'claude',
    name: body.name ?? id,
  };
  const v = createAgentVersion(db, {
    agent_id: id,
    snapshot,
    persona_text: (body.system as string) ?? null,
    change_note: 'Initial creation',
  });
  json(res, 201, {
    id,
    name: body.name ?? id,
    version: v.version,
    created_at: v.created_at,
  });
}

/** POST /api/agents/:id — update agent (Managed Agents pattern: version required) */
export function handleUpdateAgent(
  res: ServerResponse,
  agentId: string,
  body: Record<string, unknown>,
  db: SQLiteDatabase
): void {
  const latest = getLatestVersion(db, agentId);
  if (!latest) {
    json(res, 404, { error: `Agent '${agentId}' not found` });
    return;
  }
  const requestedVersion = body.version as number | undefined;
  if (requestedVersion === undefined || requestedVersion !== latest.version) {
    json(res, 409, {
      error: `Version conflict: current is v${latest.version}, you sent v${requestedVersion ?? 'none'}`,
      current_version: latest.version,
    });
    return;
  }
  const changes = (body.changes ?? body) as Record<string, unknown>;
  const currentSnapshot = JSON.parse(latest.snapshot);
  const newSnapshot = { ...currentSnapshot };

  // Apply only provided fields
  for (const key of [
    'model',
    'tier',
    'backend',
    'name',
    'effort',
    'enabled',
    'can_delegate',
    'trigger_prefix',
    'cooldown_ms',
    'auto_continue',
    'tool_permissions',
  ]) {
    if (key in changes) {
      newSnapshot[key] = changes[key];
    }
  }

  const v = createAgentVersion(db, {
    agent_id: agentId,
    snapshot: newSnapshot,
    persona_text: (changes.system as string) ?? latest.persona_text,
    change_note: (body.change_note as string) ?? null,
  });
  json(res, 200, { success: true, new_version: v.version });
}

/** POST /api/agents/:id/archive — archive (soft delete) */
export function handleArchiveAgent(res: ServerResponse, agentId: string, db: SQLiteDatabase): void {
  const latest = getLatestVersion(db, agentId);
  if (!latest) {
    json(res, 404, { error: `Agent '${agentId}' not found` });
    return;
  }
  // Mark archived by storing a version with archived flag
  const currentSnapshot = JSON.parse(latest.snapshot);
  createAgentVersion(db, {
    agent_id: agentId,
    snapshot: { ...currentSnapshot, archived: true },
    persona_text: latest.persona_text,
    change_note: 'Archived',
  });
  json(res, 200, { success: true, archived_at: new Date().toISOString() });
}

/** GET /api/agents/:id/versions — version history */
export function handleListVersions(res: ServerResponse, agentId: string, db: SQLiteDatabase): void {
  const versions = listVersions(db, agentId);
  json(res, 200, { versions });
}

/** GET /api/agents/:id/metrics?from=&to= — metrics for period */
export function handleGetAgentMetrics(
  res: ServerResponse,
  agentId: string,
  from: string,
  to: string,
  db: SQLiteDatabase
): void {
  const metrics = getMetrics(db, agentId, from, to);
  json(res, 200, { metrics });
}

/** GET /api/agents/:id/activity — recent activity log */
export function handleGetAgentActivity(
  res: ServerResponse,
  agentId: string,
  db: SQLiteDatabase,
  limit: number
): void {
  const activity = getActivity(db, agentId, limit);
  json(res, 200, { activity });
}

/** GET /api/agents/activity-summary — aggregated activity with alerts */
export function handleGetActivitySummary(
  res: ServerResponse,
  db: SQLiteDatabase,
  since: string
): void {
  const summary = getActivitySummary(db, since);
  const alerts: string[] = [];
  for (const s of summary) {
    if (s.error_rate > 30) alerts.push(`${s.agent_id}: error rate ${s.error_rate}%`);
    if (s.consecutive_errors >= 3)
      alerts.push(`${s.agent_id}: ${s.consecutive_errors} consecutive errors`);
  }
  json(res, 200, { summary, alerts });
}

/** GET /api/agents/:id/versions/:v1/compare/:v2 — before/after comparison */
export function handleCompareVersions(
  res: ServerResponse,
  agentId: string,
  v1: number,
  v2: number,
  db: SQLiteDatabase
): void {
  const comparison = compareVersionMetrics(db, agentId, v1, v2);
  json(res, 200, comparison);
}
