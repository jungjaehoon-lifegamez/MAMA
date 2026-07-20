import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface CodexThreadRecord {
  version: 1;
  sessionKey: string;
  keyHash: string;
  threadId: string;
  model: string;
  cwd: string;
  systemPromptFingerprint: string;
  mcpConfigFingerprint: string;
  createdAt: string;
  lastUsedAt: string;
}

export type CodexThreadRecordInput = Omit<
  CodexThreadRecord,
  'version' | 'keyHash' | 'createdAt' | 'lastUsedAt'
>;

interface CodexThreadRegistryOptions {
  rootDir: string;
  fileSystem?: Partial<CodexThreadRegistryFileSystem>;
  platform?: NodeJS.Platform;
}

interface CodexThreadRegistryFileSystem {
  open(path: string, flags: number, mode?: number): number;
  close(descriptor: number): void;
  stat(descriptor: number): Stats;
  chmod(descriptor: number, mode: number): void;
  sync(descriptor: number): void;
  read(descriptor: number): string;
  write(descriptor: number, value: string): void;
  lstat(path: string): Stats | undefined;
  mkdir(path: string): void;
  rename(source: string, destination: string, validateBoundary: () => void): void;
  unlink(path: string, validateBoundary: () => void): void;
  userId(): number | undefined;
}

const nodeFileSystem: CodexThreadRegistryFileSystem = {
  open(path, flags, mode) {
    return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
  },
  close: closeSync,
  stat: fstatSync,
  chmod: fchmodSync,
  sync: fsyncSync,
  read(descriptor) {
    return readFileSync(descriptor, 'utf8');
  },
  write(descriptor, value) {
    writeFileSync(descriptor, value, { encoding: 'utf8' });
  },
  lstat(path) {
    return lstatSync(path, { throwIfNoEntry: false });
  },
  mkdir(path) {
    mkdirSync(path, { mode: 0o700 });
  },
  rename(source, destination, validateBoundary) {
    validateBoundary();
    renameSync(source, destination);
  },
  unlink(path, validateBoundary) {
    validateBoundary();
    unlinkSync(path);
  },
  userId() {
    return process.getuid?.();
  },
};

export function fingerprintText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Codex thread registry record must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, property: string): string {
  const value = record[property];
  if (typeof value !== 'string') {
    throw new Error(`Codex thread registry property ${property} must be a string`);
  }
  return value;
}

function parseRecord(value: unknown): CodexThreadRecord {
  const record = requireObject(value);
  if (record.version !== 1) {
    throw new Error(`Unsupported Codex thread registry schema version: ${String(record.version)}`);
  }

  return {
    version: 1,
    sessionKey: requireString(record, 'sessionKey'),
    keyHash: requireString(record, 'keyHash'),
    threadId: requireString(record, 'threadId'),
    model: requireString(record, 'model'),
    cwd: requireString(record, 'cwd'),
    systemPromptFingerprint: requireString(record, 'systemPromptFingerprint'),
    mcpConfigFingerprint: requireString(record, 'mcpConfigFingerprint'),
    createdAt: requireString(record, 'createdAt'),
    lastUsedAt: requireString(record, 'lastUsedAt'),
  };
}

export class CodexThreadRegistry {
  private readonly rootDir: string;
  private readonly parentDir: string;
  private readonly fileSystem: CodexThreadRegistryFileSystem;
  private readonly platform: NodeJS.Platform;

  constructor(options: CodexThreadRegistryOptions) {
    this.rootDir = resolve(options.rootDir);
    this.parentDir = dirname(this.rootDir);
    if (this.parentDir === this.rootDir) {
      throw new Error('Codex thread registry directory must have a parent directory');
    }
    this.fileSystem = { ...nodeFileSystem, ...options.fileSystem };
    this.platform = options.platform ?? process.platform;
    this.withRootDirectory(() => undefined, true);
  }

