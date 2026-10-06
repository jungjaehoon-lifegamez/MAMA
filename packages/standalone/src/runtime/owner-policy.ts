import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OwnerPolicySnapshot {
  content: string | null;
  fingerprint: string;
  loaded: boolean;
}

export type OwnerPolicyProvider = () => OwnerPolicySnapshot;

const OWNER_POLICY_FILENAME = 'owner-policy.md';

export function ownerPolicyFingerprint(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function ownerPolicyPath(mamaRoot: string): string {
  return join(mamaRoot, OWNER_POLICY_FILENAME);
}

export function readOwnerPolicy(mamaRoot: string): OwnerPolicySnapshot {
  try {
    const bytes = readFileSync(ownerPolicyPath(mamaRoot));
    return {
      content: bytes.toString('utf8'),
      fingerprint: ownerPolicyFingerprint(bytes),
      loaded: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const bytes = Buffer.alloc(0);
    return { content: null, fingerprint: ownerPolicyFingerprint(bytes), loaded: false };
  }
}

export function createOwnerPolicyProvider(mamaRoot: string): OwnerPolicyProvider {
  return () => readOwnerPolicy(mamaRoot);
}

/** The revision is already durable when the action reaches this same-directory rename. */
export function replaceOwnerPolicy(mamaRoot: string, text: string): void {
  const temporary = join(mamaRoot, `.owner-policy-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, ownerPolicyPath(mamaRoot));
  } finally {
    rmSync(temporary, { force: true });
  }
}
