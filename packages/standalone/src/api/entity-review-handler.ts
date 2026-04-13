import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  EntityMergeError,
  mergeEntityNodes,
  resolveCanonicalEntityId,
} from '@jungjaehoon/mama-core/entities/store';

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
  transaction?: <T extends (...args: never[]) => unknown>(fn: T) => T;
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
  if (!cursor) {
    return null;
  }
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) {
      return null;
    }
    const score = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isFinite(score) || !id) {
      return null;
    }
    return { score, id };
  } catch {
    return null;
  }
}

function encodeCursor(score: number, id: string): string {
  return Buffer.from(`${score}:${id}`, 'utf8').toString('base64');
}

function canonicalizeActorId(req: IncomingMessage): string {
  const uuid = req.headers['cf-access-authenticated-user-uuid'];
  if (typeof uuid === 'string' && uuid.trim().length > 0) {
    return `user_uuid:${uuid.trim()}`;
  }

  const email = req.headers['cf-access-authenticated-user-email'];
  if (typeof email === 'string' && email.trim().length > 0) {
    return `user:${email.trim().toLowerCase()}`;
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim().length > 0) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) {
      return `local:${first}`;
    }
  }

  const remote = req.socket?.remoteAddress ?? 'unknown';
  return `local:${remote}`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const pre = (req as unknown as { body?: Record<string, unknown> }).body;
  if (pre && typeof pre === 'object') {
    return pre;
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    req.on('data', (chunk: Buffer) => {
      byteCount += chunk.length;
      if (byteCount > 1_048_576) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8');
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
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x));
    }
    if (parsed && typeof parsed === 'object') {
      return Object.values(parsed as Record<string, unknown>).map((x) => String(x));
    }
    return [];
  } catch {
    return [];
  }
}

interface ResolvedRef {
  kind: string;
  id: string;
  label: string;
}

