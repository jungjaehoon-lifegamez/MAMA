---
title: Remember development decisions in Claude Code
parent: Start
nav_order: 2
---

# Remember development decisions in Claude Code

Install the MAMA plugin to keep decisions and checkpoints across coding sessions. It includes a
public stdio MCP server and Claude Code commands and hooks. It uses
`~/.claude/mama-memory.db`; it runs independently of the MAMA OS daemon. For the Telegram owner
agent, use [owner setup](owner-setup.md).

## Install

These pages describe the current checkout. Use Node.js 22.13.0 or newer, run `pnpm install` and
`pnpm build` from its root, then register its local marketplace in Claude Code:

```text
/plugin marketplace add /path/to/MAMA
/plugin install mama@mama-dev
```

Restart Claude Code and check that `/mama:search` and `/mama:checkpoint` are available. The local
marketplace selects this checkout's plugin files. Its manifest still launches the published MCP
package through `npx -y @jungjaehoon/mama-server`; it does not select the checkout's server code.
Use the local stdio configuration below when verifying server changes from this branch.

For released plugin files, the release workflow advertises `/plugin marketplace add
jungjaehoon-lifegamez/claude-plugins` followed by `/plugin install mama`. A published release may
lag this checkout. Claude Code installs no npm packages for a plugin, so the first session start
after an install or a dependency change installs mama-core into the plugin's data folder
(`~/.claude/plugins/data/<plugin id>`, kept across updates); it took 13 s and 416 MB cold. The
embedding model downloads on first use. Command availability alone does not prove a successful
memory write.

## Verify a complete round trip

Save a small decision with its reason:

```text
/mama:decision test_strategy "Use the existing test runner" "Keep the project's current test workflow"
/mama:search test_strategy
```

Confirm the search returns the decision and its reason. A topic groups related records for
retrieval; explicit decision IDs in reasoning create relationships. When an approach succeeds or
fails, ask the assistant to update that decision's outcome with the evidence.

Before ending a session, run `/mama:checkpoint`. Include the goal, verified results, unfinished work,
relevant files and next steps. Start a new session, run `/mama:resume`, and confirm that the saved
context is restored. Check the current files before continuing from an older checkpoint.

## Understand the automatic context

SessionStart reads recent decisions and the latest checkpoint. The first eligible code-file Read
can inject related decisions; the first Write or Edit can remind the assistant to save what matters.
PreCompact supplies compaction guidance and unsaved-decision reminders. These hooks do not save
every edit or replace the explicit save-and-retrieve check.

`/mama:configure --show` reports effective settings. Set `MAMA_DB_PATH` before starting the client to
use another development-memory database. Set `MAMA_DISABLE_HOOKS=true` for manual-only use.
See [MCP tools, commands and hook switches](../reference/mcp-tools.md).

## Use the server without the plugin

After building the checkout, add its local stdio server to your MCP client's configuration:

```json
{
  "mcpServers": {
    "mama": {
      "command": "node",
      "args": ["/path/to/MAMA/packages/mcp-server/src/server.js"]
    }
  }
}
```

This provides the checkout's memory tools without Claude Code slash commands or hooks. Test `save`
with `type: "decision"`, then `search`, through the client. To use the published server instead,
set `command` to `npx` and `args` to `["-y", "@jungjaehoon/mama-server"]`. No MAMA OS process or
runtime socket is needed.

Sources: [local marketplace](../../.claude-plugin/marketplace.json),
[plugin manifest](../../packages/claude-code-plugin/.claude-plugin/plugin.json),
[MCP server](../../packages/mcp-server/src/server.js),
[marketplace release instructions](../../.github/workflows/release.yml).
