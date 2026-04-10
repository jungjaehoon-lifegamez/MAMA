import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCodeConnector } from '../../src/connectors/claude-code/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

let tempDir: string;
let projectsDir: string;

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {},
    auth: { type: 'none' },
    ...overrides,
  };
}

function makeConnector(configOverrides: Partial<ConnectorConfig> = {}): ClaudeCodeConnector {
  return new ClaudeCodeConnector(makeConfig(configOverrides), projectsDir);
}

function writeJsonl(filePath: string, messages: object[], mtime?: Date): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  const content = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  writeFileSync(filePath, content, 'utf8');
  if (mtime) utimesSync(filePath, mtime, mtime);
}

describe('ClaudeCodeConnector', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-code-test-'));
    projectsDir = join(tempDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('name and type', () => {
    it('has name "claude-code"', () => {
      expect(makeConnector().name).toBe('claude-code');
    });

    it('has type "local"', () => {
      expect(makeConnector().type).toBe('local');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns "none" auth requirement', () => {
      const reqs = makeConnector().getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('none');
    });
  });

  describe('init', () => {
    it('initializes when projects directory exists', async () => {
      await expect(makeConnector().init()).resolves.toBeUndefined();
    });

    it('throws when projects directory does not exist', async () => {
      const connector = new ClaudeCodeConnector(makeConfig(), '/nonexistent/path');
      await expect(connector.init()).rejects.toThrow(/cannot read/i);
    });
  });

  describe('authenticate', () => {
    it('always returns true', async () => {
      expect(await makeConnector().authenticate()).toBe(true);
    });
  });

  describe('poll', () => {
    it('returns empty array when no project directories exist', async () => {
      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('extracts user and assistant messages from JSONL', async () => {
      const projDir = join(projectsDir, '-Users-test-myproject');
      const ts = '2024-06-01T12:00:00.000Z';

      writeJsonl(
        join(projDir, 'session1.jsonl'),
        [
          { type: 'system', timestamp: ts, message: { content: 'system msg' } },
          {
            type: 'user',
            timestamp: ts,
            message: { role: 'user', content: 'What does this function do?' },
          },
          {
            type: 'assistant',
            timestamp: '2024-06-01T12:00:01.000Z',
            message: { role: 'assistant', content: 'This function handles authentication logic.' },
          },
        ],
        new Date('2024-06-01T12:00:01.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(2);
      expect(items[0]?.author).toBe('user');
      expect(items[0]?.content).toBe('What does this function do?');
      expect(items[1]?.author).toBe('claude');
      expect(items[1]?.content).toBe('This function handles authentication logic.');
    });

    it('handles array content format', async () => {
      const projDir = join(projectsDir, '-Users-test-project');

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: 'Hello, can you help me?' },
                { type: 'text', text: 'I need to refactor this.' },
              ],
            },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('Hello, can you help me?\nI need to refactor this.');
    });

    it('respects since parameter — skips old messages', async () => {
      const projDir = join(projectsDir, '-Users-test-proj');

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-01-01T00:00:00.000Z',
            message: { content: 'Old message that is long enough' },
          },
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'New message that is long enough' },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date('2024-03-01T00:00:00.000Z'));

      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('New message that is long enough');
    });

    it('skips files not modified since poll time', async () => {
      const projDir = join(projectsDir, '-Users-test-old');
      const oldDate = new Date('2023-01-01T00:00:00.000Z');

      writeJsonl(
        join(projDir, 'old-session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2023-01-01T00:00:00.000Z',
            message: { content: 'This is an old session message' },
          },
        ],
        oldDate
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));

      expect(items).toHaveLength(0);
    });

    it('skips short messages (< 10 chars)', async () => {
      const projDir = join(projectsDir, '-Users-test-short');

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'hi' },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(0);
    });

    it('skips system-reminder and command messages', async () => {
      const projDir = join(projectsDir, '-Users-test-system');

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: '<system-reminder>hook output here for testing</system-reminder>' },
          },
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:01.000Z',
            message: {
              content: '<command-message>some command here for testing</command-message>',
            },
          },
        ],
        new Date('2024-06-01T12:00:01.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(0);
    });

    it('sets source to "claude-code"', async () => {
      const projDir = join(projectsDir, '-Users-test-src');

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'A normal user message for testing' },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items[0]?.source).toBe('claude-code');
    });

    it('sets type to "message"', async () => {
      const projDir = join(projectsDir, '-Users-test-type');

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'Testing message type field value' },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items[0]?.type).toBe('message');
    });

    it('derives channel from project directory name', async () => {
      const projDir = join(projectsDir, '-Users-test-MAMA');

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'Testing channel name derivation' },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items[0]?.channel).toBe('MAMA');
    });

    it('truncates content to 5000 characters', async () => {
      const projDir = join(projectsDir, '-Users-test-long');
      const longContent = 'A'.repeat(10000);

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: longContent },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items[0]?.content.length).toBe(5000);
    });

    it('handles corrupt JSONL lines gracefully', async () => {
      const projDir = join(projectsDir, '-Users-test-corrupt');
      const filePath = join(projDir, 'session.jsonl');
      mkdirSync(projDir, { recursive: true });

      const content = [
        'not valid json',
        JSON.stringify({
          type: 'user',
          timestamp: '2024-06-01T12:00:00.000Z',
          message: { content: 'Valid message after corrupt line' },
        }),
      ].join('\n');
      writeFileSync(filePath, content + '\n', 'utf8');
      const mtime = new Date('2024-06-01T12:00:00.000Z');
      utimesSync(filePath, mtime, mtime);

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('Valid message after corrupt line');
    });

    it('scans only configured channels when specified', async () => {
      const proj1 = join(projectsDir, '-Users-test-projA');
      const proj2 = join(projectsDir, '-Users-test-projB');

      writeJsonl(
        join(proj1, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'Message from project A testing' },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      writeJsonl(
        join(proj2, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'Message from project B testing' },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = new ClaudeCodeConnector(
        makeConfig({
          channels: {
            '-Users-test-projA': { role: 'hub', name: 'projA' },
          },
        }),
        projectsDir
      );
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(1);
      expect(items[0]?.content).toContain('project A');
    });

    it('includes sessionId in metadata', async () => {
      const projDir = join(projectsDir, '-Users-test-meta');

      writeJsonl(
        join(projDir, 'abc123.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'Testing sessionId in metadata' },
          },
        ],
        new Date('2024-06-01T12:00:00.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items[0]?.metadata?.sessionId).toBe('abc123');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      const connector = makeConnector();
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('tracks lastPollTime', async () => {
      const connector = makeConnector();
      await connector.init();
      const before = new Date();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('tracks lastPollCount', async () => {
      const projDir = join(projectsDir, '-Users-test-count');

      writeJsonl(
        join(projDir, 'session.jsonl'),
        [
          {
            type: 'user',
            timestamp: '2024-06-01T12:00:00.000Z',
            message: { content: 'Message one for poll count test' },
          },
          {
            type: 'assistant',
            timestamp: '2024-06-01T12:00:01.000Z',
            message: { content: 'Response one for poll count test' },
          },
        ],
        new Date('2024-06-01T12:00:01.000Z')
      );

      const connector = makeConnector();
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollCount).toBe(2);
    });
  });

  describe('dispose', () => {
    it('disposes without error', async () => {
      const connector = makeConnector();
      await connector.init();
      await expect(connector.dispose()).resolves.toBeUndefined();
    });
  });
});
