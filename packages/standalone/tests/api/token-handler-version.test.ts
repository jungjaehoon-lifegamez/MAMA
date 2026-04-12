import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initTokenUsageTable, insertTokenUsage } from '../../src/api/token-handler.js';
import { applyTokenUsageAgentVersionMigration } from '../../src/db/migrations/token-usage-agent-version.js';

describe('Story V19.8: token_usage agent_version tracking', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    initTokenUsageTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('AC #1: stores agent_version when provided', () => {
    insertTokenUsage(db, {
      channel_key: 'discord:123',
      agent_id: 'conductor',
      agent_version: 4,
      input_tokens: 100,
      output_tokens: 50,
    });
    const row = db
      .prepare('SELECT agent_version FROM token_usage WHERE agent_id = ?')
      .get('conductor');
    expect(row.agent_version).toBe(4);
  });

  it('AC #2: defaults agent_version to null when not provided', () => {
    insertTokenUsage(db, {
      channel_key: 'discord:123',
      agent_id: 'conductor',
      input_tokens: 100,
      output_tokens: 50,
    });
    const row = db
      .prepare('SELECT agent_version FROM token_usage WHERE agent_id = ?')
      .get('conductor');
    expect(row.agent_version).toBeNull();
  });

  it('AC #3: token_usage migration no-ops when the table is absent', () => {
    const isolatedDb = new Database(':memory:');
    expect(() => applyTokenUsageAgentVersionMigration(isolatedDb)).not.toThrow();
    isolatedDb.close();
  });
});
