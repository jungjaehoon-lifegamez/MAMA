/**
 * GmailConnector — polls Gmail via the gws CLI tool.
 * Uses argv-based asynchronous gws CLI calls.
 * Skips "Using keyring backend:" prefix lines before parsing JSON.
 */

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { cliAuth } from '../framework/types.js';
import { execGwsAsync, execGwsTextAsync, gwsMissing, gwsTool } from '../framework/gws-utils.js';

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
  internalDate?: string;
}

interface GmailMessageList {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

const MAX_MESSAGE_LIST_PAGES = 20;

export class GmailConnector implements IConnector {
  readonly name = 'gmail';
  readonly type = 'api' as const;

  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;
  private config: ConnectorConfig;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    // Verify gws CLI is available
    try {
      await execGwsTextAsync(['--version']);
    } catch {
      throw new Error(gwsMissing);
    }
  }

  async dispose(): Promise<void> {
    // No resources to clean up
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        ...cliAuth(gwsTool),
        description: 'Google Workspace CLI authentication. Run: gws auth login',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      await execGwsTextAsync(['auth', 'status']);
      return true;
    } catch {
      return false;
    }
  }

  private getHeader(msg: GmailMessage, name: string): string {
    const headers = msg.payload?.headers ?? [];
    return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    const items: NormalizedItem[] = [];
    const configuredChannels = Object.entries(this.config.channels).filter(
      ([, channel]) => channel.role !== 'ignore'
    );
    if (configuredChannels.length !== 1) {
      throw new Error('Gmail requires exactly one configured inbox channel');
    }
    const [channel] = configuredChannels[0]!;

    try {
      const afterEpoch = Math.floor(since.getTime() / 1000);
      const messageRefs: Array<{ id: string; threadId: string }> = [];
      const visitedPageTokens = new Set<string>();
      let pageToken: string | undefined;
      let reachedFinalPage = false;
      for (let page = 0; page < MAX_MESSAGE_LIST_PAGES; page += 1) {
        const params = {
          userId: 'me',
          q: `after:${afterEpoch}`,
          maxResults: 25,
          ...(pageToken === undefined ? {} : { pageToken }),
        };
        let listResult: GmailMessageList;
        try {
          listResult = (await execGwsAsync([
            'gmail',
            'users',
            'messages',
            'list',
            '--params',
            JSON.stringify(params),
          ])) as GmailMessageList;
        } catch (error) {
          throw new Error(
            `Gmail poll failed for 1 of ${page + 1} message-list pages; last error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        messageRefs.push(...(listResult.messages ?? []));
        if (!listResult.nextPageToken) {
          reachedFinalPage = true;
          break;
        }
        if (visitedPageTokens.has(listResult.nextPageToken)) {
          throw new Error(`Gmail poll failed for 1 page; last error: repeated page token`);
        }
        visitedPageTokens.add(listResult.nextPageToken);
        pageToken = listResult.nextPageToken;
      }
      if (!reachedFinalPage) {
        throw new Error(
          `Gmail poll failed for 1 page; last error: page cap (${MAX_MESSAGE_LIST_PAGES}) reached`
        );
      }

      let failedMessages = 0;
      let lastMessageError: string | undefined;
      for (const ref of messageRefs) {
        try {
          const getParams = JSON.stringify({
            userId: 'me',
            id: ref.id,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          });
          const msg = (await execGwsAsync([
            'gmail',
            'users',
            'messages',
            'get',
            '--params',
            getParams,
          ])) as GmailMessage;

          const subject = this.getHeader(msg, 'Subject');
          const from = this.getHeader(msg, 'From');
          const snippet = msg.snippet ?? '';

          const internalDateMs = msg.internalDate ? parseInt(msg.internalDate, 10) : Date.now();
          const timestamp = new Date(internalDateMs);

          // Only include messages after since
          if (timestamp <= since) continue;

          items.push({
            source: 'gmail',
            sourceId: msg.id,
            channel,
            author: from,
            content: `Subject: ${subject}\n\n${snippet}`,
            timestamp,
            type: 'email',
            metadata: {
              threadId: msg.threadId,
              subject,
              from,
            },
          });
        } catch (err) {
          failedMessages += 1;
          lastMessageError = err instanceof Error ? err.message : String(err);
        }
      }
      if (failedMessages > 0) {
        throw new Error(
          `Gmail poll failed for ${failedMessages} of ${messageRefs.length} message fetches; last error: ${lastMessageError}`
        );
      }
      this.lastError = undefined;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      return items;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
