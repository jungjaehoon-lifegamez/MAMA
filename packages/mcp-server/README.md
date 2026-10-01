# MAMA public MCP server

Development decisions and checkpoints over stdio MCP. Version **2.4.0**
([package.json](package.json)); Node.js 22.13+.

The server calls [mama-core](../mama-core/README.md) **in-process**. It opens
`MAMA_DB_PATH`, then the older `MAMA_DATABASE_PATH`, or `~/.claude/mama-memory.db`.
It does not require the MAMA OS daemon, runtime socket or owner-session credential.

## Use this checkout

Build with `pnpm install` and `pnpm build` from the repository root. Configure a stdio MCP
client to run the checkout server:

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

For Claude Code commands and hooks, register the checkout's marketplace:

```text
/plugin marketplace add /path/to/MAMA
/plugin install mama@mama-dev
```

The plugin manifest launches the **published** server with `npx -y @jungjaehoon/mama-server`;
installing local plugin files does not select the checkout's server. Use the stdio configuration
above when verifying this branch. Published versions may lag the rebuild. See
[development-memory setup](../../docs/start/claude-code-plugin.md) for both install paths.

## Advertised tools

| Tool                             | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `save`                           | Save a `decision`, `checkpoint` or raw conversation `ingest` |
| `search`                         | Search or list decisions and checkpoints                     |
| `update`                         | Record a decision outcome and optional reason                |
| `search_decisions_and_contracts` | Retrieve context for code/tool use                           |
| `case_timeline_range`            | Read a bounded timeline of stored case data                  |

`load_checkpoint` is callable directly but is not advertised by `ListTools`.
Clients can also resume through `search` with `{"type":"checkpoint"}` and no query.
The [MCP reference](../../docs/reference/mcp-tools.md) defines schemas, scope behavior and errors.

Verify a decision save, search and outcome update through the client; then save a checkpoint and
retrieve it after restarting the client. Inspect result error fields rather than treating an empty
result as success.

## Storage and development

SQLite and the embedding index are local. Embeddings use the fixed
`Xenova/multilingual-e5-large` model (1024 dimensions); initial startup can download dependencies
and model assets. Keep development memory separate from OS state in `~/.mama/`.
Your MCP client controls what retrieved text it sends to its model provider.

The plain-JavaScript entry point is [src/server.js](src/server.js); handlers live in
[src/tools](src/tools). Run `pnpm test` from this package; follow
[testing](../../docs/development/testing.md) for isolated databases.

[Plugin](../claude-code-plugin/README.md) · [Documentation](../../docs/index.md) ·
[MIT](../../LICENSE).
