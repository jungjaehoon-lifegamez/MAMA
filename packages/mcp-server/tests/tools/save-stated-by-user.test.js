/**
 * W31.6: an MCP save says who stated the decision. It was always recorded as user-approved, so
 * the label could not answer the one question it exists for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAdapter } from '@jungjaehoon/mama-core/db-manager';
import { MAMAServer } from '../../src/server.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-db.js';

describe('save records who stated the decision', () => {
  let dbPath;
  let server;

  beforeAll(async () => {
    dbPath = await initTestDB('save-stated-by-user');
    server = new MAMAServer();
  });

  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });

  async function involvementOf(fields) {
    const result = await server.handleSave({
      type: 'decision',
      decision: 'Deploys freeze on Fridays',
      reasoning: 'weekend on-call is thin',
      ...fields,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const id = result.id?.id ?? result.id;
    return getAdapter().prepare('SELECT user_involvement FROM decisions WHERE id = ?').get(id)
      .user_involvement;
  }

  it('records an assistant insight unless the user stated it', async () => {
    expect(await involvementOf({ topic: 'deploy_freeze_default' })).not.toBe('approved');
    expect(await involvementOf({ topic: 'deploy_freeze_user', stated_by_user: true })).toBe(
      'approved'
    );
  });
});
