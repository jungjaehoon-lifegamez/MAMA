import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserTool } from '../../src/tools/browser-tool.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('BrowserTool screenshot lifecycle', () => {
  it('removes a screenshot that finishes after the owning turn aborts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-browser-tool-'));
    roots.push(root);
    const tool = new BrowserTool({ screenshotDir: root });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runtime = tool as unknown as {
      browser: object;
      page: {
        screenshot(options: { path: string }): Promise<void>;
      };
    };
    runtime.browser = {};
    runtime.page = {
      screenshot: async ({ path }) => {
        markStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 75));
        writeFileSync(path, 'late screenshot');
      },
    };
    const controller = new AbortController();
    const outputPath = join(root, 'late.png');
    const screenshot = tool.screenshot('late.png', controller.signal);
    await started;
    controller.abort(new Error('owning turn stopped'));

    await expect(screenshot).rejects.toThrow('owning turn stopped');
    expect(existsSync(outputPath)).toBe(false);
  });

  it('does not overwrite or delete a pre-existing caller-selected file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-browser-tool-'));
    roots.push(root);
    const outputPath = join(root, 'existing.png');
    writeFileSync(outputPath, 'keep me');
    const tool = new BrowserTool({ screenshotDir: root });
    const runtime = tool as unknown as {
      browser: object;
      page: { screenshot(options: { path: string }): Promise<void> };
    };
    runtime.browser = {};
    runtime.page = {
      screenshot: async ({ path }) => writeFileSync(path, 'new screenshot'),
    };

    await expect(tool.screenshot('existing.png')).rejects.toThrow();
    expect(
      await import('node:fs/promises').then(({ readFile }) => readFile(outputPath, 'utf8'))
    ).toBe('keep me');
  });

  it('rejects screenshot paths outside the configured directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-browser-tool-'));
    roots.push(root);
    const tool = new BrowserTool({ screenshotDir: root });
    const runtime = tool as unknown as { browser: object; page: object };
    runtime.browser = {};
    runtime.page = {};

    await expect(tool.screenshot('../outside.png')).rejects.toThrow(
      'must not contain directory components'
    );
    await expect(tool.screenshotFullPage('/tmp/outside.png')).rejects.toThrow(
      'must not contain directory components'
    );
  });

  it('does not follow a nested symlink outside the screenshot directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-browser-tool-'));
    const outside = mkdtempSync(join(tmpdir(), 'mama-browser-outside-'));
    roots.push(root, outside);
    symlinkSync(outside, join(root, 'link'));
    const tool = new BrowserTool({ screenshotDir: root });
    const runtime = tool as unknown as { browser: object; page: object };
    runtime.browser = {};
    runtime.page = {};

    await expect(tool.screenshot('link/escape.png')).rejects.toThrow(
      'must not contain directory components'
    );
    expect(existsSync(join(outside, 'escape.png'))).toBe(false);
  });

  it('uses collision-free automatic names for concurrent screenshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-browser-tool-'));
    roots.push(root);
    vi.spyOn(Date, 'now').mockReturnValue(1_784_700_000_000);
    const tool = new BrowserTool({ screenshotDir: root });
    const runtime = tool as unknown as {
      browser: object;
      page: { screenshot(options: { path: string }): Promise<void> };
    };
    runtime.browser = {};
    runtime.page = {
      screenshot: async ({ path }) => writeFileSync(path, 'screenshot'),
    };

    const [first, second] = await Promise.all([tool.screenshot(), tool.screenshot()]);

    expect(first.path).not.toBe(second.path);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });
});
