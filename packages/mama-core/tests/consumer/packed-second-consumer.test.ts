/**
 * C6 (plan W3, W4): a second consumer unpacks mama-core in a temporary directory and
 * writes, revises, links, reads and searches its own records through public exports only.
 *
 * The archive's conformance package depended on the core through a workspace link, so it never
 * met the published package: its files list or its exports map. Here the tarball is
 * unpacked outside the repository, with existing dependencies linked for an offline run.
 * Node's exports map refuses any private subpath,
 * and the consumer runs with no MAMA setting and a home directory of its own. It keeps no vectors:
 * it writes with embedder: null and searches with an embedder that answers null, so the model must
 * never load (on this install its first search used to start a model download).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const CONSUMER_FIXTURE = fileURLToPath(new URL('../fixtures/second-consumer', import.meta.url));

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  try {
    // Synchronous, so the test timeout cannot stop it: each step carries its own.
    return execFileSync(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 240_000,
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `${command} ${args.join(' ')} failed: ${failed.message}\n${failed.stdout ?? ''}\n${failed.stderr ?? ''}`
    );
  }
}

describe('a second consumer of the packed core', () => {
  it('writes, revises, links, reads and searches its own records through public exports only', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-second-consumer-'));
    try {
      // npm pack ships what the files list names: dist, which the core suite builds first.
      run('npm', ['pack', '--pack-destination', root], CORE_DIR, process.env);
      const tarball = readdirSync(root).find((name) => name.endsWith('.tgz'));
      expect(tarball).toBeDefined();
      const app = join(root, 'app');
      cpSync(CONSUMER_FIXTURE, app, { recursive: true });
      const packedCore = join(root, 'packed-core');
      mkdirSync(packedCore);
      run(
        'tar',
        ['-xzf', join(root, tarball!), '-C', packedCore, '--strip-components=1'],
        root,
        process.env
      );
      // Only dependencies are linked. The core executed below comes from the tarball.
      symlinkSync(join(CORE_DIR, 'node_modules'), join(packedCore, 'node_modules'), 'dir');
      mkdirSync(join(app, 'node_modules', '@jungjaehoon'), { recursive: true });
      symlinkSync(packedCore, join(app, 'node_modules', '@jungjaehoon', 'mama-core'), 'dir');
      const modelCache = join(
        realpathSync(join(CORE_DIR, 'node_modules', '@huggingface', 'transformers')),
        '.cache'
      );
      const hadModelCache = existsSync(modelCache);

      const home = join(root, 'home');
      mkdirSync(home);
      // A real consumer sets no MAMA variable and has a home of its own.
      const consumer = spawnSync('node', ['consumer.mjs'], {
        cwd: app,
        env: { PATH: process.env.PATH, HOME: home },
        encoding: 'utf8',
        // A model download would run for minutes; the consumer needs seconds.
        timeout: 60_000,
      });
      if (consumer.status !== 0)
        throw new Error(
          `consumer failed (${consumer.signal ?? consumer.status}):\n${consumer.stdout}\n${consumer.stderr}`
        );
      const result = JSON.parse(consumer.stdout.trim().split('\n').at(-1)!) as {
        ownTable: boolean;
        foreignTables: string[];
        scopeKinds: string[];
        judgment: string;
        revision: number;
        status: string;
        latestRecord: string;
        revisedRecord: string;
        linkId: string;
        graphEdges: Array<{ relation: string; from: string; to: string }>;
        findingId: string;
        otherId: string;
        searchHits: string[];
        searchMs: number;
        privatePath: string;
        role: string;
        roleMember: string;
        memberId: string;
        commonIdentityCount: number;
        scopeMove: { records: { checkpoints: number } };
        movedRecordVisible: boolean;
      };

      expect(result.ownTable).toBe(true);
      expect(result.foreignTables).toEqual([]);
      expect(result.scopeKinds).toEqual(['user', 'workbench']);
      expect(result.judgment).toBe('committed');
      expect(result.revision).toBe(2);
      expect(result.status).toBe('done');
      expect(result.latestRecord).toBe(result.revisedRecord);
      expect(result.linkId).toMatch(/^link_/);
      expect(result.graphEdges).toContainEqual({
        relation: 'builds_on',
        from: result.revisedRecord,
        to: result.findingId,
      });
      // Search finds the record under the consumer's scope and not the one under another.
      expect(result.searchHits).toContain(result.findingId);
      expect(result.searchHits).not.toContain(result.otherId);
      expect(result.searchMs).toBeLessThan(5_000);
      // The core's embedding model never loaded: no load notice, and no model cache was created.
      expect(`${consumer.stdout}${consumer.stderr}`).not.toContain('Loading embedding model');
      expect(existsSync(modelCache)).toBe(hadModelCache);
      expect(result.privatePath).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
      expect(result.role).toBe('bench-reviewer');
      expect(result.roleMember).toBe(result.memberId);
      expect(result.commonIdentityCount).toBe(0);
      expect(result.scopeMove.records.checkpoints).toBe(1);
      expect(result.movedRecordVisible).toBe(true);
      // The core wrote nothing into the consumer's home.
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
