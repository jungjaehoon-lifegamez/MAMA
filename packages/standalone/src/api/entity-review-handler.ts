import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

function candidateStaleEnvelope(context: Record<string, unknown>): {
  error: { code: string; message: string; hint: string; doc_url: string };
  context: Record<string, unknown>;
} {
  return {
    error: {
      code: 'entity.candidate_stale',
      message: 'Resolution candidate is stale.',
      hint: 'Refresh the candidate list and review the latest evidence before acting.',
      doc_url: 'docs/operations/entity-substrate-runbook.md#candidate-stale',
    },
    context,
  };
}

type ReviewAction = 'approve' | 'reject' | 'defer';

interface Adapter {
  prepare(sql: string): {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
}

interface CandidateRow {
  id: string;
  candidate_kind: string;
  left_ref: string;
  right_ref: string;
  status: string;
  score_total: number;
  score_structural: number;
  score_string: number;
  score_context: number;
  score_graph: number;
  score_embedding: number;
  rule_trace: string | null;
  extractor_version: string;
  embedding_model_version: string | null;
  created_at: number;
  updated_at: number;
  scope_kind?: string | null;
  scope_id?: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const ACTION_TO_TYPE: Record<ReviewAction, 'merge' | 'reject' | 'defer'> = {
  approve: 'merge',
  reject: 'reject',
  defer: 'defer',
};

const ACTION_TO_STATUS: Record<ReviewAction, 'approved' | 'rejected' | 'deferred'> = {
  approve: 'approved',
  reject: 'rejected',
  defer: 'deferred',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

function parseCursor(cursor: string | null): { score: number; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    const score = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isFinite(score) || !id) return null;
    return { score, id };
  } catch {
    return null;
  }
}

function encodeCursor(score: number, id: string): string {
  return Buffer.from(`${score}:${id}`, 'utf8').toString('base64');
}

function canonicalizeActorId(req: IncomingMessage): string {
  const remote = req.socket?.remoteAddress ?? 'unknown';
  return `local:${remote}`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const pre = (req as unknown as { body?: Record<string, unknown> }).body;
  if (pre && typeof pre === 'object') return pre;

  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 1_048_576) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseRuleTrace(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

interface ResolvedRef {
  kind: string;
  id: string;
  label: string;
}

function resolveRef(adapter: Adapter, refId: string): ResolvedRef {
  const obs = adapter
    .prepare(`SELECT id, surface_form, entity_kind_hint FROM entity_observations WHERE id = ?`)
    .get(refId) as
    | { id: string; surface_form: string; entity_kind_hint: string | null }
    | undefined;
  if (obs) {
    return {
      kind: obs.entity_kind_hint ?? 'observation',
      id: obs.id,
      label: obs.surface_form,
    };
  }

  const entity = adapter
    .prepare(`SELECT id, kind, preferred_label FROM entity_nodes WHERE id = ?`)
    .get(refId) as { id: string; kind: string; preferred_label: string } | undefined;
  if (entity) {
    return { kind: entity.kind, id: entity.id, label: entity.preferred_label };
  }

  return { kind: 'unknown', id: refId, label: refId };
}

function resolveEvidence(adapter: Adapter, refId: string): unknown[] {
  const obs = adapter.prepare(`SELECT * FROM entity_observations WHERE id = ?`).get(refId) as
    | Record<string, unknown>
    | undefined;
  if (obs) {
    return [
      {
        id: obs.id,
        surface_form: obs.surface_form,
        normalized_form: obs.normalized_form,
        lang: obs.lang,
        script: obs.script,
        context_summary: obs.context_summary,
        scope_kind: obs.scope_kind,
        scope_id: obs.scope_id,
        source_connector: obs.source_connector,
        source_raw_record_id: obs.source_raw_record_id,
        timestamp_observed: obs.timestamp_observed,
      },
    ];
  }
  return [];
}

function summarizeCandidate(adapter: Adapter, row: CandidateRow): Record<string, unknown> {
  return {
    id: row.id,
    candidate_kind: row.candidate_kind,
    status: row.status,
    score_total: row.score_total,
    left_ref: resolveRef(adapter, row.left_ref),
    right_ref: resolveRef(adapter, row.right_ref),
    created_at: new Date(row.created_at).toISOString(),
    scope_kind: row.scope_kind ?? null,
    scope_id: row.scope_id ?? null,
  };
}

export async function handleListEntityCandidates(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: Adapter
): Promise<void> {
  const url = parseUrl(req);
  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_LIMIT)
  );
  const cursor = parseCursor(url.searchParams.get('cursor'));
  const fetchLimit = limit + 1;

