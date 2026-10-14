import { vi } from 'vitest';

// All member temp enumeration and writes stay in per-file roots, never the daemon's /tmp trees.
vi.mock('../../src/runtime/backend-security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/backend-security.js')>();
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { afterAll } = await import('vitest');
  // Short aliases preserve the Claude socket limit in driver tests.
  const dm = mkdtempSync('/tmp/d');
  const rooms = mkdtempSync('/tmp/r');
  afterAll(() => {
    rmSync(dm, { recursive: true, force: true });
    rmSync(rooms, { recursive: true, force: true });
  });
  const replaceRoots = (paths: string[]) =>
    paths.map((path) =>
      path === actual.MEMBER_CLAUDE_TMP_PARENT
        ? dm
        : path === actual.MEMBER_ROOM_TMP_PARENT
          ? rooms
          : path
    );
  return {
    ...actual,
    MEMBER_CLAUDE_TMP_PARENT: dm,
    MEMBER_ROOM_TMP_PARENT: rooms,
    ownerNativeDataReadPaths: (...args: Parameters<typeof actual.ownerNativeDataReadPaths>) =>
      replaceRoots(actual.ownerNativeDataReadPaths(...args)),
  };
});
