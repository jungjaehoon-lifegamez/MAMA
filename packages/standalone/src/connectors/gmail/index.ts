/**
 * GmailConnector — polls Gmail via the gws CLI tool.
 * Uses child_process.execSync to call gws CLI commands.
 * Skips "Using keyring backend:" prefix lines before parsing JSON.
 */

import { execSync } from 'child_process';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { execGws } from '../framework/gws-utils.js';

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
}

export class GmailConnector implements IConnector {
  readonly name = 'gmail';
  readonly type = 'api' as const;

  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: ConnectorConfig) {
    // config reserved for future channel-scoped filtering
  }

  async init(): Promise<void> {
    // Verify gws CLI is available
    try {
      execSync('gws --version', { stdio: 'pipe' });
    } catch {
      throw new Error('gws CLI not found. Install it and run: gws auth login');
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
        type: 'cli',
        cli: 'gws',
        cliAuthCommand: 'gws auth login',
        description: 'Google Workspace CLI authentication. Run: gws auth login',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      execSync('gws auth status', { stdio: 'pipe' });
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
    let hadError = false;

    try {
      const afterEpoch = Math.floor(since.getTime() / 1000);
      const listParams = JSON.stringify({
        userId: 'me',
        q: `after:${afterEpoch}`,
        maxResults: 25,
      });
      const listResult = execGws(
        `gmail users messages list --params '${listParams}'`
      ) as GmailMessageList;

      const messageRefs = listResult.messages ?? [];

      for (const ref of messageRefs) {
        try {
          const getParams = JSON.stringify({
            userId: 'me',
            id: ref.id,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          });
          const msg = execGws(`gmail users messages get --params '${getParams}'`) as GmailMessage;

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
            channel: 'inbox',
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
          // Skip individual message fetch errors
          hadError = true;
          this.lastError = err instanceof Error ? err.message : String(err);
        }
      }
    } catch (err) {
      hadError = true;
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}
