import { describe, expect, it } from 'vitest';
import { ENVELOPE_HASH_EXCLUDED_FIELDS } from '../../src/envelope/types.js';
import type { Envelope } from '../../src/envelope/types.js';

describe('Envelope type', () => {
  it('compiles a sample envelope', () => {
    const sample: Envelope = {
      agent_id: 'worker',
      instance_id: 'inst_01',
      source: 'telegram',
      channel_id: 'tg:1234',
      trigger_context: { user_text: 'hi' },
      scope: {
        project_refs: [{ kind: 'project', id: '/workspace/project-a' }],
        raw_connectors: ['telegram'],
        memory_scopes: [{ kind: 'project', id: '/workspace/project-a' }],
        allowed_destinations: [{ kind: 'telegram', id: 'tg:1234' }],
      },
      tier: 1,
      budget: { wall_seconds: 10 },
      expires_at: '2026-04-26T12:00:00Z',
      envelope_hash: '0'.repeat(64),
    };

    expect(sample.tier).toBe(1);
    expect(ENVELOPE_HASH_EXCLUDED_FIELDS).toEqual(['envelope_hash', 'signature']);
  });
});
