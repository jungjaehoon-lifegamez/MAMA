import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { MEMBER_ROOM_TMP_PARENT } from '../../src/runtime/backend-security.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import {
  ensureMemberPaths,
  removeRetiredMemberTemp,
  memberClaudeTmpDir,
  memberRoomTmpRoot,
  memberRoomClaudeTmpDir,
  ensureMemberClaudeTmpDir,
  memberPaths,
  validateMemberRoot,
} from '../../src/runtime/member-paths.js';
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it('separates backend state and host runtime paths, creates private roots and a git boundary', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-owner-')));
  roots.push(home);
  vi.stubEnv('HOME', home);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-members-')));
  roots.push(root);
  validateMemberRoot(root, [home, join(home, '.mama')]);
  const first = ensureMemberPaths(root, 'fixture-one');
  const second = ensureMemberPaths(root, 'fixture-two');
  for (const key of Object.keys(first) as Array<keyof typeof first>) {
    expect(first[key]).not.toBe(second[key]);
    expect(first[key]).toContain('/fixture-one');
  }
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(first.workspaceDir, '.git', 'HEAD'), 'utf8')).toBe(
    'ref: refs/heads/main\n'
  );
  for (const id of ['../escape', 'a/b', '.', '', 'a:b'])
    expect(() => memberPaths(root, id)).toThrow(/safe path component/);
  symlinkSync(home, join(root, 'fixture-symlink'));
  expect(() => ensureMemberPaths(root, 'fixture-symlink')).toThrow(/symlink/);
});

const account = (uid: number) => createHash('sha256').update(String(uid)).digest('hex').slice(0, 3);

it('fits the room sandbox suffix for a ten-digit uid and separates people in the same room', () => {
  const parent = `/tmp/m${account(9999999999)}`;
  const path = memberRoomClaudeTmpDir('fixture-member', '-100', { parent, uid: 9999999999 });
  expect(Buffer.byteLength(join(path, 'claude-9999999999'))).toBeLessThanOrEqual(44);
  expect(path).not.toBe(
    memberRoomClaudeTmpDir('fixture-other', '-100', { parent, uid: 9999999999 })
  );
});

it("keeps each OS account's member temp parents apart, and a member's fits a ten-digit uid", async () => {
  // The test setup points these at per-file folders; the module's own values are the daemon's.
  const actual = await vi.importActual<typeof import('../../src/runtime/backend-security.js')>(
    '../../src/runtime/backend-security.js'
  );
  expect(actual.MEMBER_CLAUDE_TMP_PARENT).toBe(`/tmp/mm${account(userInfo().uid)}`);
  expect(actual.MEMBER_ROOM_TMP_PARENT).toBe(`/tmp/m${account(userInfo().uid)}`);
  expect(actual.RETIRED_MEMBER_TMP_PARENTS).toEqual(['/tmp/mama-m', '/tmp/m']);
  const dm = join(`/tmp/mm${account(9999999999)}`, basename(memberClaudeTmpDir('fixture-member')));
  expect(Buffer.byteLength(join(dm, 'claude-9999999999'))).toBeLessThanOrEqual(44);
});

it("removes this account's retired member temp parents, never a link or a missing one", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'retired-temp-')));
  roots.push(base);
  const own = join(base, 'own');
  fs.mkdirSync(join(own, 'member', 'claude-1'), { recursive: true });
  const target = join(base, 'target');
  fs.mkdirSync(target);
  const link = join(base, 'link');
  symlinkSync(target, link);
  removeRetiredMemberTemp([own, link, join(base, 'missing')]);
  expect(fs.existsSync(own)).toBe(false);
  expect(fs.existsSync(link)).toBe(true);
  expect(fs.existsSync(target)).toBe(true);
});

it('creates and repairs managed room temp directories as 0700', () => {
  const temp = memberRoomClaudeTmpDir('fixture-private', '-100');
  ensureMemberClaudeTmpDir(temp);
  const parent = memberRoomTmpRoot('fixture-private');
  const paths = [MEMBER_ROOM_TMP_PARENT, parent, temp, join(temp, `claude-${process.getuid!()}`)];
  for (const path of paths) expect(statSync(path).mode & 0o777).toBe(0o700);
  fs.chmodSync(parent, 0o755);
  fs.chmodSync(temp, 0o755);
  ensureMemberClaudeTmpDir(temp);
  for (const path of paths) expect(statSync(path).mode & 0o777).toBe(0o700);
});

it.each(['parent', 'principal', 'room'])(
  'refuses a foreign-owned %s temp directory before chmod',
  (level) => {
    const temp = memberRoomClaudeTmpDir('fixture-foreign', '-100');
    ensureMemberClaudeTmpDir(temp);
    const target =
      level === 'parent'
        ? MEMBER_ROOM_TMP_PARENT
        : level === 'principal'
          ? memberRoomTmpRoot('fixture-foreign')
          : temp;
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
      const value = original(path);
      return path === target ? Object.assign(value, { uid: process.getuid!() + 1 }) : value;
    }) as typeof fs.lstatSync);
    const chmod = vi.spyOn(fs, 'chmodSync');
    expect(() => ensureMemberClaudeTmpDir(temp)).toThrow(/not owned/);
    expect(chmod.mock.calls.some(([path]) => path === target)).toBe(false);
  }
);

it('refuses symlinked temp directories', () => {
  const parent = memberRoomTmpRoot('fixture-symlink-temp');
  fs.mkdirSync(parent, { mode: 0o700 });
  const path = memberRoomClaudeTmpDir('fixture-symlink-temp', '-100');
  symlinkSync(MEMBER_ROOM_TMP_PARENT, path);
  expect(() => ensureMemberClaudeTmpDir(path)).toThrow(/symlink/);
});

it('refuses a member root that is HOME written in another letter case', () => {
  const home = mkdtempSync(join(tmpdir(), 'mama-member-case-'));
  try {
    const upper = home.toUpperCase();
    // Only a case-insensitive disk (the macOS default) names the same folder this way.
    if (upper === home || !fs.existsSync(upper)) return;
    expect(() => validateMemberRoot(join(upper, 'members'), [home])).toThrow(
      'member_root must not overlap HOME'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
