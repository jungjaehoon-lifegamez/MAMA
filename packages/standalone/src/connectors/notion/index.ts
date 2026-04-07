/**
 * NotionConnector — polls Notion pages via native fetch.
 * Uses POST /search to find recently edited pages, then fetches block children for content.
 */

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

interface NotionRichText {
  plain_text: string;
}

interface NotionTitleProperty {
  title: NotionRichText[];
}

interface NotionPage {
  id: string;
  last_edited_time: string;
  properties: Record<string, NotionTitleProperty | unknown>;
}

interface NotionSearchResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

interface NotionBlockChildrenResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

export class NotionConnector implements IConnector {
  readonly name = 'notion';
  readonly type = 'api' as const;

  private config: ConnectorConfig;
  private token: string | null = null;
  private readonly baseUrl = 'https://api.notion.com/v1';
  private readonly notionVersion = '2022-06-28';
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const token =
      this.config.auth.token ?? process.env[this.config.auth.tokenName ?? 'NOTION_TOKEN'];
    if (!token) {
      throw new Error('Notion token not found. Set NOTION_TOKEN environment variable.');
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
        tokenName: 'NOTION_TOKEN',
        description:
          'Notion Internal Integration Token. Create an integration at https://www.notion.so/my-integrations and share your pages with it.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.token) return false;
      const res = await fetch(`${this.baseUrl}/users/me`, {
        headers: this.authHeaders(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Notion-Version': this.notionVersion,
      'Content-Type': 'application/json',
    };
  }

  private extractTitle(page: NotionPage): string {
    for (const value of Object.values(page.properties)) {
      const prop = value as NotionTitleProperty;
      if (Array.isArray(prop.title)) {
        return prop.title.map((t) => t.plain_text).join('');
      }
    }
    return page.id;
  }

  private extractBlockText(block: NotionBlock): string {
    const blockContent = block[block.type] as Record<string, unknown> | undefined;
    if (!blockContent) return '';
    const richText = blockContent['rich_text'] as NotionRichText[] | undefined;
    if (!Array.isArray(richText)) return '';
    return richText.map((t) => t.plain_text).join('');
  }

  private async fetchBlockChildren(pageId: string): Promise<string> {
    const texts: string[] = [];
    let startCursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.baseUrl}/blocks/${pageId}/children?page_size=100${startCursor ? `&start_cursor=${startCursor}` : ''}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(url, {
          headers: this.authHeaders(),
          signal: controller.signal,
        });
        if (!res.ok) break;
        const data = (await res.json()) as NotionBlockChildrenResponse;

        for (const block of data.results ?? []) {
          const text = this.extractBlockText(block);
          if (text) texts.push(text);
        }

        hasMore = data.has_more ?? false;
        startCursor = data.next_cursor ?? undefined;
      } catch {
        break;
      } finally {
        clearTimeout(timeout);
      }
    }

    return texts.join('\n');
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.token) throw new Error('NotionConnector not initialized');

    const items: NormalizedItem[] = [];
    let hadError = false;

    try {
      let startCursor: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const searchBody: Record<string, unknown> = {
          filter: { property: 'object', value: 'page' },
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          page_size: 100,
        };
        if (startCursor) searchBody.start_cursor = startCursor;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let res: Response;
        try {
          res = await fetch(`${this.baseUrl}/search`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify(searchBody),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (!res.ok) {
          hadError = true;
          this.lastError = `Notion search HTTP ${res.status}`;
          this.lastPollTime = new Date();
          this.lastPollCount = 0;
          return items;
        }

        const data = (await res.json()) as NotionSearchResponse;

        for (const page of data.results) {
          const lastEdited = new Date(page.last_edited_time);
          if (lastEdited <= since) continue;

          const title = this.extractTitle(page);
          const blockText = await this.fetchBlockChildren(page.id);
          const content = blockText ? `${title}\n\n${blockText}` : title;

          items.push({
            source: 'notion',
            sourceId: page.id,
            channel: 'notion',
            author: '',
            content,
            timestamp: lastEdited,
            type: 'document',
            metadata: {
              pageId: page.id,
              title,
              lastEditedTime: page.last_edited_time,
            },
          });
        }

        hasMore = data.has_more ?? false;
        startCursor = data.next_cursor ?? undefined;
      }
    } catch (err) {
      hadError = true;
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}
