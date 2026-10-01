---
title: Development-memory MCP tools
parent: Reference
nav_order: 6
---

# Development-memory MCP tools

Use `@jungjaehoon/mama-server` from Claude Code, Claude Desktop or another stdio MCP client to
save development decisions and resume coding sessions. The server calls `mama-core` in-process and
opens its own database; it does not require the MAMA OS daemon or its socket.

The database is `MAMA_DB_PATH`, then the older `MAMA_DATABASE_PATH`, then
`~/.claude/mama-memory.db`. Plugin hooks use the same defaults. Keep this database separate from
MAMA OS state in `~/.mama/`. Start with the [plugin setup](../start/claude-code-plugin.md).

## Tools advertised to clients

| Tool                             | Purpose and key inputs                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `save`                           | Required `type`: `decision`, `checkpoint`, or `ingest`. Per-type inputs below.                                                                                                                                                                                                                   |
| `search`                         | Optional `query`, `type` (`all`, `decision`, `checkpoint`), `limit` (default 10), and `scopes`. A query searches decisions semantically and checkpoint summaries by text. Without a query it returns recent decisions and checkpoints, with decisions first.                                     |
| `update`                         | Required decision `id` and `outcome` (`success`, `failed`, `partial`, case-insensitive); optional `reason`. `failure` is also normalized to `FAILED`.                                                                                                                                            |
| `link`                           | Required `from`, `to`, `relation` (`builds_on`, `refines`, `contradicts`, `debates`, `synthesizes`, `mentions`) and `reason`. Links two decisions after saving. With `to` set to an `edgeId` and `relation` `contradicts`, it corrects a wrong link; nothing is edited.                          |
| `get_decision`                   | Required `id`. One decision with `supersedes`, `superseded_by` and every edge in and out: relation, the other decision's id, topic and first line, the reason, who wrote it (`agent`, `agent_text`, `host`) and any correction.                                                                  |
| `search_decisions_and_contracts` | Related decisions and contracts for tooling. Optional `query`, `filePath`, `toolName`, `decisionLimit` (5), `contractLimit` (3), `similarityThreshold` (0.7).                                                                                                                                    |
| `case_timeline_range`            | Bounded timeline for stored case data. Required `case_id`; optional `from`, `to` (ISO dates or epoch milliseconds), `order` (`asc` by default or `desc`), `limit` (100 by default, maximum 500), `include_connector_enrichments`. This public MCP tool is separate from OS work-history actions. |

`load_checkpoint` is callable directly but is not advertised in `ListTools`. It loads the latest
checkpoint and accepts `include_narrative`, `include_links`, and `link_depth`. An advertised way to
resume is `search` with `{"type":"checkpoint"}` and no query. Scoped checkpoint reads are rejected;
with scoped `type: "all"` searches, only decisions are returned.

## Save the right record

| `save.type`  | Required fields                                                                          | Optional fields                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `decision`   | `topic`, `decision`, `reasoning`                                                         | `confidence` (0–1, default 0.5), `scopes`, `event_date`, registry `item`, `actors` (`person`, `role`), `links` and `replaces`.        |
| `checkpoint` | `summary`                                                                                | `next_steps`, `open_files`.                                                                                                           |
| `ingest`     | Nonempty `messages` array of `{role, content}`; roles are `user`, `assistant`, `system`. | `scopes`, `session_date`. Stores a raw conversation observation without creating decisions. The removed `extract` option is rejected. |

Search before saving related decisions. Name the ones a decision builds on, debates or combines in
`links` (`[{id, relation, reason}]`) and the ones it replaces in `replaces` (`[{id, reason}]`);
nothing is linked for you, and the reasoning text is not parsed. Topic reuse alone does not create
an edge. Read a decision's edges with `get_decision` and follow them. Record what was decided, why,
and the evidence; use `update` after observing the outcome.

Decision searches also accept `strict`, `strictness` (`recall`, `balanced`, `strict`), `threshold`,
`disableRecency`, `includeRelated`, `topicPrefix`, `minLexicalSupport`, and `diagnostics`.
Read the result's success or error fields before treating an empty list as no matching memory.

MCP responses contain text blocks. Structured results are JSON in that text; a thrown exception is
returned with `isError: true`. Individual tools can also return `success: false` inside the JSON.

## Claude Code commands and hooks

| Command                                         | Action                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/mama:decision <topic> <decision> <reasoning>` | Save a decision; optional `--confidence`.                                          |
| `/mama:search [query]`                          | Search or list; optional `--type` and `--limit`.                                   |
| `/mama:checkpoint`                              | Ask the assistant to save the goal, evidence, unfinished work and next steps.      |
| `/mama:resume`                                  | Load the latest checkpoint.                                                        |
| `/mama:configure --show`                        | Show database, embedding model and hook switches. It does not write configuration. |

| Hook event     | Current behavior                                                                                                   | Manifest timeout |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `SessionStart` | Install the plugin's dependencies when needed, then include the latest checkpoint and the newest active decisions. | 180 seconds      |

SessionStart is the only hook: the manifest registers no `PreToolUse`, `PostToolUse`, `PreCompact` or
`UserPromptSubmit` hook, and the assistant pulls everything else with the tools and commands. Verify
a save and a later retrieval to check continuity.

| Environment variable      | Effect                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- |
| `MAMA_DB_PATH`            | Development-memory database override; takes precedence over `MAMA_DATABASE_PATH`. |
| `MAMA_DISABLE_HOOKS=true` | Disable all hook features.                                                        |
| `MAMA_DAEMON=1`           | Enable only the features named by `MAMA_HOOK_FEATURES`; none when it is unset.    |
| `MAMA_HOOK_FEATURES`      | Comma-separated feature names in daemon mode; any name enables SessionStart.      |
| `MAMA_DEBUG=true`         | Enable diagnostic logging in components that support it.                          |

Embeddings use the fixed `Xenova/multilingual-e5-large` model with 1024 dimensions, cached in
`~/.cache/huggingface/transformers`. Initial setup may download dependencies and model assets.

Sources: [MCP server and schemas](../../packages/mcp-server/src/server.js),
[tool handlers](../../packages/mcp-server/src/tools),
[plugin manifest](../../packages/claude-code-plugin/.claude-plugin/plugin.json),
[hook scripts](../../packages/claude-code-plugin/scripts),
[feature gates](../../packages/claude-code-plugin/src/core/hook-features.js).
