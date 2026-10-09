import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { ownerProbes } from '../../../../scripts/p6b-owner-native-smoke.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

// Run the real verifier with synthetic transcripts and a fake sandbox executable; no model,
// login, product runtime, live config or real Codex executable is invoked.
it.each(['successful-denied-read', 'missing-native-control'])(
  'does not certify a generated Codex profile over a contradictory owner transcript: %s',
  (scenario) => {
    const root = realpathSync(mkdtempSync('/tmp/p6b-'));
    roots.push(root);
    const state = {
      fixtureRoot: root,
      home: join(root, 'h'),
      runtimeRoot: join(root, 'm'),
      tmpDir: join(root, 't'),
      workspaceDir: join(root, 'w'),
      databasePath: join(root, 'db'),
      rawPath: join(root, 'r'),
      rawDatabasePath: join(root, 'r', 'raw.db'),
      memberRoot: join(root, 'u'),
      memberSentinel: join(root, 'u', 'sentinel.txt'),
      controlFile: join(root, 'w', 'control.txt'),
      claudeConfigDir: join(root, 'm', 'claude-config'),
      codexHome: join(root, 'm', '.codex'),
      isolatedHome: join(root, 'm', 'codex-runtime', 'home'),
      evidenceDir: join(root, 'e'),
    };
    for (const dir of [
      state.home,
      state.runtimeRoot,
      state.tmpDir,
      state.workspaceDir,
      state.rawPath,
      state.memberRoot,
      state.claudeConfigDir,
      state.codexHome,
      state.isolatedHome,
      state.evidenceDir,
    ])
      mkdirSync(dir, { recursive: true });
    for (const file of [
      state.databasePath,
      state.rawDatabasePath,
      state.memberSentinel,
      state.controlFile,
    ])
      writeFileSync(file, file === state.controlFile ? 'P6B_OWNER_WORKSPACE_CONTROL' : 'fixture');
    const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
    json(join(root, 'owner-smoke.json'), state);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'codex'),
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in *p6b:shell-control*) echo P6B_OWNER_WORKSPACE_CONTROL; exit 0;; esac
done
echo 'Operation not permitted' >&2
exit 1
`,
      { mode: 0o700 }
    );
    for (const backend of ['claude', 'codex']) {
      json(join(state.evidenceDir, `${backend}.json`), {
        status: 'completed',
        modelRunId: 'fixture-run',
      });
      json(join(state.evidenceDir, `${backend}-traces.json`), [
        { tool_name: 'help', execution_status: 'completed' },
      ]);
      const events = [];
      for (const probe of ownerProbes(state, backend)) {
        const denied = probe.expected !== 'succeeded';
        if (backend === 'claude') {
          events.push({
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: probe.id,
                  name: probe.kind === 'shell' ? 'Bash' : probe.kind,
                  input:
                    probe.kind === 'shell'
                      ? { command: probe.command }
                      : probe.kind === 'Read'
                        ? { file_path: probe.file }
                        : { path: probe.file, pattern: probe.pattern },
                },
              ],
            },
          });
          events.push({
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: probe.id,
                  is_error: denied,
                  content: denied ? 'Permission denied' : 'P6B_OWNER_WORKSPACE_CONTROL',
                },
              ],
            },
          });
        } else if (!(scenario === 'missing-native-control' && !denied)) {
          const succeeded =
            !denied || (scenario === 'successful-denied-read' && probe.id === 'shell-db');
          events.push({
            method: 'item/completed',
            params: {
              item: {
                id: probe.id,
                type: 'commandExecution',
                command: probe.command,
                exitCode: succeeded ? 0 : 1,
                aggregatedOutput: !denied
                  ? 'P6B_OWNER_WORKSPACE_CONTROL'
                  : succeeded
                    ? 'SQLite format 3'
                    : 'Permission denied',
              },
            },
          });
        }
      }
      writeFileSync(
        join(state.evidenceDir, `${backend}-cli.jsonl`),
        events.map((event) => JSON.stringify(event)).join('\n')
      );
    }
    const result = spawnSync(
      process.execPath,
      [
        join(__dirname, '../../../../scripts/p6b-owner-native-smoke.mjs'),
        'verify',
        '--fixture',
        root,
      ],
      { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } }
    );
    expect(result.status, result.stderr).toBe(1);
    const proof = JSON.parse(readFileSync(join(state.evidenceDir, 'verification.json'), 'utf8'));
    expect(proof.claude.passed).toBe(true);
    expect(proof.codex.passed).toBe(false);
  }
);
