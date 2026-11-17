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

  it('lists the rooms the source reads, with their names', async () => {
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
    await expect(connector.sendMessage('111', 'x')).rejects.toThrow(/may have been posted/);
    const late = vi.fn().mockResolvedValue(json(502, {}));
    const second = new ChatworkConnector(config, { fetch: late });
    await second.init();
    await expect(second.sendMessage('111', 'x')).rejects.toThrow(/may have been posted/);
  });
});
