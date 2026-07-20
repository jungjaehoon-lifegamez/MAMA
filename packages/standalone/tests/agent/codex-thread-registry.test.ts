import {
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexThreadRegistry,
  fingerprintText,
  type CodexThreadRecord,
  type CodexThreadRecordInput,
} from '../../src/agent/codex-thread-registry.js';

type RegistryFileSystem = NonNullable<
  ConstructorParameters<typeof CodexThreadRegistry>[0]['fileSystem']
>;

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mama-codex-thread-registry-'));
  temporaryDirectories.push(directory);
  return directory;
}

function recordPath(rootDir: string, sessionKey: string): string {
  return join(rootDir, `${fingerprintText(sessionKey)}.json`);
}

function makeRecord(sessionKey = 'discord:channel-1'): CodexThreadRecord {
  return {
    version: 1,
    sessionKey,
    keyHash: fingerprintText(sessionKey),
    threadId: 'thread_1',
    model: 'gpt-5.4',
    cwd: '/workspace',
    systemPromptFingerprint: fingerprintText('rules'),
    mcpConfigFingerprint: fingerprintText('{}'),
    createdAt: '2026-07-20T00:00:00.000Z',
    lastUsedAt: '2026-07-20T00:00:00.000Z',
  };
}

function writeStoredRecord(rootDir: string, sessionKey: string, value: unknown): void {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  writeFileSync(recordPath(rootDir, sessionKey), JSON.stringify(value), { mode: 0o600 });
}

function saveInWorker(rootDir: string, input: CodexThreadRecordInput): Promise<void> {
  const moduleUrl = new URL('../../src/agent/codex-thread-registry.ts', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl)
      .then(({ CodexThreadRegistry }) => {
        new CodexThreadRegistry({ rootDir: workerData.rootDir }).save(workerData.input);
        parentPort.postMessage('saved');
      })
      .catch((error) => {
        throw error;
      });
  `;

  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      execArgv: ['--no-warnings'],
      workerData: { moduleUrl, rootDir, input },
    });
    worker.once('message', () => resolve());
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Registry writer worker exited with code ${code}`));
      }
    });
  });
}

