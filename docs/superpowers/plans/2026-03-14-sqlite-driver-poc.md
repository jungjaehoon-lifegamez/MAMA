# SQLite Driver PoC Archive

**Status:** Completed and superseded on 2026-03-14.

## Outcome

- The original coexistence PoC succeeded.
- After verification, MAMA was simplified further and now ships as `node:sqlite`-only.
- `better-sqlite3` fallback and prebuild handling were removed.
- All public packages now require Node.js 22+.

## Verified Results

- `mama-core`, `mcp-server`, `claude-code-plugin`, and `mama-os` run on the shared SQLite database through Node's built-in `node:sqlite` runtime.
- Codex-installed MCP usage was verified against the existing `~/.claude/mama-memory.db`.
- Standalone `codex-mcp` startup and daemon shutdown regressions discovered during the migration were fixed separately after the PoC.

## Follow-up Work That Was Completed

- Plugin install path updated so SQLite no longer depends on a compiled addon.
- Standalone direct SQLite usages were migrated to the shared `node:sqlite` wrapper.
- Codex backend bootstrap and shutdown stability fixes were merged after runtime validation.
