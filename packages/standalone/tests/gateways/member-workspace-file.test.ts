import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMemberWorkspaceFile, readWorkspaceFile } from '../../src/api/file-delivery.js';

describe('member workspace file open', () => {
  let root: string;
  let file: string;
  let linkedFile: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'member-file-open-')));
    mkdirSync(join(root, 'actual'));
    file = join(root, 'actual', 'result.txt');
    writeFileSync(file, 'fixture bytes');
    symlinkSync(join(root, 'actual'), join(root, 'linked'));
    linkedFile = join(root, 'linked', 'result.txt');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a file through a symlinked parent', () => {
    expect(() => {
      const fd = openMemberWorkspaceFile(linkedFile);
      closeSync(fd);
    }).toThrow('path must not pass through a symlink');
  });

  it('opens the realpath and reads its bytes from the descriptor', async () => {
    const fd = openMemberWorkspaceFile(realpathSync(linkedFile));
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of readWorkspaceFile(fd)) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('fixture bytes');
    } finally {
      closeSync(fd);
    }
  });

  it('refuses a hard link', () => {
    const hardLink = join(root, 'hard-link.txt');
    linkSync(file, hardLink);
    expect(() => {
      const fd = openMemberWorkspaceFile(hardLink);
      closeSync(fd);
    }).toThrow('path must not be a hard link');
  });
});
