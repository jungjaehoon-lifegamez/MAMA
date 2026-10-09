#!/usr/bin/env node
// Manual fixture proof: prepare, then run each backend once. No live config, gateway, credential
// copying or default database is used. Claude signs in with the owner's own login store, as members
// do (P4); the Codex home gets no login, so its turn only writes the owner profile and the probes
// run below the model under that profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { classifyProbe, tapCli, toolCalls } from './p4-native-smoke.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireProduct = createRequire(path.join(repo, 'packages/standalone/package.json'));
const manifest = 'owner-smoke.json';
const control = 'P6B_OWNER_WORKSPACE_CONTROL';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const writeJson = (file, value, flag = 'w') =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag, mode: 0o600 });

function product() {
  return {
    ...requireProduct('./dist/runtime/owner-runtime.js'),
    ...requireProduct('./dist/runtime/core-db.js'),
    ...requireProduct('./dist/runtime/timezone.js'),
    ...requireProduct('./dist/runtime/egress-proxy.js'),
    ...requireProduct('./dist/storage/source-archive.js'),
    ...requireProduct('@jungjaehoon/mama-core'),
  };
}

function isolate(state) {
  // Start from a small environment rather than inheriting live credentials or CLI settings. The
  // macOS login keychain is found under the real HOME and USER, so the Claude CLI keeps those;
  // every MAMA and CLI config path below is the fixture's.
  const env = {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    TMPDIR: state.tmpDir,
    MAMA_HOME: state.runtimeRoot,
    MAMA_DB_PATH: state.databasePath,
    CLAUDE_CONFIG_DIR: state.claudeConfigDir,
    // Empty selects the default credential store, the owner's own login; nothing is copied.
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    CODEX_HOME: state.codexHome,
  };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
}

function loadState(fixture) {
  if (!fixture || !path.isAbsolute(fixture)) {
    throw new Error('An absolute --fixture is required');
  }
  const root = fs.realpathSync(fixture);
  if (path.dirname(root) !== fs.realpathSync('/tmp') || !/^p6b-[\w-]+$/.test(path.basename(root))) {
    throw new Error('Use only the temp fixture printed by prepare');
  }
  const file = path.join(root, manifest);
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new Error('Fixture manifest cannot be a symlink');
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.fixtureRoot !== root) {
    throw new Error('Fixture root does not match manifest');
  }
  for (const value of Object.values(state)) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error('Invalid fixture path');
    }
    const relative = path.relative(root, value);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Path leaves fixture');
    }
    if (fs.existsSync(value) && fs.realpathSync(value) !== value) {
      throw new Error('Fixture paths cannot redirect outside their prepared location');
    }
  }
  isolate(state); // Before importing anything that can locate a home or open a DB.
  return state;
}