function resolveAliasEntityId(
  adapter: Adapter,
  refId: string
): { entityId: string; label: string } | null {
  try {
    const alias = adapter
      .prepare(`SELECT entity_id, label FROM entity_aliases WHERE id = ?`)
      .get(refId) as { entity_id: string; label: string } | undefined;
    if (!alias) {
      return null;
    }
    return { entityId: alias.entity_id, label: alias.label };
  } catch (error) {
    throw new Error(
      `Failed to resolve entity review alias ref ${refId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function resolveRef(adapter: Adapter, initialRefId: string): ResolvedRef {
  const aliasEntity = resolveAliasEntityId(adapter, initialRefId);
  const refId = aliasEntity?.entityId ?? initialRefId;

  let obs: { id: string; surface_form: string; entity_kind_hint: string | null } | undefined;
  try {
    obs = adapter
      .prepare(`SELECT id, surface_form, entity_kind_hint FROM entity_observations WHERE id = ?`)
      .get(refId) as
      | { id: string; surface_form: string; entity_kind_hint: string | null }
      | undefined;
  } catch (error) {
    throw new Error(
      `Failed to resolve entity review observation ref ${initialRefId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (obs) {
    return {
      kind: obs.entity_kind_hint ?? 'observation',
      id: obs.id,
      label: obs.surface_form,
    };
  }

  let entity: { id: string; kind: string; preferred_label: string } | undefined;
  try {
    entity = adapter
      .prepare(`SELECT id, kind, preferred_label FROM entity_nodes WHERE id = ?`)
      .get(refId) as { id: string; kind: string; preferred_label: string } | undefined;
  } catch (error) {
    throw new Error(
      `Failed to resolve entity review node ref ${initialRefId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (entity) {
    return { kind: entity.kind, id: entity.id, label: entity.preferred_label };
  }

  return { kind: 'unknown', id: initialRefId, label: aliasEntity?.label ?? initialRefId };
}

function resolveEvidence(adapter: Adapter, initialRefId: string): unknown[] {
  const aliasEntity = resolveAliasEntityId(adapter, initialRefId);
  const refId = aliasEntity?.entityId ?? initialRefId;
  let obs: Record<string, unknown> | undefined;
  try {
    obs = adapter.prepare(`SELECT * FROM entity_observations WHERE id = ?`).get(refId) as
      | Record<string, unknown>
      | undefined;
  } catch (error) {
    throw new Error(
      `Failed to resolve entity review evidence for ${initialRefId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
  if (idx < 0 || idx + 1 >= parts.length) {
    return null;
  }
  const id = parts[idx + 1]!;
  if (!id) {
    return null;
  }
  if (suffix) {
    const tail = parts[idx + 2];
    if (tail !== suffix) {
      return null;
    }
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

  const evidenceJson = JSON.stringify({
    candidate_id: id,
    left_ref: candidate.left_ref,
    right_ref: candidate.right_ref,
    score_total: candidate.score_total,
    rule_trace: parseRuleTrace(candidate.rule_trace),
  });

  // Best-effort resolve each candidate ref to an owning entity_node id.
  // Supported: ref is a direct entity_nodes.id, or an entity_aliases.id that
  // points at one. Observation-only refs (cluster candidates with no backing
  // entity) intentionally return null — the approve path then falls back to
  // audit-only behavior for backward compat, matching the v1 scope in
  // docs/superpowers/specs/2026-04-13-canonical-entity-merge-design.md.
  //
  // Merge-chain integrity errors (cycle, depth cap) are NOT swallowed — they
  // propagate to the outer try/catch so the handler returns 409 with a stable
  // code instead of silently downgrading to an audit-only write.
  const resolveRefToEntityId = (refId: string): string | null => {
    const alias = adapter
      .prepare(`SELECT entity_id FROM entity_aliases WHERE id = ?`)
      .get(refId) as { entity_id: string } | undefined;
    const initialEntityId = alias?.entity_id ?? refId;

    const node = adapter
      .prepare(`SELECT id FROM entity_nodes WHERE id = ?`)
      .get(initialEntityId) as { id: string } | undefined;
    if (!node) {
      return null;
    }
    try {
      return resolveCanonicalEntityId(adapter, node.id);
    } catch (err) {
      if (err instanceof EntityMergeError && err.code === 'entity.node_not_found') {
        return null;
      }
      throw err;
    }
  };

  let leftEntityId: string | null;
  let rightEntityId: string | null;
  try {
    leftEntityId = resolveRefToEntityId(candidate.left_ref);
    rightEntityId = resolveRefToEntityId(candidate.right_ref);
  } catch (err) {
    if (err instanceof EntityMergeError) {
      json(res, 409, {
        error: {
          code: err.code,
          message: err.message,
          hint: 'Inspect entity_nodes state for the candidate refs before retrying.',
          doc_url: 'docs/operations/entity-substrate-runbook.md#merge-failed',
        },
        context: {
          candidate_id: id,
          attempted_action: action,
        },
      });
      return;
    }
    throw err;
  }
  const canRealMerge =
    action === 'approve' &&
    leftEntityId !== null &&
    rightEntityId !== null &&
    leftEntityId !== rightEntityId;

  let mergeActionId = `mact_${randomUUID()}`;
  let createdAt = Date.now();

  const runRealMerge = () => {
    const result = mergeEntityNodes({
      adapter,
      source_id: leftEntityId as string,
      target_id: rightEntityId as string,
      actor_type: 'user',
      actor_id: actorId,
      reason,
      candidate_id: id,
      evidence_json: evidenceJson,
    });
    mergeActionId = result.merge_action_id;
    createdAt = result.merged_at;

    adapter
      .prepare(
        `
          UPDATE entity_resolution_candidates
          SET status = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(candidateStatus, createdAt, id);
  };

  const runAuditOnly = () => {
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
        leftEntityId,
        rightEntityId,
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
  };

  const persistDecision = canRealMerge ? runRealMerge : runAuditOnly;

  try {
    if (typeof adapter.transaction === 'function') {
      const txResult = adapter.transaction(persistDecision as never) as unknown;
      if (typeof txResult === 'function') {
        txResult();
      }
    } else {
      persistDecision();
    }
  } catch (err) {
    if (err instanceof EntityMergeError) {
      json(res, 409, {
        error: {
          code: err.code,
          message: err.message,
          hint: 'Inspect entity_nodes state for the candidate refs before retrying.',
          doc_url: 'docs/operations/entity-substrate-runbook.md#merge-failed',
        },
        context: {
          candidate_id: id,
          attempted_action: action,
          left_entity_id: leftEntityId,
          right_entity_id: rightEntityId,
        },
      });
      return;
    }
    throw err;
  }

  json(res, 200, {
    candidate_id: id,
    merge_action_id: mergeActionId,
    action: actionType,
    actor_id: actorId,
    created_at: new Date(createdAt).toISOString(),
    merge_applied: canRealMerge,
  });
}
