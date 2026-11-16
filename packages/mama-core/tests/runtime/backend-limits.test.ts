import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeBackendLimits,
  codexBackendLimits,
  type BackendLimits,
} from '../../src/runtime/backend-limits.js';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';
import { CodexAppServerProcess } from '../../src/runtime/drivers/codex-app-server-process.js';

// Shapes measured on Claude Code's stream-json `rate_limit_event` and Codex CLI 0.160.1's
// `account/rateLimits/updated`, with fixture numbers.
const claudeInfo = {
  status: 'allowed',
  resetsAt: 1_800_000_000,
  rateLimitType: 'five_hour',
  unifiedWindows: {
    five_hour: { utilization: 0.21, resetsAt: 1_800_000_000, status: 'allowed' },
    seven_day: { utilization: 0.325, resetsAt: 1_800_500_000, status: 'allowed' },
  },
};
const codexParams = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
    secondary: null,
  },
};

describe('backend limits', () => {
  it('reads Claude windows as percent used with reset times', () => {
    expect(claudeBackendLimits(claudeInfo, 5)).toEqual({
      backend: 'claude',
      bucket: null,
      observedAt: 5,
      windows: [
        { window: '5h', usedPercent: 21, resetsAt: 1_800_000_000_000 },
        { window: '7d', usedPercent: 33, resetsAt: 1_800_500_000_000 },
      ],
    });
    expect(claudeBackendLimits({ status: 'allowed' }, 5)).toBeNull();
  });

  it('reads Codex windows by their length', () => {
    expect(codexBackendLimits(codexParams, 5)).toEqual({
      backend: 'codex',
      bucket: null,
      observedAt: 5,
      windows: [{ window: '7d', usedPercent: 13, resetsAt: 1_800_000_000_000 }],
    });
    expect(
      codexBackendLimits(
        {
          rateLimits: {
            primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
            secondary: { usedPercent: 2, windowDurationMins: 45 },
            limitId: 'codex_other',
          },
        },
        5
      )?.windows
    ).toEqual([
      { window: '5h', usedPercent: 40, resetsAt: null },
      { window: '45m', usedPercent: 2, resetsAt: null },
    ]);
    expect(
      codexBackendLimits(
        {
          rateLimits: {
            limitId: 'codex_other',
            primary: { usedPercent: 1, windowDurationMins: 60 },
          },
        },
        5
      )?.bucket
    ).toBe('codex_other');
    // A window without its length keeps its measurement.
    expect(
      codexBackendLimits(
        { rateLimits: { primary: { usedPercent: 40, windowDurationMins: null } } },
        5
      )?.windows
    ).toEqual([{ window: 'window', usedPercent: 40, resetsAt: null }]);
    expect(codexBackendLimits({ rateLimits: { primary: null } }, 5)).toBeNull();
  });
});

describe('drivers report the limit', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('the Claude process hands a rate_limit_event to its listener', () => {
    const seen: BackendLimits[] = [];
    const proc = new PersistentClaudeProcess({
      sessionId: 'fixture-session',
      workspaceDir: '/tmp/fixture-workspace',
      onBackendLimits: (limits) => seen.push(limits),
    });
    const internal = proc as unknown as {
      process: EventEmitter;
      state: string;
      handleStdout(chunk: Buffer): void;
    };
    internal.process = new EventEmitter();
    internal.state = 'idle';
    internal.handleStdout(
      Buffer.from(`${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: claudeInfo })}\n`)
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.windows.map((window) => window.window)).toEqual(['5h', '7d']);
  });

  it('the Codex app-server hands account/rateLimits/updated to its listener', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-limits-'));
    roots.push(root);
    const seen: BackendLimits[] = [];
    const proc = new CodexAppServerProcess({
      hostRootDir: root,
      sessionKey: 'fixture',
      model: 'fixture-model',
      systemPrompt: '',
      cwd: root,
      sandbox: 'read-only',
      onBackendLimits: (limits) => seen.push(limits),
    });
    (
      proc as unknown as { handleNotification(method: string, params: unknown): void }
    ).handleNotification('account/rateLimits/updated', codexParams);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.windows).toEqual([
      { window: '7d', usedPercent: 13, resetsAt: 1_800_000_000_000 },
    ]);
  });
});
