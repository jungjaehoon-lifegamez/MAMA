import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared by daemon boot (writer) and the stdio action server (reader). */
export function sessionCredentialPath(mamaHome: string): string {
  return join(mamaHome, 'runtime', 'session-credential');
}

/** Read at request time: credentials rotate when the runtime starts again. */
export function readSessionCredential(mamaHome: string): string | undefined {
  return readCredentialFile(sessionCredentialPath(mamaHome));
}

export function readCredentialFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const credential = readFileSync(path, 'utf8').trim();
  return credential === '' ? undefined : credential;
}
