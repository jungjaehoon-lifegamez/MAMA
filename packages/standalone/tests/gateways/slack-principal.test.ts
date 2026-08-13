import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (payload: { event: unknown; ack: () => Promise<void> }) => Promise<void>
  >(),
  authTest: vi.fn(),
  socketStart: vi.fn().mockResolvedValue(undefined),
  socketDisconnect: vi.fn().mockResolvedValue(undefined),
  postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'response-ts' }),
  chatUpdate: vi.fn().mockResolvedValue({ ok: true }),
  chatDelete: vi.fn().mockResolvedValue({ ok: true }),
  downloadFile: vi.fn(),
  buildContentBlocks: vi.fn().mockResolvedValue([]),
}));

vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: vi.fn().mockImplementation(() => ({
    on: vi.fn(
      (
        event: string,
        handler: (payload: { event: unknown; ack: () => Promise<void> }) => Promise<void>
      ) => {
        seams.handlers.set(event, handler);
      }
    ),
    start: seams.socketStart,
    disconnect: seams.socketDisconnect,
  })),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    auth: { test: seams.authTest },
    chat: {
      postMessage: seams.postMessage,
      update: seams.chatUpdate,
      delete: seams.chatDelete,
    },
  })),
}));

vi.mock('../../src/gateways/attachment-utils.js', () => ({
  downloadFile: seams.downloadFile,
  buildContentBlocks: seams.buildContentBlocks,
}));

import { ChannelHistory, setChannelHistory } from '../../src/gateways/channel-history.js';
import { SlackGateway } from '../../src/gateways/slack.js';
import type { TurnProcessor } from '../../src/gateways/turn-contract.js';
import type { NormalizedMessage } from '../../src/gateways/types.js';

interface SyntheticSlackEvent {
  type: string;
  channel: string;
  channel_type: string;
  user: string;
  text: string;
  ts: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private_download: string;
    size: number;
  }>;
}

function completed(): ReturnType<TurnProcessor['processTurn']> {
  return Promise.resolve({
    outcome: 'completed',
    response: 'completed',
    sessionId: 'slack-principal-session',
    injectedDecisions: [],
    duration: 1,
    provenance: { status: 'available', modelRunId: 'slack-principal-run' },
    sourceTurnId: 'slack-principal-turn',
    sourceMessageRef: 'slack:synthetic:turn',
  });
}

function makeEvent(input: {
  user: string;
  ts: string;
  text?: string;
  files?: SyntheticSlackEvent['files'];
}): SyntheticSlackEvent {
  return {
    type: 'message',
    channel: 'channel-principal',
    channel_type: 'channel',
    user: input.user,
    text: input.text ?? 'synthetic request',
    ts: input.ts,
    files: input.files,
  };
}

async function deliver(
  route: 'message' | 'app_mention',
  event: SyntheticSlackEvent
): Promise<void> {
  const handler = seams.handlers.get(route);
  expect(handler).toBeTypeOf('function');
  await handler!({ event, ack: vi.fn().mockResolvedValue(undefined) });
}

function loggerDouble() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('Slack ingress principal admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seams.handlers.clear();
    seams.authTest.mockResolvedValue({ ok: true, team_id: 'team-principal' });
    seams.downloadFile.mockResolvedValue('/tmp/slack-principal-file');
    seams.buildContentBlocks.mockResolvedValue([]);
    setChannelHistory(new ChannelHistory());
  });

  it.each(['message', 'app_mention'] as const)(
    'diverts a non-owner on the %s route before history or attachment work',
    async (route) => {
      const turnProcessor: TurnProcessor = { processTurn: vi.fn(() => completed()) };
      const gateway = new SlackGateway({
        botToken: 'xoxb-synthetic',
        appToken: 'xapp-synthetic',
        ownerUserId: 'owner-user',
        turnProcessor,
        config: { channels: { 'channel-principal': { requireMention: false } } },
      });
      const history = new ChannelHistory();
      setChannelHistory(history);
      await gateway.start();

      await deliver(
        route,
        makeEvent({
          user: 'external-user',
          ts: route === 'message' ? '1000.0001' : '1000.0002',
          files: [
            {
              id: 'file-1',
              name: 'payload.txt',
              mimetype: 'text/plain',
              url_private_download: 'https://files.invalid/payload.txt',
              size: 12,
            },
          ],
        })
      );

      expect(turnProcessor.processTurn).not.toHaveBeenCalled();
      expect(seams.downloadFile).not.toHaveBeenCalled();
      expect(seams.buildContentBlocks).not.toHaveBeenCalled();
      expect(history.getHistory('channel-principal')).toEqual([]);
      expect(seams.postMessage).not.toHaveBeenCalled();
    }
  );

  it('admits an unmentioned owner in a requireMention:false channel with a frozen principal', async () => {
    const routed: NormalizedMessage[] = [];
    const turnProcessor: TurnProcessor = {
      processTurn: vi.fn((message) => {
        routed.push(message);
        return completed();
      }),
    };
    const gateway = new SlackGateway({
      botToken: 'xoxb-synthetic',
      appToken: 'xapp-synthetic',
      ownerUserId: 'owner-user',
      turnProcessor,
      config: { channels: { 'channel-principal': { requireMention: false } } },
    });
    await gateway.start();

    await deliver('message', makeEvent({ user: 'owner-user', ts: '1000.0003' }));

    expect(turnProcessor.processTurn).toHaveBeenCalledTimes(1);
    expect(routed[0]?.principal).toEqual({
      class: 'owner',
      lane: 'owner',
      canonicalId: 'slack:team-principal:owner-user',
      consoleEligible: false,
    });
    expect(Object.isFrozen(routed[0]?.principal)).toBe(true);
  });

  it('fails closed without an owner and emits the boot warning once', async () => {
    const turnProcessor: TurnProcessor = { processTurn: vi.fn(() => completed()) };
    const gateway = new SlackGateway({
      botToken: 'xoxb-synthetic',
      appToken: 'xapp-synthetic',
      turnProcessor,
      config: { channels: { 'channel-principal': { requireMention: false } } },
    });
    const logger = loggerDouble();
    Reflect.set(gateway, 'logger', logger);

    await gateway.start();
    await deliver('message', makeEvent({ user: 'owner-user', ts: '1000.0004' }));

    expect(turnProcessor.processTurn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the Slack team ID is unknown and logs that condition once', async () => {
    seams.authTest.mockResolvedValue({ ok: true });
    const turnProcessor: TurnProcessor = { processTurn: vi.fn(() => completed()) };
    const gateway = new SlackGateway({
      botToken: 'xoxb-synthetic',
      appToken: 'xapp-synthetic',
      ownerUserId: 'owner-user',
      turnProcessor,
      config: { channels: { 'channel-principal': { requireMention: false } } },
    });
    const logger = loggerDouble();
    Reflect.set(gateway, 'logger', logger);
    await gateway.start();

    await deliver('message', makeEvent({ user: 'owner-user', ts: '1000.0005' }));
    await deliver('message', makeEvent({ user: 'owner-user', ts: '1000.0006' }));

    expect(turnProcessor.processTurn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
