import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { execGwsAsync } from '../../src/connectors/framework/gws-utils.js';

let bin: string;

function fakeGws(script: string): void {
  writeFileSync(join(bin, 'gws'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, 'gws'), 0o755);
}

describe('execGwsAsync', () => {
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'gws-bin-'));
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
  });

  it("reports the API's error that gws prints on stdout when it exits non-zero", async () => {
    fakeGws(
      'echo "Using keyring backend: keyring" >&2\necho \'{"error":{"code":404,"reason":"notFound"}}\'\nexit 1'
    );
    await expect(execGwsAsync(['drive', 'files', 'get'])).rejects.toThrow(
      'gws CLI returned an error: {"code":404,"reason":"notFound"}'
    );
  });

  it('keeps the exit error when stdout holds no error JSON', async () => {
    fakeGws('echo "boom" >&2\nexit 3');
    await expect(execGwsAsync(['drive', 'files', 'get'])).rejects.toThrow('Command failed');
  });

  it('parses the JSON a successful call prints', async () => {
    fakeGws('echo "Using keyring backend: keyring" >&2\necho \'{"files":[]}\'');
    await expect(execGwsAsync(['drive', 'files', 'list'])).resolves.toEqual({ files: [] });
  });
});
