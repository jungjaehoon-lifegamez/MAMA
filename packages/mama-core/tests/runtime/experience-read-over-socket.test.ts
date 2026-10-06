/**
 * The advertised route: a principal calling `memory.read:experience` over the
 * real socket, with a real client.
 *
 * The action's authority is the RUN whose evidence it reads, and only a host
 * can name a run. A turn's host names it per turn; this socket's host names it
 * per principal, beside the access it resolves the credential to. Neither
 * derives it at call time, and the action refuses a call no host named -- which
 * is why this has to be exercised through the client rather than by handing the
 * fact to a dispatcher in a test: a producer that stops stating it does not
 * fail a unit test, it makes an advertised action uncallable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCatalog, coreActionRegistrations } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { createClient } from '../../src/client/client.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { getAdapter } from '../../src/db-manager.js';
import type { JudgmentAccess } from '../../src/knowledge/judgments.js';
import { appendOperationToolTrace } from '../../src/runtime/tool-trace-store.js';
import { startRuntime, type RuntimeHandle } from '../../src/runtime/runtime.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const PROJECT = 'proj-socket';

const OWNER: JudgmentAccess = {
  principalId: 'owner:runtime',
  agentId: 'mama-owner',
  scopes: [{ kind: 'project', id: PROJECT }],
  actions: ['memory.read:experience'],
};

describe('an advertised core action over the real client route', () => {
  let dbPath = '';
  let dir = '';
  let runtime: RuntimeHandle | undefined;
  let socketPath = '';
  let journalPath = '';
  let credential = '';

  beforeAll(async () => {
    dbPath = await initTestDB('experience-read-over-socket');
    dir = mkdtempSync(join(tmpdir(), 'mama-experience-socket-'));
    socketPath = join(dir, 'runtime.sock');
    journalPath = join(dir, 'operations.jsonl');
    const credentialPath = join(dir, 'owner.credential');
    const adapter = getAdapter();
    appendOperationToolTrace(adapter, {
      operation_id: 'op-socket',
      actor_principal_id: 'owner:runtime',
      tool_name: 'code_act',
      execution_status: 'completed',
      owner_scope: 'owner:runtime',
      project_id: PROJECT,
      created_at: 1_700_000_000_000,
    });
    const catalog = createCatalog(
      coreActionRegistrations(createKnowledge({ adapter, embedder: null }), adapter)
    );

    runtime = await startRuntime({
      paths: { socketPath },
      catalog,
      dispatch: createDispatcher(catalog),
      principals: [
        {
          access: OWNER,
          credentialPath,
          // What this socket's host can truthfully name: the run its one
          // principal calls as. Stated beside the access, not derived per call.
          runEvidenceScope: { ownerScope: 'owner:runtime', projectId: PROJECT },
        },
      ],
      reclaimStaleSocket: true,
    });
    credential = readFileSync(credentialPath, 'utf8');
  });

  afterAll(async () => {
    await runtime?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    await cleanupTestDB(dbPath);
  });

  it('answers a granted principal, bounded to the run the host named', async () => {
    const client = createClient({ socketPath, journalPath, credential });

    const result = await client.call({ action: 'memory.read:experience', input: {} });

    expect(result.status).toBe('completed');
    const data = (result as { data: { traces: Array<{ tool_name: string }> } }).data;
    expect(data.traces.map((row) => row.tool_name)).toEqual(['code_act']);
  });
});
