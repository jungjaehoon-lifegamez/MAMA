import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MEMBER_CLAUDE_TMP_PARENT, physicalReadPath } from '../runtime/backend-security.js';
import { ensureMemberPaths, memberClaudeTmpDir } from '../runtime/member-paths.js';

/** Enrollment and owner cutover discard the same pre-enrollment P4 smoke environment. */
export function clearMemberSmokeState(memberRoot: string, principalId: string): void {
  const paths = ensureMemberPaths(memberRoot, principalId);
  const temp = memberClaudeTmpDir(principalId);
  const expectedTemp = join(
    physicalReadPath(dirname(MEMBER_CLAUDE_TMP_PARENT)),
    basename(MEMBER_CLAUDE_TMP_PARENT),
    basename(temp)
  );
  if (physicalReadPath(temp) !== expectedTemp)
    throw new Error('Member temp path must not be a symlink');
  rmSync(paths.runtimeRoot, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
  ensureMemberPaths(memberRoot, principalId);
  mkdirSync(temp, { recursive: true, mode: 0o700 });
}
