import { realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { OwnerRuntimeOptions } from './owner-runtime.js';

/** Canonicalize even future files. Only a missing ancestor is expected; other errors fail boot. */
export function physicalReadPath(path: string): string {
  path = resolve(path);
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    return join(physicalReadPath(parent), path.slice(parent.length + (parent === '/' ? 0 : 1)));
  }
}

export function normalizeReadPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(physicalReadPath))];
}

/** Member-only boundary. The owner's credential list and driver options do not use this list. */
export function ownerDataReadPaths(options: OwnerRuntimeOptions): string[] {
  const root = options.runtimeRoot;
  const database = physicalReadPath(options.databasePath);
  const wiki = options.wiki;
  return normalizeReadPaths([
    homedir(),
    root,
    options.databasePath,
    `${options.databasePath}-wal`,
    `${options.databasePath}-shm`,
    database,
    `${database}-wal`,
    `${database}-shm`,
    options.rawPath,
    ...(wiki
      ? [
          wiki.vaultPath,
          isAbsolute(wiki.wikiDir) ? wiki.wikiDir : join(wiki.vaultPath, wiki.wikiDir),
        ]
      : []),
    // Atomic report saves create a random temporary sibling, so deny the slot directory too.
    options.reportPath ?? join(root, 'report-slots.json'),
    dirname(options.reportPath ?? join(root, 'report-slots.json')),
    options.attachmentPorts?.downloadsDir ?? join(root, 'downloads'),
    options.driveDelivery?.stagingDir ?? join(root, 'runtime', 'outgoing'),
    options.workspaceDir,
    join(root, 'owner-policy.md'),
    ...credentialReadPaths(root, options.codexHome, options.replayKeyFile),
    join(root, 'codex-runtime', 'home'),
    join(root, 'codex-runtime', 'threads'),
    ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : []),
    // Members read this store through their CLI; their tools must not.
    ...(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
      ? [process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR]
      : []),
    ...(options.jev ? [options.jev.keyFile, options.jev.vocabFile] : []),
    options.mcpConfigPath ?? join(root, 'mama-mcp-config.json'),
    options.socketPath,
    options.credentialPath,
    join(root, 'logs'),
    // The Claude sandbox temp dir every session of this OS user falls back to, the owner's included.
    join('/tmp', `claude-${userInfo().uid}`),
    ...(options.ownerDeniedReadPaths ?? []),
  ]);
}

/** CLI authentication lives in the backend homes. No secret-shaped daemon variable is needed.
 * Non-secret CLAUDE_CODE_* messaging/settings variables remain available to native children.
 */
export function backendEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      // MAX_THINKING_TOKENS is a budget count the Claude CLI reads, not a credential.
      ([name]) =>
        name === 'MAX_THINKING_TOKENS' ||
        !/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^MAMA_ICAL_URL_)/i.test(name)
    )
  );
}

/** Paths are supplied by the product, never discovered by the shared engine. */
export function credentialReadPaths(
  runtimeRoot: string,
  codexHome?: string,
  replayKeyFile?: string
): string[] {
  return [
    ...new Set([
      resolve(runtimeRoot, 'auth.env'),
      resolve(runtimeRoot, 'config.yaml'),
      resolve(runtimeRoot, 'runtime'),
      resolve(runtimeRoot, '.codex'),
      resolve(replayKeyFile ?? resolve(runtimeRoot, 'jev-key')),
      ...(codexHome ? [resolve(codexHome)] : []),
    ]),
  ];
}