function runRegistryWorker(source: string, workerData: Record<string, unknown>): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      execArgv: ['--no-warnings'],
      workerData,
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Registry worker exited with code ${code}`));
      }
    });
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CodexThreadRegistry', () => {
  it('saves and loads a complete thread record with private filesystem modes', () => {
    const parentDir = makeTemporaryDirectory();
    const rootDir = join(parentDir, 'threads');
    const registry = new CodexThreadRegistry({ rootDir });

    const saved = registry.save({
      sessionKey: 'discord:channel-1',
      threadId: 'thread_1',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });

    expect(registry.load('discord:channel-1')).toEqual(saved);
    expect(saved).toMatchObject({
      version: 1,
      sessionKey: 'discord:channel-1',
      keyHash: fingerprintText('discord:channel-1'),
      threadId: 'thread_1',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });
    expect(saved.createdAt).toBe(saved.lastUsedAt);
    expect(lstatSync(rootDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(recordPath(rootDir, saved.sessionKey)).mode & 0o777).toBe(0o600);
  });

  it('tightens existing directory and record permissions', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const record = makeRecord();
    writeStoredRecord(rootDir, record.sessionKey, record);
    chmodSync(rootDir, 0o755);
    chmodSync(recordPath(rootDir, record.sessionKey), 0o644);

    const registry = new CodexThreadRegistry({ rootDir });

    expect(registry.load(record.sessionKey)).toEqual(record);
    expect(lstatSync(rootDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(recordPath(rootDir, record.sessionKey)).mode & 0o777).toBe(0o600);
  });

  it('keeps atomic writes for different keys independent', async () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const registry = new CodexThreadRegistry({ rootDir });

    await Promise.all([
      saveInWorker(rootDir, {
        sessionKey: 'discord:one',
        threadId: 'thread_one',
        model: 'gpt-5.4',
        cwd: '/workspace/one',
        systemPromptFingerprint: fingerprintText('one'),
        mcpConfigFingerprint: fingerprintText('{}'),
      }),
      saveInWorker(rootDir, {
        sessionKey: 'slack:two',
        threadId: 'thread_two',
        model: 'gpt-5.4',
        cwd: '/workspace/two',
        systemPromptFingerprint: fingerprintText('two'),
        mcpConfigFingerprint: fingerprintText('{}'),
      }),
    ]);

    expect(registry.load('discord:one')?.threadId).toBe('thread_one');
    expect(registry.load('slack:two')?.threadId).toBe('thread_two');
    expect(readdirSync(rootDir).sort()).toEqual(
      [`${fingerprintText('discord:one')}.json`, `${fingerprintText('slack:two')}.json`].sort()
    );
  });

  it('allows concurrent first-use workers to create and validate one registry root', async () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const workerCount = 8;
    const sharedState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const state = new Int32Array(sharedState);
    const moduleUrl = new URL('../../src/agent/codex-thread-registry.ts', import.meta.url).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({ CodexThreadRegistry, fingerprintText }) => {
        const state = new Int32Array(workerData.sharedState);
        Atomics.add(state, 0, 1);
        Atomics.notify(state, 0);
        while (Atomics.load(state, 1) === 0) {
          Atomics.wait(state, 1, 0, 100);
        }
        const { mkdirSync } = require('node:fs');
        const registry = new CodexThreadRegistry({
          rootDir: workerData.rootDir,
          fileSystem: {
            mkdir(path) {
              Atomics.add(state, 2, 1);
              Atomics.notify(state, 2);
              while (Atomics.load(state, 2) < workerData.workerCount) {
                Atomics.wait(state, 2, Atomics.load(state, 2), 100);
              }
              mkdirSync(path, { mode: 0o700 });
            },
          },
        });
        registry.save({
          sessionKey: 'worker:' + workerData.index,
          threadId: 'thread_' + workerData.index,
          model: 'gpt-5.4',
          cwd: '/workspace',
          systemPromptFingerprint: fingerprintText('rules'),
          mcpConfigFingerprint: fingerprintText('{}'),
        });
        parentPort.postMessage('saved');
      });
    `;
    const workers = Array.from({ length: workerCount }, (_, index) =>
      runRegistryWorker(source, { moduleUrl, rootDir, sharedState, index, workerCount })
    );

    while (Atomics.load(state, 0) < workerCount) {
      Atomics.wait(state, 0, Atomics.load(state, 0), 100);
    }
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1, workerCount);

    await expect(Promise.all(workers)).resolves.toEqual(Array(workerCount).fill('saved'));
    expect(readdirSync(rootDir)).toHaveLength(workerCount);
  });

  it('only exposes complete old or new records while replacements are written', async () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const registry = new CodexThreadRegistry({ rootDir });
    const sessionKey = 'discord:atomic-read';
    const sharedState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const moduleUrl = new URL('../../src/agent/codex-thread-registry.ts', import.meta.url).href;
    registry.save({
      sessionKey,
      threadId: 'thread_old',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });

    const writerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({ CodexThreadRegistry, fingerprintText }) => {
        const state = new Int32Array(workerData.sharedState);
        const registry = new CodexThreadRegistry({ rootDir: workerData.rootDir });
        Atomics.store(state, 0, 1);
        Atomics.notify(state, 0);
        for (let index = 0; index < 200; index += 1) {
          registry.save({
            sessionKey: workerData.sessionKey,
            threadId: index % 2 === 0 ? 'thread_new_a' : 'thread_new_b',
            model: 'gpt-5.4',
            cwd: '/workspace',
            systemPromptFingerprint: fingerprintText('rules'),
            mcpConfigFingerprint: fingerprintText('{}'),
          });
        }
        Atomics.store(state, 1, 1);
        Atomics.notify(state, 1);
        parentPort.postMessage('written');
      });
    `;
    const readerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({ CodexThreadRegistry }) => {
        const state = new Int32Array(workerData.sharedState);
        const registry = new CodexThreadRegistry({ rootDir: workerData.rootDir });
        while (Atomics.load(state, 0) === 0) {
          Atomics.wait(state, 0, 0, 100);
        }
        const observed = new Set();
        let reads = 0;
        while (Atomics.load(state, 1) === 0 || reads < 200) {
          observed.add(registry.load(workerData.sessionKey).threadId);
          reads += 1;
        }
        parentPort.postMessage({ observed: [...observed], reads });
      });
    `;
    const workerData = { moduleUrl, rootDir, sessionKey, sharedState };

    const [writerResult, readerResult] = await Promise.all([
      runRegistryWorker(writerSource, workerData),
      runRegistryWorker(readerSource, workerData),
    ]);

    expect(writerResult).toBe('written');
    expect(readerResult).toEqual(
      expect.objectContaining({
        observed: expect.arrayContaining([]),
        reads: expect.any(Number),
      })
    );
    const observed = (readerResult as { observed: string[] }).observed;
    expect(observed.length).toBeGreaterThan(0);
    expect(
      observed.every((value) => ['thread_old', 'thread_new_a', 'thread_new_b'].includes(value))
    ).toBe(true);
    expect(readdirSync(rootDir)).toEqual([`${fingerprintText(sessionKey)}.json`]);
  });

  it('preserves creation time and refreshes payload and last-used time on update', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const registry = new CodexThreadRegistry({ rootDir });
    const createdAt = new Date('2026-07-20T00:00:00.000Z');
    const updatedAt = new Date('2026-07-20T00:05:00.000Z');

    vi.useFakeTimers();
    try {
      vi.setSystemTime(createdAt);
      const first = registry.save({
        sessionKey: 'discord:update',
        threadId: 'thread_old',
        model: 'gpt-5.4',
        cwd: '/workspace/old',
        systemPromptFingerprint: fingerprintText('old rules'),
        mcpConfigFingerprint: fingerprintText('{"old":true}'),
      });

      vi.setSystemTime(updatedAt);
      const second = registry.save({
        sessionKey: 'discord:update',
        threadId: 'thread_new',
        model: 'gpt-5.4-mini',
        cwd: '/workspace/new',
        systemPromptFingerprint: fingerprintText('new rules'),
        mcpConfigFingerprint: fingerprintText('{"new":true}'),
      });

      expect(second.createdAt).toBe(first.createdAt);
      expect(second.createdAt).toBe(createdAt.toISOString());
      expect(second.lastUsedAt).toBe(updatedAt.toISOString());
      expect(second.lastUsedAt).not.toBe(first.lastUsedAt);
      expect(registry.load('discord:update')).toEqual(second);
      expect(second).toMatchObject({
        threadId: 'thread_new',
        model: 'gpt-5.4-mini',
        cwd: '/workspace/new',
        systemPromptFingerprint: fingerprintText('new rules'),
        mcpConfigFingerprint: fingerprintText('{"new":true}'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes only the explicitly selected session key', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const registry = new CodexThreadRegistry({ rootDir });
    const common = {
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    };
    registry.save({ sessionKey: 'discord:one', threadId: 'thread_one', ...common });
    registry.save({ sessionKey: 'discord:two', threadId: 'thread_two', ...common });

    registry.remove('discord:one');

    expect(registry.load('discord:one')).toBeUndefined();
    expect(registry.load('discord:two')?.threadId).toBe('thread_two');
  });

  it('throws for invalid JSON instead of silently falling back', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const sessionKey = 'discord:invalid-json';
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    writeFileSync(recordPath(rootDir, sessionKey), '{invalid', { mode: 0o600 });
    const registry = new CodexThreadRegistry({ rootDir });

    expect(() => registry.load(sessionKey)).toThrow(/invalid JSON/i);
  });

  it('throws for an unsupported schema version', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const record = { ...makeRecord(), version: 2 };
    writeStoredRecord(rootDir, record.sessionKey, record);

    expect(() => new CodexThreadRegistry({ rootDir }).load(record.sessionKey)).toThrow(
      /schema version/i
    );
  });

  it('throws when the stored session key does not match its digest', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const requestedKey = 'discord:expected';
    const record = {
      ...makeRecord(requestedKey),
      keyHash: fingerprintText('discord:different'),
    };
    writeStoredRecord(rootDir, requestedKey, record);

    expect(() => new CodexThreadRegistry({ rootDir }).load(requestedKey)).toThrow(/key.*mismatch/i);
  });

  it('throws when a required record property is missing', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const record = makeRecord();
    const { threadId: _threadId, ...malformed } = record;
    writeStoredRecord(rootDir, record.sessionKey, malformed);

    expect(() => new CodexThreadRegistry({ rootDir }).load(record.sessionKey)).toThrow(/threadId/i);
  });

  it('throws when a persisted record property has the wrong runtime type', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const record = { ...makeRecord(), threadId: 42 };
    writeStoredRecord(rootDir, record.sessionKey, record);

    expect(() => new CodexThreadRegistry({ rootDir }).load(record.sessionKey)).toThrow(
      /threadId.*string/i
    );
  });

  it('refuses a record replaced by a symlink at descriptor-open time', () => {
    const parentDir = makeTemporaryDirectory();
    const rootDir = join(parentDir, 'threads');
    const outsideRecord = join(parentDir, 'outside.json');
    const sessionKey = 'discord:descriptor-race';
    const path = recordPath(rootDir, sessionKey);
    const registry = new CodexThreadRegistry({ rootDir });
    registry.save({
      sessionKey,
      threadId: 'thread_safe',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });
    writeFileSync(outsideRecord, JSON.stringify(makeRecord(sessionKey)), { mode: 0o600 });
    let replaced = false;
    let openedWithNoFollow = false;
    const racingRegistry = new CodexThreadRegistry({
      rootDir,
      fileSystem: {
        open(candidatePath, flags, mode) {
          if (candidatePath === path && !replaced) {
            openedWithNoFollow = (flags & constants.O_NOFOLLOW) === constants.O_NOFOLLOW;
            replaced = true;
            unlinkSync(path);
            symlinkSync(outsideRecord, path);
          }
          return openSync(candidatePath, flags, mode);
        },
      },
    });

    expect(() => racingRegistry.load(sessionKey)).toThrow(/symbolic link/i);
    expect(replaced).toBe(true);
    expect(openedWithNoFollow).toBe(true);
    expect(readFileSync(outsideRecord, 'utf8')).toContain(sessionKey);
  });

  it('preserves the prior record and removes the temp file when rename fails', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const sessionKey = 'discord:rename-failure';
    const registry = new CodexThreadRegistry({ rootDir });
    registry.save({
      sessionKey,
      threadId: 'thread_old',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });
    const renameError = new Error('injected rename failure');
    const failingRegistry = new CodexThreadRegistry({
      rootDir,
      fileSystem: {
        rename(source, destination) {
          if (destination === recordPath(rootDir, sessionKey)) {
            throw renameError;
          }
          renameSync(source, destination);
        },
      },
    });

    expect(() =>
      failingRegistry.save({
        sessionKey,
        threadId: 'thread_new',
        model: 'gpt-5.4',
        cwd: '/workspace',
        systemPromptFingerprint: fingerprintText('rules'),
        mcpConfigFingerprint: fingerprintText('{}'),
      })
    ).toThrow(renameError);
    expect(registry.load(sessionKey)?.threadId).toBe('thread_old');
    expect(readdirSync(rootDir)).toEqual([`${fingerprintText(sessionKey)}.json`]);
  });

  it('does not replace the original write error when temp cleanup also fails', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const sessionKey = 'discord:cleanup-failure';
    const renameError = new Error('original rename failure');
    const registry = new CodexThreadRegistry({
      rootDir,
      fileSystem: {
        rename() {
          throw renameError;
        },
        unlink() {
          throw new Error('secondary cleanup failure');
        },
      },
    });

    expect(() =>
      registry.save({
        sessionKey,
        threadId: 'thread_new',
        model: 'gpt-5.4',
        cwd: '/workspace',
        systemPromptFingerprint: fingerprintText('rules'),
        mcpConfigFingerprint: fingerprintText('{}'),
      })
    ).toThrow(renameError);
  });

  it('fsyncs the temp record and parent directory through real descriptors', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const syncedTypes: string[] = [];
    const fileSystem: RegistryFileSystem = {
      sync(descriptor) {
        syncedTypes.push(fstatSync(descriptor).isDirectory() ? 'directory' : 'file');
        fsyncSync(descriptor);
      },
    };
    const registry = new CodexThreadRegistry({ rootDir, fileSystem });

    registry.save({
      sessionKey: 'discord:durability',
      threadId: 'thread_durable',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });

    expect(syncedTypes).toEqual(['directory', 'file', 'directory']);
    expect(lstatSync(rootDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(recordPath(rootDir, 'discord:durability')).mode & 0o777).toBe(0o600);
  });

  it('fsyncs the parent directory after creating the registry directory', () => {
    const parentDir = makeTemporaryDirectory();
    const rootDir = join(parentDir, 'threads');
    const syncedDirectories: string[] = [];

    new CodexThreadRegistry({
      rootDir,
      fileSystem: {
        sync(descriptor) {
          const stats = fstatSync(descriptor);
          if (stats.isDirectory()) {
            syncedDirectories.push(
              stats.dev === lstatSync(parentDir).dev && stats.ino === lstatSync(parentDir).ino
                ? 'parent'
                : 'root'
            );
          }
          fsyncSync(descriptor);
        },
      },
    });

    expect(syncedDirectories).toEqual(['parent']);
  });

  it('uses the Windows-compatible flag strategy and still rejects a descriptor-time symlink', () => {
    const parentDir = makeTemporaryDirectory();
    const rootDir = join(parentDir, 'threads');
    const outsideRecord = join(parentDir, 'outside.json');
    const sessionKey = 'discord:windows-descriptor-race';
    const path = recordPath(rootDir, sessionKey);
    const registry = new CodexThreadRegistry({ rootDir });
    registry.save({
      sessionKey,
      threadId: 'thread_safe',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });
    writeFileSync(outsideRecord, JSON.stringify(makeRecord(sessionKey)), { mode: 0o600 });
    const observedFlags: number[] = [];
    let replaced = false;
    const windowsRegistry = new CodexThreadRegistry({
      rootDir,
      platform: 'win32',
      fileSystem: {
        open(candidatePath, flags, mode) {
          observedFlags.push(flags);
          if (candidatePath === path && !replaced) {
            replaced = true;
            unlinkSync(path);
            symlinkSync(outsideRecord, path);
          }
          return openSync(candidatePath, flags, mode);
        },
      },
    });

    expect(() => windowsRegistry.load(sessionKey)).toThrow(/symbolic link|identity changed/i);
    expect(replaced).toBe(true);
    expect(observedFlags.every((flags) => (flags & constants.O_NOFOLLOW) === 0)).toBe(true);
    expect(observedFlags.every((flags) => (flags & constants.O_DIRECTORY) === 0)).toBe(true);
    expect(readFileSync(outsideRecord, 'utf8')).toContain(sessionKey);
  });

  it('rejects a Windows open that followed a transient symlink before chmod or read', () => {
    const parentDir = makeTemporaryDirectory();
    const rootDir = join(parentDir, 'threads');
    const outsideRecord = join(parentDir, 'outside.json');
    const displacedRecord = join(parentDir, 'displaced.json');
    const sessionKey = 'discord:windows-transient-symlink';
    const path = recordPath(rootDir, sessionKey);
    const registry = new CodexThreadRegistry({ rootDir });
    registry.save({
      sessionKey,
      threadId: 'thread_safe',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });
    writeFileSync(outsideRecord, JSON.stringify(makeRecord(sessionKey)), { mode: 0o640 });
    const outsideIdentity = lstatSync(outsideRecord);
    let swapped = false;
    let touchedOutside = false;
    const windowsRegistry = new CodexThreadRegistry({
      rootDir,
      platform: 'win32',
      fileSystem: {
        open(candidatePath, flags, mode) {
          if (candidatePath !== path || swapped) {
            return openSync(candidatePath, flags, mode);
          }
          swapped = true;
          renameSync(path, displacedRecord);
          symlinkSync(outsideRecord, path);
          const descriptor = openSync(path, flags, mode);
          unlinkSync(path);
          renameSync(displacedRecord, path);
          return descriptor;
        },
        chmod(descriptor, mode) {
          const identity = fstatSync(descriptor);
          if (identity.dev === outsideIdentity.dev && identity.ino === outsideIdentity.ino) {
            touchedOutside = true;
          }
          fchmodSync(descriptor, mode);
        },
        read(descriptor) {
          const identity = fstatSync(descriptor);
          if (identity.dev === outsideIdentity.dev && identity.ino === outsideIdentity.ino) {
            touchedOutside = true;
          }
          return readFileSync(descriptor, 'utf8');
        },
      },
    });

    expect(() => windowsRegistry.load(sessionKey)).toThrow(/identity changed/i);
    expect(swapped).toBe(true);
    expect(touchedOutside).toBe(false);
    expect(lstatSync(outsideRecord).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')(
    'aborts save when the root is swapped inside the final rename guard',
    () => {
      const parentDir = makeTemporaryDirectory();
      const rootDir = join(parentDir, 'threads');
      const displacedRoot = join(parentDir, 'displaced-threads');
      const sessionKey = 'discord:rename-root-swap';
      const destination = recordPath(rootDir, sessionKey);
      const attackerValue = 'attacker-owned-record';
      const registry = new CodexThreadRegistry({ rootDir });
      registry.save({
        sessionKey,
        threadId: 'thread_old',
        model: 'gpt-5.4',
        cwd: '/workspace',
        systemPromptFingerprint: fingerprintText('rules'),
        mcpConfigFingerprint: fingerprintText('{}'),
      });
      let guardCalled = false;
      const racingRegistry = new CodexThreadRegistry({
        rootDir,
        fileSystem: {
          rename(source, target, validateBoundary) {
            renameSync(rootDir, displacedRoot);
            mkdirSync(rootDir, { mode: 0o700 });
            writeFileSync(destination, attackerValue, { mode: 0o600 });
            guardCalled = true;
            validateBoundary();
            renameSync(source, target);
          },
        },
      });

      expect(() =>
        racingRegistry.save({
          sessionKey,
          threadId: 'thread_new',
          model: 'gpt-5.4',
          cwd: '/workspace',
          systemPromptFingerprint: fingerprintText('rules'),
          mcpConfigFingerprint: fingerprintText('{}'),
        })
      ).toThrow(/identity changed/i);
      expect(guardCalled).toBe(true);
      expect(readFileSync(destination, 'utf8')).toBe(attackerValue);
      expect(JSON.parse(readFileSync(recordPath(displacedRoot, sessionKey), 'utf8')).threadId).toBe(
        'thread_old'
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'aborts remove when the root is swapped inside the final unlink guard',
    () => {
      const parentDir = makeTemporaryDirectory();
      const rootDir = join(parentDir, 'threads');
      const displacedRoot = join(parentDir, 'displaced-threads');
      const sessionKey = 'discord:unlink-root-swap';
      const destination = recordPath(rootDir, sessionKey);
      const attackerValue = 'attacker-owned-record';
      const registry = new CodexThreadRegistry({ rootDir });
      registry.save({
        sessionKey,
        threadId: 'thread_old',
        model: 'gpt-5.4',
        cwd: '/workspace',
        systemPromptFingerprint: fingerprintText('rules'),
        mcpConfigFingerprint: fingerprintText('{}'),
      });
      let guardCalled = false;
      const racingRegistry = new CodexThreadRegistry({
        rootDir,
        fileSystem: {
          unlink(target, validateBoundary) {
            renameSync(rootDir, displacedRoot);
            mkdirSync(rootDir, { mode: 0o700 });
            writeFileSync(destination, attackerValue, { mode: 0o600 });
            guardCalled = true;
            validateBoundary();
            unlinkSync(target);
          },
        },
      });

      expect(() => racingRegistry.remove(sessionKey)).toThrow(/identity changed/i);
      expect(guardCalled).toBe(true);
      expect(readFileSync(destination, 'utf8')).toBe(attackerValue);
      expect(JSON.parse(readFileSync(recordPath(displacedRoot, sessionKey), 'utf8')).threadId).toBe(
        'thread_old'
      );
    }
  );

  it.skipIf(process.platform === 'win32')('detects a root swap immediately after unlink', () => {
    const parentDir = makeTemporaryDirectory();
    const rootDir = join(parentDir, 'threads');
    const displacedRoot = join(parentDir, 'displaced-threads');
    const sessionKey = 'discord:post-unlink-root-swap';
    const destination = recordPath(rootDir, sessionKey);
    const attackerValue = 'attacker-owned-record';
    const registry = new CodexThreadRegistry({ rootDir });
    registry.save({
      sessionKey,
      threadId: 'thread_old',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });
    const racingRegistry = new CodexThreadRegistry({
      rootDir,
      fileSystem: {
        unlink(target, validateBoundary) {
          validateBoundary();
          unlinkSync(target);
          renameSync(rootDir, displacedRoot);
          mkdirSync(rootDir, { mode: 0o700 });
          writeFileSync(destination, attackerValue, { mode: 0o600 });
        },
      },
    });

    expect(() => racingRegistry.remove(sessionKey)).toThrow(/identity changed/i);
    expect(readFileSync(destination, 'utf8')).toBe(attackerValue);
  });

  it('rejects a symlinked trusted parent boundary', () => {
    const baseDir = makeTemporaryDirectory();
    const actualParent = join(baseDir, 'actual-parent');
    const linkedParent = join(baseDir, 'linked-parent');
    mkdirSync(actualParent, { mode: 0o700 });
    symlinkSync(actualParent, linkedParent);

    expect(() => new CodexThreadRegistry({ rootDir: join(linkedParent, 'threads') })).toThrow(
      /parent.*symbolic link/i
    );
  });

  it.skipIf(process.platform === 'win32')('rejects a writable parent trust boundary', () => {
    const parentDir = makeTemporaryDirectory();
    chmodSync(parentDir, 0o777);

    expect(() => new CodexThreadRegistry({ rootDir: join(parentDir, 'threads') })).toThrow(
      /parent.*group\/world writable/i
    );
  });

  it.skipIf(process.platform === 'win32')('rejects a parent owned by an untrusted UID', () => {
    const parentDir = makeTemporaryDirectory();
    const actualUserId = process.getuid?.() ?? 1_000;
    const untrustedOwnerId = actualUserId === 1_234 ? 4_321 : 1_234;
    const withUntrustedOwner = (stats: ReturnType<typeof lstatSync>) =>
      new Proxy(stats, {
        get(target, property) {
          return property === 'uid' ? untrustedOwnerId : Reflect.get(target, property, target);
        },
      });

    expect(
      () =>
        new CodexThreadRegistry({
          rootDir: join(parentDir, 'threads'),
          fileSystem: {
            userId: () => actualUserId,
            stat(descriptor) {
              return withUntrustedOwner(fstatSync(descriptor));
            },
            lstat(path) {
              const stats = lstatSync(path, { throwIfNoEntry: false });
              return stats === undefined ? undefined : withUntrustedOwner(stats);
            },
          },
        })
    ).toThrow(/parent.*owner/i);
  });

  it('narrowly ignores unsupported directory fsync errors on Windows', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    let fileSyncs = 0;
    const registry = new CodexThreadRegistry({
      rootDir,
      platform: 'win32',
      fileSystem: {
        sync(descriptor) {
          if (fstatSync(descriptor).isDirectory()) {
            throw Object.assign(new Error('directory sync unsupported'), { code: 'EINVAL' });
          }
          fileSyncs += 1;
          fsyncSync(descriptor);
        },
      },
    });

    registry.save({
      sessionKey: 'discord:windows-directory-sync',
      threadId: 'thread_durable',
      model: 'gpt-5.4',
      cwd: '/workspace',
      systemPromptFingerprint: fingerprintText('rules'),
      mcpConfigFingerprint: fingerprintText('{}'),
    });

    expect(fileSyncs).toBe(1);
  });

  it('propagates unexpected directory fsync errors on Windows', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const syncError = Object.assign(new Error('unexpected directory sync failure'), {
      code: 'EIO',
    });

    expect(
      () =>
        new CodexThreadRegistry({
          rootDir,
          platform: 'win32',
          fileSystem: {
            sync() {
              throw syncError;
            },
          },
        })
    ).toThrow(syncError);
  });

  it('rejects a symlinked registry directory', () => {
    const parentDir = makeTemporaryDirectory();
    const targetDir = join(parentDir, 'target');
    const rootDir = join(parentDir, 'threads');
    mkdirSync(targetDir, { mode: 0o700 });
    symlinkSync(targetDir, rootDir);

    expect(() => new CodexThreadRegistry({ rootDir })).toThrow(/symbolic link/i);
  });

  it('rejects a symlinked record', () => {
    const parentDir = makeTemporaryDirectory();
    const rootDir = join(parentDir, 'threads');
    const outsideRecord = join(parentDir, 'outside.json');
    const sessionKey = 'discord:symlink';
    mkdirSync(rootDir, { mode: 0o700 });
    writeFileSync(outsideRecord, JSON.stringify(makeRecord(sessionKey)), { mode: 0o600 });
    symlinkSync(outsideRecord, recordPath(rootDir, sessionKey));

    expect(() => new CodexThreadRegistry({ rootDir }).load(sessionKey)).toThrow(/symbolic link/i);
    expect(readFileSync(outsideRecord, 'utf8')).toContain(sessionKey);
  });

  it('returns undefined only when no record exists', () => {
    const rootDir = join(makeTemporaryDirectory(), 'threads');
    const registry = new CodexThreadRegistry({ rootDir });

    expect(registry.load('discord:missing')).toBeUndefined();
  });

  it.each(['load', 'remove'] as const)(
    'does not treat a missing record as absence when the registry boundary changed during %s',
    (operation) => {
      const parentDir = makeTemporaryDirectory();
      const rootDir = join(parentDir, 'threads');
      const displacedRoot = join(parentDir, 'displaced-threads');
      const sessionKey = `discord:missing-boundary-${operation}`;
      const path = recordPath(rootDir, sessionKey);
      let armed = false;
      let swapped = false;
      const registry = new CodexThreadRegistry({
        rootDir,
        fileSystem: {
          lstat(candidatePath) {
            if (armed && candidatePath === path && !swapped) {
              swapped = true;
              renameSync(rootDir, displacedRoot);
              mkdirSync(rootDir, { mode: 0o700 });
              return undefined;
            }
            return lstatSync(candidatePath, { throwIfNoEntry: false });
          },
        },
      });
      armed = true;

      expect(() => registry[operation](sessionKey)).toThrow(/identity changed/i);
      expect(swapped).toBe(true);
    }
  );
});

describe('fingerprintText', () => {
  it('returns a deterministic SHA-256 digest', () => {
    expect(fingerprintText('rules')).toBe(
      '6c621d1a05138a7888d37d9269a9da8e2e11e4aced2f6cfd24b05ab1b9e61bb0'
    );
    expect(fingerprintText('rules')).toBe(fingerprintText('rules'));
    expect(fingerprintText('rules')).not.toBe(fingerprintText('Rules'));
  });
});
