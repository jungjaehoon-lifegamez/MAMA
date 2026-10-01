/**
 * ChatworkConnector — polls Chatwork rooms via native fetch.
 * No SDK dependency; uses X-ChatWorkToken header for auth.
 */

import type {
  AuthRequirement,
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

interface ChatworkMessage {
  message_id: string;
  account: {
    account_id: number;
    name: string;
    avatar_image_url: string;
  };
  body: string;
  send_time: number;
  update_time: number;
}

interface ChatworkFile {
  file_id: number | string;
  message_id?: number | string;
  filename: string;
  filesize?: number;
  size?: number;
  upload_time: number;
  download_url?: string;
}

interface ChatworkMember {
  account_id: number;
  name: string;
}

export interface ChatworkConnectorOptions {
  fetch?: typeof fetch;
}

const CHATWORK_FILE_TIME_WINDOW_MS = 5 * 60_000;

export function extractChatworkFileIds(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(/\[download:(\d+)\]/g)) ids.add(match[1]!);
  for (const match of body.matchAll(/\[preview[^\]]*fileId=(\d+)[^\]]*\]/g)) {
    ids.add(match[1]!);
  }
  return [...ids];
}

export function extractChatworkFiles(body: string): Array<{ fileId: string; name?: string }> {
  return extractChatworkFileIds(body).map((fileId) => {
    const match = body.match(new RegExp(`\\[download:${fileId}\\]\\s*([^\\n\\[]+)`));
    const name = match?.[1]?.trim();
    return { fileId, ...(name === undefined || name === '' ? {} : { name }) };
  });
}

export class ChatworkConnector implements IConnector {
  readonly name = 'chatwork';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private token: string | null = null;
  private readonly baseUrl = 'https://api.chatwork.com/v2';
  private readonly http: typeof fetch;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  /**
   * Per-room last seen message ID for incremental polling.
   * NOTE: The Chatwork API has no cursor-based pagination. `force=0` returns only
   * messages the SERVER has not yet handed to this token — a read cursor shared by
   * every reader of the token. Measured live 2026-09-10: a second poller on the same
   * token (30 s cadence vs our 5 min) consumed the cursor first and this connector
   * saw ~1 message/day while the rooms carried ~30/day. So we ask for `force=1`
   * (the latest 100 regardless of read state) and dedupe client-side with the
   * `since` timestamp plus this per-room last seen message_id.
   * Limitation: if a room receives >100 messages between polls, the oldest
   * messages in that batch will be missed — this is a Chatwork API constraint.
   */
  private lastMessageIds: Map<string, string> = new Map();
  private pendingMessageIds: Map<string, string> | null = null;
  private pollCommitDeferred = false;

  constructor(config: ConnectorConfig, options: ChatworkConnectorOptions = {}) {
    this.config = config;
    this.http = options.fetch ?? fetch;
  }

  async init(): Promise<void> {
    const token = process.env[this.config.auth.tokenName ?? 'CHATWORK_API_TOKEN'];
    if (!token) {
      throw new Error('Chatwork API token not found. Set CHATWORK_API_TOKEN environment variable.');
    }
    this.token = token;
  }

