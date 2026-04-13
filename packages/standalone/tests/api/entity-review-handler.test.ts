import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import {
  attachEntityAlias,
  createEntityNode,
  upsertEntityObservation,
} from '../../../mama-core/src/entities/store.js';
import {
  handleGetEntityCandidate,
  handleListEntityCandidates,
  handleReviewEntityCandidate,
} from '../../src/api/entity-review-handler.js';

interface MockResponse {
  res: ServerResponse;
  readJson: () => unknown;
  getStatus: () => number;
}

function createMockRequest(input: {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  rawBody?: Buffer;
  headers?: Record<string, string>;
  remoteAddress?: string;
}): IncomingMessage {
  const stream = new Readable({
    read() {
      if (input.rawBody) {
        this.push(input.rawBody);
        this.push(null);
        return;
      }
      if (input.body !== undefined) {
        this.push(JSON.stringify(input.body));
      }
      this.push(null);
    },
  }) as IncomingMessage;

  Object.assign(stream, {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1' },
  });

  return stream;
}

function createMockResponse(): MockResponse {
  let statusCode = 200;
  let payload = '';
  const headers: Record<string, string> = {};

  const res = {
    writeHead(code: number, nextHeaders?: Record<string, string>) {
      statusCode = code;
      if (nextHeaders) {
        Object.assign(headers, nextHeaders);
      }
      return this;
    },
    end(chunk?: string) {
      payload = chunk ?? '';
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => statusCode,
    readJson: () => JSON.parse(payload),
  };
}

async function seedCandidate(input: {
  candidateId: string;
  leftId: string;
  rightId: string;
  leftLabel: string;
  rightLabel: string;
  scoreTotal: number;
  scopeId: string;
}): Promise<void> {
  await createEntityNode({
    id: `entity_${input.candidateId}`,
    kind: 'project',
    preferred_label: input.leftLabel,
    status: 'active',
    scope_kind: 'channel',
    scope_id: input.scopeId,
    merged_into: null,
  });

  await upsertEntityObservation({
    id: input.leftId,
    observation_type: 'generic',
    entity_kind_hint: 'project',
    surface_form: input.leftLabel,
    normalized_form: input.leftLabel.toLowerCase(),
    lang: 'en',
    script: 'Latn',
    context_summary: `${input.leftLabel} planning note`,
    related_surface_forms: [input.leftLabel],
    timestamp_observed: 1710000000000,
    scope_kind: 'channel',
    scope_id: input.scopeId,
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    source_connector: 'slack',
    source_raw_db_ref: '~/.mama/connectors/slack/raw.db',
    source_raw_record_id: `raw_${input.leftId}`,
  });

  await upsertEntityObservation({
    id: input.rightId,
    observation_type: 'generic',
    entity_kind_hint: 'project',
    surface_form: input.rightLabel,
    normalized_form: input.rightLabel.toLowerCase(),
    lang: 'en',
    script: 'Latn',
    context_summary: `${input.rightLabel} planning note`,
    related_surface_forms: [input.rightLabel],
    timestamp_observed: 1710000001000,
    scope_kind: 'channel',
    scope_id: input.scopeId,
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    source_connector: 'slack',
    source_raw_db_ref: '~/.mama/connectors/slack/raw.db',
    source_raw_record_id: `raw_${input.rightId}`,
  });

  getAdapter()
    .prepare(
      `
        INSERT INTO entity_resolution_candidates (
          id, candidate_kind, left_ref, right_ref, status, score_total,
          score_structural, score_string, score_context, score_graph, score_embedding,
          rule_trace, extractor_version, embedding_model_version, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.candidateId,
      'cluster',
      input.leftId,
      input.rightId,
      'pending',
      input.scoreTotal,
      1,
      0.5,
      0.25,
      0,
      0,
      JSON.stringify(['normalized_form_match', 'scope_match']),
      'history-extractor@v1',
      'multilingual-e5-large',
      Date.now(),
      Date.now()
    );
}

describe('Story E1.8: Entity review API', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-review-handler');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM entity_merge_actions').run();
    adapter.prepare('DELETE FROM entity_resolution_candidates').run();
    adapter.prepare('DELETE FROM entity_observations').run();
    adapter.prepare('DELETE FROM entity_aliases').run();
    adapter.prepare('DELETE FROM entity_nodes').run();
  });

  describe('AC #1: GET /api/entities/candidates', () => {
    it('lists pending candidates with opaque cursor pagination', async () => {
      await seedCandidate({
        candidateId: 'candidate_alpha',
        leftId: 'obs_alpha_left',
        rightId: 'obs_alpha_right',
        leftLabel: 'Project Alpha',
        rightLabel: 'Project Alpha Launch',
        scoreTotal: 0.95,
        scopeId: 'C123',
      });
      await seedCandidate({
        candidateId: 'candidate_beta',
        leftId: 'obs_beta_left',
        rightId: 'obs_beta_right',
        leftLabel: 'Project Beta',
        rightLabel: 'Project Beta Launch',
        scoreTotal: 0.85,
        scopeId: 'C123',
      });

      const req = createMockRequest({
        method: 'GET',
        url: '/api/entities/candidates?limit=1',
      });
      const first = createMockResponse();
      await handleListEntityCandidates(req, first.res, getAdapter());

      expect(first.getStatus()).toBe(200);
      const firstBody = first.readJson() as {
        candidates: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(firstBody.candidates).toHaveLength(1);
      expect(firstBody.candidates[0]?.id).toBe('candidate_alpha');
      expect(typeof firstBody.next_cursor).toBe('string');

      const secondReq = createMockRequest({
        method: 'GET',
        url: `/api/entities/candidates?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`,
      });
      const second = createMockResponse();
      await handleListEntityCandidates(secondReq, second.res, getAdapter());

      const secondBody = second.readJson() as {
        candidates: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(secondBody.candidates).toHaveLength(1);
      expect(secondBody.candidates[0]?.id).toBe('candidate_beta');
      expect(secondBody.next_cursor).toBeNull();
    });
  });

  describe('AC #2: GET /api/entities/candidates/:id', () => {
    it('returns candidate detail with evidence and score breakdown', async () => {
      await seedCandidate({
        candidateId: 'candidate_detail',
        leftId: 'obs_detail_left',
        rightId: 'obs_detail_right',
        leftLabel: 'Project Gamma',
        rightLabel: 'Gamma Project',
        scoreTotal: 0.91,
        scopeId: 'C555',
      });

      const req = createMockRequest({
        method: 'GET',
        url: '/api/entities/candidates/candidate_detail',
      });
      const res = createMockResponse();
      await handleGetEntityCandidate(req, res.res, getAdapter());

      const body = res.readJson() as {
        candidate: { id: string; evidence: Array<{ id: string }>; rule_trace: string[] };
      };
      expect(res.getStatus()).toBe(200);
      expect(body.candidate.id).toBe('candidate_detail');
      expect(body.candidate.evidence).toHaveLength(2);
      expect(body.candidate.rule_trace).toEqual(['normalized_form_match', 'scope_match']);
    });

    it('parses object-shaped rule_trace payloads into a readable array', async () => {
      await seedCandidate({
        candidateId: 'candidate_rule_trace_object',
        leftId: 'obs_rule_object_left',
        rightId: 'obs_rule_object_right',
        leftLabel: 'Project Rule Left',
        rightLabel: 'Project Rule Right',
        scoreTotal: 0.77,
        scopeId: 'C556',
      });

      getAdapter()
        .prepare(
          `
            UPDATE entity_resolution_candidates
            SET rule_trace = ?
            WHERE id = ?
          `
        )
        .run(JSON.stringify({ structural: 1, context: 0.25 }), 'candidate_rule_trace_object');

      const req = createMockRequest({
        method: 'GET',
        url: '/api/entities/candidates/candidate_rule_trace_object',
      });
      const res = createMockResponse();
      await handleGetEntityCandidate(req, res.res, getAdapter());

      const body = res.readJson() as { candidate: { rule_trace: string[] } };
      expect(body.candidate.rule_trace).toEqual(['1', '0.25']);
    });

    it('resolves alias refs through entity aliases before building the candidate summary', async () => {
      await createEntityNode({
        id: 'entity_alias_target',
        kind: 'project',
        preferred_label: 'Alias Backed Project',
        status: 'active',
        scope_kind: 'channel',
        scope_id: 'C558',
        merged_into: null,
      });
      await attachEntityAlias({
        id: 'alias_runtime_target',
        entity_id: 'entity_alias_target',
        label: 'Alias Runtime Target',
        normalized_label: 'alias runtime target',
        lang: 'en',
        script: 'Latn',
        label_type: 'alt',
        source_type: 'synthetic',
        source_ref: 'synthetic:alias',
        confidence: 0.9,
        status: 'active',
      });
      await upsertEntityObservation({
        id: 'obs_alias_right',
        observation_type: 'generic',
        entity_kind_hint: 'project',
        surface_form: 'Alias Backed Project',
        normalized_form: 'alias backed project',
        lang: 'en',
        script: 'Latn',
        context_summary: 'alias backed context',
        related_surface_forms: ['Alias Runtime Target'],
        timestamp_observed: 1710000000000,
        scope_kind: 'channel',
        scope_id: 'C558',
        extractor_version: 'history-extractor@v1',
        embedding_model_version: 'multilingual-e5-large',
        source_connector: 'synthetic',
        source_raw_db_ref: '/tmp/alias-runtime.db',
        source_raw_record_id: 'raw_alias_right',
      });

      getAdapter()
        .prepare(
          `
            INSERT INTO entity_resolution_candidates (
              id, candidate_kind, left_ref, right_ref, status, score_total,
              score_structural, score_string, score_context, score_graph, score_embedding,
              rule_trace, extractor_version, embedding_model_version, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          'candidate_alias_ref',
          'alias_to_entity',
          'alias_runtime_target',
          'obs_alias_right',
          'pending',
          0.81,
          0.2,
          0.1,
          0.3,
          0,
          0,
          JSON.stringify({ structural: 0.2 }),
          'history-extractor@v1',
          'multilingual-e5-large',
          Date.now(),
          Date.now()
        );

      const req = createMockRequest({
        method: 'GET',
        url: '/api/entities/candidates/candidate_alias_ref',
      });
      const res = createMockResponse();
      await handleGetEntityCandidate(req, res.res, getAdapter());

      const body = res.readJson() as {
        candidate: { left_ref: { id: string; label: string } };
      };
      expect(body.candidate.left_ref.id).toBe('entity_alias_target');
      expect(body.candidate.left_ref.label).toBe('Alias Backed Project');
    });
  });

  describe('AC #3: POST /api/entities/candidates/:id/approve', () => {
    it('ignores actor_id in request body and is idempotent on replay', async () => {
      await seedCandidate({
        candidateId: 'candidate_approve',
        leftId: 'obs_approve_left',
        rightId: 'obs_approve_right',
        leftLabel: 'Project Delta',
        rightLabel: 'Delta Project',
        scoreTotal: 0.93,
        scopeId: 'C777',
      });

      const req = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_approve/approve',
        body: { actor_id: 'malicious-body-actor', reason: 'looks right' },
      });
      const first = createMockResponse();
      await handleReviewEntityCandidate(req, first.res, getAdapter(), 'approve');

      const firstBody = first.readJson() as { actor_id: string; merge_action_id: string };
      expect(first.getStatus()).toBe(200);
      expect(firstBody.actor_id).toBe('local:127.0.0.1');

      const replayReq = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_approve/approve',
        body: { actor_id: 'another-body-actor' },
      });
      const replay = createMockResponse();
      await handleReviewEntityCandidate(replayReq, replay.res, getAdapter(), 'approve');

      const replayBody = replay.readJson() as { merge_action_id: string };
      expect(replayBody.merge_action_id).toBe(firstBody.merge_action_id);
    });

    it('prefers authenticated UUID headers over email and remote address for actor_id', async () => {
      await seedCandidate({
        candidateId: 'candidate_auth_actor',
        leftId: 'obs_auth_left',
        rightId: 'obs_auth_right',
        leftLabel: 'Project Lambda',
        rightLabel: 'Lambda Project',
        scoreTotal: 0.9,
        scopeId: 'C101',
      });

      const req = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_auth_actor/approve',
        body: {},
        headers: {
          'cf-access-authenticated-user-uuid': '  user-123  ',
          'cf-access-authenticated-user-email': 'reviewer@example.com',
        },
        remoteAddress: '10.0.0.7',
      });
      const res = createMockResponse();
      await handleReviewEntityCandidate(req, res.res, getAdapter(), 'approve');

      const body = res.readJson() as { actor_id: string };
      expect(body.actor_id).toBe('user_uuid:user-123');
    });
  });

  describe('AC #4: POST /api/entities/candidates/:id/reject', () => {
    it('rejects a candidate and persists rejected status', async () => {
      await seedCandidate({
        candidateId: 'candidate_reject',
        leftId: 'obs_reject_left',
        rightId: 'obs_reject_right',
        leftLabel: 'Project Epsilon',
        rightLabel: 'Epsilon Project',
        scoreTotal: 0.72,
        scopeId: 'C888',
      });

      const req = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_reject/reject',
        body: { reason: 'not the same project' },
      });
      const res = createMockResponse();
      await handleReviewEntityCandidate(req, res.res, getAdapter(), 'reject');

      expect(res.getStatus()).toBe(200);
      const row = getAdapter()
        .prepare('SELECT status FROM entity_resolution_candidates WHERE id = ?')
        .get('candidate_reject') as { status: string };
      expect(row.status).toBe('rejected');
    });
  });

  describe('AC #5: POST /api/entities/candidates/:id/defer', () => {
    it('defers a candidate and returns stale on a conflicting follow-up action', async () => {
      await seedCandidate({
        candidateId: 'candidate_defer',
        leftId: 'obs_defer_left',
        rightId: 'obs_defer_right',
        leftLabel: 'Project Zeta',
        rightLabel: 'Zeta Project',
        scoreTotal: 0.7,
        scopeId: 'C999',
      });

      const deferReq = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_defer/defer',
        body: { reason: 'need more evidence' },
      });
      const deferRes = createMockResponse();
      await handleReviewEntityCandidate(deferReq, deferRes.res, getAdapter(), 'defer');
      expect(deferRes.getStatus()).toBe(200);

      const rejectReq = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_defer/reject',
        body: { reason: 'actually reject it' },
      });
      const rejectRes = createMockResponse();
      await handleReviewEntityCandidate(rejectReq, rejectRes.res, getAdapter(), 'reject');

      expect(rejectRes.getStatus()).toBe(409);
      const body = rejectRes.readJson() as { error: { code: string } };
      expect(body.error.code).toBe('entity.candidate_stale');
    });

    it('rejects oversized multibyte request bodies using the byte limit', async () => {
      await seedCandidate({
        candidateId: 'candidate_body_limit',
        leftId: 'obs_limit_left',
        rightId: 'obs_limit_right',
        leftLabel: 'Project Limit Left',
        rightLabel: 'Project Limit Right',
        scoreTotal: 0.7,
        scopeId: 'C557',
      });

      const oversized = Buffer.from(`{"reason":"${'\\uAC00'.repeat(400000)}"}`, 'utf8');
      const req = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_body_limit/defer',
        rawBody: oversized,
      });
      const res = createMockResponse();

      await handleReviewEntityCandidate(req, res.res, getAdapter(), 'defer');

      expect(res.getStatus()).toBe(400);
      const body = res.readJson() as { error: { message: string } };
      expect(body.error.message).toContain('Request body too large');
    });
  });

  describe('Issue #79: approve actually merges canonical entities', () => {
    async function seedEntityPair(scopeId: string): Promise<{
      sourceEntityId: string;
      targetEntityId: string;
      candidateId: string;
    }> {
      const sourceEntityId = 'entity_source_79';
      const targetEntityId = 'entity_target_79';
      await createEntityNode({
        id: sourceEntityId,
        kind: 'project',
        preferred_label: 'Project 79 Source',
        status: 'active',
        scope_kind: 'channel',
        scope_id: scopeId,
        merged_into: null,
      });
      await createEntityNode({
        id: targetEntityId,
        kind: 'project',
        preferred_label: 'Project 79 Target',
        status: 'active',
        scope_kind: 'channel',
        scope_id: scopeId,
        merged_into: null,
      });
      await attachEntityAlias({
        id: 'alias_source_79',
        entity_id: sourceEntityId,
        label: 'Project 79 Source',
        normalized_label: 'project 79 source',
        lang: 'en',
        script: 'Latn',
        label_type: 'pref',
        source_type: 'synthetic',
        source_ref: 'synthetic:test',
        confidence: 0.9,
        status: 'active',
      });
      await attachEntityAlias({
        id: 'alias_target_79',
        entity_id: targetEntityId,
        label: 'Project 79 Target',
        normalized_label: 'project 79 target',
        lang: 'en',
        script: 'Latn',
        label_type: 'pref',
        source_type: 'synthetic',
        source_ref: 'synthetic:test',
        confidence: 0.9,
        status: 'active',
      });

      const candidateId = 'candidate_issue79';
      getAdapter()
        .prepare(
          `
            INSERT INTO entity_resolution_candidates (
              id, candidate_kind, left_ref, right_ref, status, score_total,
              score_structural, score_string, score_context, score_graph, score_embedding,
              rule_trace, extractor_version, embedding_model_version, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          candidateId,
          'entity_to_entity',
          'alias_source_79',
          'alias_target_79',
          'pending',
          0.92,
          0.9,
          0.85,
          0.7,
          0,
          0,
          JSON.stringify(['structural_match']),
          'history-extractor@v1',
          'multilingual-e5-large',
          Date.now(),
          Date.now()
        );

      return { sourceEntityId, targetEntityId, candidateId };
    }

    it('populates source/target entity IDs and sets merged_into on approve', async () => {
      const { sourceEntityId, targetEntityId, candidateId } = await seedEntityPair('C_issue79');

      const req = createMockRequest({
        method: 'POST',
        url: `/api/entities/candidates/${candidateId}/approve`,
        body: { reason: 'same project' },
      });
      const res = createMockResponse();
      await handleReviewEntityCandidate(req, res.res, getAdapter(), 'approve');

      expect(res.getStatus()).toBe(200);
      const body = res.readJson() as { merge_applied: boolean; merge_action_id: string };
      expect(body.merge_applied).toBe(true);

      // Merge action row has both entity IDs populated (was null before the fix).
      const action = getAdapter()
        .prepare(
          'SELECT source_entity_id, target_entity_id, action_type FROM entity_merge_actions WHERE id = ?'
        )
        .get(body.merge_action_id) as {
        source_entity_id: string | null;
        target_entity_id: string | null;
        action_type: string;
      };
      expect(action.source_entity_id).toBe(sourceEntityId);
      expect(action.target_entity_id).toBe(targetEntityId);
      expect(action.action_type).toBe('merge');

      // Source entity is now tombstoned into target.
      const source = getAdapter()
        .prepare('SELECT merged_into, status FROM entity_nodes WHERE id = ?')
        .get(sourceEntityId) as { merged_into: string | null; status: string };
      expect(source.merged_into).toBe(targetEntityId);
      expect(source.status).toBe('merged');

      // Target entity is untouched.
      const target = getAdapter()
        .prepare('SELECT merged_into, status FROM entity_nodes WHERE id = ?')
        .get(targetEntityId) as { merged_into: string | null; status: string };
      expect(target.merged_into).toBeNull();
      expect(target.status).toBe('active');

      // Timeline event recorded the merge on the source entity.
      const timeline = getAdapter()
        .prepare(
          'SELECT event_type, entity_id FROM entity_timeline_events WHERE entity_id = ? AND event_type = ?'
        )
        .get(sourceEntityId, 'merged') as { event_type: string; entity_id: string };
      expect(timeline.event_type).toBe('merged');
    });

    it('falls back to audit-only when refs do not resolve to entity nodes', async () => {
      // Original cluster-observation path — no backing entities. Must not regress.
      await seedCandidate({
        candidateId: 'candidate_cluster_only',
        leftId: 'obs_cluster_left',
        rightId: 'obs_cluster_right',
        leftLabel: 'Cluster Left',
        rightLabel: 'Cluster Right',
        scoreTotal: 0.81,
        scopeId: 'C_cluster',
      });

      const req = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_cluster_only/approve',
        body: { reason: 'approve observation cluster' },
      });
      const res = createMockResponse();
      await handleReviewEntityCandidate(req, res.res, getAdapter(), 'approve');

      expect(res.getStatus()).toBe(200);
      const body = res.readJson() as { merge_applied: boolean };
      expect(body.merge_applied).toBe(false);

      // Audit row exists but no entity was mutated (no entity nodes to mutate).
      const action = getAdapter()
        .prepare('SELECT action_type FROM entity_merge_actions WHERE candidate_id = ?')
        .get('candidate_cluster_only') as { action_type: string };
      expect(action.action_type).toBe('merge');
    });

    it('returns 409 entity.merge_scope_mismatch when entities cross scopes', async () => {
      await createEntityNode({
        id: 'entity_scope_a',
        kind: 'project',
        preferred_label: 'Scope A',
        status: 'active',
        scope_kind: 'channel',
        scope_id: 'C_scope_a',
        merged_into: null,
      });
      await createEntityNode({
        id: 'entity_scope_b',
        kind: 'project',
        preferred_label: 'Scope B',
        status: 'active',
        scope_kind: 'channel',
        scope_id: 'C_scope_b',
        merged_into: null,
      });
      await attachEntityAlias({
        id: 'alias_scope_a',
        entity_id: 'entity_scope_a',
        label: 'Scope A',
        normalized_label: 'scope a',
        lang: 'en',
        script: 'Latn',
        label_type: 'pref',
        source_type: 'synthetic',
        source_ref: 'synthetic:test',
        confidence: 0.9,
        status: 'active',
      });
      await attachEntityAlias({
        id: 'alias_scope_b',
        entity_id: 'entity_scope_b',
        label: 'Scope B',
        normalized_label: 'scope b',
        lang: 'en',
        script: 'Latn',
        label_type: 'pref',
        source_type: 'synthetic',
        source_ref: 'synthetic:test',
        confidence: 0.9,
        status: 'active',
      });
      getAdapter()
        .prepare(
          `
            INSERT INTO entity_resolution_candidates (
              id, candidate_kind, left_ref, right_ref, status, score_total,
              score_structural, score_string, score_context, score_graph, score_embedding,
              rule_trace, extractor_version, embedding_model_version, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          'candidate_cross_scope',
          'entity_to_entity',
          'alias_scope_a',
          'alias_scope_b',
          'pending',
          0.85,
          0.9,
          0.8,
          0.5,
          0,
          0,
          JSON.stringify(['cross_scope']),
          'history-extractor@v1',
          'multilingual-e5-large',
          Date.now(),
          Date.now()
        );

      const req = createMockRequest({
        method: 'POST',
        url: '/api/entities/candidates/candidate_cross_scope/approve',
        body: { reason: 'attempt cross-scope merge' },
      });
      const res = createMockResponse();
      await handleReviewEntityCandidate(req, res.res, getAdapter(), 'approve');

      expect(res.getStatus()).toBe(409);
      const body = res.readJson() as { error: { code: string } };
      expect(body.error.code).toBe('entity.merge_scope_mismatch');

      // Candidate was NOT updated; entities were NOT mutated.
      const candidateRow = getAdapter()
        .prepare('SELECT status FROM entity_resolution_candidates WHERE id = ?')
        .get('candidate_cross_scope') as { status: string };
      expect(candidateRow.status).toBe('pending');

      const scopeA = getAdapter()
        .prepare('SELECT status, merged_into FROM entity_nodes WHERE id = ?')
        .get('entity_scope_a') as { status: string; merged_into: string | null };
      expect(scopeA.status).toBe('active');
      expect(scopeA.merged_into).toBeNull();
    });
  });
});
