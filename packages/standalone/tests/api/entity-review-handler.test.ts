import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDB, initTestDB } from '../../../mama-core/src/test-utils.js';
import { getAdapter } from '../../../mama-core/src/db-manager.js';
import {
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
  headers?: Record<string, string>;
  remoteAddress?: string;
}): IncomingMessage {
  const stream = new Readable({
    read() {
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
  });
});
