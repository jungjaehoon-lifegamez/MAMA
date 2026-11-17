/**
 * SlackConnector — polls Slack channels through the Slack Web API client.
 * Auth token is read from the daemon environment.
 */

import type { WebClient } from '@slack/web-api';

import type {
  AuthRequirement,
  ChannelConfig,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import {
  type AttachmentDescriptor,
  type AttachmentListRequest,
  type AttachmentDownloadRequest,
} from '../framework/attachments.js';
import { requireHttpsUrl, saveResponseBody } from '../framework/attachment-io.js';
import { messageWithCauses } from '../../utils/error-message.js';
import { outcomeUnknown } from '../framework/outcome.js';

interface SlackMessageFile {
  id?: string;
  name?: string;
}

/** The message fields a poll reads, from conversations.history or conversations.replies. */
interface SlackMessage {
  ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  files?: unknown;
}

/**
 * How far back a poll looks for threads that received a new reply. A reply posted only in the
 * thread is not a channel message, so it is found through its parent. Measured on live channels:
 * the longest-running thread over 90 days stayed active for 24 days. A reply to an older thread is
 * not read.
 */
const THREAD_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

interface SlackFileInfo {
  id: string;
  name: string;
  size: number;
  created: number;
  url_private?: string;
  channels?: string[];
  groups?: string[];
}

export interface SlackConnectorOptions {
  client?: WebClient;
  clientFactory?: (token: string) => WebClient;
  fetch?: typeof fetch;
}

export function extractSlackFileIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\(slack_file:([A-Za-z0-9_-]+)\)/g)) ids.add(match[1]!);
  return [...ids];
}

function requireSlackFileUrl(value: unknown): string {
  const parsed = new URL(requireHttpsUrl(value, 'Slack file url_private'));
  if (
    parsed.hostname !== 'files.slack.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('Slack file url_private must use the trusted Slack file origin');
  }
  return parsed.href;
}

/** Slack Web API errors carry Slack's code in `data.error`. */
function slackErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === 'string' ? code : undefined;
}

/** Slack errors after which a post may still have been stored (Slack: the call may have partly run). */
const SLACK_MAY_HAVE_POSTED = new Set([
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
]);

/** Channel errors that no retry fixes until someone changes the bot or the channel. */
const UNRECOVERABLE = new Set(['not_in_channel', 'channel_not_found', 'is_archived']);
export class SlackConnector implements IConnector {
  readonly name = 'slack';
  readonly type = 'api' as const;

  private readonly config: ConnectorConfig;
  private readonly providedClient: WebClient | undefined;
  private readonly clientFactory: ((token: string) => WebClient) | undefined;
  private readonly http: typeof fetch;
  private client: WebClient | null = null;
  /**
   * The client that posts. The reading client retries a failed request for up to half an hour; a
   * post whose answer was lost would then be posted again, so this one never retries.
   */
  private sendClient: WebClient | null = null;
  private token: string | null = null;
  private readonly userCache = new Map<string, string>();
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined;
  /** This poll's failed channels and the since they must be read from again (v1 X1). */
  private partialProblem: { error: string; readFrom?: Date } | undefined;
  /**
   * Each channel's own since: the start of its last poll that answered. A channel that answers
   * reads from here, not from a cursor a failing channel holds back, so a long failure does not
   * widen the others' reads. Memory only: after a restart every channel reads from the held cursor
   * once. Committed with the poll (commitPoll), so an aborted handoff reads it again.
   */
  private channelSince = new Map<string, number>();
  private pendingChannelSince: Map<string, number> | null = null;

  constructor(config: ConnectorConfig, options: SlackConnectorOptions = {}) {
    // A setting, checked when the source is built, before it runs (see NotionConnector): the
    // setup page takes the token this block names, so it may name no other secret. A block
    // without a name reads this one.
    if ((config.auth.tokenName ?? 'MAMA_SLACK_TOKEN') !== 'MAMA_SLACK_TOKEN') {
      throw new Error('Slack auth.tokenName must be MAMA_SLACK_TOKEN');
    }
    this.config = config;
    this.providedClient = options.client;
    this.clientFactory = options.clientFactory;
    this.http = options.fetch ?? fetch;
  }

  async init(): Promise<void> {
    const token = process.env.MAMA_SLACK_TOKEN;
    if (!token) {
      throw new Error('Slack bot token not found in the daemon environment (MAMA_SLACK_TOKEN).');
    }
    this.token = token;
    if (this.providedClient !== undefined) {
      this.client = this.sendClient = this.providedClient;
      return;
    }
    if (this.clientFactory !== undefined) {
      this.client = this.sendClient = this.clientFactory(token);
      return;
    }
    const { WebClient } = await import('@slack/web-api');
    this.client = new WebClient(token);
    // A rate limit is answered as an error (nothing posted) instead of a wait; a post that hangs
    // would hold the Telegram press that approved it.
    this.sendClient = new WebClient(token, {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: 30_000,
    });
  }

