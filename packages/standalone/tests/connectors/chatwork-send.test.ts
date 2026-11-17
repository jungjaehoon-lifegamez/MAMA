import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatworkConnector } from '../../src/connectors/chatwork/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const envName = 'MAMA_CHATWORK_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: {
    '111': { role: 'hub', name: 'room-one' },
    '222': { role: 'hub' },
    '333': { role: 'ignore', name: 'muted' },
  },
  auth: { type: 'token', tokenName: envName },
};

function json(status: number, body: unknown) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('ChatworkConnector sends (approvals.md, S1)', () => {
  beforeEach(() => {
    process.env[envName] = 'fixture-chatwork-token';
  });
  afterEach(() => {
    delete process.env[envName];
  });

  it('lists the rooms the source reads, with their names, not the ignored ones', async () => {
    const connector = new ChatworkConnector(config, { fetch: vi.fn() });
    expect(connector.rooms()).toEqual([
      { id: '111', name: 'room-one' },
      { id: '222', name: null },
    ]);
  });

  it('names the account the token posts as', async () => {
    const http = vi.fn().mockResolvedValue(json(200, { account_id: 7, name: 'account-a' }));
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();
    await expect(connector.account()).resolves.toEqual({ id: '7', name: 'account-a' });
    expect(http.mock.calls[0]?.[0]).toBe('https://api.chatwork.com/v2/me');
    // Read right before a post, so bounded like it.
    expect(http.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('posts one message as a form and returns its id', async () => {
    const http = vi.fn().mockResolvedValue(json(200, { message_id: '9001' }));
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();
    await expect(connector.sendMessage('111', 'line one\nline two & more')).resolves.toEqual({
      messageId: '9001',
    });
    expect(http).toHaveBeenCalledTimes(1);
    const [url, request] = http.mock.calls[0]!;
    expect(url).toBe('https://api.chatwork.com/v2/rooms/111/messages');
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({
      'X-ChatWorkToken': 'fixture-chatwork-token',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(new URLSearchParams(request.body as string).get('body')).toBe(
      'line one\nline two & more'
    );
  });

  it('says a refused post was not posted', async () => {
    const http = vi.fn().mockResolvedValue(json(403, { errors: ['no permission'] }));
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();
    await expect(connector.sendMessage('111', 'x')).rejects.toThrow(
      /Chatwork refused the message \(403\).*no permission.*not posted/
    );
  });

  it('says a post whose answer was lost may have been posted', async () => {
    const http = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();
    await expect(connector.sendMessage('111', 'x')).rejects.toMatchObject({
      name: 'outcome_unknown',
      message: expect.stringMatching(/may have been posted/),
    });
    const late = vi.fn().mockResolvedValue(json(502, {}));
    const second = new ChatworkConnector(config, { fetch: late });
    await second.init();
    await expect(second.sendMessage('111', 'x')).rejects.toMatchObject({ name: 'outcome_unknown' });
  });

  it('gives up after a timeout, as may have been posted', async () => {
    const http = vi.fn((_url: string, request: RequestInit) => {
      expect(request.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(new DOMException('timed out', 'TimeoutError'));
    });
    const connector = new ChatworkConnector(config, { fetch: http as unknown as typeof fetch });
    await connector.init();
    await expect(connector.sendMessage('111', 'x')).rejects.toMatchObject({
      name: 'outcome_unknown',
    });
  });

  it('a post whose answer cannot be read was posted, outcome unknown', async () => {
    const http = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    });
    const connector = new ChatworkConnector(config, { fetch: http });
    await connector.init();
    await expect(connector.sendMessage('111', 'x')).rejects.toMatchObject({
      name: 'outcome_unknown',
      message: expect.stringMatching(/answered 200.*likely posted/),
    });
  });
});

describe('ChatworkConnector sends with a person’s token (approvals.md, P1)', () => {
  beforeEach(() => {
    process.env[envName] = 'fixture-chatwork-token';
  });
  afterEach(() => {
    delete process.env[envName];
  });

  it('posts and names the account with the token it is given, not the install’s', async () => {
    const http = vi.fn(async (url: string) =>
      String(url).endsWith('/me')
        ? json(200, { account_id: 8, name: 'person-b' })
        : json(200, { message_id: '9002' })
    );
    const connector = new ChatworkConnector(config, { fetch: http as unknown as typeof fetch });
    await connector.init();
    await connector.account('person-token');
    await connector.sendMessage('111', 'hi', 'person-token');
    for (const [, request] of http.mock.calls)
      expect((request as RequestInit).headers).toMatchObject({ 'X-ChatWorkToken': 'person-token' });
  });
});
