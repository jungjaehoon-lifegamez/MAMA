/**
 * Validation HTTP Handlers
 *
 * REST endpoints for validation summary, history, session detail,
 * comparison, and approval actions.
 */

import type { Request, Response } from 'express';
import type { SQLiteDatabase } from '../sqlite.js';
import {
  getValidationSummary,
  listValidationHistory,
  getValidationSessionDetail,
  approveValidationSession,
  getAgentValidationState,
} from '../validation/store.js';

function paramStr(val: unknown): string {
  if (Array.isArray(val)) return String(val[0] ?? '');
  return String(val ?? '');
}

// ── Summary ─────────────────────────────────────────────────────────────────
// GET /api/agents/:id/validation/summary

export function handleValidationSummary(db: SQLiteDatabase, req: Request, res: Response): void {
  const agentId = paramStr(req.params.id);
  const summary = getValidationSummary(db, agentId);
  res.json({ summary });
}

// ── History ─────────────────────────────────────────────────────────────────
// GET /api/agents/:id/validation/history

export function handleValidationHistory(db: SQLiteDatabase, req: Request, res: Response): void {
  const agentId = paramStr(req.params.id);
  const limit = parseInt(paramStr(req.query.limit || '50'), 10) || 50;
  const history = listValidationHistory(db, agentId, limit);
  res.json({ history });
}

// ── Session Detail ──────────────────────────────────────────────────────────
// GET /api/validation-sessions/:id

export function handleValidationSessionDetail(
  db: SQLiteDatabase,
  req: Request,
  res: Response
): void {
  const sessionId = paramStr(req.params.id);
  const detail = getValidationSessionDetail(db, sessionId);
  if (!detail) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(detail);
}

// ── Compare ─────────────────────────────────────────────────────────────────
// GET /api/agents/:id/compare?session=<id>&baseline=approved

export function handleValidationCompare(db: SQLiteDatabase, req: Request, res: Response): void {
  const agentId = paramStr(req.params.id);
  const sessionId = paramStr(req.query.session);
  const baselineMode = paramStr(req.query.baseline || 'approved');

  if (!sessionId) {
    res.status(400).json({ error: 'session query parameter required' });
    return;
  }

  const current = getValidationSessionDetail(db, sessionId);
  if (!current) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Find baseline session
  let baselineSessionId: string | null = null;
  if (baselineMode === 'approved') {
    const state = getAgentValidationState(db, agentId, current.session.trigger_type);
    baselineSessionId = state?.approved_session_id ?? null;
  } else {
    baselineSessionId = baselineMode;
  }

  if (!baselineSessionId) {
    res.json({ current, baseline: null, deltas: [] });
    return;
  }

  const baseline = getValidationSessionDetail(db, baselineSessionId);
  if (!baseline) {
    res.json({ current, baseline: null, deltas: [] });
    return;
  }

  // Compute deltas
  const baselineMetrics = new Map(baseline.metrics.map((m) => [m.name, m.value]));
  const deltas = current.metrics.map((m) => ({
    name: m.name,
    current: m.value,
    baseline: baselineMetrics.get(m.name) ?? null,
    delta: baselineMetrics.has(m.name) ? m.value - baselineMetrics.get(m.name)! : null,
    direction: m.direction,
  }));

  res.json({ current, baseline, deltas });
}

// ── Approve ─────────────────────────────────────────────────────────────────
// POST /api/agents/:id/validation/approve?session_id=<id>

export function handleValidationApprove(db: SQLiteDatabase, req: Request, res: Response): void {
  const sessionId =
    paramStr(req.query.session_id) || (req.body?.session_id as string | undefined) || '';
  if (!sessionId) {
    res.status(400).json({ error: 'session_id required' });
    return;
  }

  const detail = getValidationSessionDetail(db, sessionId);
  if (!detail) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  approveValidationSession(db, sessionId);
  res.json({ success: true, approved_session: sessionId });
}
