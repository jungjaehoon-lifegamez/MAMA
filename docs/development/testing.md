---
title: Testing
parent: Development
nav_order: 7
---

# Testing

Test the changed behaviour at its real boundary, then prove the owner result. A helper test,
completed model turn or stored row cannot substitute for the delivered answer or artifact.
Use [the intent workflow](intent-workflow.md) to name the evidence level you actually observed.

## Run the right scope

From the repository root:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

Run a package or file from inside that package. Do not run a root Vitest command with `--root`;
it can use the wrong configuration and report false failures.

```bash
cd packages/mama-core
pnpm exec vitest run tests/knowledge/commitment-read.test.ts
pnpm exec vitest run -t "revision"
```

Other useful focused suites, each from its own package directory:

| Package              | Test files                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `mama-core`          | `tests/knowledge/commitment-write.test.ts`, `tests/knowledge/instance-isolation.test.ts`, `tests/unit/recall-kind-array.test.ts` |
| `standalone`         | `tests/api/work-actions.test.ts`, `tests/api/stored-source-actions.test.ts`, `tests/runtime/owner-runtime-lessons.test.ts`       |
| `standalone`         | `tests/runtime/owner-security.test.ts`, `tests/runtime/native-tool-traces.test.ts`, `tests/cli/onboarding.test.ts`               |
| `claude-code-plugin` | `tests/manifests/plugin-manifests.test.js`                                                                                       |

Tests are Vitest-based. Consult each package's config and scripts; there is no fixed test count or
repository-wide coverage percentage promised by this guide. Root test execution builds its
prerequisites through Turbo. Standalone's direct tests use core's built exports, so rebuild core
after changing it.

## Isolate state before initialization

Set `MAMA_DB_PATH` to a temporary database before importing code that calls `initDB()`. The
otherwise-default `~/.claude/mama-memory.db` is real development memory and is not disposable.
Use separate databases per test, close handles and restore environment state during cleanup.

Tests that touch configuration or home paths must use a temporary home. For a shell smoke test:

```bash
test_home=$(mktemp -d)
HOME="$test_home" MAMA_DB_PATH="$test_home/memory.db" pnpm exec vitest run <test-file>
```

Use a task-specific variable; do not overwrite the shell's own `HOME` for the whole session.
Never print configuration ranges or credential files. Do not delete SQLite WAL or SHM files to
work around a failure; inspect the owning process and the database lifecycle first.

`MAMA_FORCE_TIER_3=true` disables real embedding generation for test runs that use lexical paths
or stubs. The plugin test configuration sets it. Such a run cannot prove semantic retrieval.
For search changes, also use the real model with realistic titles and known relevant records.
Check both retrieval and ranking; a synthetic shared word can hide a missed real query.

## Verify the whole owner path

For live behaviour, retain the owner turn, a clean bounded slice of `~/.mama/logs/daemon.log`,
and a database read-back. Follow mailbox input, model run, action/native tool traces, durable
changes and the Telegram receipt. Compare the actual answer, report or artifact with the source.
For correction work, repeat a related request in a fresh session and after restart, and test an
unrelated request for scope spillover.

A crashed daemon is restarted by its service, so killing the process is not stopping it. Before
modifying product state under `~/.mama`, stop it and check that nothing holds the install:

```bash
mama stop
mama status
```

Check the `DAEMON_JS` target in `~/.mama/start.sh` to establish which build will run. MAMA's
product home is the repository's disposable testbed; the development-memory database is not.
Do not use daemon logs to infer model cost or call frequency.

A benchmark using `claude -p` must pass `--setting-sources project` so global plugin hooks do not
contaminate it. Compare candidates with the same model, reasoning effort, source snapshots and
as-of time. Measure the whole request-to-delivery interval, including queue time and failures.

For shared-engine changes, C6 requires a packed core installed outside the workspace, with an
independent database and public exports. Workspace-linked tests alone cannot establish that a
second consumer can install and use the package.
