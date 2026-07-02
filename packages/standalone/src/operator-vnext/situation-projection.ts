import { createHash } from 'node:crypto';

import {
  assertNonEmptySourceRefs,
  serializeSourceRef,
} from '@jungjaehoon/mama-core/provenance/source-ref';

import type {
  VNextReportSlot,
  VNextSituationInput,
  VNextSituationProjection,
  VNextTodaySituationRow,
} from './situation-projection-types.js';

const DEFAULT_PRIORITY = 100;

function requiredString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty`);
  }
  return trimmed;
}

function finiteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function clampConfidence(value: number): number {
  const confidence = finiteNumber(value, 'confidence');
  if (confidence < 0 || confidence > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
  return confidence;
}

function stableProjectionHash(rows: readonly VNextTodaySituationRow[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  if (rows.length === 1) {
    return rows[0].view_model_hash;
  }
  return createHash('sha256')
    .update(JSON.stringify(rows.map((row) => row.view_model_hash)))
    .digest('hex');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rowFromSituation(input: VNextSituationInput): VNextTodaySituationRow {
  assertNonEmptySourceRefs(input.evidenceRefs);
  const evidenceRefs = input.evidenceRefs.map((ref) => serializeSourceRef(ref));

  return {
    situation_id: requiredString(input.situationId, 'situationId'),
    situation_version: nonNegativeInteger(input.situationVersion, 'situationVersion'),
    awareness_run_id: requiredString(input.awarenessRunId, 'awarenessRunId'),
    title: requiredString(input.title, 'title'),
    summary: requiredString(input.summary, 'summary'),
    next_action: requiredString(input.nextAction, 'nextAction'),
    status: input.status,
    freshness: input.freshness,
    verification_state: input.verificationState,
    confidence: clampConfidence(input.confidence),
    evidence_count: evidenceRefs.length,
    evidence_refs: evidenceRefs,
    updated_at_ms: nonNegativeInteger(input.updatedAtMs, 'updatedAtMs'),
    view_model_hash: requiredString(input.viewModelHash, 'viewModelHash'),
    priority: nonNegativeInteger(input.priority ?? DEFAULT_PRIORITY, 'priority'),
    tags: [...(input.tags ?? [])].map((tag) => requiredString(tag, 'tag')),
    pending_reason: input.pendingReason
      ? requiredString(input.pendingReason, 'pendingReason')
      : null,
    owner_hint: input.ownerHint ? requiredString(input.ownerHint, 'ownerHint') : null,
    issue_count: nonNegativeInteger(input.issueCount ?? 0, 'issueCount'),
  };
}

export function buildSituationProjection(
  situations: readonly VNextSituationInput[],
  nowMs = Date.now()
): VNextSituationProjection {
  const generatedAtMs = nonNegativeInteger(nowMs, 'nowMs');
  const today = situations
    .map((situation) => rowFromSituation(situation))
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        right.updated_at_ms - left.updated_at_ms ||
        left.situation_id.localeCompare(right.situation_id)
    );

  return {
    projectionVersion: 1,
    generatedAtMs,
    viewModelHash: stableProjectionHash(today),
    today,
    status: {
      total: today.length,
      live: today.filter((row) => row.freshness === 'live').length,
      stale: today.filter((row) => row.freshness === 'stale').length,
      degraded: today.filter((row) => row.freshness === 'degraded').length,
      pendingVerification: today.filter((row) => row.verification_state === 'pending').length,
      verified: today.filter((row) => row.verification_state === 'verified').length,
      issueCount: today.reduce((sum, row) => sum + row.issue_count, 0),
      newestUpdatedAtMs: today.reduce<number | null>(
        (max, row) => (max === null ? row.updated_at_ms : Math.max(max, row.updated_at_ms)),
        null
      ),
    },
  };
}

export function buildReportSlotsFromSituationProjection(
  projection: VNextSituationProjection
): VNextReportSlot[] {
  const updatedAt = projection.generatedAtMs;
  const plural = projection.status.total === 1 ? 'situation' : 'situations';
  const statusHtml = [
    `<strong>${projection.status.total} current ${plural}</strong>`,
    `live ${projection.status.live}`,
    `pending ${projection.status.pendingVerification}`,
    `degraded ${projection.status.degraded}`,
  ].join(' · ');

  const todayRows = projection.today
    .map(
      (row) =>
        `<li data-situation-id="${escapeHtml(row.situation_id)}" data-view-model-hash="${escapeHtml(
          row.view_model_hash
        )}"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(
          row.next_action
        )}</span><code>${escapeHtml(row.view_model_hash)}</code></li>`
    )
    .join('');

  const evidenceRows = projection.today
    .map(
      (row) =>
        `<li><strong>${escapeHtml(row.title)}</strong><span>${row.evidence_count} refs</span></li>`
    )
    .join('');

  return [
    {
      slotId: 'briefing',
      html: `<section data-vnext-slot="briefing">${statusHtml}<ol>${todayRows}</ol></section>`,
      priority: 0,
      updatedAt,
    },
    {
      slotId: 'vnext-status',
      html: `<section data-vnext-slot="status">${statusHtml}</section>`,
      priority: 10,
      updatedAt,
    },
    {
      slotId: 'vnext-today',
      html: `<section data-vnext-slot="today"><ol>${todayRows}</ol></section>`,
      priority: 20,
      updatedAt,
    },
    {
      slotId: 'vnext-evidence',
      html: `<section data-vnext-slot="evidence"><ol>${evidenceRows}</ol></section>`,
      priority: 30,
      updatedAt,
    },
  ];
}
