---
name: mama-context
description: MAMA context at session start; everything else is pulled with the MAMA tools and commands.
---

# MAMA Context

## Overview

This skill documents the one hook the MAMA Claude Code plugin ships. The plugin manifest is the
authority for which hooks run. At session start the agent sees the last checkpoint and the newest
active decisions; everything else it pulls when it needs it, with `/mama:search <topic>` or the MCP
`search` tool for the full decision, its reasoning, outcome and evolution chain.

## Active hook

**SessionStart Hook** (`scripts/sessionstart-hook.js`)

- Runs when a Claude Code session starts, resumes or is compacted.
- Installs the plugin's npm dependencies into `${CLAUDE_PLUGIN_DATA}` when they are missing or out of
  date (Claude Code does not install them).
- Opens the local memory database and adds the last checkpoint and the five newest active decisions
  to the session's context. Replaced, retired and contradicted decisions, and records that only amend
  another, stay out, as recall leaves them out.
- Loads no embedding model.
- Manifest timeout: 180 seconds, for a first dependency install.

## No tool or compaction hooks

The plugin registers no `PreToolUse`, `PostToolUse` or `PreCompact` hook (removed 2026-10-01):

- A read hook blocked the first read of each code file to push decisions matched on the file name.
- An edit hook pushed the same reminder after each first edit; recording decisions is in the
  project instructions.
- A compaction hook's output is shown to the user only and never reaches the compaction.

## Configuration boundary

Hook registration lives in `packages/claude-code-plugin/.claude-plugin/plugin.json`. Feature
activation is controlled by `src/core/hook-features.js`. To stop the hook entirely, disable the
plugin in Claude Code rather than relying on an undocumented configuration key.

## Developer checks

```bash
pnpm --dir packages/claude-code-plugin vitest run tests/hooks/sessionstart-hook.test.js
```
