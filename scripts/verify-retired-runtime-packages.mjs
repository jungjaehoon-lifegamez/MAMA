import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'mama-retired-runtime-packages-'));
const archiveRoot = join(tempRoot, 'archives');
const installRoot = join(tempRoot, 'installed');
const stateRoot = join(tempRoot, 'state');
const tempWorkRoot = join(tempRoot, 'tmp');
const npmUserConfig = join(tempRoot, 'npmrc');
const staleClient = join(REPOSITORY_ROOT, 'packages/mama-core/dist/embedding-client.js');
const staleServer = join(
  REPOSITORY_ROOT,
  'packages/mama-core/dist/embedding-server/mobile/websocket-handler.js'
);
const sentinelDirectories = [
  dirname(staleServer),
  dirname(dirname(staleServer)),
  dirname(staleClient),
];

const inheritedEnvironmentNames = [
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
];

function createChildEnvironment() {
  const environment = {};
  for (const name of inheritedEnvironmentNames) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  assert.ok(environment.PATH, 'PATH is required for package verification');
  return {
    ...environment,
    TMPDIR: tempWorkRoot,
    TEMP: tempWorkRoot,
    TMP: tempWorkRoot,
    XDG_CONFIG_HOME: join(tempRoot, 'xdg-config'),
    XDG_CACHE_HOME: join(tempRoot, 'xdg-cache'),
    XDG_DATA_HOME: join(tempRoot, 'xdg-data'),
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    NPM_CONFIG_CACHE: join(tempRoot, 'npm-cache'),
    PNPM_HOME: join(tempRoot, 'pnpm-home'),
    COREPACK_HOME: join(tempRoot, 'corepack-home'),
    MAMA_DB_PATH: join(stateRoot, 'memory.db'),
    MAMA_DATABASE_PATH: join(stateRoot, 'sessions.db'),
    MAMA_SECURITY_LOG_DIR: join(tempRoot, 'security'),
    HF_HOME: join(tempRoot, 'model-cache'),
    TRANSFORMERS_CACHE: join(tempRoot, 'model-cache'),
    CI: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
  };
}

function snapshotFile(path) {
  return existsSync(path) ? { existed: true, bytes: readFileSync(path) } : { existed: false };
}

function restoreFile(path, snapshot) {
  if (snapshot.existed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, snapshot.bytes);
    return;
  }
  rmSync(path, { force: true });
}

function removeNewEmptyDirectories(directorySnapshots) {
  for (const { path, existed } of directorySnapshots) {
    if (existed || !existsSync(path) || readdirSync(path).length > 0) {
      continue;
    }
    rmdirSync(path);
  }
}

function verifyCleanupHelpers() {
  const proofRoot = join(tempRoot, 'cleanup-proof');
  const existing = join(proofRoot, 'existing', 'sentinel.js');
  const absent = join(proofRoot, 'absent', 'nested', 'sentinel.js');
  const priorBytes = Buffer.from('prior sentinel bytes\n');
  mkdirSync(dirname(existing), { recursive: true });
  writeFileSync(existing, priorBytes);

  const existingSnapshot = snapshotFile(existing);
  writeFileSync(existing, 'overwritten\n');
  restoreFile(existing, existingSnapshot);
  assert.deepEqual(readFileSync(existing), priorBytes);

  const absentDirectories = [dirname(absent), dirname(dirname(absent))].map((path) => ({
    path,
    existed: existsSync(path),
  }));
  const absentSnapshot = snapshotFile(absent);
  mkdirSync(dirname(absent), { recursive: true });
  writeFileSync(absent, 'temporary\n');
  restoreFile(absent, absentSnapshot);
  removeNewEmptyDirectories(absentDirectories);
  assert.equal(existsSync(absent), false);
  assert.equal(existsSync(dirname(absent)), false);
}

let childEnvironment;
let staleClientSnapshot;
let staleServerSnapshot;
let sentinelDirectorySnapshots;

