import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sessionCredentialPath } from './session-credential.js';
import { normalizeReadPaths, physicalReadPath } from './backend-security.js';

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Resolve existing ancestors too: a symlink must not move a member root into HOME. */
const physical = physicalReadPath;

/** Include inactive registrations and unregistered debris; enumerate again before each turn. */
export function otherMemberReadPaths(
  root: string,
  principalId: string,
  registered: readonly string[]
): string[] {
  const own = memberPaths(root, principalId).runtimeRoot;
  return normalizeReadPaths(
    [
      ...registered.map((id) => memberPaths(root, id).runtimeRoot),
      ...readdirSync(root).map((entry) => join(root, entry)),
    ].filter((path) => path !== own)
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
