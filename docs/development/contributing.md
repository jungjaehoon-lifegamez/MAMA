---
title: Contributing
parent: Development
nav_order: 3
---

# Contributing

Start with [INTENT](../../INTENT.md) and [AGENTS](../../AGENTS.md). Name the owner check your
change serves: understanding source material, keeping work history together, answering from
saved evidence, reporting changes, or applying corrections. Engine changes also need the shared
core check. The active work list is [the development plan](plan.md).

## Set up the workspace

Use Node.js 22.13.0 or newer and pnpm. The root `package.json` pins the package-manager version.
From the repository root:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The root build, typecheck and test scripts use Turbo. Build dependencies before running a
consumer package directly; standalone tests load the built core package. For focused tests,
change into the package directory as described in [testing](testing.md).

## Put the change in the right package

| Change                                                                  | Package                       |
| ----------------------------------------------------------------------- | ----------------------------- |
| Records, revisions, evidence, memory, search, shared runtime            | `packages/mama-core`          |
| Owner behaviour, work fields, connectors, Telegram, board, wiki, viewer | `packages/standalone`         |
| Public development-memory MCP tools                                     | `packages/mcp-server`         |
| Claude Code commands and hooks                                          | `packages/claude-code-plugin` |

Read the current producer, consumer and assembly point before adding a mechanism. Reuse working
code through public exports; do not reproduce core logic in adapters. Check the registered
action catalog before promising a tool. See [architecture](../explanation/architecture.md).

## Make the result reviewable

1. Use a feature branch. Concurrent workers each use an isolated worktree; never switch branches
   in a shared checkout.
2. Reproduce the reported problem through the real input path. Keep source data, observations,
   judgment and delivery evidence distinct.
3. Implement the smallest change supported by that evidence. Follow [code standards](code-standards.md)
   and update the affected guide or reference.
4. Run focused checks, then the required package and repository checks. Establish the owner result
   using [the intent workflow](intent-workflow.md).
5. Add 3–5 lines to [checks](checks.md): result, evidence and what still fails.
   Record architecture, API contract and configuration decisions with the development-memory MCP
   `save` tool.

Use neutral fixtures. Do not add personal names, business names, channel or user identifiers,
private addresses, credentials or operational source content to code, examples or test data.
Keep `docs/superpowers/` out of commits. Review the working tree and staged changes before a commit.

Stage named files and pass the commit message from a file:

```bash
git add <changed-files>
git commit -F <message-file>
git log -1 --oneline
```

Use a concise subject such as `fix: preserve work revision evidence` or `docs: explain owner setup`.
The PR should explain the concrete problem, resulting behaviour, validation and remaining limits.
Do not present a passing test suite as proof that the overall product purpose is complete.

Before publication, follow [the release process](release-process.md), including the privacy review
and the owner's go-ahead before the push and PR.
