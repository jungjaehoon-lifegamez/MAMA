import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObsidianConnector } from '../../src/connectors/obsidian/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

let tempDir: string;

function makeConfig(vaultPath?: string, overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: vaultPath ? { vault: { role: 'hub', name: 'vault', vaultPath } } : {},
    auth: { type: 'none' },
    ...overrides,
  };
}

function createMdFile(filePath: string, content: string, mtime: Date): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  utimesSync(filePath, mtime, mtime);
}

describe('ObsidianConnector', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'obsidian-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('name and type', () => {
    it('has name "obsidian"', () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      expect(connector.name).toBe('obsidian');
    });

    it('has type "local"', () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      expect(connector.type).toBe('local');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns "none" auth requirement', () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('none');
    });
  });

  describe('init', () => {
    it('initializes successfully when vaultPath exists', async () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when vaultPath is not configured', async () => {
      const connector = new ObsidianConnector(makeConfig(undefined));
      await expect(connector.init()).rejects.toThrow(/vault path/i);
    });

    it('throws when vaultPath does not exist', async () => {
      const connector = new ObsidianConnector(makeConfig('/nonexistent/path/vault'));
      await expect(connector.init()).rejects.toThrow(/does not exist/i);
    });
  });

  describe('authenticate', () => {
    it('returns true when vaultPath exists', async () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when no vaultPath configured', async () => {
      const connector = new ObsidianConnector(makeConfig(undefined));
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns empty array when no md files exist', async () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('returns md files modified after since', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z');
      const oldFile = join(tempDir, 'old-note.md');
      const newFile = join(tempDir, 'new-note.md');

      createMdFile(oldFile, '# Old Note', new Date('2023-12-31T23:59:59.000Z'));
      createMdFile(newFile, '# New Note\n\nContent here', new Date('2024-01-01T00:00:01.000Z'));

      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(since);

      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('new-note.md');
    });

    it('sets sourceId to relative path from vault root', async () => {
      const notesDir = join(tempDir, 'notes');
      mkdirSync(notesDir);
      const filePath = join(notesDir, 'my-note.md');
      createMdFile(filePath, '# Note', new Date('2024-06-01T00:00:00.000Z'));

      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));

      const noteItem = items.find((i) => i.sourceId.includes('my-note.md'));
      expect(noteItem?.sourceId).toBe('notes/my-note.md');
    });

    it('sets source to "obsidian"', async () => {
      createMdFile(join(tempDir, 'test.md'), '# Test', new Date('2024-01-01T00:00:01.000Z'));
      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('obsidian');
    });

    it('sets type to "note"', async () => {
      createMdFile(join(tempDir, 'test.md'), '# Test', new Date('2024-01-01T00:00:01.000Z'));
      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.type).toBe('note');
    });

    it('sets content to full markdown content', async () => {
      const content = '# My Note\n\nThis is the body text.';
      createMdFile(join(tempDir, 'test.md'), content, new Date('2024-01-01T00:00:01.000Z'));
      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe(content);
    });

    it('sets channel to parent directory name for nested files', async () => {
      const subDir = join(tempDir, 'projects');
      mkdirSync(subDir);
      createMdFile(join(subDir, 'plan.md'), '# Plan', new Date('2024-06-01T00:00:00.000Z'));

      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));

      const item = items.find((i) => i.sourceId.includes('plan.md'));
      expect(item?.channel).toBe('projects');
    });

    it('sets channel to "vault" for root-level files', async () => {
      createMdFile(join(tempDir, 'root.md'), '# Root', new Date('2024-06-01T00:00:00.000Z'));

      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));

      const item = items.find((i) => i.sourceId === 'root.md');
      expect(item?.channel).toBe('vault');
    });

    it('skips hidden directories', async () => {
      const hiddenDir = join(tempDir, '.obsidian');
      mkdirSync(hiddenDir);
      createMdFile(
        join(hiddenDir, 'config.md'),
        'hidden content',
        new Date('2024-06-01T00:00:00.000Z')
      );

      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items.some((i) => i.sourceId.includes('.obsidian'))).toBe(false);
    });

    it('handles nested subdirectories recursively', async () => {
      const deepDir = join(tempDir, 'a', 'b', 'c');
      mkdirSync(deepDir, { recursive: true });
      createMdFile(join(deepDir, 'deep.md'), '# Deep', new Date('2024-06-01T00:00:00.000Z'));

      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items.some((i) => i.sourceId.includes('deep.md'))).toBe(true);
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('tracks lastPollTime after poll', async () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      const before = new Date();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('dispose', () => {
    it('disposes without error', async () => {
      const connector = new ObsidianConnector(makeConfig(tempDir));
      await connector.init();
      await expect(connector.dispose()).resolves.toBeUndefined();
    });
  });
});