  async dispose(): Promise<void> {
    this.token = null;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.token !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'token',
        tokenName: 'CHATWORK_API_TOKEN',
        description:
          'Chatwork API token from https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.token) return false;
      const res = await this.http(`${this.baseUrl}/me`, {
        headers: { 'X-ChatWorkToken': this.token },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.token) throw new Error('ChatworkConnector not initialized');

    const items: NormalizedItem[] = [];
    const pendingMessageIds = new Map(this.lastMessageIds);
    const failedRooms = new Set<string>();
    let polledRooms = 0;
    const sinceEpoch = Math.floor(since.getTime() / 1000);

    for (const [roomId, channelCfg] of Object.entries(this.config.channels)) {
      if (channelCfg.role === 'ignore') continue;
      polledRooms += 1;

      try {
        // force=1: the latest 100 messages independent of the server-side read cursor,
        // which any other reader of this token would otherwise consume first. New-ness
        // is decided below by `since` and the per-room last seen message_id.
        const lastMsgId = this.lastMessageIds.get(roomId);
        const res = await this.http(`${this.baseUrl}/rooms/${roomId}/messages?force=1`, {
          headers: { 'X-ChatWorkToken': this.token },
        });

        if (!res.ok) {
          failedRooms.add(roomId);
          this.lastError = `Room ${roomId}: HTTP ${res.status}`;
          continue;
        }

        const messages = (await res.json()) as ChatworkMessage[];

        let maxMsgId = lastMsgId ?? '';
        for (const msg of messages) {
          if (msg.send_time <= sinceEpoch) continue;
          // Skip messages we've already processed (client-side guard)
          if (lastMsgId && msg.message_id <= lastMsgId) continue;

          if (msg.message_id > maxMsgId) maxMsgId = msg.message_id;

          const chatworkFileIds = extractChatworkFileIds(msg.body);
          const chatworkFiles = extractChatworkFiles(msg.body);
          items.push({
            source: 'chatwork',
            sourceId: `${roomId}:${msg.message_id}`,
            channel: channelCfg.name ?? roomId,
            author: msg.account.name,
            content: msg.body,
            timestamp: new Date(msg.send_time * 1000),
            type: 'message',
            metadata: {
              roomId,
              messageId: msg.message_id,
              accountId: msg.account.account_id,
              ...(chatworkFileIds.length === 0 ? {} : { chatworkFileIds }),
              ...(chatworkFiles.length === 0 ? {} : { chatworkFiles }),
            },
          });
        }

        if (maxMsgId) pendingMessageIds.set(roomId, maxMsgId);
      } catch (err) {
        failedRooms.add(roomId);
        this.lastError = `Room ${roomId}: ${messageWithCauses(err)}`;
      }
    }

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (failedRooms.size > 0) {
      this.abortPollHandoff();
      throw new Error(
        `Chatwork poll failed for ${failedRooms.size} of ${polledRooms} configured rooms; last error: ${this.lastError}`
      );
    }
    this.pendingMessageIds = pendingMessageIds;
    if (!this.pollCommitDeferred) this.commitPoll();
    this.lastError = undefined;

    return items;
  }

  beginPollHandoff(): void {
    if (this.pollCommitDeferred || this.pendingMessageIds !== null) {
      throw new Error('Chatwork poll handoff is already active');
    }
    this.pollCommitDeferred = true;
  }

  commitPoll(): void {
    if (this.pendingMessageIds === null) {
      throw new Error('Chatwork poll state is unavailable to commit');
    }
    this.lastMessageIds = this.pendingMessageIds;
    this.pendingMessageIds = null;
    this.pollCommitDeferred = false;
  }

  abortPollHandoff(): void {
    this.pendingMessageIds = null;
    this.pollCommitDeferred = false;
  }

  async listAttachments(request: AttachmentListRequest): Promise<AttachmentDescriptor[]> {
    if (!this.token) throw new Error('ChatworkConnector not initialized');
    if (request.roomId.trim() === '') throw new Error('Chatwork attachment roomId is required');

    const requestedIds = new Set(
      (request.fileIds ?? []).map((fileId) => String(fileId).trim()).filter(Boolean)
    );
    if (requestedIds.size > 0) {
      const files: AttachmentDescriptor[] = [];
      for (const fileId of requestedIds) {
        const { descriptor } = await this.readFile(request.roomId, fileId);
        files.push({ ...descriptor, matchedBy: request.fileIdRule ?? 'metadata_file_id' });
      }
      return files;
    }

    // The unfiltered endpoint returns the room's 100 oldest files (measured 2026-09-26).
    // Resolve the uploader before listing so recent attachments can be found.
    const accountId = await this.uploaderAccountId(request);
    if (request.messageId === undefined && !Number.isFinite(request.sourceAtMs)) {
      throw new Error('Chatwork attachment upload-time matching requires sourceAtMs');
    }
    const response = await this.http(
      `${this.baseUrl}/rooms/${encodeURIComponent(request.roomId)}/files?account_id=${encodeURIComponent(accountId)}`,
      { headers: { 'X-ChatWorkToken': this.token } }
    );
    if (!response.ok) {
      throw new Error(
        `Chatwork file list failed for room ${request.roomId}: HTTP ${response.status}`
      );
    }
    const files = (await response.json()) as unknown;
    if (!Array.isArray(files)) throw new Error('Chatwork file list response must be an array');

    return files.flatMap((value: unknown) => {
      const file = this.chatworkFileDescriptor(value, 'upload_time');
      const raw = value as ChatworkFile;
      if (
        request.messageId !== undefined &&
        raw.message_id !== undefined &&
        raw.message_id !== null
      ) {
        return String(raw.message_id) === request.messageId
          ? [{ ...file, matchedBy: 'message_id' as const }]
          : [];
      }
      if (!Number.isFinite(request.sourceAtMs)) {
        throw new Error('Chatwork attachment upload-time matching requires sourceAtMs');
      }
      return Math.abs(file.uploadTime - Number(request.sourceAtMs)) <= CHATWORK_FILE_TIME_WINDOW_MS
        ? [file]
        : [];
    });
  }

  private async uploaderAccountId(request: AttachmentListRequest): Promise<string> {
    if (request.accountId?.trim()) return request.accountId.trim();
    if (!request.author?.trim()) {
      throw new Error('Chatwork attachment lookup requires uploader accountId or author');
    }
    const response = await this.http(
      `${this.baseUrl}/rooms/${encodeURIComponent(request.roomId)}/members`,
      { headers: { 'X-ChatWorkToken': this.token! } }
    );
    if (!response.ok) {
      throw new Error(
        `Chatwork member list failed for room ${request.roomId}: HTTP ${response.status}`
      );
    }
    const members = (await response.json()) as unknown;
    if (!Array.isArray(members)) throw new Error('Chatwork member list response must be an array');
    const member = (members as ChatworkMember[]).find((entry) => entry.name === request.author);
    if (!member) {
      throw new Error(
        `No Chatwork room member matches author "${request.author}" in room ${request.roomId}`
      );
    }
    return String(member.account_id);
  }

  async downloadAttachment(
    request: AttachmentDownloadRequest
  ): Promise<{ descriptor: AttachmentDescriptor; size: number }> {
    if (!this.token) throw new Error('ChatworkConnector not initialized');
    if (request.roomId.trim() === '' || request.fileId.trim() === '') {
      throw new Error('Chatwork attachment roomId and fileId are required');
    }
    const { descriptor, downloadUrl } = await this.readFile(request.roomId, request.fileId, true);
    const download = await this.http(requireHttpsUrl(downloadUrl, 'Chatwork download_url'));
    if (!download.ok) {
      throw new Error(`Chatwork file ${request.fileId} download failed: HTTP ${download.status}`);
    }
    const size = await saveResponseBody(download, request.targetPath);
    return { descriptor, size };
  }

  private async readFile(
    roomId: string,
    fileId: string,
    createDownloadUrl = false
  ): Promise<{ descriptor: AttachmentDescriptor; downloadUrl?: string }> {
    const query = createDownloadUrl ? '?create_download_url=1' : '';
    const response = await this.http(
      `${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}${query}`,
      { headers: { 'X-ChatWorkToken': this.token! } }
    );
    if (!response.ok) {
      throw new Error(
        `Chatwork file ${fileId} is not available in room ${roomId}: HTTP ${response.status}`
      );
    }
    const value = (await response.json()) as unknown;
    const descriptor = this.chatworkFileDescriptor(value, 'metadata_file_id');
    if (descriptor.fileId !== fileId) {
      throw new Error(`Chatwork file response does not match requested file ${fileId}`);
    }
    return { descriptor, downloadUrl: (value as ChatworkFile).download_url };
  }

  private chatworkFileDescriptor(
    value: unknown,
    matchedBy: AttachmentDescriptor['matchedBy']
  ): AttachmentDescriptor {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Chatwork file response must contain an object');
    }
    const file = value as ChatworkFile;
    const fileId = String(file.file_id ?? '').trim();
    const name = typeof file.filename === 'string' ? file.filename : '';
    const size = Number(file.filesize ?? file.size);
    const uploadTime = Number(file.upload_time) * 1_000;
    if (!/^\d+$/.test(fileId) || name.trim() === '' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Chatwork file response omitted a valid id, filename, or size');
    }
    if (!Number.isSafeInteger(uploadTime) || uploadTime < 0) {
      throw new Error('Chatwork file response omitted a valid upload_time');
    }
    return { fileId, name, size, uploadTime, matchedBy };
  }
}
