/**
 * C6 without search (plan W3): a second consumer installs the packed mama-core in a temporary
 * directory and writes, revises, links and reads its own records through public exports only.
 *
 * The archive's conformance package depended on the core through a workspace link, so it never
 * met the published package: its files list, its exports map or its install. Here the tarball is
 * packed and installed outside the repository, Node's exports map refuses any private subpath,
 * and the consumer runs with no MAMA setting and a home directory of its own. Search waits for
 * W4: recall needs an embedder, which a consumer has to be able to leave out first.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_DIR = new URL('../..', import.meta.url).pathname;
const CONSUMER_FIXTURE = new URL('../fixtures/second-consumer', import.meta.url).pathname;

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `${command} ${args.join(' ')} failed: ${failed.message}\n${failed.stdout ?? ''}\n${failed.stderr ?? ''}`
    );
  }
}

describe('a second consumer of the packed core', () => {
  it('writes, revises, links and reads its own records through public exports only', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-second-consumer-'));
    try {
      // npm pack ships what the files list names: dist, which the core suite builds first.
      run('npm', ['pack', '--pack-destination', root], CORE_DIR, process.env);
      const tarball = readdirSync(root).find((name) => name.endsWith('.tgz'));
      expect(tarball).toBeDefined();
      const app = join(root, 'app');
      cpSync(CONSUMER_FIXTURE, app, { recursive: true });
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({
          name: 'mama-second-consumer',
          private: true,
          type: 'module',
          dependencies: { '@jungjaehoon/mama-core': `file:${join(root, tarball!)}` },
          // pnpm 10 runs no dependency build scripts unless named; without its native binding
          // the first openDatabase fails.
          pnpm: { onlyBuiltDependencies: ['better-sqlite3'] },
        })
      );
      run('pnpm', ['install', '--prefer-offline', '--ignore-workspace'], app, process.env);

      const home = join(root, 'home');
      mkdirSync(home);
      // A real consumer sets no MAMA variable and has a home of its own.
      const output = run('node', ['consumer.mjs'], app, { PATH: process.env.PATH, HOME: home });
      const result = JSON.parse(output.trim().split('\n').at(-1)!) as {
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
        privatePath: string;
      };

      expect(result.ownTable).toBe(true);
      expect(result.foreignTables).toEqual([]);
      expect(result.scopeKinds).toEqual(['workbench']);
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
      expect(result.privatePath).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
      // The core wrote nothing into the consumer's home.
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