  let rows: CandidateRow[];
  if (cursor) {
    rows = adapter
      .prepare(
        `
          SELECT * FROM entity_resolution_candidates
          WHERE status = 'pending'
            AND (
              score_total < ?
              OR (score_total = ? AND id > ?)
            )
          ORDER BY score_total DESC, id ASC
          LIMIT ?
        `
      )
      .all(cursor.score, cursor.score, cursor.id, fetchLimit) as CandidateRow[];
  } else {
    rows = adapter
      .prepare(
        `
          SELECT * FROM entity_resolution_candidates
          WHERE status = 'pending'
          ORDER BY score_total DESC, id ASC
          LIMIT ?
        `
      )
      .all(fetchLimit) as CandidateRow[];
  }

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1]!;
    nextCursor = encodeCursor(last.score_total, last.id);
    rows = rows.slice(0, limit);
  }

  const candidates = rows.map((row) => summarizeCandidate(adapter, row));

  json(res, 200, { candidates, next_cursor: nextCursor });
}

function extractIdFromPath(url: URL, suffix?: string): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('candidates');
  if (idx < 0 || idx + 1 >= parts.length) return null;
  const id = parts[idx + 1]!;
  if (!id) return null;
  if (suffix) {
    const tail = parts[idx + 2];
    if (tail !== suffix) return null;
  }
  return id;
}

export async function handleGetEntityCandidate(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: Adapter
): Promise<void> {
  const url = parseUrl(req);
  const id = extractIdFromPath(url);
  if (!id) {
    json(res, 400, { error: { code: 'entity.invalid_request', message: 'missing candidate id' } });
    return;
  }

  const row = adapter.prepare(`SELECT * FROM entity_resolution_candidates WHERE id = ?`).get(id) as
    | CandidateRow
    | undefined;
  if (!row) {
    json(res, 404, {
      error: { code: 'entity.candidate_not_found', message: `candidate ${id} not found` },
    });
    return;
  }

  const summary = summarizeCandidate(adapter, row);
  const evidence = [
    ...resolveEvidence(adapter, row.left_ref),
    ...resolveEvidence(adapter, row.right_ref),
  ];

  const candidate = {
    ...summary,
    score_structural: row.score_structural,
    score_string: row.score_string,
    score_context: row.score_context,
    score_graph: row.score_graph,
    score_embedding: row.score_embedding,
    rule_trace: parseRuleTrace(row.rule_trace),
    evidence,
    extractor_version: row.extractor_version,
    embedding_model_version: row.embedding_model_version,
  };

  json(res, 200, { candidate });
}

export async function handleReviewEntityCandidate(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: Adapter,
  action: ReviewAction
): Promise<void> {
  const url = parseUrl(req);
  const id = extractIdFromPath(url, action);
  if (!id) {
    json(res, 400, { error: { code: 'entity.invalid_request', message: 'missing candidate id' } });
    return;
  }

  let body: Record<string, unknown> = {};
  try {
    body = await readBody(req);
  } catch (err) {
    json(res, 400, {
      error: {
        code: 'entity.invalid_request',
        message: err instanceof Error ? err.message : 'invalid body',
      },
    });
    return;
  }

  const actorId = canonicalizeActorId(req);
  const actionType = ACTION_TO_TYPE[action];
  const candidateStatus = ACTION_TO_STATUS[action];
  const reason = typeof body.reason === 'string' ? body.reason : `${action}_from_review_api`;

  const candidate = adapter
    .prepare(`SELECT * FROM entity_resolution_candidates WHERE id = ?`)
    .get(id) as CandidateRow | undefined;

  if (!candidate) {
    json(res, 404, {
      error: { code: 'entity.candidate_not_found', message: `candidate ${id} not found` },
    });
    return;
  }

  const existingAction = adapter
    .prepare(
      `
        SELECT id, action_type, actor_id, created_at
        FROM entity_merge_actions
        WHERE candidate_id = ? AND action_type = ? AND actor_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `
    )
    .get(id, actionType, actorId) as
    | { id: string; action_type: string; actor_id: string; created_at: number }
    | undefined;

  if (existingAction) {
    json(res, 200, {
      candidate_id: id,
      merge_action_id: existingAction.id,
      action: actionType,
      actor_id: existingAction.actor_id,
      created_at: new Date(existingAction.created_at).toISOString(),
    });
    return;
  }

  if (candidate.status !== 'pending') {
    json(
      res,
      409,
      candidateStaleEnvelope({
        candidate_id: id,
        current_status: candidate.status,
        attempted_action: action,
      })
    );
    return;
  }

  const mergeActionId = `mact_${randomUUID()}`;
  const createdAt = Date.now();
  const evidenceJson = JSON.stringify({
    candidate_id: id,
    left_ref: candidate.left_ref,
    right_ref: candidate.right_ref,
    score_total: candidate.score_total,
    rule_trace: parseRuleTrace(candidate.rule_trace),
  });

  adapter
    .prepare(
      `
        INSERT INTO entity_merge_actions (
          id, action_type, source_entity_id, target_entity_id, candidate_id,
          actor_type, actor_id, reason, evidence_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      mergeActionId,
      actionType,
      null,
      null,
      id,
      'user',
      actorId,
      reason,
      evidenceJson,
      createdAt
    );

  adapter
    .prepare(
      `
        UPDATE entity_resolution_candidates
        SET status = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(candidateStatus, createdAt, id);

  json(res, 200, {
    candidate_id: id,
    merge_action_id: mergeActionId,
    action: actionType,
    actor_id: actorId,
    created_at: new Date(createdAt).toISOString(),
  });
}
