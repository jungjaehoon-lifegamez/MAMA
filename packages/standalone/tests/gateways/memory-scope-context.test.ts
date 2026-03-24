import { describe, it, expect } from 'vitest';
import { deriveMemoryScopes } from '../../src/memory/scope-context.js';

describe('standalone memory scope context', () => {
  it('should derive project, channel, and user scopes from a gateway message', () => {
    const scopes = deriveMemoryScopes({
      source: 'telegram',
      channelId: 'chat-1',
      userId: 'user-1',
      projectId: '/repo/demo',
    });

    expect(scopes.map((item) => item.kind)).toEqual(['project', 'channel', 'user', 'global']);
  });
});
