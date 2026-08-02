import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCodexAuxiliaryToolBridge } from '../../src/agent/codex-auxiliary-tools.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TG-03/TG-04/TG-06: Codex auxiliary tool boundary', () => {
  it('advertises only the exact policy and performs bounded file operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-codex-aux-'));
    roots.push(root);
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const bridge = createCodexAuxiliaryToolBridge({
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      roots: [root],
      executeCommand,
    });

    expect(bridge.tools.map((tool) => tool.name)).toEqual([
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
    ]);
    const path = join(root, 'notes', 'status.txt');
    await bridge.execute({ callId: '1', name: 'Write', input: { path, content: 'alpha' } });
    await bridge.execute({
      callId: '2',
      name: 'Edit',
      input: { path, old_string: 'alpha', new_string: 'beta' },
    });
    expect(readFileSync(path, 'utf8')).toBe('beta');
    await expect(
      bridge.execute({ callId: '3', name: 'Glob', input: { path: root, pattern: '**/*.txt' } })
    ).resolves.toMatchObject({ content: expect.stringContaining('status.txt'), isError: false });
    await expect(
      bridge.execute({ callId: '4', name: 'Grep', input: { path: root, pattern: 'beta' } })
    ).resolves.toMatchObject({ content: expect.stringContaining('beta'), isError: false });
    await bridge.execute({ callId: '5', name: 'Bash', input: { command: 'pwd', workdir: root } });
    const canonicalRoot = realpathSync(root);
    expect(executeCommand).toHaveBeenCalledWith('pwd', canonicalRoot, [canonicalRoot], undefined);
  });

  it('rejects outside paths and symlink escapes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-codex-aux-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'mama-codex-aux-outside-'));
    roots.push(root, outside);
    writeFileSync(join(outside, 'secret'), 'nope');
    mkdirSync(join(root, 'links'));
    symlinkSync(outside, join(root, 'links', 'outside'));
    const bridge = createCodexAuxiliaryToolBridge({
      allowedTools: ['Read'],
      roots: [root],
      executeCommand: vi.fn(),
    });

    await expect(
      bridge.execute({ callId: '1', name: 'Read', input: { path: join(outside, 'secret') } })
    ).resolves.toMatchObject({ isError: true, content: expect.stringContaining('outside') });
    await expect(
      bridge.execute({
        callId: '2',
        name: 'Read',
        input: { path: join(root, 'links', 'outside', 'secret') },
      })
    ).resolves.toMatchObject({ isError: true, content: expect.stringContaining('outside') });
  });

  it('TG-03/TG-06 rejects oversized reads before loading them and bounds command streams', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-codex-aux-bounds-'));
    roots.push(root);
    const oversizedPath = join(root, 'oversized.txt');
    writeFileSync(oversizedPath, 'x'.repeat(200_001));
    const executeCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'o'.repeat(80_000),
      stderr: 'e'.repeat(70_000),
    }));
    const bridge = createCodexAuxiliaryToolBridge({
      allowedTools: ['Read', 'Bash'],
      roots: [root],
      executeCommand,
    });

    await expect(
      bridge.execute({ callId: 'read', name: 'Read', input: { path: oversizedPath } })
    ).resolves.toMatchObject({ isError: true, content: 'File exceeds read limit' });

    const commandResult = await bridge.execute({
      callId: 'bash',
      name: 'Bash',
      input: { command: 'verbose-command' },
    });
    const parsed = JSON.parse(commandResult.content) as Record<string, unknown>;
    expect((parsed.stdout as string).length).toBe(50_000);
    expect((parsed.stderr as string).length).toBe(50_000);
    expect(parsed).toMatchObject({
      stdoutBytes: 80_000,
      stderrBytes: 70_000,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
  });
});
