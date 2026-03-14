# SQLite Driver Coexistence PoC Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `node:sqlite`-based database adapter to `mama-core` that coexists with the current `better-sqlite3` adapter, then verify `mcp-server` and `claude-code-plugin` still work through the existing core API.

**Architecture:** Keep the current `DatabaseAdapter` abstraction intact and add a second SQLite implementation under `mama-core/src/db-adapter`. The adapter factory selects `node:sqlite`, `better-sqlite3`, or `auto` via environment variable and runtime capability detection, while all callers above the adapter boundary remain unchanged.

**Tech Stack:** TypeScript, `node:sqlite` (`DatabaseSync`/`StatementSync`), existing SQLite schema and migrations, Vitest.

---

## Chunk 1: Adapter Layer

### Task 1: Add `node:sqlite` statement wrapper

**Files:**

- Create: `packages/mama-core/src/db-adapter/node-sqlite-statement.ts`
- Modify: `packages/mama-core/src/db-adapter/statement.ts`
- Test: `packages/mama-core/tests/unit/module-exports.test.js`

- [ ] **Step 1: Write/extend export test for new statement wrapper**

Add an assertion that the db-adapter module exports the new `NodeSQLiteStatement` wrapper.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir packages/mama-core exec vitest run tests/unit/module-exports.test.js`
Expected: FAIL because `NodeSQLiteStatement` is not exported yet.

- [ ] **Step 3: Implement minimal wrapper**

Create a wrapper around `node:sqlite` prepared statements with the existing `Statement` interface:

- `all(...params)`
- `get(...params)`
- `run(...params)`

Keep placeholder conversion and run-result normalization local to the wrapper or a small helper.

- [ ] **Step 4: Export wrapper from statement module**

Modify `statement.ts` so the new wrapper can be imported alongside `SQLiteStatement`.

- [ ] **Step 5: Re-run test**

Run: `pnpm --dir packages/mama-core exec vitest run tests/unit/module-exports.test.js`
Expected: PASS

### Task 2: Add `node:sqlite` adapter implementation

**Files:**

- Create: `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts`
- Modify: `packages/mama-core/src/db-adapter/base-adapter.ts`
- Test: `packages/mama-core/tests/unit/db-initialization.test.js`

- [ ] **Step 1: Add a failing initialization test path for the new adapter**

Extend db initialization tests to exercise adapter creation under `MAMA_SQLITE_DRIVER=node-sqlite`.

- [ ] **Step 2: Run test to verify it fails**

Run: `MAMA_SQLITE_DRIVER=node-sqlite pnpm --dir packages/mama-core exec vitest run tests/unit/db-initialization.test.js`
Expected: FAIL because adapter selection/implementation does not exist yet.

- [ ] **Step 3: Implement `NodeSQLiteAdapter`**

Mirror the current `SQLiteAdapter` responsibilities:

- path resolution
- connection open/close
- WAL/busy_timeout pragmas
- `prepare`, `exec`, `transaction`
- `vectorSearch`, `insertEmbedding`
- `runMigrations`

Preserve schema/migration behavior exactly; do not change SQL files.

- [ ] **Step 4: Re-run targeted adapter test**

Run: `MAMA_SQLITE_DRIVER=node-sqlite pnpm --dir packages/mama-core exec vitest run tests/unit/db-initialization.test.js`
Expected: PASS

## Chunk 2: Adapter Selection

### Task 3: Add runtime driver selection to factory

**Files:**

- Modify: `packages/mama-core/src/db-adapter/index.ts`
- Modify: `packages/mama-core/src/db-manager.ts`
- Test: `packages/mama-core/tests/unit/db-initialization.test.js`

- [ ] **Step 1: Add failing test for driver selection**

Add coverage for:

- `MAMA_SQLITE_DRIVER=node-sqlite`
- `MAMA_SQLITE_DRIVER=better-sqlite3`
- `MAMA_SQLITE_DRIVER=auto`

- [ ] **Step 2: Run the selection test and confirm failure**

Run: `pnpm --dir packages/mama-core exec vitest run tests/unit/db-initialization.test.js`
Expected: FAIL on new selection assertions.

- [ ] **Step 3: Implement adapter selection**

In `createAdapter()`:

- `node-sqlite` => force new adapter
- `better-sqlite3` => force old adapter
- `auto` or unset => prefer `node:sqlite` when available on Node 22+, otherwise old adapter

Keep returned type as `DatabaseAdapter` so callers do not change.

- [ ] **Step 4: Re-run tests**

Run: `pnpm --dir packages/mama-core exec vitest run tests/unit/db-initialization.test.js tests/unit/module-exports.test.js`
Expected: PASS

## Chunk 3: Cross-Package Verification

### Task 4: Verify `mcp-server` compatibility through core API

**Files:**

- Modify: `packages/mcp-server/tests/unit/db-initialization.test.js`
- Test: `packages/mcp-server/tests/unit/db-initialization.test.js`

- [ ] **Step 1: Add a Node SQLite compatibility smoke path**

Add one test or environment-configured path that exercises initialization with `MAMA_SQLITE_DRIVER=node-sqlite`.

- [ ] **Step 2: Run test to verify current behavior**

Run: `MAMA_SQLITE_DRIVER=node-sqlite pnpm --dir packages/mcp-server exec vitest run tests/unit/db-initialization.test.js`
Expected: PASS after adapter selection is wired.

### Task 5: Verify Claude Code plugin compatibility through core API

**Files:**

- Modify: `packages/claude-code-plugin/tests/core/db-initialization.test.js`
- Modify: `packages/claude-code-plugin/tests/install/postinstall.test.js`
- Test: `packages/claude-code-plugin/tests/core/db-initialization.test.js`
- Test: `packages/claude-code-plugin/tests/install/postinstall.test.js`

- [ ] **Step 1: Add plugin-side smoke coverage for `MAMA_SQLITE_DRIVER=node-sqlite`**

Ensure plugin initialization and SQLite checks still behave through the core abstraction.

- [ ] **Step 2: Run plugin tests**

Run: `MAMA_SQLITE_DRIVER=node-sqlite pnpm --dir packages/claude-code-plugin exec vitest run tests/core/db-initialization.test.js tests/install/postinstall.test.js`
Expected: PASS

## Chunk 4: Verification and Findings

### Task 6: Run final verification matrix

**Files:**

- Modify: `docs/superpowers/plans/2026-03-14-sqlite-driver-poc.md`

- [ ] **Step 1: Run core verification**

Run: `pnpm --dir packages/mama-core exec vitest run`
Expected: PASS

- [ ] **Step 2: Run MCP verification**

Run: `MAMA_SQLITE_DRIVER=node-sqlite pnpm --dir packages/mcp-server exec vitest run tests/unit/db-initialization.test.js`
Expected: PASS

- [ ] **Step 3: Run plugin verification**

Run: `MAMA_SQLITE_DRIVER=node-sqlite pnpm --dir packages/claude-code-plugin exec vitest run tests/core/db-initialization.test.js tests/install/postinstall.test.js`
Expected: PASS

- [ ] **Step 4: Run typecheck where applicable**

Run: `pnpm --dir packages/mama-core typecheck`
Expected: PASS

- [ ] **Step 5: Record PoC findings**

Append a short findings section to this plan capturing:

- working paths
- broken or shimmed behavior
- migration/transaction quirks
- performance risk notes

## PoC Findings

- `mama-core` now supports coexistence between `better-sqlite3` and `node:sqlite` through `MAMA_SQLITE_DRIVER=better-sqlite3|node-sqlite|auto`.
- On the current local runtime (`Node 25.8.0`), `auto` selects `node:sqlite` successfully.
- `mama-core` verification passed:
  - `pnpm --dir packages/mama-core typecheck`
  - `pnpm --dir packages/mama-core test`
- Cross-package smoke verification passed with `MAMA_SQLITE_DRIVER=node-sqlite`:
  - `pnpm --dir packages/mcp-server exec vitest run tests/unit/db-initialization.test.js`
  - `pnpm --dir packages/claude-code-plugin exec vitest run tests/core/db-initialization.test.js tests/install/postinstall.test.js`
- Compatibility shims currently required:
  - a lightweight `pragma()` compatibility layer because `node:sqlite` does not expose the same helper as `better-sqlite3`
  - `Uint8Array` to `Buffer` conversion for embedding BLOB reads/writes
  - manual transaction wrapper using `BEGIN/COMMIT/ROLLBACK`
- Important limitation: Claude Code plugin installation still directly checks `better-sqlite3` in `scripts/postinstall.js`, so install-path simplification is not solved by this PoC alone.
- Remaining work before full adoption:
  - broaden test coverage beyond initialization smoke tests
  - decide whether `Node 22+` becomes the minimum supported runtime for the `node:sqlite` path
  - optionally move plugin install checks away from hard dependency on `better-sqlite3`
