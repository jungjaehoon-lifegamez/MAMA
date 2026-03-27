import crypto from 'node:crypto';

import { getAdapter, initDB } from '../db-manager.js';
import type { AuditFindingRecord } from './types.js';

function safeParseJsonArray(value: unknown): string[] {
  try {
    return JSON.parse(String(value)) as string[];
  } catch {
    return [];
  }
}

function deserializeFinding(row: Record<string, unknown>): AuditFindingRecord {
  return {
    finding_id: String(row.finding_id),
    kind: row.kind as AuditFindingRecord['kind'],
    severity: row.severity as AuditFindingRecord['severity'],
    summary: String(row.summary),
    evidence_refs: safeParseJsonArray(row.evidence_refs),
    affected_memory_ids: safeParseJsonArray(row.affected_memory_ids),
    recommended_action: String(row.recommended_action),
    status: row.status as AuditFindingRecord['status'],
    created_at: Number(row.created_at),
    resolved_at:
      row.resolved_at === null || row.resolved_at === undefined
        ? undefined
        : Number(row.resolved_at),
  };
}

export async function createAuditFinding(
  input: Omit<AuditFindingRecord, 'finding_id' | 'status' | 'created_at' | 'resolved_at'>
): Promise<string> {
  await initDB();
  const adapter = getAdapter();
  const findingId = `finding_${crypto.randomUUID().replace(/-/g, '')}`;

  adapter
    .prepare(
      `
        INSERT INTO audit_findings (
          finding_id, kind, severity, summary, evidence_refs, affected_memory_ids,
          recommended_action, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
      `
    )
    .run(
      findingId,
      input.kind,
      input.severity,
      input.summary,
      JSON.stringify(input.evidence_refs),
      JSON.stringify(input.affected_memory_ids),
      input.recommended_action,
      Date.now()
    );

  return findingId;
}

export async function listOpenAuditFindings(): Promise<AuditFindingRecord[]> {
  await initDB();
  const adapter = getAdapter();

  const rows = adapter
    .prepare(
      `
        SELECT finding_id, kind, severity, summary, evidence_refs, affected_memory_ids,
               recommended_action, status, created_at, resolved_at
        FROM audit_findings
        WHERE status = 'open'
        ORDER BY created_at DESC
      `
    )
    .all() as Record<string, unknown>[];

  return rows.map(deserializeFinding);
}

export async function resolveAuditFinding(
  findingId: string,
  status: 'resolved' | 'dismissed'
): Promise<void> {
  await initDB();
  const adapter = getAdapter();

  adapter
    .prepare(
      `
        UPDATE audit_findings
        SET status = ?, resolved_at = ?
        WHERE finding_id = ?
      `
    )
    .run(status, Date.now(), findingId);
}
