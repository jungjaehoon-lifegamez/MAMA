/**
 * An amendment moves the target's projection columns and keeps, in its own record, the values it
 * replaced: the columns show the present, the appended records show the history.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { appendJudgment } from '../../src/knowledge/judgments.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const access = {
  principalId: 'principal-amend',
  agentId: 'agent-amend',
  scopes: [{ kind: 'project' as const, id: 'scope-amend' }],
  actions: [],
};

function payload(recordId: string): Record<string, unknown> {
  const row = getAdapter()
    .prepare('SELECT payload_json FROM decisions WHERE id = ?')
    .get(recordId) as {
    payload_json: string;
  };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

describe('knowledge/judgments: amendments keep what they replaced', () => {
  let dbPath = '';

  beforeAll(async () => {
    dbPath = await initTestDB('amendment-history');
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('an outcome amendment records the outcome it replaced', async () => {
    const adapter = getAdapter();
    const decision = await appendJudgment(
      { commandId: 'amend-base', topic: 'rollout', summary: 'Roll out', recordKind: 'judgment' },
      access,
      { adapter }
    );
    const target = { kind: 'memory' as const, id: decision.recordId };
    const first = await appendJudgment(
      {
        commandId: 'amend-success',
        topic: 'judgment/rollout',
        summary: 'Outcome SUCCESS',
        recordKind: 'judgment',
        amends: [{ target, outcome: 'SUCCESS' }],
      },
      access,
      { adapter }
    );
    const second = await appendJudgment(
      {
        commandId: 'amend-failed',
        topic: 'judgment/rollout',
        summary: 'Outcome FAILED',
        recordKind: 'judgment',
        amends: [{ target, outcome: 'FAILED', failureReason: 'rolled back' }],
      },
      access,
      { adapter }
    );

    expect(payload(first.recordId).replacedValues).toEqual([
      { target: decision.recordId, values: { outcome: null } },
    ]);
    expect(payload(second.recordId).replacedValues).toEqual([
      { target: decision.recordId, values: { outcome: 'SUCCESS', failureReason: null } },
    ]);
    expect(
      adapter.prepare('SELECT outcome FROM decisions WHERE id = ?').get(decision.recordId)
    ).toEqual({ outcome: 'FAILED' });
  });

  it('a replacement records the status the replaced record had', async () => {
    const adapter = getAdapter();
    const earlier = await appendJudgment(
      { commandId: 'replace-old', topic: 'policy', summary: 'Old policy', recordKind: 'judgment' },
      access,
      { adapter }
    );
    const later = await appendJudgment(
      {
        commandId: 'replace-new',
        topic: 'policy',
        summary: 'New policy',
        recordKind: 'judgment',
        replaces: [{ id: earlier.recordId, reason: 'the owner changed the policy' }],
      },
      access,
      { adapter }
    );

    const replaced = payload(later.recordId).replacedValues as Array<{
      target: string;
      values: Record<string, unknown>;
    }>;
    expect(replaced).toEqual([
      { target: earlier.recordId, values: { status: expect.anything(), supersededBy: null } },
    ]);
    expect(replaced[0].values.status).not.toBe('superseded');
  });
});
