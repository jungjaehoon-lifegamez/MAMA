/**
 * Intelligence API router for /api/intelligence endpoints
 *
 * Provides alerts, activity feed, and project summary endpoints
 * derived from the decisions database.
 */

import { Router } from 'express';
import type { SQLiteDatabase } from '../sqlite.js';
import { asyncHandler } from './error-handler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertSeverity = 'high' | 'medium' | 'low';

export interface Alert {
  id: string | number;
  topic: string;
  kind: 'stale' | 'low_confidence';
  severity: AlertSeverity;
  message: string;
  updated_at: string;
}

export interface ActivityItem {
  type: string;
  id: string | number;
  topic: string;
  summary: string;
  project?: string;
  timestamp: string;
}

export interface ProjectSummary {
  project: string;
  activeDecisions: number;
  lastActivity: string;
  connectors?: string[];
}

export interface PipelineProject {
  project: string;
  activeDecisions: number;
  lastActivity: string;
  stages?: Record<string, number>;
  isNew?: boolean;
}

export interface ConnectorActivityItem {
  connector: string;
  summary: string;
  channel: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Pure business-logic functions
// ---------------------------------------------------------------------------

/**
 * Input shape for alert computation.
 */
export interface DecisionForAlerts {
  id: string | number;
  topic: string;
  decision: string;
  updated_at: string;
  status: string;
  confidence: number | null;
}

const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Severity ranking for sorting — higher number = higher priority */
const SEVERITY_RANK: Record<AlertSeverity, number> = { high: 3, medium: 2, low: 1 };

/**
 * Build alert list from a set of decisions.
 * Flags:
 *   - `stale`: active decisions where now - updated_at > 14 days
 *   - `low_confidence`: active decisions with confidence < 0.4
 * Returns alerts sorted by severity descending (high → medium → low).
 */
export function buildAlertsFromDecisions(
  decisions: DecisionForAlerts[],
  now: Date = new Date()
): Alert[] {
  const alerts: Alert[] = [];
  const nowMs = now.getTime();

  for (const d of decisions) {
    if (d.status !== 'active') continue;

    const updatedMs = new Date(d.updated_at).getTime();
    const ageMs = nowMs - updatedMs;

    if (ageMs > STALE_THRESHOLD_MS) {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      alerts.push({
        id: d.id,
        topic: d.topic,
        kind: 'stale',
        severity: ageDays > 30 ? 'high' : 'medium',
        message: `Decision has not been updated in ${ageDays} day${ageDays !== 1 ? 's' : ''}`,
        updated_at: d.updated_at,
      });
    }

    const confidence = d.confidence ?? 1;
    if (confidence < 0.4) {
      alerts.push({
        id: d.id,
        topic: d.topic,
        kind: 'low_confidence',
        severity: confidence < 0.2 ? 'high' : 'low',
        message: `Low confidence decision (${confidence.toFixed(2)})`,
        updated_at: d.updated_at,
      });
    }
  }

  return alerts.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/**
 * Build activity feed from raw items, sorted by timestamp descending.
 */
export function buildActivityFeed(items: ActivityItem[]): ActivityItem[] {
  return [...items].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * Build projects summary, sorted by lastActivity descending.
 */
export function buildProjectsSummary(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort(
    (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );
}

/**
 * Build pipeline fallback from project summaries, sorted by lastActivity descending.
 */
export function buildPipelineFallback(projects: ProjectSummary[]): PipelineProject[] {
  return [...projects]
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime())
    .map((p) => ({
      project: p.project,
      activeDecisions: p.activeDecisions,
      lastActivity: p.lastActivity,
    }));
}

/**
 * Build connector activity list, keeping only the latest item per connector,
 * sorted by timestamp descending.
 */
export function buildConnectorActivity(items: ConnectorActivityItem[]): ConnectorActivityItem[] {
  const latest = new Map<string, ConnectorActivityItem>();
  for (const item of items) {
    const existing = latest.get(item.connector);
    if (!existing || new Date(item.timestamp).getTime() > new Date(existing.timestamp).getTime()) {
      latest.set(item.connector, item);
    }
  }
  return Array.from(latest.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface DecisionRow {
  id: number;
  topic: string;
  decision: string;
  updated_at: string;
  status: string;
  confidence: number | null;
  created_at: string;
}

interface ProjectRow {
  project: string;
  activeDecisions: number;
  lastActivity: string;
}

interface ProjectDecisionRow {
  id: number;
  topic: string;
  decision: string;
  reasoning: string | null;
  status: string;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectDecision {
  id: number;
  topic: string;
  decision: string;
  reasoning: string | null;
  status: string;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Create the intelligence API router.
 */
export function createIntelligenceRouter(
  db: SQLiteDatabase,
  deps?: {
    reportStore?: { get(slotId: string): { html: string; updatedAt: number } | undefined };
    eventBus?: {
      getRecentNotices(
        limit: number
      ): Array<{ agent: string; action: string; target: string; timestamp: number }>;
    };
  }
): Router {
  const router = Router();

  // GET /api/intelligence/alerts
  // Queries active decisions, builds and returns alert list.
  router.get(
    '/alerts',
    asyncHandler(async (_req, res) => {
      const rows = db
        .prepare(
          `SELECT id, topic, decision, updated_at, status, confidence
           FROM decisions
           WHERE status = 'active'
           ORDER BY updated_at ASC`
        )
        .all() as DecisionRow[];

      const alerts = buildAlertsFromDecisions(rows);
      res.json({ alerts });
    })
  );

  // GET /api/intelligence/activity?limit=50
  // Returns recent decisions as activity items, max 200.
  router.get(
    '/activity',
    asyncHandler(async (req, res) => {
      const rawLimit = parseInt((req.query.limit as string) || '50', 10);
      const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit, 200);

      const rows = db
        .prepare(
          `SELECT id, topic, decision, status, updated_at, created_at
           FROM decisions
           ORDER BY updated_at DESC
           LIMIT ?`
        )
        .all(limit) as DecisionRow[];

      const items: ActivityItem[] = rows.map((r) => ({
        type: 'decision',
        id: r.id,
        topic: r.topic,
        summary: r.decision,
        timestamp: r.updated_at,
      }));

      res.json({ activity: buildActivityFeed(items), limit });
    })
  );

  // GET /api/intelligence/projects
  // Joins memory_scope_bindings + memory_scopes (kind='project') + decisions (status='active'),
  // groups by external_id and sorts by most recent activity.
  router.get(
    '/projects',
    asyncHandler(async (_req, res) => {
      const rows = db
        .prepare(
          `SELECT
             ms.external_id AS project,
             COUNT(d.id)    AS activeDecisions,
             MAX(d.updated_at) AS lastActivity
           FROM memory_scopes ms
           JOIN memory_scope_bindings msb ON msb.scope_id = ms.id
           JOIN decisions d ON d.id = msb.memory_id
           WHERE ms.kind = 'project'
             AND d.status = 'active'
           GROUP BY ms.external_id
           ORDER BY lastActivity DESC`
        )
        .all() as ProjectRow[];

      const projects: ProjectSummary[] = rows.map((r) => ({
        project: r.project,
        activeDecisions: r.activeDecisions,
        lastActivity: r.lastActivity,
      }));

      res.json({ projects: buildProjectsSummary(projects) });
    })
  );

  // GET /api/intelligence/projects/:projectId/decisions?limit=50
  // Returns decisions belonging to a specific project scope.
  router.get(
    '/projects/:projectId/decisions',
    asyncHandler(async (req, res) => {
      const projectId = req.params.projectId;
      const rawLimit = parseInt((req.query.limit as string) || '50', 10);
      const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit, 200);

      const rows = db
        .prepare(
          `SELECT d.id, d.topic, d.decision, d.reasoning, d.status, d.confidence,
                  d.created_at, d.updated_at
           FROM decisions d
           JOIN memory_scope_bindings msb ON msb.memory_id = d.id
           JOIN memory_scopes ms ON ms.id = msb.scope_id
           WHERE ms.kind = 'project'
             AND ms.external_id = ?
           ORDER BY d.updated_at DESC
           LIMIT ?`
        )
        .all(projectId, limit) as ProjectDecisionRow[];

      const decisions: ProjectDecision[] = rows.map((r) => ({
        id: r.id,
        topic: r.topic,
        decision: r.decision,
        reasoning: r.reasoning,
        status: r.status,
        confidence: r.confidence,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      res.json({ project: projectId, decisions, limit });
    })
  );

  // -------------------------------------------------------------------------
  // New endpoints: /summary, /pipeline, /notices
  // -------------------------------------------------------------------------

  // GET /api/intelligence/summary
  // Reads from reportStore's "briefing" slot (Dashboard Agent publishes to this slot).
  router.get(
    '/summary',
    asyncHandler(async (_req, res) => {
      const slot = deps?.reportStore?.get('briefing');
      if (!slot) {
        res.json({ text: '', generatedAt: null });
        return;
      }
      res.json({ text: slot.html, generatedAt: slot.updatedAt });
    })
  );

  // GET /api/intelligence/pipeline
  // Same SQL query as /projects, returns buildPipelineFallback(projects).
  router.get(
    '/pipeline',
    asyncHandler(async (_req, res) => {
      const rows = db
        .prepare(
          `SELECT
             ms.external_id AS project,
             COUNT(d.id)    AS activeDecisions,
             MAX(d.updated_at) AS lastActivity
           FROM memory_scopes ms
           JOIN memory_scope_bindings msb ON msb.scope_id = ms.id
           JOIN decisions d ON d.id = msb.memory_id
           WHERE ms.kind = 'project'
             AND d.status = 'active'
           GROUP BY ms.external_id
           ORDER BY lastActivity DESC`
        )
        .all() as ProjectRow[];

      const projects: ProjectSummary[] = rows.map((r) => ({
        project: r.project,
        activeDecisions: r.activeDecisions,
        lastActivity: r.lastActivity,
      }));

      res.json({ projects: buildPipelineFallback(projects) });
    })
  );

  // GET /api/intelligence/notices?limit=10
  // Reads from eventBus.getRecentNotices(). Max limit 50.
  router.get(
    '/notices',
    asyncHandler(async (req, res) => {
      const rawLimit = parseInt((req.query.limit as string) || '10', 10);
      const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 10 : rawLimit, 50);

      const notices = deps?.eventBus?.getRecentNotices(limit) ?? [];
      res.json({ notices });
    })
  );

  return router;
}