  async dispose(): Promise<void> {
    this.client = null;
    this.sendClient = null;
    this.token = null;
    this.userCache.clear();
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.client !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'token',
        tokenName: 'MAMA_SLACK_TOKEN',
        description: 'Slack bot token with history and user lookup access.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.client) return false;
      await this.client.auth.test();
      return true;
    } catch {
      return false;
    }
  }

  /** The channels this source reads (not the ignored ones): the only channels a send may post to. */
  channels(): Array<{ id: string; name: string | null }> {
    return Object.entries(this.config.channels)
      .filter(([, channel]) => channel.role !== 'ignore')
      .map(([id, channel]) => ({ id, name: channel.name ?? null }));
  }

  /** The Slack account the token posts as, for an approval card (approvals.md, S2). */
  async account(token?: string): Promise<{ id: string; name: string; bot: boolean }> {
    if (!this.sendClient) throw new Error('SlackConnector not initialized');
    // Read just before a post (P1), so through the bounded client that posts: a stalled check
    // cannot hold the press. A person's own token is passed per call; the install's is the client's.
    const me = await (token === undefined
      ? this.sendClient.auth.test()
      : this.sendClient.auth.test({ token }));
    return {
      id: String(me.user_id ?? ''),
      name: String(me.user ?? me.user_id ?? ''),
      bot: me.bot_id !== undefined,
    };
  }

  /**
   * Posts one message as the token's account. Only an approved proposal calls this
   * (slack.message.send). Slack's own refusal is not posted; a lost answer may have been, and the
   * error says which so nobody posts it twice.
   */
  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    token?: string
  ): Promise<{ channel: string; ts: string }> {
    if (!this.sendClient) throw new Error('SlackConnector not initialized');
    let posted;
    try {
      posted = await this.sendClient.chat.postMessage({
        channel,
        text,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
        ...(token === undefined ? {} : { token }),
      });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code !== undefined && !SLACK_MAY_HAVE_POSTED.has(code))
        throw new Error(`Slack refused the message (${code}). It was not posted.`);
      const retryAfter = (error as { code?: unknown; retryAfter?: unknown }).retryAfter;
      if ((error as { code?: unknown }).code === 'slack_webapi_rate_limited_error')
        throw new Error(
          `Slack refused the message (rate limited, retry after ${String(retryAfter)} s). It was not posted.`
        );
      throw outcomeUnknown(
        `Slack did not answer (${messageWithCauses(error)}); the message may have been posted: read the channel before sending it again.`
      );
    }
    return { channel: String(posted.channel ?? channel), ts: String(posted.ts) };
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached !== undefined) return cached;
    if (!this.client) return userId;
    try {
      const result = await this.client.users.info({ user: userId });
      const name = result.user?.real_name ?? result.user?.name ?? userId;
      this.userCache.set(userId, name);
      return name;
    } catch (error) {
      // A user Slack no longer has keeps their id. Any other failure (a rate limit, the network)
      // fails the channel, to be read again: an id stored as the author would make the same
      // message a new revision once the name resolves.
      if (slackErrorCode(error) !== 'user_not_found') throw error;
      this.userCache.set(userId, userId);
      return userId;
    }
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.client) throw new Error('SlackConnector not initialized');

    const items: NormalizedItem[] = [];
    const failedChannels = new Map<string, string>();
    /** Failures retrying cannot fix: reported, but they hold no cursor. */
    const lostChannels = new Map<string, string>();
    const heldSince: number[] = [];
    const pending = new Map(this.channelSince);
    const pollStart = Date.now();
    let polledChannels = 0;

    for (const [channelId, channelConfig] of Object.entries(this.config.channels)) {
      if (channelConfig.role === 'ignore') continue;
      polledChannels += 1;
      const channelSince = new Date(
        Math.max(this.channelSince.get(channelId) ?? since.getTime(), since.getTime())
      );
      const oldest = (channelSince.getTime() / 1000).toFixed(6);
      // History is read back THREAD_LOOKBACK_MS so a thread started before `since` still shows its
      // newest reply time; only messages after `since` become items.
      const historyOldest = ((channelSince.getTime() - THREAD_LOOKBACK_MS) / 1000).toFixed(6);
      // A channel that fails part-way keeps none of its items: the next poll reads it from `since`.
      const channelItems: NormalizedItem[] = [];
      try {
        const activeThreads: string[] = [];
        let cursor: string | undefined;
        do {
          const result = await this.client.conversations.history({
            channel: channelId,
            oldest: historyOldest,
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const message of result.messages ?? []) {
            if (
              typeof message.ts === 'string' &&
              (message.reply_count ?? 0) > 0 &&
              Number(message.latest_reply) * 1000 > channelSince.getTime()
            ) {
              activeThreads.push(message.ts);
            }
            const item = await this.messageItem(channelId, channelConfig, message, channelSince);
            if (item) channelItems.push(item);
          }
          cursor = result.response_metadata?.next_cursor || undefined;
        } while (cursor !== undefined);

        for (const threadTs of activeThreads) {
          let replyCursor: string | undefined;
          do {
            const result = await this.client.conversations.replies({
              channel: channelId,
              ts: threadTs,
              oldest,
              limit: 200,
              ...(replyCursor === undefined ? {} : { cursor: replyCursor }),
            });
            // The SDK's reply type omits `subtype`, which the API sends (e.g. thread_broadcast).
            for (const reply of (result.messages ?? []) as SlackMessage[]) {
              // The thread's first message is the parent, read from history. A reply also sent to
              // the channel (thread_broadcast) is a channel message and comes from history too.
              if (reply.ts === threadTs || reply.subtype === 'thread_broadcast') continue;
              const item = await this.messageItem(channelId, channelConfig, reply, channelSince);
              if (item) channelItems.push(item);
            }
            replyCursor = result.response_metadata?.next_cursor || undefined;
          } while (replyCursor !== undefined);
        }
        items.push(...channelItems);
        pending.set(channelId, pollStart);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (UNRECOVERABLE.has(slackErrorCode(error) ?? '')) lostChannels.set(channelId, reason);
        else {
          failedChannels.set(channelId, reason);
          heldSince.push(channelSince.getTime());
        }
      }
    }

    const failures = [...failedChannels, ...lostChannels].map(
      ([channelId, reason]) => `Channel ${channelId}: ${reason}`
    );
    if (polledChannels > 0 && failedChannels.size + lostChannels.size === polledChannels) {
      // Nothing was read: the scheduler keeps its cursor and tries every channel again.
      this.lastError = failures.join('; ');
      this.partialProblem = undefined;
      this.pendingChannelSince = null;
      throw new Error(
        `Slack poll failed for ${failedChannels.size} of ${polledChannels} configured channels; ${this.lastError}`
      );
    }
    items.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // The channels that answered are recorded; the scheduler's cursor stays at this since until the
    // failed ones answer, and what they read twice is one version in the raw store.
    this.lastError = failures.length > 0 ? `skipped ${failures.join('; skipped ')}` : undefined;
    this.partialProblem =
      this.lastError === undefined
        ? undefined
        : heldSince.length > 0
          ? { error: this.lastError, readFrom: new Date(Math.min(...heldSince)) }
          : { error: this.lastError };
    if (this.lastError !== undefined) console.warn(`[slack] ${this.lastError}`);
    this.pendingChannelSince = pending;
    if (!this.pollCommitDeferred) this.commitPoll();
    return items;
  }

  private pollCommitDeferred = false;

  beginPollHandoff(): void {
    this.pollCommitDeferred = true;
  }

  commitPoll(): void {
    if (this.pendingChannelSince !== null) this.channelSince = this.pendingChannelSince;
    this.pendingChannelSince = null;
    this.pollCommitDeferred = false;
  }

  abortPollHandoff(): void {
    this.pendingChannelSince = null;
    this.pollCommitDeferred = false;
  }

  partialFailure(): { error: string; readFrom?: Date } | undefined {
    return this.partialProblem;
  }

  /** One person's message after `since`, from history or a thread; null for anything else. */
  private async messageItem(
    channelId: string,
    channelConfig: ChannelConfig,
    message: SlackMessage,
    since: Date
  ): Promise<NormalizedItem | null> {
    const messageFiles = Array.isArray(message.files) ? (message.files as SlackMessageFile[]) : [];
    if (
      message.bot_id ||
      message.subtype === 'bot_message' ||
      !message.user ||
      (!message.text && messageFiles.length === 0)
    ) {
      return null;
    }
    const timestamp = new Date(Number(message.ts) * 1000);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() <= since.getTime()) {
      return null;
    }
    return {
      source: 'slack',
      sourceId: `${channelId}:${message.ts}`,
      channel: channelConfig.name ?? channelId,
      author: await this.resolveUserName(message.user),
      content: message.text ?? '',
      timestamp,
      type: 'message',
      metadata: {
        channelId,
        ts: message.ts,
        ...(message.thread_ts === undefined ? {} : { threadTs: message.thread_ts }),
        ...(messageFiles.length === 0
          ? {}
          : {
              slackFileIds: messageFiles
                .map((file) => file.id)
                .filter((id): id is string => typeof id === 'string' && id.trim() !== ''),
              slackFiles: messageFiles
                .filter(
                  (file): file is SlackMessageFile & { id: string } =>
                    typeof file.id === 'string' && file.id.trim() !== ''
                )
                .map((file) => ({
                  fileId: file.id,
                  ...(file.name ? { name: file.name } : {}),
                })),
            }),
      },
    };
  }

  async listAttachments(request: AttachmentListRequest): Promise<AttachmentDescriptor[]> {
    const ids = [
      ...new Set((request.fileIds ?? []).map((fileId) => fileId.trim()).filter(Boolean)),
    ];
    if (ids.length === 0) return [];
    const matchedBy = request.fileIdRule ?? 'metadata_file_id';
    return Promise.all(
      ids.map(async (fileId) => this.readAttachment(request.roomId, fileId, matchedBy))
    );
  }

  async downloadAttachment(
    request: AttachmentDownloadRequest
  ): Promise<{ descriptor: AttachmentDescriptor; size: number }> {
    const descriptor = await this.readAttachment(
      request.roomId,
      request.fileId,
      'metadata_file_id'
    );
    const clientToken = this.token;
    if (!clientToken) throw new Error('SlackConnector not initialized');
    const fileInfo = await this.fetchFileInfo(request.fileId);
    const downloadUrl = requireSlackFileUrl(fileInfo.url_private);
    let response: Response;
    try {
      response = await this.http(downloadUrl, {
        headers: { Authorization: `Bearer ${clientToken}` },
        // Never let an authenticated request follow a server-supplied destination.
        redirect: 'manual',
      });
    } catch {
      throw new Error('Slack file download request failed');
    }
    if (!response.ok) {
      // Cleanup failures must not expose authenticated request details.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        response.status >= 300 && response.status < 400
          ? 'Slack file download redirects are not allowed'
          : `Slack file download failed: HTTP ${response.status}`
      );
    }
    const size = await saveResponseBody(response, request.targetPath);
    return { descriptor, size };
  }

  private async readAttachment(
    roomId: string,
    fileId: string,
    matchedBy: AttachmentDescriptor['matchedBy']
  ): Promise<AttachmentDescriptor> {
    if (!this.client) throw new Error('SlackConnector not initialized');
    if (roomId.trim() === '' || fileId.trim() === '') {
      throw new Error('Slack attachment roomId and fileId are required');
    }
    const file = await this.fetchFileInfo(fileId);
    const memberships = [...(file.channels ?? []), ...(file.groups ?? [])];
    if (memberships.length === 0 || !memberships.includes(roomId)) {
      throw new Error(`Slack file ${fileId} does not belong to observation room ${roomId}`);
    }
    return {
      fileId: file.id,
      name: file.name,
      size: file.size,
      uploadTime: file.created * 1_000,
      matchedBy,
    };
  }

  private async fetchFileInfo(fileId: string): Promise<SlackFileInfo> {
    if (!this.client) throw new Error('SlackConnector not initialized');
    const result = (await this.client.files.info({ file: fileId })) as unknown as {
      ok?: boolean;
      error?: string;
      file?: Partial<SlackFileInfo>;
    };
    if (!result.ok || !result.file) {
      throw new Error(
        `Slack files.info failed for ${fileId}: ${result.error ?? 'no file metadata'}`
      );
    }
    const file = result.file;
    const id = typeof file.id === 'string' ? file.id : '';
    const name = typeof file.name === 'string' ? file.name : '';
    const size = Number(file.size);
    const created = Number(file.created);
    if (
      id.trim() === '' ||
      name.trim() === '' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isSafeInteger(created) ||
      created < 0
    ) {
      throw new Error(`Slack files.info returned malformed metadata for ${fileId}`);
    }
    return {
      id,
      name,
      size,
      created,
      ...(typeof file.url_private === 'string' ? { url_private: file.url_private } : {}),
      ...(Array.isArray(file.channels)
        ? { channels: file.channels.filter((v): v is string => typeof v === 'string') }
        : {}),
      ...(Array.isArray(file.groups)
        ? { groups: file.groups.filter((v): v is string => typeof v === 'string') }
        : {}),
    };
  }
}
