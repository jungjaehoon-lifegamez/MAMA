import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { sessionCredentialPath } from './session-credential.js';
import {
  MEMBER_CLAUDE_TMP_PARENT,
  MEMBER_ROOM_TMP_PARENT,
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
export function memberClaudeTmpDir(principalId: string): string {
  const id = createHash('sha256').update(principalId).digest('hex').slice(0, 12);
  return join(MEMBER_CLAUDE_TMP_PARENT, id);
}

/** Known before any room starts, so other principals deny this whole subtree. */
export function memberRoomTmpRoot(principalId: string): string {
  return join(
    MEMBER_ROOM_TMP_PARENT,
    createHash('sha256').update(principalId).digest('hex').slice(0, 8)
  );
}

export function memberRoomClaudeTmpDir(
  principalId: string,
  channel: string,
  options: { parent?: string; uid?: number } = {}
): string {
  const path = join(
    options.parent === undefined
      ? memberRoomTmpRoot(principalId)
      : join(options.parent, createHash('sha256').update(principalId).digest('hex').slice(0, 8)),
    createHash('sha256')
      .update(JSON.stringify([principalId, channel]))
      .digest('hex')
      .slice(0, 10)
  );
  if (Buffer.byteLength(join(path, `claude-${options.uid ?? userInfo().uid}`)) > 44)
    throw new Error('Room Claude temp path exceeds the 44-byte sandbox limit');
  return path;
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
