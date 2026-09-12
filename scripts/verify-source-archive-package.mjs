import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const corePackage = join(repositoryRoot, 'packages', 'mama-core');
const standalonePackage = join(repositoryRoot, 'packages', 'standalone');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mama-source-archive-package-'));

try {
  const packDirectory = join(temporaryRoot, 'pack');
  const consumerDirectory = join(temporaryRoot, 'consumer');
  const importProbeDirectory = join(temporaryRoot, 'import-probe');
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });
  mkdirSync(importProbeDirectory, { recursive: true });

  const staleStandalonePaths = [
    'dist/connectors/framework/raw-store.js',
    'dist/connectors/framework/raw-store.d.ts',
    'dist/db/migrations/raw-item-revisions.js',
    'dist/db/migrations/raw-item-revisions.d.ts',
  ];
  for (const relativePath of staleStandalonePaths) {
    const absolutePath = join(standalonePackage, relativePath);
    mkdirSync(resolve(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, 'stale generated output\n');
  }
  execFileSync('pnpm', ['--filter', '@jungjaehoon/mama-os', 'build'], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  });
  const standalonePackOutput = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', packDirectory],
    { cwd: standalonePackage, encoding: 'utf8' }
  );
  const [standalonePack] = JSON.parse(standalonePackOutput);
  const standaloneFiles = new Set(standalonePack.files.map(({ path }) => path));
  for (const stalePath of staleStandalonePaths) {
    if (standaloneFiles.has(stalePath)) {
      throw new Error(`Standalone package retained deleted generated path: ${stalePath}`);
    }
  }
  const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: corePackage,
    encoding: 'utf8',
  });
  const [{ filename }] = JSON.parse(packOutput);
  const tarball = join(packDirectory, filename);

  execFileSync('npm', ['init', '--yes'], { cwd: consumerDirectory, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: consumerDirectory,
    stdio: 'ignore',
  });

  const installedPackage = join(consumerDirectory, 'node_modules', '@jungjaehoon', 'mama-core');
  const manifest = JSON.parse(readFileSync(join(installedPackage, 'package.json'), 'utf8'));
  if (
    manifest.exports?.['./storage/source-archive'] !== './dist/storage/source-archive.js' ||
    manifest.exports?.['./storage/sqlite'] !== './dist/storage/sqlite.js' ||
    !existsSync(join(installedPackage, 'dist', 'storage', 'migrations', 'raw-item-revisions.js'))
  ) {
    throw new Error('Packed package is missing source archive exports or migration');
  }

  const importProbeProgram = `
    import { readdirSync } from 'node:fs';
    import { createRequire } from 'node:module';
    const snapshot = () => readdirSync('.', { recursive: true }).map(String).sort();
    const before = snapshot();
    const require = createRequire(${JSON.stringify(join(consumerDirectory, 'package.json'))});
    const sourceArchive = require('@jungjaehoon/mama-core/storage/source-archive');
    const sqlite = require('@jungjaehoon/mama-core/storage/sqlite');
    if (typeof sourceArchive.RawStore !== 'function' || typeof sqlite.default !== 'function') {
      throw new Error('Import-only probe did not load storage exports');
    }
    const after = snapshot();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Storage import created files in the empty probe directory');
    }
    const forbidden = Object.keys(require.cache).filter((path) =>
      /(?:embedding|transformers|standalone[\\/](?:dist|src)[\\/](?:agent|cli|gateways))/.test(path)
    );
    if (forbidden.length > 0) {
      throw new Error('Storage import loaded model or runtime modules');
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', importProbeProgram], {
    cwd: importProbeDirectory,
    env: {
      ...process.env,
      MAMA_DB_PATH: join(importProbeDirectory, 'state', 'memory.db'),
      MAMA_DATABASE_PATH: join(importProbeDirectory, 'state', 'database.db'),
      HF_HOME: join(importProbeDirectory, 'cache', 'hf'),
      TRANSFORMERS_CACHE: join(importProbeDirectory, 'cache', 'transformers'),
    },
    stdio: 'inherit',
    timeout: 5_000,
  });

  const roots = [join(temporaryRoot, 'archive-one'), join(temporaryRoot, 'archive-two')];
  const verificationProgram = `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const { RawStore } = require('@jungjaehoon/mama-core/storage/source-archive');
    const { default: Database } = require('@jungjaehoon/mama-core/storage/sqlite');
    if (typeof RawStore !== 'function' || typeof Database !== 'function') {
      throw new Error('Packed storage modules did not expose their implementations');
    }
    const [firstRoot, secondRoot] = ${JSON.stringify(roots)};
    const makeItem = (sourceId, content) => ({
      source: 'example', sourceId, sourceEntityId: sourceId,
      channel: 'example-channel', author: 'example-author', content,
      timestamp: new Date('2026-01-01T00:00:00.000Z'), type: 'document',
    });
    const first = new RawStore(firstRoot);
    first.save('example', [makeItem('item-one', 'first archive')]);
    first.close();
    const reopened = new RawStore(firstRoot);
    const reopenedItems = reopened.query('example', new Date(0));
    reopened.close();
    const second = new RawStore(secondRoot);
    second.save('example', [makeItem('item-two', 'second archive')]);
    const isolatedItems = second.query('example', new Date(0));
    second.close();
    if (
      reopenedItems.length !== 1 || reopenedItems[0]?.sourceId !== 'item-one' ||
      reopenedItems[0]?.content !== 'first archive' || reopenedItems[0]?.type !== 'document' ||
      !(reopenedItems[0]?.timestamp instanceof Date)
    ) {
      throw new Error('Packed source archive did not preserve close and reopen behavior');
    }
    if (
      isolatedItems.length !== 1 || isolatedItems[0]?.sourceId !== 'item-two' ||
      isolatedItems[0]?.content !== 'second archive' || isolatedItems[0]?.type !== 'document' ||
      !(isolatedItems[0]?.timestamp instanceof Date)
    ) {
      throw new Error('Packed source archive did not isolate storage roots');
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', verificationProgram], {
    cwd: consumerDirectory,
    stdio: 'inherit',
  });

  process.stdout.write('Packed source archive verification passed\n');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