function run(command, args, cwd = REPOSITORY_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnvironment,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.slice(-4_000);
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)}):\n${output}`);
  }
  return result.stdout;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packageRoot(name) {
  return join(installRoot, 'node_modules', ...name.split('/'));
}

function listFiles(root, relative = '') {
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = join(relative, entry.name);
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function pack(relativePackageRoot) {
  const output = run('pnpm', [
    '--dir',
    relativePackageRoot,
    'pack',
    '--json',
    '--pack-destination',
    archiveRoot,
  ]);
  return JSON.parse(output).filename;
}

try {
  childEnvironment = createChildEnvironment();
  staleClientSnapshot = snapshotFile(staleClient);
  staleServerSnapshot = snapshotFile(staleServer);
  sentinelDirectorySnapshots = sentinelDirectories.map((path) => ({
    path,
    existed: existsSync(path),
  }));

  mkdirSync(archiveRoot, { recursive: true });
  mkdirSync(installRoot, { recursive: true });
  for (const path of [
    stateRoot,
    tempWorkRoot,
    childEnvironment.XDG_CONFIG_HOME,
    childEnvironment.XDG_CACHE_HOME,
    childEnvironment.XDG_DATA_HOME,
    childEnvironment.NPM_CONFIG_CACHE,
    childEnvironment.PNPM_HOME,
    childEnvironment.COREPACK_HOME,
    childEnvironment.MAMA_SECURITY_LOG_DIR,
    childEnvironment.HF_HOME,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(npmUserConfig, '');
  verifyCleanupHelpers();

  mkdirSync(dirname(staleServer), { recursive: true });
  writeFileSync(staleClient, 'throw new Error("stale embedding client");\n');
  writeFileSync(staleServer, 'throw new Error("stale embedding server");\n');

  run('pnpm', ['--dir', 'packages/mama-core', 'build']);
  assert.equal(existsSync(staleClient), false, 'core build retained a stale embedding client');
  assert.equal(existsSync(staleServer), false, 'core build retained a stale embedding server');

  const archives = [
    pack('packages/mama-core'),
    pack('packages/mcp-server'),
    pack('packages/standalone'),
    pack('packages/claude-code-plugin'),
  ];
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', ...archives],
    installRoot
  );

  const coreRoot = packageRoot('@jungjaehoon/mama-core');
  const corePackage = readJson(join(coreRoot, 'package.json'));
  assert.equal(corePackage.exports['./embeddings'], './dist/embeddings.js');
  assert.equal(corePackage.exports['./embedding-client'], undefined);
  assert.equal(corePackage.exports['./embedding-server'], undefined);
  for (const [subpath, target] of Object.entries({
    './registry/types': './dist/registry/types.js',
    './registry/store': './dist/registry/store.js',
    './registry/record-identity': './dist/registry/record-identity.js',
    './operations/owner-action-effects': './dist/operations/owner-action-effects.js',
  })) {
    assert.equal(corePackage.exports[subpath], target, `missing installed core export: ${subpath}`);
  }
  assert.equal(corePackage.dependencies.ws, undefined);
  assert.equal(corePackage.devDependencies?.['@types/ws'], undefined);
  assert.equal(existsSync(join(coreRoot, 'dist/embedding-client.js')), false);
  assert.equal(existsSync(join(coreRoot, 'dist/embedding-server')), false);
  assert.equal(existsSync(join(coreRoot, 'scripts/clean-dist.mjs')), false);

  const mcpRoot = packageRoot('@jungjaehoon/mama-server');
  const mcpPackage = readJson(join(mcpRoot, 'package.json'));
  const mcpSource = readFileSync(join(mcpRoot, 'src/server.js'), 'utf8');
  assert.doesNotMatch(
    mcpSource,
    /3849|embedding-server|MAMA_MCP_START_HTTP_EMBEDDING|MAMA_SERVER_TOKEN|MAMA_SERVER_PORT|setupLogging/
  );
  assert.equal(existsSync(join(mcpRoot, 'start-http-server.js')), false);

  const osRoot = packageRoot('@jungjaehoon/mama-os');
  const osPackage = readJson(join(osRoot, 'package.json'));
  assert.equal(osPackage.dependencies.ws, undefined);
  assert.equal(osPackage.devDependencies?.['@types/ws'], undefined);
  const retainedOsModules = [
    'dist/api/upload-handler',
    'dist/api/agent-raw-handler',
    'dist/api/graph-api',
    'dist/gateways/telegram',
    'dist/operator/owner-action-effects',
    'dist/agent/code-act/host-bridge',
    'dist/api/report-handler',
    'dist/api/runtime-status-handler',
    'dist/gateways/session-store',
  ];
  for (const modulePath of retainedOsModules) {
    for (const extension of ['js', 'd.ts']) {
      const installedPath = join(osRoot, `${modulePath}.${extension}`);
      assert.equal(
        existsSync(installedPath),
        true,
        `retained installed module missing: ${modulePath}.${extension}`
      );
    }
  }
  const uploadSource = readFileSync(join(osRoot, 'dist/api/upload-handler.js'), 'utf8');
  assert.match(
    uploadSource,
    /function createUploadRouter\(\)\s*\{\s*ensureMediaDirectories\(\);\s*startUploadRateLimitCleanup\(\);/
  );
  const runtimeSource = [
    'dist/cli/commands/start.js',
    'dist/cli/commands/stop.js',
    'dist/cli/runtime/utilities.js',
    'dist/cli/runtime/shutdown.js',
    'dist/cli/runtime/server-start.js',
    'dist/cli/runtime/api-routes-init.js',
    'dist/cli/runtime/metrics-init.js',
    'dist/observability/health-check.js',
  ]
    .map((path) => readFileSync(join(osRoot, path), 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    runtimeSource,
    /3849|EMBEDDING_PORT|startEmbeddingServer|WebSocket upgrade|\/api\/sessions|\/api\/session/
  );
  const pluginRoot = packageRoot('mama-plugin');
  const configure = readFileSync(join(pluginRoot, 'commands/configure.md'), 'utf8');
  assert.doesNotMatch(
    configure,
    /--disable-http|--disable-websocket|--enable-all|--set-auth-token|--generate-token|MAMA_AUTH_TOKEN/
  );
  const precompact = readFileSync(join(pluginRoot, 'scripts/precompact-hook.js'), 'utf8');
  assert.match(precompact, /MAMA_HTTP_PORT\s*\|\|\s*'3847'/);

  const importProbe = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const coreRoot = ${JSON.stringify(coreRoot)};
    const mcpRoot = ${JSON.stringify(mcpRoot)};
    const mcpVersion = ${JSON.stringify(mcpPackage.version)};
    const osRoot = ${JSON.stringify(osRoot)};
    const embeddings = await import(pathToFileURL(coreRoot + '/dist/embeddings.js').href);
    assert.equal(typeof embeddings.generateEmbedding, 'function');
    const core = await import(pathToFileURL(coreRoot + '/dist/index.js').href);
    assert.equal(typeof core.evolveMemory, 'function');
    for (const name of [
      'createNode',
      'upsertNode',
      'resolveAlias',
      'setRecordIdentity',
      'appendOperationToolTrace',
      'verifyOwnerActionContext',
    ]) {
      assert.equal(typeof core[name], 'function', 'missing core root symbol: ' + name);
    }
    const registryTypes = await import('@jungjaehoon/mama-core/registry/types');
    assert.deepEqual(registryTypes.REGISTRY_KINDS, ['item', 'person', 'client']);
    const registryStore = await import('@jungjaehoon/mama-core/registry/store');
    assert.equal(typeof registryStore.createNode, 'function');
    assert.equal(typeof registryStore.resolveAlias, 'function');
    const recordIdentity = await import('@jungjaehoon/mama-core/registry/record-identity');
    assert.equal(typeof recordIdentity.setRecordIdentity, 'function');
    assert.equal(typeof recordIdentity.validateRecordIdentityReferences, 'function');
    const ownerActionEffects = await import(
      '@jungjaehoon/mama-core/operations/owner-action-effects'
    );
    assert.equal(typeof ownerActionEffects.verifyOwnerActionContext, 'function');
    assert.equal(typeof ownerActionEffects.ownerActionOriginMatch, 'function');
    for (const name of ['getServerPort', 'DEFAULT_PORT', 'HOST', 'TIMEOUT_MS']) {
      assert.equal(name in core, false, 'removed core root symbol remains: ' + name);
    }
    const require = createRequire(import.meta.url);
    const mcp = require(mcpRoot + '/src/server.js');
    assert.equal(typeof mcp.MAMAServer, 'function');
    const mcpServer = new mcp.MAMAServer();
    assert.deepEqual(mcpServer.server._serverInfo, {
      name: 'mama-server',
      version: mcpVersion,
    });
    const utilities = await import(pathToFileURL(osRoot + '/dist/cli/runtime/utilities.js').href);
    assert.equal(utilities.API_PORT, 3847);
    assert.deepEqual(utilities.RUNTIME_PORTS, [3847]);
    assert.equal('EMBEDDING_PORT' in utilities, false);
    const runtimeStatus = await import(
      pathToFileURL(osRoot + '/dist/api/runtime-status-handler.js').href
    );
    assert.equal(typeof runtimeStatus.createRuntimeStatusRouter, 'function');
    const reportApi = await import(pathToFileURL(osRoot + '/dist/api/report-handler.js').href);
    assert.equal(typeof reportApi.createReportRouter, 'function');
    const sessionStore = await import(
      pathToFileURL(osRoot + '/dist/gateways/session-store.js').href
    );
    assert.equal(typeof sessionStore.SessionStore, 'function');
    const upload = await import(pathToFileURL(osRoot + '/dist/api/upload-handler.js').href);
    assert.equal(typeof upload.createUploadRouter, 'function');
    const agentRaw = await import(pathToFileURL(osRoot + '/dist/api/agent-raw-handler.js').href);
    assert.equal(typeof agentRaw.createAgentRawRouter, 'function');
    const graph = await import(pathToFileURL(osRoot + '/dist/api/graph-api.js').href);
    assert.equal(typeof graph.createGraphHandler, 'function');
    const telegram = await import(pathToFileURL(osRoot + '/dist/gateways/telegram.js').href);
    assert.equal(typeof telegram.TelegramGateway, 'function');
    const ownerActions = await import(
      pathToFileURL(osRoot + '/dist/operator/owner-action-effects.js').href
    );
    assert.equal(typeof ownerActions.OwnerActionEffectLedger, 'function');
    const hostBridge = await import(
      pathToFileURL(osRoot + '/dist/agent/code-act/host-bridge.js').href
    );
    assert.equal(typeof hostBridge.HostBridge, 'function');
  `;
  run('node', ['--input-type=module', '--eval', importProbe], installRoot);
  for (const [label, path] of [
    ['MAMA state', stateRoot],
    ['model cache', childEnvironment.HF_HOME],
    ['security state', childEnvironment.MAMA_SECURITY_LOG_DIR],
  ]) {
    assert.deepEqual(listFiles(path), [], `${label} changed during import-only probe`);
  }

  process.stdout.write('Retired runtime package verification passed.\n');
} finally {
  try {
    if (staleClientSnapshot && staleServerSnapshot && sentinelDirectorySnapshots) {
      restoreFile(staleClient, staleClientSnapshot);
      restoreFile(staleServer, staleServerSnapshot);
      removeNewEmptyDirectories(sentinelDirectorySnapshots);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
