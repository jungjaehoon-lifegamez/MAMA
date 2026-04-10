# v0.18 Remaining Work — Design Spec

**Date:** 2026-04-10
**Branch:** feat/v018-output-layer
**Scope:** 4 sequential tasks to complete v0.18 agent swarm + output layer

---

## 1. mama_save Null Ref Fix (HIGH)

### Problem

`agent-loop-init.ts:103` creates `AgentLoop` without passing `executorOptions` (4th arg).
Result: `GatewayToolExecutor.mamaDbPath = undefined` → `initializeMAMAApi()` gets no DB path → null ref on mama_save.

### Fix

In `packages/standalone/src/cli/runtime/agent-loop-init.ts`, pass `executorOptions` as 4th argument to `new AgentLoop()`:

```ts
const agentLoop = new AgentLoop(oauthManager, { ... }, undefined, {
  mamaDbPath: expandPath(config.database.path)
});
```

### Files

- `packages/standalone/src/cli/runtime/agent-loop-init.ts` (line ~103)

### Verification

1. `mama stop && mama start`
2. Trigger mama_save via agent ("remember this decision")
3. Check `daemon.log` for mama_save errors — must be zero
4. Verify decision appears in DB via `/api/decisions`

---

## 2. Conductor Skill Injection (MEDIUM)

### Problem

Conductor cannot pass workflow instructions (skills) to sub-agents during delegation. `executeDelegate()` only accepts `{ agentId, task, background }`.

### Design

Add optional `skill` field to delegate input. When present, read `~/.mama/skills/{skill}.md` and prepend to delegation prompt.

### Changes

**gateway-tool-executor.ts** — in `executeDelegate()`:

```ts
if (input.skill) {
  const skillPath = join(homedir(), '.mama', 'skills', `${input.skill}.md`);
  if (existsSync(skillPath)) {
    const skillContent = readFileSync(skillPath, 'utf-8');
    delegationPrompt = skillContent + '\n\n---\n\n' + delegationPrompt;
  } else {
    logger.warn(`Skill not found: ${input.skill}`);
  }
}
```

**gateway-tools.md** — add `skill` parameter documentation to delegate tool section.

**types.ts** — add `skill?: string` to DelegateInput type.

### Files

- `packages/standalone/src/agent/gateway-tool-executor.ts` (~line 2156)
- `packages/standalone/src/agent/gateway-tools.md` (delegate section)
- `packages/standalone/src/agent/types.ts` (DelegateInput)

### Verification

1. Create `~/.mama/skills/test-skill.md` with test content
2. Conductor delegates with `skill: "test-skill"`
3. Confirm sub-agent's system prompt includes skill content (check daemon.log)

---

## 3. Playground Removal + Log Viewer Migration (MEDIUM)

### Problem

Playground system is unused except for Log Viewer, which is embedded as `mama-log-viewer.html` in an iframe. This causes style inconsistency and template sync issues. Decision: remove playground entirely, migrate Log Viewer to native viewer module.

### Design

**Phase 3a — Migrate Log Viewer to viewer module:**

- Create `packages/standalone/public/viewer/src/modules/logs.ts`
- Extract log viewing logic from `templates/playgrounds/mama-log-viewer.html` (polling, filtering, search, export)
- Wire into viewer tab system (Logs tab already exists per recent commits)
- Remove iframe-based loading

**Phase 3b — Remove playground infrastructure:**

Delete:

- `packages/standalone/templates/playgrounds/` (all 4 HTML files)
- Playground CRUD API routes in `api-routes-init.ts` (lines 999-1182)
- `packages/standalone/public/viewer/src/modules/playground.ts` (entire module)
- playground_create tool from `tool-registry.ts`, `gateway-tool-executor.ts`, `host-bridge.ts`
- Playground type from `types.ts`
- `chat.ts` relayToPlayground logic (lines 1022, 1041-1068, playgroundAwaitingResponse flag)
- X-Frame-Options playground exception in `api/index.ts` (lines 133-135)
- gateway-tools.md playground section (lines 67-69)

### Files (modify)

- `packages/standalone/public/viewer/src/modules/logs.ts` (NEW)
- `packages/standalone/public/viewer/src/modules/chat.ts`
- `packages/standalone/src/cli/runtime/api-routes-init.ts`
- `packages/standalone/src/agent/tool-registry.ts`
- `packages/standalone/src/agent/gateway-tool-executor.ts`
- `packages/standalone/src/agent/gateway-tools.md`
- `packages/standalone/src/agent/types.ts`
- `packages/standalone/src/agent/code-act/host-bridge.ts`
- `packages/standalone/src/api/index.ts`

### Files (delete)

- `packages/standalone/templates/playgrounds/` (entire directory)
- `packages/standalone/public/viewer/src/modules/playground.ts`

### Verification

1. Viewer Logs tab loads and shows daemon.log content (no iframe)
2. Log filtering, search, export still work
3. No remaining references to "playground" in source (grep)
4. `pnpm test` passes
5. No 404 errors in browser console

---

## 4. DB node:sqlite to better-sqlite3 Unification (LOW)

### Problem

Standalone uses `node:sqlite` (requires Node 22.13+) while mama-core uses `better-sqlite3`. Two different SQLite drivers in the same monorepo creates unnecessary complexity.

### Design

Replace the `node:sqlite` wrapper with `better-sqlite3` in standalone. The wrapper's API surface (`prepare`, `exec`, `pragma`, `transaction`, `close`) maps 1:1 to better-sqlite3's native API, so 25 consumers need zero changes.

### Changes

**package.json** — add `better-sqlite3` + `@types/better-sqlite3` to dependencies.

**sqlite.ts** — replace `require('node:sqlite').DatabaseSync` with `require('better-sqlite3')`. Simplify wrapper since better-sqlite3's native API already matches the exposed interface. Remove `NodeSqliteConnection` class; better-sqlite3 instances can be used directly.

### Files

- `packages/standalone/package.json`
- `packages/standalone/src/sqlite.ts`

### Verification

1. `pnpm install` (new dependency resolves)
2. `pnpm test` — all 2512 tests pass
3. `mama start` → health check passes
4. Verify DB read/write via viewer

---

## Execution Order

1. mama_save fix → verify
2. Skill Injection → verify
3. Playground removal (3a: migrate logs, 3b: delete playground) → verify
4. DB unification → verify
5. Final: `pnpm test` full suite

## Success Criteria

- mama_save works without null ref (daemon.log clean)
- Conductor can delegate with skill injection
- No playground code remains; Log Viewer works natively in viewer
- Single SQLite driver (better-sqlite3) across monorepo
- All tests pass (2512+)