  load(sessionKey: string): CodexThreadRecord | undefined {
    const keyHash = fingerprintText(sessionKey);
    const path = this.recordPath(keyHash);
    return this.withRootDirectory((root) => {
      const descriptor = this.openRecordForRead(path, root);
      if (descriptor === undefined) {
        this.assertBoundary(root);
        return undefined;
      }

      const source = this.withDescriptor(descriptor, () => {
        const identity = this.fileSystem.stat(descriptor);
        this.ensureSafeRecord(identity);
        this.assertBoundary(root);
        this.assertOpenedRecordPath(path, identity);
        this.fileSystem.chmod(descriptor, 0o600);
        this.assertBoundary(root);
        this.assertOpenedRecordPath(path, identity);
        return this.fileSystem.read(descriptor);
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(source) as unknown;
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in Codex thread registry record: ${detail}`);
      }
      const record = parseRecord(parsed);
      if (record.sessionKey !== sessionKey || record.keyHash !== keyHash) {
        throw new Error('Codex thread registry key/digest mismatch');
      }
      return record;
    });
  }

  save(input: CodexThreadRecordInput): CodexThreadRecord {
    const keyHash = fingerprintText(input.sessionKey);
    const path = this.recordPath(keyHash);
    const existing = this.load(input.sessionKey);
    const now = new Date().toISOString();
    const record: CodexThreadRecord = {
      version: 1,
      sessionKey: input.sessionKey,
      keyHash,
      threadId: input.threadId,
      model: input.model,
      cwd: input.cwd,
      systemPromptFingerprint: input.systemPromptFingerprint,
      mcpConfigFingerprint: input.mcpConfigFingerprint,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

    this.withRootDirectory((root) => {
      let temporaryCreated = false;
      let renamed = false;
      let temporaryIdentity: Stats | undefined;
      try {
        const descriptor = this.fileSystem.open(temporaryPath, this.recordWriteFlags(), 0o600);
        temporaryCreated = true;
        this.withDescriptor(descriptor, () => {
          temporaryIdentity = this.fileSystem.stat(descriptor);
          this.ensureSafeRecord(temporaryIdentity);
          this.assertRecordIdentity(temporaryPath, temporaryIdentity);
          this.fileSystem.chmod(descriptor, 0o600);
          this.fileSystem.write(descriptor, `${JSON.stringify(record)}\n`);
          this.fileSystem.sync(descriptor);
        });
        this.assertBoundary(root);
        this.fileSystem.rename(temporaryPath, path, () => {
          this.assertBoundary(root);
          if (temporaryIdentity === undefined) {
            throw new Error('Codex thread registry temporary file identity was not captured');
          }
          this.assertRecordIdentity(temporaryPath, temporaryIdentity);
        });
        renamed = true;
        this.assertBoundary(root);
        this.syncDirectory(root.root.descriptor);
      } catch (error: unknown) {
        if (temporaryCreated && !renamed) {
          this.removeTemporaryFileBestEffort(temporaryPath, root);
        }
        throw error;
      }
    });

    return record;
  }

  remove(sessionKey: string): void {
    const path = this.recordPath(fingerprintText(sessionKey));
    this.withRootDirectory((root) => {
      const descriptor = this.openRecordForRead(path, root);
      if (descriptor === undefined) {
        this.assertBoundary(root);
        return;
      }
      this.withDescriptor(descriptor, () => {
        const identity = this.fileSystem.stat(descriptor);
        this.ensureSafeRecord(identity);
        this.assertBoundary(root);
        this.assertRecordIdentity(path, identity);
        this.fileSystem.unlink(path, () => {
          this.assertBoundary(root);
          this.assertRecordIdentity(path, identity);
        });
        this.assertBoundary(root);
      });
      this.syncDirectory(root.root.descriptor);
    });
  }

  private recordPath(keyHash: string): string {
    return join(this.rootDir, `${keyHash}.json`);
  }

  private withRootDirectory<T>(operation: (root: RegistryBoundary) => T, syncParent = false): T {
    return this.withDirectory(this.parentDir, 'parent', (parent) => {
      this.ensureTrustedParent(parent.identity);
      let created = false;
      if (this.fileSystem.lstat(this.rootDir) === undefined) {
        this.assertDirectoryIdentity(this.parentDir, parent.identity, 'parent');
        try {
          this.fileSystem.mkdir(this.rootDir);
          created = true;
        } catch (error: unknown) {
          if (errorCode(error) !== 'EEXIST') {
            throw error;
          }
        }
        this.assertDirectoryIdentity(this.parentDir, parent.identity, 'parent');
      }

      return this.withDirectory(this.rootDir, 'registry', (root) => {
        this.fileSystem.chmod(root.descriptor, 0o700);
        const boundary = { parent, root };
        this.assertBoundary(boundary);
        if (created || syncParent) {
          this.syncDirectory(parent.descriptor);
        }
        return operation(boundary);
      });
    });
  }

  private withDirectory<T>(
    path: string,
    label: 'parent' | 'registry',
    operation: (directory: OpenDirectory) => T
  ): T {
    const before = this.fileSystem.lstat(path);
    if (before === undefined) {
      throw new Error(`Codex thread registry ${label} directory does not exist`);
    }
    if (before.isSymbolicLink()) {
      throw new Error(`Codex thread registry ${label} directory must not be a symbolic link`);
    }

    let descriptor: number;
    try {
      descriptor = this.fileSystem.open(path, this.directoryOpenFlags());
    } catch (error: unknown) {
      if (errorCode(error) === 'ELOOP' || this.fileSystem.lstat(path)?.isSymbolicLink()) {
        throw new Error(`Codex thread registry ${label} directory must not be a symbolic link`, {
          cause: error,
        });
      }
      throw error;
    }

    return this.withDescriptor(descriptor, () => {
      const identity = this.fileSystem.stat(descriptor);
      if (!identity.isDirectory()) {
        throw new Error(`Codex thread registry ${label} path must be a directory`);
      }
      if (!sameIdentity(before, identity)) {
        throw new Error(`Codex thread registry ${label} directory identity changed during open`);
      }
      this.assertDirectoryIdentity(path, identity, label);
      return operation({ descriptor, identity });
    });
  }

  private assertBoundary(boundary: RegistryBoundary): void {
    this.assertDirectoryIdentity(this.parentDir, boundary.parent.identity, 'parent');
    this.assertDirectoryIdentity(this.rootDir, boundary.root.identity, 'registry');
  }

  private assertDirectoryIdentity(path: string, expected: Stats, label: string): void {
    const current = this.fileSystem.lstat(path);
    if (current === undefined) {
      throw new Error(`Codex thread registry ${label} directory disappeared during operation`);
    }
    if (current.isSymbolicLink()) {
      throw new Error(`Codex thread registry ${label} directory must not be a symbolic link`);
    }
    if (!current.isDirectory() || !sameIdentity(current, expected)) {
      throw new Error(`Codex thread registry ${label} directory identity changed during operation`);
    }
  }

  private openRecordForRead(path: string, boundary: RegistryBoundary): number | undefined {
    try {
      const before = this.fileSystem.lstat(path);
      if (before === undefined) {
        this.assertBoundary(boundary);
        return undefined;
      }
      this.ensureSafeRecord(before);
      const descriptor = this.fileSystem.open(path, this.recordReadFlags());
      try {
        const identity = this.fileSystem.stat(descriptor);
        this.ensureSafeRecord(identity);
        if (this.platform === 'win32' && !sameIdentity(before, identity)) {
          throw new Error('Codex thread registry record identity changed during open');
        }
        this.assertOpenedRecordPath(path, identity);
        return descriptor;
      } catch (error: unknown) {
        try {
          this.fileSystem.close(descriptor);
        } catch {
          // Descriptor cleanup cannot replace the validation failure.
        }
        throw error;
      }
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        this.assertBoundary(boundary);
        return undefined;
      }
      if (errorCode(error) === 'ELOOP' || this.fileSystem.lstat(path)?.isSymbolicLink()) {
        throw new Error('Codex thread registry record must not be a symbolic link', {
          cause: error,
        });
      }
      throw error;
    }
  }

  private ensureSafeRecord(stats: Stats): void {
    if (stats.isSymbolicLink()) {
      throw new Error('Codex thread registry record must not be a symbolic link');
    }
    if (!stats.isFile()) {
      throw new Error('Codex thread registry record must be a regular file');
    }
  }

  private assertRecordIdentity(path: string, expected: Stats): void {
    const current = this.fileSystem.lstat(path);
    if (current === undefined) {
      throw new Error('Codex thread registry record disappeared during operation');
    }
    if (current.isSymbolicLink()) {
      throw new Error('Codex thread registry record must not be a symbolic link');
    }
    if (!current.isFile() || !sameIdentity(current, expected)) {
      throw new Error('Codex thread registry record identity changed during operation');
    }
  }

  private assertRecordPathNotSymlink(path: string): void {
    if (this.fileSystem.lstat(path)?.isSymbolicLink()) {
      throw new Error('Codex thread registry record must not be a symbolic link');
    }
  }

  private assertOpenedRecordPath(path: string, expected: Stats): void {
    if (this.platform === 'win32') {
      this.assertRecordIdentity(path, expected);
      return;
    }
    this.assertRecordPathNotSymlink(path);
  }

  private ensureTrustedParent(stats: Stats): void {
    if (this.platform === 'win32') {
      // Node's Stats uid/mode do not describe Windows ACL trust. The caller must place the
      // registry under an ACL-protected parent; descriptor/path identity and reparse-point
      // validation enforce the topology guarantees that Node exposes portably.
      return;
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Error('Codex thread registry parent directory must not be group/world writable');
    }
    const userId = this.fileSystem.userId();
    if (userId === undefined) {
      throw new Error('Codex thread registry cannot validate the parent directory owner UID');
    }
    if (stats.uid !== userId && stats.uid !== 0) {
      throw new Error('Codex thread registry parent directory has an untrusted owner UID');
    }
  }

  private directoryOpenFlags(): number {
    if (this.platform === 'win32') {
      return constants.O_RDONLY;
    }
    return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  }

  private recordReadFlags(): number {
    return this.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
  }

  private recordWriteFlags(): number {
    const common = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
    return this.platform === 'win32' ? common : common | constants.O_NOFOLLOW;
  }

  private withDescriptor<T>(descriptor: number, operation: () => T): T {
    let result: T;
    try {
      result = operation();
    } catch (error: unknown) {
      try {
        this.fileSystem.close(descriptor);
      } catch {
        // Descriptor cleanup cannot replace the original operation failure.
      }
      throw error;
    }
    this.fileSystem.close(descriptor);
    return result;
  }

  private syncDirectory(descriptor: number): void {
    try {
      this.fileSystem.sync(descriptor);
    } catch (error: unknown) {
      const code = errorCode(error);
      const unsupportedOnWindows =
        this.platform === 'win32' && (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EBADF');
      if (!unsupportedOnWindows) {
        throw error;
      }
    }
  }

  private removeTemporaryFileBestEffort(path: string, boundary: RegistryBoundary): void {
    try {
      this.fileSystem.unlink(path, () => this.assertBoundary(boundary));
    } catch {
      // Cleanup cannot replace the original write/durability failure.
    }
  }
}

interface OpenDirectory {
  descriptor: number;
  identity: Stats;
}

interface RegistryBoundary {
  parent: OpenDirectory;
  root: OpenDirectory;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