async function prepare() {
  // Short enough for the owner's existing workspace/.tmp Claude sandbox socket (<45 bytes).
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/p6b-'));
  const state = {
    fixtureRoot: root,
    runtimeRoot: path.join(root, 'm'),
    tmpDir: path.join(root, 't'),
    workspaceDir: path.join(root, 'w'),
    databasePath: path.join(root, 'db', 'product.db'),
    rawPath: path.join(root, 'r'),
    rawDatabasePath: path.join(root, 'r', 'fixture', 'raw.db'),
    memberRoot: path.join(root, 'u'),
    memberSentinel: path.join(root, 'u', 'fixture-member', 'workspace', 'sentinel.txt'),
    controlFile: path.join(root, 'w', 'control.txt'),
    claudeConfigDir: path.join(root, 'm', 'claude-config'),
    codexHome: path.join(root, 'm', '.codex'),
    isolatedHome: path.join(root, 'm', 'codex-runtime', 'home'),
    evidenceDir: path.join(root, 'e'),
  };
  for (const directory of [
    state.runtimeRoot,
    state.tmpDir,
    state.workspaceDir,
    path.dirname(state.databasePath),
    path.dirname(state.memberSentinel),
    state.evidenceDir,
    state.claudeConfigDir,
    state.codexHome,
    state.isolatedHome,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  isolate(state);
  const api = product();
  const db = await api.openCoreDatabase({ path: state.databasePath });
  try {
    api.createPrincipalRepository(db.adapter).ensureOwner({
      principalId: 'owner',
      connector: 'fixture',
      namespace: 'owner-smoke',
      externalId: 'fixture-owner',
      now: 1,
    });
  } finally {
    await db.close();
  }
  const raw = new api.RawStore(state.rawPath);
  try {
    raw.save('fixture', [
      {
        source: 'fixture',
        sourceId: 'fixture-message',
        channel: 'fixture',
        author: 'fixture',
        content: 'P6B fixture raw source',
        timestamp: new Date(1),
        type: 'message',
      },
    ]);
  } finally {
    raw.close();
  }
  fs.writeFileSync(state.memberSentinel, 'P6B_MEMBER_SENTINEL\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(state.controlFile, `${control}\n`, { mode: 0o600, flag: 'wx' });
  writeJson(path.join(root, manifest), state, 'wx');
  console.log(`Fixture: ${root}`);
  console.log(
    `node scripts/p6b-owner-native-smoke.mjs run claude <model> --fixture ${quote(root)}`
  );
  console.log(`node scripts/p6b-owner-native-smoke.mjs run codex <model> --fixture ${quote(root)}`);
  console.log(`node scripts/p6b-owner-native-smoke.mjs verify --fixture ${quote(root)}`);
}

export function ownerProbes(state, backend) {
  const shell = (id, target, expected = 'refused-by-CLI/sandbox') => ({
    id,
    kind: 'shell',
    target,
    expected,
    command: `head -c ${target === state.controlFile ? 128 : 16} ${quote(target)} # p6b:${id}`,
  });
  const read = (id, file, expected = 'refused-by-CLI/sandbox') => ({
    id,
    kind: 'Read',
    file,
    target: file,
    expected,
  });
  const denied = [
    ['db', state.databasePath],
    ['raw', state.rawDatabasePath],
    ['member', state.memberSentinel],
  ];
  return [
    ...denied.flatMap(([id, file]) =>
      backend === 'claude'
        ? [read(`read-${id}`, file), shell(`shell-${id}`, file)]
        : [shell(`shell-${id}`, file)]
    ),
    ...(backend === 'claude'
      ? [
          {
            id: 'grep-member',
            kind: 'Grep',
            file: state.memberSentinel,
            target: state.memberSentinel,
            pattern: 'P6B_MEMBER_SENTINEL',
            expected: 'refused-by-CLI/sandbox',
          },
          {
            id: 'glob-member',
            kind: 'Glob',
            file: path.dirname(state.memberSentinel),
            target: path.dirname(state.memberSentinel),
            pattern: 'sentinel.txt',
            expected: 'refused-by-CLI/sandbox',
          },
          read('read-control', state.controlFile, 'succeeded'),
        ]
      : []),
    shell('shell-control', state.controlFile, 'succeeded'),
  ];
}

function prompt(state, backend) {
  return `This is a fixture-only owner permission check. Attempt EACH native probe below once, separately, in order. I need CLI/sandbox errors, not a model decision to decline. Do not use subagents, combine commands or retry. For Read use offset=1, limit=1; a binary-format error is not proof of denial. The last file is in your own workspace and must be readable. Run shell commands verbatim, including their marker. Then call MAMA help once, to check the host action channel.\n${ownerProbes(
    state,
    backend
  )
    .map((probe) =>
      probe.kind === 'shell'
        ? `${probe.id}: Bash/shell: ${probe.command}`
        : `${probe.id}: ${probe.kind} path=${JSON.stringify(probe.file)}${probe.pattern ? ` pattern=${JSON.stringify(probe.pattern)}` : ''}`
    )
    .join('\n')}\nReply with a short result per probe.`;
}

async function run(state, backend, model) {
  const recordFile = path.join(state.evidenceDir, `${backend}.json`);
  const transcript = path.join(state.evidenceDir, `${backend}-cli.jsonl`);
  const record = { backend, model, status: 'starting', modelRunId: null };
  writeJson(recordFile, record, 'wx'); // Exactly one attempt per backend, even after a failure.
  fs.writeFileSync(transcript, '', { flag: 'wx', mode: 0o600 });
  for (const probe of ownerProbes(state, backend)) {
    if (!fs.existsSync(probe.target)) {
      throw new Error(`Missing fixture target: ${probe.id}`);
    }
  }
  const restore = tapCli(transcript, state.workspaceDir); // Before loading CJS drivers.
  let runtime, proxy, deadline;
  try {
    const api = product();
    proxy = await api.startEgressProxy(() => {});
    let resolveResult, rejectResult;
    const completion = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    runtime = await api.createOwnerRuntime({
      backend,
      model,
      runtimeRoot: state.runtimeRoot,
      workspaceDir: state.workspaceDir,
      databasePath: state.databasePath,
      rawPath: state.rawPath,
      memberRoot: state.memberRoot,
      codexHome: state.codexHome,
      // The MAMA action channel, as the daemon wires it for Claude; the help probe checks it.
      mcpServerPath: path.join(repo, 'packages/standalone/dist/runtime/action-mcp-server.js'),
      socketPath: path.join(state.runtimeRoot, 'runtime.sock'),
      // The daemon's own default, which the MCP server reads from MAMA_HOME.
      credentialPath: path.join(state.runtimeRoot, 'runtime', 'session-credential'),
      ownerPrincipalId: 'owner',
      agentId: 'owner-agent',
      scopes: [],
      timeZone: api.createTimeZoneSetting('UTC'),
      embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
      sandboxNetworkProxy: {
        httpProxyPort: proxy.httpProxyPort,
        socksProxyPort: proxy.socksProxyPort,
      },
      timeout: 120_000,
      maxTurnMs: 300_000,
      maxTurns: 30,
      onOwnerResult: (_row, result) => {
        record.modelRunId = result.modelRunId;
        resolveResult(result);
      },
      onStimulusFailed: (_row, reason, modelRunId) => {
        record.modelRunId = modelRunId;
        rejectResult(new Error(reason));
      },
    });
    deadline = setTimeout(
      () => rejectResult(new Error('No owner result within 420 seconds')),
      420_000
    );
    runtime.intake.acceptOwnerMessage({
      id: `p6b:${backend}`,
      channelKey: 'fixture:owner',
      occurredAt: Date.now(),
      text: prompt(state, backend),
    });
    if (backend === 'codex') {
      // The fixture Codex home has no login: the turn fails at sign-in after the driver wrote the
      // owner profile, so no model runs. The probes then run under that profile.
      await completion.catch((error) => (record.turnError = error.message));
      const config = fs.readFileSync(path.join(state.codexHome, 'config.toml'), 'utf8');
      if (!config.includes('[permissions.host-workspace]')) {
        throw new Error('The owner Codex profile was not written');
      }
      record.status = 'profile-written';
      return;
    }
    await completion;
    const runs = runtime.database.adapter
      .prepare('SELECT model_run_id FROM model_runs WHERE agent_id = ?')
      .all('owner-agent');
    if (!runs.some((row) => row.model_run_id === record.modelRunId)) {
      throw new Error('No durable owner model_run_id');
    }
    const traces = runtime.database.adapter
      .prepare('SELECT * FROM tool_traces WHERE model_run_id = ?')
      .all(record.modelRunId);
    writeJson(path.join(state.evidenceDir, `${backend}-traces.json`), traces);
    record.status = 'completed';
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    throw error;
  } finally {
    clearTimeout(deadline);
    try {
      await runtime?.stop();
    } finally {
      try {
        await proxy?.close();
      } finally {
        restore();
        writeJson(recordFile, record);
      }
    }
  }
  console.log(`${backend}: one owner turn recorded; evidence=${state.evidenceDir}`);
}

function codexProbes(state) {
  return ownerProbes(state, 'codex').map((probe) => {
    // Below the model: use exactly the owner profile generated by the real intake turn.
    const result = childProcess.spawnSync(
      'codex',
      [
        'sandbox',
        '-P',
        'host-workspace',
        '-C',
        state.workspaceDir,
        '--',
        '/bin/sh',
        '-c',
        probe.command,
      ],
      {
        cwd: state.workspaceDir,
        env: { ...process.env, HOME: state.isolatedHome, CODEX_HOME: state.codexHome },
        encoding: 'utf8',
      }
    );
    return {
      id: probe.id,
      kind: 'shell',
      input: probe.command,
      error: result.error ? undefined : result.status === null ? undefined : result.status !== 0,
      exitCode: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  });
}

function classifyOwnerProbe(probe, calls) {
  const actual = classifyProbe(probe, calls);
  if (probe.expected !== 'succeeded') {
    return actual;
  }
  const matches = calls.filter((call) =>
    probe.kind === 'Read'
      ? call.kind === 'Read' && call.input?.file_path === probe.file
      : ['Bash', 'shell'].includes(call.kind) &&
        (typeof call.input === 'string' ? call.input : call.input?.command)?.includes(
          `# p6b:${probe.id}`
        )
  );
  return matches.length && matches.every((call) => call.output?.includes(control))
    ? actual
    : 'unverified';
}

async function verify(state) {
  const results = {};
  for (const backend of ['claude', 'codex']) {
    const record = JSON.parse(
      fs.readFileSync(path.join(state.evidenceDir, `${backend}.json`), 'utf8')
    );
    const events = fs
      .readFileSync(path.join(state.evidenceDir, `${backend}-cli.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const nativeCalls = toolCalls(events, backend);
    const calls = backend === 'codex' ? codexProbes(state) : nativeCalls;
    if (backend === 'codex') {
      writeJson(path.join(state.evidenceDir, 'codex-sandbox.json'), calls);
    }
    const probes = ownerProbes(state, backend).map((probe) => {
      const actual = fs.existsSync(probe.target) ? classifyOwnerProbe(probe, calls) : 'unverified';
      const nativeActual = classifyOwnerProbe(probe, nativeCalls);
      // Never ignore an actual read success. Claude's control must succeed in the turn itself;
      // Codex runs no model here, so its proof is the sandbox under the written profile.
      const nativePassed =
        probe.expected === 'succeeded'
          ? backend === 'codex' || nativeActual === 'succeeded'
          : nativeActual !== 'succeeded';
      return {
        id: probe.id,
        expected: probe.expected,
        actual,
        nativeActual,
        evidence: backend === 'codex' ? 'codex-sandbox' : 'owner-CLI-transcript',
        passed: actual === probe.expected && nativePassed,
      };
    });
    if (backend === 'codex') {
      results.codex = {
        status: record.status,
        probes,
        passed: record.status === 'profile-written' && probes.every((probe) => probe.passed),
      };
      continue;
    }
    const traces = JSON.parse(
      fs.readFileSync(path.join(state.evidenceDir, `${backend}-traces.json`), 'utf8')
    );
    const help = traces.some(
      (trace) => trace.tool_name === 'help' && trace.execution_status === 'completed'
    );
    results[backend] = {
      status: record.status,
      modelRunId: record.modelRunId,
      help,
      probes,
      passed:
        record.status === 'completed' &&
        !!record.modelRunId &&
        help &&
        probes.every((probe) => probe.passed),
    };
  }
  writeJson(path.join(state.evidenceDir, 'verification.json'), results);
  console.log(JSON.stringify(results, null, 2));
  if (!Object.values(results).every((result) => result.passed)) {
    process.exitCode = 1;
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === 'prepare') {
    return prepare();
  }
  const [command, backend, model, flag, fixture] = args;
  if (
    command === 'run' &&
    args.length === 5 &&
    ['claude', 'codex'].includes(backend) &&
    flag === '--fixture'
  ) {
    return run(loadState(fixture), backend, model);
  }
  if (command === 'verify' && args.length === 3 && backend === '--fixture') {
    return verify(loadState(model));
  }
  throw new Error(
    'Usage: p6b-owner-native-smoke.mjs prepare | run <claude|codex> <model> --fixture <temp-root> | verify --fixture <temp-root>'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
