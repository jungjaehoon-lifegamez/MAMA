/**
 * ClaudeCodeConnector — reads conversation history from Claude Code's JSONL files.
 * Polls ~/.claude/projects/<project-dir>/*.jsonl for user and assistant messages
 * newer than the given timestamp.
 *
 * Each JSONL file is one session. Messages have types: user, assistant, system, etc.
 * We extract user + assistant messages as conversation items.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

interface JsonlMessage {
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  sessionId?: string;
}

export class ClaudeCodeConnector implements IConnector {
  readonly name = 'claude-code';
  readonly type = 'local' as const;

  private basePath: string;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(
    private config: ConnectorConfig,
    basePath?: string
  ) {
    this.basePath = basePath ?? join(homedir(), '.claude', 'projects');
  }

  async init(): Promise<void> {
    try {
      readdirSync(this.basePath);
    } catch {
      throw new Error(`ClaudeCodeConnector: cannot read ${this.basePath}`);
    }
  }

  async dispose(): Promise<void> {
    // No resources to clean up
  }

  async healthCheck(): Promise<ConnectorHealth> {
    let healthy = false;
    try {
      readdirSync(this.basePath);
      healthy = true;
    } catch {
      // basePath not accessible
    }
    return {
      healthy: healthy && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'none',
        description: 'No authentication required. Reads local Claude Code conversation files.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    return true;
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    const items: NormalizedItem[] = [];
    const sinceMs = since.getTime();

    try {
      // Get configured channels (project directories) or scan all
      const channelKeys = Object.keys(this.config.channels || {});
      const projectDirs = channelKeys.length > 0 ? channelKeys : this.scanProjectDirs();

      for (const projectDir of projectDirs) {
        const fullPath = join(this.basePath, projectDir);
        let sessionFiles: string[];
        try {
          sessionFiles = readdirSync(fullPath).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }

        for (const file of sessionFiles) {
          const filePath = join(fullPath, file);
          try {
            const stat = statSync(filePath);
            // Skip files not modified since last poll
            if (stat.mtimeMs < sinceMs) continue;

            const sessionId = basename(file, '.jsonl');
            const messages = this.parseJsonl(filePath, sinceMs);

            for (const msg of messages) {
              items.push({
                source: 'claude-code',
                sourceId: `claude-code:${sessionId}:${msg.timestamp}`,
                channel: this.projectLabel(projectDir),
                author: msg.role === 'user' ? 'user' : 'claude',
                content: msg.content,
                timestamp: new Date(msg.timestamp),
                type: 'message',
                metadata: {
                  sessionId,
                  role: msg.role,
                  projectDir,
                },
              });
            }
          } catch {
            // Skip corrupt files
          }
        }
      }

      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastPollCount = 0;
    }

    return items;
  }

  private scanProjectDirs(): string[] {
    try {
      return readdirSync(this.basePath).filter((d) => {
        try {
          return statSync(join(this.basePath, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  private projectLabel(dirName: string): string {
    // Convert dir encoding: -Users-username-project-MyApp → MyApp
    const parts = dirName.split('-').filter(Boolean);
    return parts[parts.length - 1] || dirName;
  }

  private parseJsonl(
    filePath: string,
    sinceMs: number
  ): Array<{ role: string; content: string; timestamp: number }> {
    const results: Array<{ role: string; content: string; timestamp: number }> = [];
    const raw = readFileSync(filePath, 'utf-8');

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let msg: JsonlMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      // Only extract user and assistant messages
      if (msg.type !== 'user' && msg.type !== 'assistant') continue;

      const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
      if (ts <= sinceMs) continue;

      let content = '';
      const msgContent = msg.message?.content;
      if (typeof msgContent === 'string') {
        content = msgContent;
      } else if (Array.isArray(msgContent)) {
        content = msgContent
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('\n');
      }

      // Skip empty, very short, or command-only messages
      if (!content || content.length < 10) continue;
      // Skip hook/system messages
      if (content.startsWith('<command-message>') || content.startsWith('<system-reminder>'))
        continue;

      const role = msg.type === 'user' ? 'user' : 'assistant';
      results.push({ role, content: content.slice(0, 5000), timestamp: ts });
    }

    return results;
  }
}
