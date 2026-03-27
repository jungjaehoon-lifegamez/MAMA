import { describe, it, expect } from 'vitest';
import { initDB, getAdapter } from '../../src/db-manager.js';

describe('Memory V2 scope schema', () => {
  it('should create memory_scopes and memory_scope_bindings tables', async () => {
    await initDB();
    const adapter = getAdapter();

    const scopes = adapter
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_scopes'`)
      .all();
    const bindings = adapter
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_scope_bindings'`)
      .all();

    expect(scopes).toHaveLength(1);
    expect(bindings).toHaveLength(1);
  });
});
