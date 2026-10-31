---
title: MAMA
nav_order: 1
---

# MAMA

MAMA keeps your work history on your computer and gives you one place to ask about it. Connect
your work sources, ask questions in Telegram, and get reports with the records behind them.
MAMA also keeps decisions and checkpoints available between Claude Code sessions.

MAMA runs with Claude or Codex. Your records stay on your computer; connected services and the
model receive the information needed for each task.

## Start here

On the Mac that will run MAMA, open Claude Code or Codex and say:

> Install MAMA OS from https://github.com/jungjaehoon-lifegamez/MAMA by following its owner setup
> guide, docs/start/owner-setup.md.

Name the repository: "install MAMA" alone can send the agent to other programs called mama. The
agent runs the install command, and you never type in a terminal:

```sh
curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | MAMA_INIT_MODEL=<model> sh -s -- --backend <claude|codex> --non-interactive
```

In Claude Code, MAMA's plugin has a `mama-install` skill that does the same: run
`/plugin marketplace add jungjaehoon-lifegamez/claude-plugins`, then `/plugin install mama`. macOS
is supported today; Linux and Docker are not yet.

- [Your first day with MAMA](start/tutorial.md) walks through setup and a first owner conversation.
- [Owner setup](start/owner-setup.md) is the setup your agent follows, with what it installs and
  the supported versions.
- [Development memory](start/claude-code-plugin.md) sets up the Claude Code plugin and MCP server.

## Guides

Read about [sources](guides/connectors.md), [messengers](guides/messengers.md),
[reports and the board](guides/reports-and-board.md), [corrections](guides/corrections-and-learning.md),
and [security](guides/security.md).

## Learn how MAMA works

[Architecture](explanation/architecture.md), [memory and search](explanation/memory-and-search.md),
and [the owner conversation](explanation/owner-loop.md) describe the main parts.

## Reference and development

Look up the [command line](reference/cli.md), [configuration](reference/configuration.md),
[available actions](reference/actions.md), or [MCP tools](reference/mcp-tools.md). Contributors can
start with [development notes](development/contributing.md).
