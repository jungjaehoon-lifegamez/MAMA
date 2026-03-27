import { describe, it, expect } from 'vitest';
import { classifyProfileEntries } from '../../src/memory-v2/profile-builder.js';

describe('profile builder', () => {
  it('should split static and dynamic memories', () => {
    const result = classifyProfileEntries([
      {
        id: '1',
        kind: 'preference',
        summary: 'Concise answers',
        details: 'Prefer short responses',
        confidence: 0.9,
        status: 'active',
        scopes: [],
        source: { package: 'mama-core', source_type: 'test' },
        created_at: 1,
        updated_at: 1,
      },
      {
        id: '2',
        kind: 'decision',
        summary: 'Current repo uses pnpm',
        details: 'Workspace standard',
        confidence: 0.8,
        status: 'active',
        scopes: [],
        source: { package: 'mama-core', source_type: 'test' },
        created_at: 1,
        updated_at: 1,
      },
    ]);

    expect(result.static).toHaveLength(1);
    expect(result.dynamic).toHaveLength(1);
  });
});
