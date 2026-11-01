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

You need a Mac, Claude Code or Codex signed in, and a Telegram account. On the Mac that will run
MAMA, open Claude Code or Codex and say:

> Install MAMA OS from https://github.com/jungjaehoon-lifegamez/MAMA

Keep the address in. "Install MAMA" alone can send the agent to other programs called mama. You
never type in a terminal. Your agent guides you through these steps, in this order:

1. make a bot with BotFather in Telegram;
2. choose the backend and the model, or let the agent pick;
3. on the page MAMA opens in your browser, paste the bot token, message the bot, and enter the
   code it sends;
4. add the bot to a group as an administrator and send `/bind` there;
5. setup is done when MAMA answers your message;
6. then the agent asks which sources MAMA should watch; pick some, or say "later".

In Claude Code, MAMA's plugin has a `mama-install` skill that does the same: run
`/plugin marketplace add jungjaehoon-lifegamez/claude-plugins`, then `/plugin install mama`. macOS
is supported today; Linux and Docker are not yet.

- [Your first day with MAMA](start/tutorial.md) walks through setup and a first owner conversation.
- [Owner setup](start/owner-setup.md) is the setup your agent follows, with the install command,
  what it installs and the supported versions.
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
