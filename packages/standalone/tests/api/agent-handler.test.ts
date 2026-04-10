import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import Database from '../../src/sqlite.js';
import {
  initAgentTables,
  createAgentVersion,
  upsertMetrics,
  listVersions,
} from '../../src/db/agent-store.js';
import {
  handleGetAgents,
  handleGetAgent,
  handleCreateAgent,
  handleUpdateAgent,
  handleArchiveAgent,
  handleListVersions,
  handleCompareVersions,
  handleGetAgentMetrics,
} from '../../src/api/agent-handler.js';
function mockRes() {
  const res = { _status: 0, _body: '', _headers: {} as Record<string, string> } as {
    _status: number;
    _body: string;
    _headers: Record<string, string>;
    writeHead: (s: number, h: Record<string, string>) => void;
    end: (b: string) => void;
  };
  res.writeHead = (s, h) => {
    res._status = s;
    res._headers = h;
  };
  res.end = (b) => {
    res._body = b;
  };
  return res as unknown as ServerResponse & { _status: number; _body: string };
}

function makeConfig(agents: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return { multi_agent: { enabled: true, agents } };
}

describe('agent-handler', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initAgentTables(db);
  });

  describe('handleGetAgents', () => {
    it('returns agents list with latest version', () => {
      createAgentVersion(db, { agent_id: 'conductor', snapshot: { tier: 1 } });
      const config = makeConfig({ conductor: { name: 'Conductor', tier: 1, model: 'opus' } });
      const res = mockRes();
      handleGetAgents(res, config, db);
      const body = JSON.parse(res._body);
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].version).toBe(1);
      expect(body.agents[0].id).toBe('conductor');
    });

    it('returns version 0 for agents without versions', () => {
      const config = makeConfig({ dev: { name: 'Dev' } });
      const res = mockRes();
      handleGetAgents(res, config, db);
      const body = JSON.parse(res._body);
      expect(body.agents[0].version).toBe(0);
    });
  });

  describe('handleGetAgent', () => {
    it('returns single agent with persona text', () => {
      createAgentVersion(db, {
        agent_id: 'conductor',
        snapshot: { tier: 1 },
        persona_text: 'You are Conductor.',
      });
      const config = makeConfig({ conductor: { name: 'Conductor', tier: 1 } });
      const res = mockRes();
      handleGetAgent(res, 'conductor', config, db);
      const body = JSON.parse(res._body);
      expect(body.id).toBe('conductor');
      expect(body.system).toBe('You are Conductor.');
      expect(body.version).toBe(1);
    });

    it('returns 404 for unknown agent', () => {
      const res = mockRes();
      handleGetAgent(res, 'unknown', makeConfig({}), db);
      expect(res._status).toBe(404);
    });
  });

  describe('handleCreateAgent', () => {
    it('creates agent with version 1', () => {
      const res = mockRes();
      handleCreateAgent(res, { id: 'qa', name: 'QA Bot', model: 'sonnet', tier: 2 }, db);
      expect(res._status).toBe(201);
      const body = JSON.parse(res._body);
      expect(body.id).toBe('qa');
      expect(body.version).toBe(1);
    });

    it('rejects duplicate id with 409', () => {
      handleCreateAgent(mockRes(), { id: 'qa', name: 'QA', model: 'sonnet', tier: 1 }, db);
      const res = mockRes();
      handleCreateAgent(res, { id: 'qa', name: 'QA2', model: 'sonnet', tier: 1 }, db);
      expect(res._status).toBe(409);
    });

    it('rejects invalid id with 400', () => {
      const res = mockRes();
      handleCreateAgent(res, { id: 'has spaces', name: 'Bad', model: 'x', tier: 1 }, db);
      expect(res._status).toBe(400);
    });
  });

  describe('handleUpdateAgent', () => {
    it('updates agent and increments version', () => {
      createAgentVersion(db, { agent_id: 'dev', snapshot: { model: 'sonnet', tier: 1 } });
      const res = mockRes();
      handleUpdateAgent(
        res,
        'dev',
        { version: 1, changes: { model: 'opus' }, change_note: 'Upgrade' },
        db
      );
      const body = JSON.parse(res._body);
      expect(body.new_version).toBe(2);
    });

    it('rejects version mismatch with 409', () => {
      createAgentVersion(db, { agent_id: 'dev', snapshot: { tier: 1 } });
      const res = mockRes();
      handleUpdateAgent(res, 'dev', { version: 99, changes: { tier: 2 } }, db);
      expect(res._status).toBe(409);
    });

    it('returns 404 for unknown agent', () => {
      const res = mockRes();
      handleUpdateAgent(res, 'ghost', { version: 1, changes: {} }, db);
      expect(res._status).toBe(404);
    });

    it('preserves omitted fields', () => {
      createAgentVersion(db, {
        agent_id: 'dev',
        snapshot: { model: 'sonnet', tier: 1, effort: 'high' },
      });
      const res = mockRes();
      handleUpdateAgent(res, 'dev', { version: 1, changes: { tier: 2 } }, db);
      // Check the new snapshot has effort preserved
      const versions = listVersions(db, 'dev');
      const latest = JSON.parse(versions[0].snapshot);
      expect(latest.effort).toBe('high');
      expect(latest.tier).toBe(2);
    });
  });

  describe('handleArchiveAgent', () => {
    it('archives agent by adding archived version', () => {
      createAgentVersion(db, { agent_id: 'old', snapshot: { tier: 1 } });
      const res = mockRes();
      handleArchiveAgent(res, 'old', db);
      const body = JSON.parse(res._body);
      expect(body.success).toBe(true);
      expect(body.archived_at).toBeDefined();
    });
  });

  describe('handleListVersions', () => {
    it('returns version history in desc order', () => {
      createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 1 } });
      createAgentVersion(db, { agent_id: 'dev', snapshot: { v: 2 } });
      const res = mockRes();
      handleListVersions(res, 'dev', db);
      const body = JSON.parse(res._body);
      expect(body.versions).toHaveLength(2);
      expect(body.versions[0].version).toBe(2);
    });
  });

  describe('handleCompareVersions', () => {
    it('returns metrics comparison', () => {
      upsertMetrics(db, {
        agent_id: 'dev',
        agent_version: 1,
        period_start: '2026-04-10',
        input_tokens: 1000,
      });
      upsertMetrics(db, {
        agent_id: 'dev',
        agent_version: 2,
        period_start: '2026-04-10',
        input_tokens: 400,
      });
      const res = mockRes();
      handleCompareVersions(res, 'dev', 1, 2, db);
      const body = JSON.parse(res._body);
      expect(body.version_a.input_tokens).toBe(1000);
      expect(body.version_b.input_tokens).toBe(400);
    });
  });

  describe('handleGetAgentMetrics', () => {
    it('returns metrics for period', () => {
      upsertMetrics(db, {
        agent_id: 'dev',
        agent_version: 1,
        period_start: '2026-04-10',
        input_tokens: 500,
      });
      const res = mockRes();
      handleGetAgentMetrics(res, 'dev', '2026-04-01', '2026-04-11', db);
      const body = JSON.parse(res._body);
      expect(body.metrics).toHaveLength(1);
    });
  });
});
