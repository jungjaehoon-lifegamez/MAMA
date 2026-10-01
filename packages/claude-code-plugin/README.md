# MAMA for Claude Code

Save development decisions and checkpoints, then retrieve them in later coding sessions.
Version **2.1.4**, as declared in [package.json](package.json) and the
[plugin manifest](.claude-plugin/plugin.json). Requires Node.js 22.13+.

The plugin supplies commands and hooks backed by the
[public MCP server](../mcp-server/README.md), which uses core in-process.
Its default database is `~/.claude/mama-memory.db`; the MAMA OS daemon is not required.

## Install from this checkout

Build with `pnpm install` and `pnpm build` from the repository root, then run in Claude Code:

```text
/plugin marketplace add /path/to/MAMA
/plugin install mama@mama-dev
```

Restart Claude Code. These commands select local plugin files, but the manifest
([plugin.json](.claude-plugin/plugin.json) and [.mcp.json](.mcp.json)) launches the
published MCP package with `npx -y @jungjaehoon/mama-server`.
For this branch's server code, use the local stdio configuration in
[development-memory setup](../../docs/start/claude-code-plugin.md). That guide also describes the
released marketplace path; published packages may lag this rebuild.

Verify a save/search round trip, then save a checkpoint and resume it in a fresh session.

## Commands

| Command                                         | Purpose                                                         |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `/mama:decision <topic> <decision> <reasoning>` | Save a decision, optionally with `--confidence`                 |
| `/mama:search [query]`                          | Search or list, optionally with `--type` and `--limit`          |
| `/mama:checkpoint`                              | Save the current goal, evidence, unfinished work and next steps |
| `/mama:resume`                                  | Load the latest checkpoint                                      |
| `/mama:configure --show`                        | Show effective settings; does not write configuration           |

## Hooks and switches

| Event                            | Behavior                                                                |
| -------------------------------- | ----------------------------------------------------------------------- |
| `SessionStart`                   | Initialize memory and supply recent decisions and the latest checkpoint |
| `PreToolUse` → `Read`            | Inject related decisions on an eligible code file's first read          |
| `PostToolUse` → `Write` / `Edit` | Remind the assistant to save meaningful decisions                       |
| `PreCompact`                     | Supply compaction guidance and unsaved-decision reminders               |

Hooks provide context; they do not automatically save every edit or a checkpoint at compaction.

| Environment               | Effect                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `MAMA_DB_PATH`            | Database override, ahead of the older `MAMA_DATABASE_PATH`                                                                           |
| `MAMA_DISABLE_HOOKS=true` | Disable all hook features                                                                                                            |
| `MAMA_DAEMON=1`           | Enable only features explicitly named in `MAMA_HOOK_FEATURES`                                                                        |
| `MAMA_HOOK_FEATURES`      | Comma-separated `memory,keywords,rules,agents,contracts` in daemon mode; Read/Edit hooks need `contracts`, PreCompact needs `memory` |
| `MAMA_DEBUG=true`         | Enable supported diagnostic logging                                                                                                  |

Embedding model: fixed `Xenova/multilingual-e5-large`, 1024 dimensions. Local storage and
embedding computation do not imply that the Claude Code conversation stays on the machine;
initial setup can also download dependencies and model assets.

See [tools, commands and hooks](../../docs/reference/mcp-tools.md) for inputs and timeouts,
[troubleshooting](../../docs/guides/troubleshooting.md) for failures, and
[testing](../../docs/development/testing.md) before running `pnpm test` in this package.

[Documentation](../../docs/index.md) · [Shared engine](../mama-core/README.md) · [MIT](../../LICENSE).
