import { describe, expect, it } from 'vitest';

import { ChannelHistory } from '../../src/gateways/channel-history.js';

function recordFixtureHistory(history: ChannelHistory): void {
  const timestamp = Date.now();
  history.record('channel-1', {
    messageId: 'owner-message',
    sender: 'Owner',
    userId: 'owner-1',
    body: 'trusted owner context',
    timestamp,
  });
  history.record('channel-1', {
    messageId: 'external-message',
    sender: 'External',
    userId: 'external-1',
    body: 'untrusted delayed injection',
    timestamp: timestamp + 1,
  });
  history.record('channel-1', {
    messageId: 'bot-message',
    sender: 'MAMA',
    userId: 'bot-1',
    body: 'prior bot response',
    timestamp: timestamp + 2,
    isBot: true,
  });
}

describe('ChannelHistory prompt filtering', () => {
  it('preserves existing behavior when includeUserIds is omitted', () => {
    const history = new ChannelHistory();
    recordFixtureHistory(history);

    const context = history.formatForContext('channel-1');

    expect(context).toContain('trusted owner context');
    expect(context).toContain('untrusted delayed injection');
    expect(context).toContain('prior bot response');
  });

  it('includes only selected users and bot entries when includeUserIds is provided', () => {
    const history = new ChannelHistory();
    recordFixtureHistory(history);

    const context = history.formatForContext('channel-1', undefined, undefined, {
      includeUserIds: new Set(['owner-1']),
    });

    expect(context).toContain('trusted owner context');
    expect(context).not.toContain('untrusted delayed injection');
    expect(context).toContain('prior bot response');
  });

  it('returns an empty context for human-only history when the provided set is empty', () => {
    const history = new ChannelHistory();
    history.record('channel-1', {
      messageId: 'external-message',
      sender: 'External',
      userId: 'external-1',
      body: 'untrusted delayed injection',
      timestamp: Date.now(),
    });

    expect(
      history.formatForContext('channel-1', undefined, undefined, {
        includeUserIds: new Set(),
      })
    ).toBe('');
  });
});
