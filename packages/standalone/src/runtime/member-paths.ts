import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { sessionCredentialPath } from './session-credential.js';
import {
  MEMBER_CLAUDE_TMP_PARENT,
  MEMBER_ROOM_TMP_PARENT,
  RETIRED_MEMBER_TMP_PARENTS,
  HOST_DOCUMENT_RENDER_ROOT,
  normalizeReadPaths,
  physicalReadPath,
} from './backend-security.js';

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Resolve existing ancestors too: a symlink must not move a member root into HOME. */
const physical = physicalReadPath;

/**
 * Claude's sandbox shell uses CLAUDE_CODE_TMPDIR/claude-<uid> only when that path fits 44 bytes
 * (AF_UNIX socket paths); a longer one falls back to the /tmp/claude-<uid> every Claude session of
 * this OS user shares. A member workspace path is far longer, so each member gets a short one.
 */
const SANDBOX_PATH_LIMIT = 44;

/** Bytes left under a parent for the hashed components once `/claude-<uid>` is counted. */
function hashBudget(parent: string, uid: number, separators: number): number {
  return SANDBOX_PATH_LIMIT - Buffer.byteLength(`${parent}/claude-${uid}`) - separators;
}

function hashed(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * The hash lengths a room path gets: the full 8 and 10 hex where the budget allows, which is every
 * account up to seven-digit uids; a ten-digit directory uid leaves 5 and 6.
 */
function roomHashLengths(parent: string, uid: number): { principal: number; room: number } {
  const budget = hashBudget(parent, uid, 2);
  const principal = Math.min(8, Math.floor(budget / 2));
  return { principal, room: Math.min(10, budget - principal) };
}

export function memberClaudeTmpDir(
  principalId: string,
  options: { parent?: string; uid?: number } = {}
): string {
  const parent = options.parent ?? MEMBER_CLAUDE_TMP_PARENT;
  const length = Math.min(12, hashBudget(parent, options.uid ?? userInfo().uid, 1));
  return join(parent, hashed(principalId, length));
}

/** Known before any room starts, so other principals deny this whole subtree. */
export function memberRoomTmpRoot(
  principalId: string,
  options: { parent?: string; uid?: number } = {}
): string {
  const parent = options.parent ?? MEMBER_ROOM_TMP_PARENT;
  const lengths = roomHashLengths(parent, options.uid ?? userInfo().uid);
  return join(parent, hashed(principalId, lengths.principal));
}

export function memberRoomClaudeTmpDir(
  principalId: string,
  channel: string,
  options: { parent?: string; uid?: number } = {}
): string {
  const parent = options.parent ?? MEMBER_ROOM_TMP_PARENT;
  const uid = options.uid ?? userInfo().uid;
  const lengths = roomHashLengths(parent, uid);
  const path = join(
    memberRoomTmpRoot(principalId, { parent, uid }),
    hashed(JSON.stringify([principalId, channel]), lengths.room)
  );
  if (Buffer.byteLength(join(path, `claude-${uid}`)) > SANDBOX_PATH_LIMIT)
    throw new Error('Room Claude temp path exceeds the 44-byte sandbox limit');
  return path;
}

/**
 * Remove the member temp folders this account's MAMA made under the parents it used before they
 * were per account: entries named as MAMA named them (8 hex for a room root, 12 for a member) and
 * owned by this uid. Anything else in those generic /tmp names belongs to someone else and stays;
 * the parent goes only once empty. Called at daemon boot, before any member session runs.
 */
export function removeRetiredMemberTemp(
  parents: readonly string[] = RETIRED_MEMBER_TMP_PARENTS
): void {
  const uid = userInfo().uid;
  const own = (path: string) => {
    const entry = lstatSync(path);
    return !entry.isSymbolicLink() && entry.isDirectory() && entry.uid === uid;
  };
  for (const parent of parents) {
    try {
      if (!own(parent)) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of readdirSync(parent)) {
      const path = join(parent, name);
      if (/^(?:[0-9a-f]{8}|[0-9a-f]{12})$/.test(name) && own(path))
        rmSync(path, { recursive: true, force: true });
    }
    if (readdirSync(parent).length === 0) rmdirSync(parent);
  }
}

/** A shared /tmp name must never adopt another user's directory or a symlink. */
export function ensureMemberClaudeTmpDir(path: string): void {
  const parent = inside(MEMBER_ROOM_TMP_PARENT, path)
    ? MEMBER_ROOM_TMP_PARENT
    : MEMBER_CLAUDE_TMP_PARENT;
  if (!inside(parent, path)) throw new Error('Member temp path must be under its managed parent');
  const ensure = (directory: string) => {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Member temp path must be a directory, not a symlink');
    if (entry.uid !== userInfo().uid)
      throw new Error('Member temp path is not owned by the current uid');
    chmodSync(directory, 0o700);
  };
  ensure(parent);
  let current = parent;
  for (const component of relative(parent, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    ensure(current);
  }
  ensure(join(path, `claude-${userInfo().uid}`));
}

/** Include inactive registrations and unregistered debris; enumerate again before each turn. */
export function otherMemberReadPaths(
  root: string,
  principalId: string,
  registered: readonly string[],
  room = false
): string[] {
  const own = [
    memberPaths(root, principalId).runtimeRoot,
    memberClaudeTmpDir(principalId),
    memberRoomTmpRoot(principalId),
  ];
  // The CLI creates the temp parent at a member's first Claude turn.
  const tmpEntries =
    !room && existsSync(MEMBER_CLAUDE_TMP_PARENT)
      ? readdirSync(MEMBER_CLAUDE_TMP_PARENT).map((entry) => join(MEMBER_CLAUDE_TMP_PARENT, entry))
      : [];
  const roomEntries = existsSync(MEMBER_ROOM_TMP_PARENT)
    ? readdirSync(MEMBER_ROOM_TMP_PARENT).map((entry) => join(MEMBER_ROOM_TMP_PARENT, entry))
    : [];
  return normalizeReadPaths(
    [
      HOST_DOCUMENT_RENDER_ROOT,
      ...registered.flatMap((id) => [
        memberPaths(root, id).runtimeRoot,
        memberClaudeTmpDir(id),
        memberRoomTmpRoot(id),
      ]),
      ...readdirSync(root).map((entry) => join(root, entry)),
      ...tmpEntries,
      ...roomEntries,
    ].filter((path) => !own.includes(path))
  );
}

/** ownerPaths: HOME, the MAMA home and, at boot, every owner data path members are denied. */
export function validateMemberRoot(root: string, ownerPaths: string[]): string {
  if (!isAbsolute(root)) throw new Error('member_root must be absolute');
  const resolved = physical(resolve(root));
  for (const forbidden of ownerPaths.map((path) => physical(resolve(path)))) {
    if (inside(forbidden, resolved) || inside(resolved, forbidden))
      throw new Error('member_root must not overlap HOME, the MAMA home or owner data paths');
  }
  return resolved;
}

export function memberPaths(root: string, principalId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(principalId))
    throw new Error('Member principal id must be one safe path component');
  const runtimeRoot = join(root, principalId);
  return {
    runtimeRoot,
    workspaceDir: join(runtimeRoot, 'workspace'),
    downloadsDir: join(runtimeRoot, 'downloads'),
    claudeConfigDir: join(runtimeRoot, 'claude-config'),
    pluginDir: join(runtimeRoot, '.empty-plugins'),
    codexHome: join(runtimeRoot, '.codex'),
    isolatedHome: join(runtimeRoot, 'codex-runtime', 'home'),
    registryRoot: join(runtimeRoot, 'codex-runtime', 'threads'),
    credentialPath: sessionCredentialPath(runtimeRoot),
    mcpConfigPath: join(runtimeRoot, 'runtime', 'mama-mcp-config.json'),
    journalPath: join(runtimeRoot, 'runtime', 'client-journal.jsonl'),
  };
}

export type MemberPaths = ReturnType<typeof memberPaths>;

/**
 * Each archive stays beside its source, so a rename never crosses filesystems: under member_root
 * and under the member temp parent, both covered by the owner deny and every other member deny.
 */
export function setAsideMemberPaths(root: string, principalId: string): void {
  const runtime = memberPaths(root, principalId).runtimeRoot;
  const temp = memberClaudeTmpDir(principalId);
  const paths = [runtime, temp, memberRoomTmpRoot(principalId)].filter((path) => existsSync(path));
  for (const path of paths) {
    if (physical(path) !== physical(dirname(path)) + sep + path.split(sep).at(-1))
      throw new Error('Member directory to set aside must not be a symlink');
  }
  const suffix = randomUUID();
  for (const path of paths) {
    if (path === runtime) {
      const archive = join(root, `.retired-${principalId}-${suffix}`);
      mkdirSync(archive, { mode: 0o700 });
      renameSync(path, join(archive, 'runtime'));
    } else {
      renameSync(path, join(dirname(path), `.retired-${basename(path)}-${suffix}`));
    }
  }
}

export function ensureMemberPaths(root: string, principalId: string): MemberPaths {
  const paths = memberPaths(root, principalId);
  // Host directories and backend state must remain under this principal, including on restart.
  for (const path of [
    root,
    paths.runtimeRoot,
    paths.workspaceDir,
    paths.downloadsDir,
    paths.claudeConfigDir,
    paths.pluginDir,
    paths.codexHome,
    paths.isolatedHome,
    paths.registryRoot,
    dirname(paths.credentialPath),
  ]) {
    if (existsSync(path) && physical(path) !== resolve(path))
      throw new Error(`Member path must not be a symlink: ${path}`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const gitDir = join(paths.workspaceDir, '.git');
  if (existsSync(gitDir) && physical(gitDir) !== resolve(gitDir))
    throw new Error(`Member git boundary must not be a symlink: ${gitDir}`);
  mkdirSync(gitDir, { recursive: true, mode: 0o700 });
  const head = join(gitDir, 'HEAD');
  if (!existsSync(head)) writeFileSync(head, 'ref: refs/heads/main\n', { mode: 0o600 });
  return paths;
}
