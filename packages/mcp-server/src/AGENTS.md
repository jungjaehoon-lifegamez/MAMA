# Public MCP server

`@jungjaehoon/mama-server` is an independent stdio MCP process. It opens its own
development-memory database and runs embeddings in process using only the public
exports of `@jungjaehoon/mama-core`.

Architecture: MCP SDK → tool handlers → core API → local SQLite and embeddings.

- `server.js` selects `MAMA_DB_PATH`, or `~/.claude/mama-memory.db` when unset,
  before calling `initDB({ refuseNewerSchema: true })`. Keep this default consistent
  with the plugin's `scripts/db-path.js`. The plugin pins this server's version, and
  this server is published with an exact core version, so the plugin's hooks and this
  server run one core and both refuse a database a newer version migrated.
- Declare the model cache at `~/.cache/huggingface/transformers` before embedding.
- `tools/index.js` provides the shared tool registry. Handlers use `mama-api`,
  `db-manager`, `embeddings`, `knowledge`, and the root public export.
- `mama/` formats responses, expands decision links, runs narrative searches and
  records in-process restart metrics.

The advertised tools are `save`, `search`, `update`,
`search_decisions_and_contracts`, and `case_timeline_range`. `save` accepts
`decision`, `checkpoint`, and `ingest`. `load_checkpoint` remains callable for the
plugin's checkpoint/resume commands; the registry also retains the legacy tools.
Never accept caller-supplied provenance as trusted ingestion metadata.

Tests run from this package with `pnpm test`. The setup file assigns a temporary
HOME and MAMA_DB_PATH before test imports; no test may open the user's memory DB.
The stdio integration test uses separate temporary homes and verifies persisted
memory and checkpoints across process restarts. Node.js >= 22.13.0 is required.
