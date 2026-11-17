import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';

import { SlackConnector } from '../../src/connectors/slack/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const envName = 'MAMA_SLACK_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: {
    C1: { role: 'hub', name: 'channel-one' },
    C2: { role: 'ignore', name: 'muted' },
    C3: { role: 'hub' },
  },
  auth: { type: 'token', tokenName: envName },
};

function connectorWith(client: unknown) {
  return new SlackConnector(config, { client: client as WebClient });
}

describe('SlackConnector sends (approvals.md, S2)', () => {
  beforeEach(() => {
    process.env[envName] = 'fixture-slack-token';
  });
  afterEach(() => {
    delete process.env[envName];
  });

  it('lists the channels the source reads, not the ignored ones', () => {
    expect(connectorWith({}).channels()).toEqual([
      { id: 'C1', name: 'channel-one' },
      { id: 'C3', name: null },
    ]);
  });

  it('names the account the token posts as, bot or person', async () => {
    const test = vi
      .fn()
      .mockResolvedValue({ ok: true, user: 'mama-bot', user_id: 'U1', bot_id: 'B1' });
    const connector = connectorWith({ auth: { test } });
    await connector.init();
    await expect(connector.account()).resolves.toEqual({ id: 'U1', name: 'mama-bot', bot: true });
  });

  it('posts one message, in a thread when given, and returns its ts', async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, channel: 'C1', ts: '1700000000.000100' });
    const connector = connectorWith({ chat: { postMessage } });
    await connector.init();
    await expect(connector.postMessage('C1', 'hello', '1690000000.000200')).resolves.toEqual({
      channel: 'C1',
      ts: '1700000000.000100',
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'hello',
      thread_ts: '1690000000.000200',
    });
    await connector.postMessage('C1', 'top');
    expect(postMessage).toHaveBeenLastCalledWith({ channel: 'C1', text: 'top' });
  });

  it('says a refused post was not posted and a lost answer may have been', async () => {
    const refused = Object.assign(new Error('An API error occurred: missing_scope'), {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'missing_scope' },
    });
    const connector = connectorWith({ chat: { postMessage: vi.fn().mockRejectedValue(refused) } });
    await connector.init();
    await expect(connector.postMessage('C1', 'x')).rejects.toThrow(
      /Slack refused the message \(missing_scope\).*not posted/
    );
    const lost = connectorWith({
      chat: { postMessage: vi.fn().mockRejectedValue(new Error('socket hang up')) },
    });
    await lost.init();
    await expect(lost.postMessage('C1', 'x')).rejects.toMatchObject({
      name: 'outcome_unknown',
      message: expect.stringMatching(/may have been posted/),
    });
  });

  it('Slack server errors may have posted; a rate limit did not', async () => {
    for (const code of [
      'internal_error',
      'fatal_error',
      'service_unavailable',
      'request_timeout',
    ]) {
      const failed = Object.assign(new Error(`An API error occurred: ${code}`), {
        code: 'slack_webapi_platform_error',
        data: { ok: false, error: code },
      });
      const connector = connectorWith({ chat: { postMessage: vi.fn().mockRejectedValue(failed) } });
      await connector.init();
      await expect(connector.postMessage('C1', 'x')).rejects.toMatchObject({
        name: 'outcome_unknown',
      });
    }
    const limited = Object.assign(new Error('A rate limit was exceeded'), {
      code: 'slack_webapi_rate_limited_error',
      retryAfter: 30,
    });
    const connector = connectorWith({ chat: { postMessage: vi.fn().mockRejectedValue(limited) } });
    await connector.init();
    await expect(connector.postMessage('C1', 'x')).rejects.toThrow(
      /Slack refused the message \(rate limited, retry after 30 s\).*not posted/
    );
  });
});
