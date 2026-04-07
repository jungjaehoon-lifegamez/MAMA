/**
 * ObsidianConnector — polls an Obsidian vault by scanning *.md files on the local filesystem.
 * Uses statSync for mtime checks and readFileSync for content.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

export class ObsidianConnector implements IConnector {
  readonly name = 'obsidian';
  readonly type = 'local' as const;

  private config: ConnectorConfig;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) {
      throw new Error('Obsidian vault path not configured. Set vaultPath in channel config.');
    }
    try {
      statSync(vaultPath);
    } catch {
      throw new Error(`Obsidian vault path does not exist: ${vaultPath}`);
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
        type: 'none',
        description: 'No authentication required. Configure vaultPath in channel settings.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) return false;
    try {
      statSync(vaultPath);
      return true;
    } catch {
      return false;
    }
  }

  private getVaultPath(): string | undefined {
    for (const channelCfg of Object.values(this.config.channels)) {
      if (channelCfg.vaultPath) {
        return channelCfg.vaultPath;
      }
    }
    return undefined;
  }

  private collectMdFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip hidden directories (e.g., .obsidian, .git)
        if (entry.name.startsWith('.')) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.collectMdFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
    return results;
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) throw new Error('ObsidianConnector: vaultPath not configured');

    const items: NormalizedItem[] = [];
    let hadError = false;

    try {
      const mdFiles = this.collectMdFiles(vaultPath);

      for (const filePath of mdFiles) {
        try {
          const stat = statSync(filePath);
          if (stat.mtime <= since) continue;

          const relPath = relative(vaultPath, filePath);
          const parts = relPath.split(/[/\\]/);
          const channelName = parts.length > 1 ? (parts[0] ?? 'vault') : 'vault';

          const content = readFileSync(filePath, 'utf8');

          items.push({
            source: 'obsidian',
            sourceId: relPath,
            channel: channelName,
            author: '',
            content,
            timestamp: stat.mtime,
            type: 'note',
            metadata: {
              filePath,
              relPath,
              mtime: stat.mtime.toISOString(),
            },
          });
        } catch (err) {
          // Skip individual file errors
          hadError = true;
          this.lastError = err instanceof Error ? err.message : String(err);
        }
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
