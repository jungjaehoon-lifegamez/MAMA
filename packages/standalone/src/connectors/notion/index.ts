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
  id: string;
  has_children?: boolean;
  type: string;
  [key: string]: unknown;
}

interface NotionBlockChildrenResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

const MAX_SEARCH_PAGES = 100;
const MAX_BLOCK_PAGES = 100;
const MAX_BLOCK_DEPTH = 8;

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
    // A setting, checked when the source is built: `mama init --section connectors` and doctor
    // build each source before it runs (init needs the token).
    if (config.auth.tokenName !== 'MAMA_NOTION_TOKEN') {
      throw new Error('Notion auth.tokenName must be MAMA_NOTION_TOKEN');
    }
    this.config = config;
  }

  async init(): Promise<void> {
    const tokenName = this.config.auth.tokenName!;
    const token = process.env[tokenName];
    if (!token) {
      throw new Error('Notion token not found. Run mama secret set MAMA_NOTION_TOKEN.');
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
        tokenName: 'MAMA_NOTION_TOKEN',
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

  private async fetchBlockChildren(pageId: string, depth = 0): Promise<string> {
    if (depth > MAX_BLOCK_DEPTH)
      throw new Error(`block children depth cap (${MAX_BLOCK_DEPTH}) reached`);
    const texts: string[] = [];
    let startCursor: string | undefined;
    const visitedCursors = new Set<string>();
    for (let page = 0; page < MAX_BLOCK_PAGES; page += 1) {
      const url = new URL(`${this.baseUrl}/blocks/${pageId}/children`);
      url.searchParams.set('page_size', '100');
      if (startCursor) url.searchParams.set('start_cursor', startCursor);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(url.toString(), {
          headers: this.authHeaders(),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`block children HTTP ${res.status} for page ${page + 1}`);
        const data = (await res.json()) as NotionBlockChildrenResponse;

        for (const block of data.results ?? []) {
          const text = this.extractBlockText(block);
          if (text) texts.push(text);
          if (block.has_children) {
            if (depth === MAX_BLOCK_DEPTH)
              throw new Error(`block children depth cap (${MAX_BLOCK_DEPTH}) reached`);
            texts.push(await this.fetchBlockChildren(block.id, depth + 1));
          }
        }

        if (!data.has_more) return texts.join('\n');
        const nextCursor = data.next_cursor;
        if (!nextCursor) throw new Error(`block children page ${page + 1} omitted next_cursor`);
        if (visitedCursors.has(nextCursor)) {
          throw new Error(`block children pagination repeated a cursor at page ${page + 1}`);
        }
        visitedCursors.add(nextCursor);
        startCursor = nextCursor;
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`block children page cap (${MAX_BLOCK_PAGES}) reached`);
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.token) throw new Error('NotionConnector not initialized');
    const configuredChannels = Object.entries(this.config.channels).filter(
      ([, channel]) => channel.role !== 'ignore'
    );
    if (configuredChannels.length !== 1) {
      throw new Error('Notion requires exactly one configured workspace channel');
    }
    const [channel] = configuredChannels[0]!;
    const items: NormalizedItem[] = [];
    try {
      let startCursor: string | undefined;
      const visitedCursors = new Set<string>();
      let pagesRead = 0;
      for (let pageNumber = 0; pageNumber < MAX_SEARCH_PAGES; pageNumber += 1) {
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
          throw new Error(`search HTTP ${res.status} on page ${pageNumber + 1}`);
        }

        const data = (await res.json()) as NotionSearchResponse;
        pagesRead += 1;

        for (const page of data.results) {
          const lastEdited = new Date(page.last_edited_time);
          if (lastEdited.getTime() <= since.getTime() - 60_000) continue;

          const title = this.extractTitle(page);
          let blockText: string;
          try {
            blockText = await this.fetchBlockChildren(page.id);
          } catch (error) {
            throw new Error(
              `Notion page content fetch failed for 1 of ${pagesRead} search pages; last error: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          const content = blockText ? `${title}\n\n${blockText}` : title;

          items.push({
            source: 'notion',
            sourceId: page.id,
            channel,
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

        if (!data.has_more) {
          items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          this.lastError = undefined;
          this.lastPollTime = new Date();
          this.lastPollCount = items.length;
          return items;
        }
        const nextCursor = data.next_cursor;
        if (!nextCursor) throw new Error(`search page ${pageNumber + 1} omitted next_cursor`);
        if (visitedCursors.has(nextCursor)) {
          throw new Error(`search pagination repeated a cursor at page ${pageNumber + 1}`);
        }
        visitedCursors.add(nextCursor);
        startCursor = nextCursor;
      }
      throw new Error(`search page cap (${MAX_SEARCH_PAGES}) reached`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = `Notion poll failed for 1 page fetch; last error: ${message}`;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      throw new Error(this.lastError, { cause: err });
    }
  }
}
