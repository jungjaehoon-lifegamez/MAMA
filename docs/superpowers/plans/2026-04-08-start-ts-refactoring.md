# start.ts God Object Refactoring Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 3977-line `start.ts` God Object into ~15 focused modules with a thin orchestrator, making each subsystem independently testable while preserving all existing behavior.

**Architecture:** Define a `MAMARuntime` context object to replace 25+ closure variables. Extract cohesive initializer functions that take runtime context and return their products. `start.ts` becomes a ~250-line orchestrator calling initializers in dependency order.

**Tech Stack:** TypeScript, Node.js, existing MAMA standalone infrastructure

---

## Context

`packages/standalone/src/cli/commands/start.ts` is a 3977-line God Object containing ALL initialization for MAMA OS. The `runAgentLoop()` function alone is ~3000 lines with ~25 mutable closure variables threaded through callbacks, route handlers, and shutdown code.

**Why now:** We just fixed a critical bug where Dashboard/Wiki agents couldn't execute `report_publish`/`wiki_publish` because each `AgentLoop` creates its own internal `GatewayToolExecutor`, but publishers were wired to a separate standalone executor. Root cause investigation was blocked by the file's impenetrability — 3977 lines, no modularity, side effects everywhere.

**Pre-requisite fix already applied:** `agent-loop.ts` now has `setReportPublisher()` and `setWikiPublisher()` methods, and `start.ts` calls them on Dashboard/Wiki agent loops. Build passes, 2469 tests pass.

## Dependency Graph (Initialization Order)

```
Phase 1:  config → db, oauthManager, metricsStore, healthService, healthCheckService
Phase 2:  db → sessionStore, toolExecutor; config+oauth → agentLoop → agentLoopClient
Phase 3:  config → mamaApi, mamaApiClient, connectorExtractionFn
Phase 4:  sessionStore+agentLoopClient+mamaApiClient → messageRouter → memoryAgent
Phase 5:  healthService+messageRouter+toolExecutor → graphHandler
Phase 6:  messageRouter+sessionStore+graphHandler → embeddingServer
Phase 7:  config → scheduler, cronWorker, cronEmitter
Phase 8:  config+messageRouter+toolExecutor+agentLoop → gateways (Discord/Slack/Telegram)
Phase 9:  gateways+healthCheckService+graphHandlerOptions → cross-wiring + plugins
Phase 10: agentLoop+discordGateway+config → heartbeatScheduler, tokenKeepAlive
Phase 11: config+connectorExtractionFn → connectors
Phase 12: scheduler+db+healthService+eventBus → apiServer
Phase 13: apiServer+all → REST routes, middleware, dashboard/wiki agents
Phase 14: apiServer → server start, WebSocket
Phase 15: everything → graceful shutdown
```

## File Layout After Refactoring

```
packages/standalone/src/cli/
  commands/
    start.ts              (~250 lines: startCommand + thin runAgentLoop orchestrator)
  runtime/
    types.ts              (~80 lines: MAMARuntime, AgentLoopClient, MAMAApiShape)
    utilities.ts          (~460 lines: pure utility functions + constants)
    daemon.ts             (~265 lines: daemon spawn + watchdog)
    metrics-init.ts       (~80 lines)
    mama-core-init.ts     (~255 lines)
    agent-loop-init.ts    (~230 lines)
    memory-agent-init.ts  (~155 lines)
    gateway-init.ts       (~155 lines)
    gateway-wiring.ts     (~260 lines)
    scheduler-init.ts     (~125 lines)
    connector-init.ts     (~195 lines)
    api-server-init.ts    (~75 lines)
    api-routes-init.ts    (~1110 lines)
    server-start.ts       (~140 lines)
    shutdown.ts           (~170 lines)
```

## Critical Files

- `packages/standalone/src/cli/commands/start.ts` — the file being refactored
- `packages/standalone/src/agent/agent-loop.ts` — AgentLoop constructor, internal executor
- `packages/standalone/src/agent/gateway-tool-executor.ts` — set\* methods for wiring
- `packages/standalone/src/api/index.ts` — ApiServer interface, createApiServer
- `packages/standalone/src/cli/index.ts` — daemon command (second call site for runAgentLoop)

---

### Task 1: Extract utility functions to `utilities.ts`

**Files:**

- Create: `src/cli/runtime/utilities.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `src/cli/runtime/utilities.ts`**

Move these items from start.ts (lines 114-574):

- `API_PORT`, `EMBEDDING_PORT` constants
- `SecurityAlertTarget` interface + `parseSecurityAlertTargets()` function
- `embeddingServer`, `embeddingShutdownToken` module state + `startEmbeddingServerIfAvailable()`
- `NormalizedDiscordGuildConfig` + `normalizeDiscordGuilds()`
- `waitForPortAvailable()`
- `checkAndTakeoverExistingServer()`
- `openBrowser()`, `isOnboardingComplete()`, `syncBuiltinSkills()`
- `shouldAutoOpenBrowser()`, `isExecutable()`
- `findExecutableInPath()`, `resolveCodexCommandForStartup()`, `hasCodexBackendConfigured()`

Export all functions and types.

- [ ] **Step 2: Update start.ts imports**

Replace the moved code with imports from `../../runtime/utilities.js`.

- [ ] **Step 3: Run tests**

Run: `pnpm build && pnpm test`
Expected: 0 errors, 2469 tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/standalone/src/cli/runtime/utilities.ts packages/standalone/src/cli/commands/start.ts
git commit -m "refactor(start): extract utility functions to runtime/utilities.ts"
```

---

### Task 2: Extract daemon logic to `daemon.ts`

**Files:**

- Create: `src/cli/runtime/daemon.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `src/cli/runtime/daemon.ts`**

Move lines 694-958 from start.ts:

- `WATCHDOG` config object
- `spawnDaemonChild()` function
- `startDaemon()` function
- `startWatchdog()` function (including inlined watchdog bash script)

Dependencies: `API_PORT` from utilities.ts, node builtins.

- [ ] **Step 2: Update start.ts**

Replace moved code with imports. `startCommand()` calls `startDaemon()` — update that reference.

- [ ] **Step 3: Run tests + verify daemon start/stop**

Run: `pnpm build && pnpm test`
Expected: 2469 tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/standalone/src/cli/runtime/daemon.ts packages/standalone/src/cli/commands/start.ts
git commit -m "refactor(start): extract daemon/watchdog to runtime/daemon.ts"
```

---

### Task 3: Define MAMARuntime type

**Files:**

- Create: `src/cli/runtime/types.ts`

- [ ] **Step 1: Create the MAMARuntime interface**

Extract the `AgentLoopClient` interface (currently anonymous at start.ts:1217-1321) and `MAMAApiShape` type (currently inline at start.ts:1404-1440) into named types.

Define `MAMARuntime` interface holding all shared state fields:

- Foundational: `config`, `db`, `oauthManager`
- Observability: `metricsStore`, `healthService`, `healthCheckService`
- Session/Tool: `sessionStore`, `toolExecutor`, `agentLoop`, `agentLoopClient`
- MAMA Core: `mamaApi`, `mamaApiClient`, `connectorExtractionFn`
- Routing: `messageRouter`, `memoryAgentLoop`
- Graph: `graphHandlerOptions`, `graphHandler`
- Scheduler: `scheduler`, `cronWorker`, `cronEmitter`
- Gateways: `discordGateway`, `slackGateway`, `telegramGateway`, `gateways`
- Heartbeat: `heartbeatScheduler`, `tokenKeepAlive`
- Connectors: `rawStoreForApi`, `enabledConnectorNames`
- API: `apiServer`, `eventBus`
- Cleanup: intervals, `pluginLoader`

- [ ] **Step 2: Run typecheck**

Run: `pnpm build && pnpm test`

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/cli/runtime/types.ts
git commit -m "refactor(start): define MAMARuntime context type"
```

---

### Task 4: Extract metrics/health initialization

**Files:**

- Create: `src/cli/runtime/metrics-init.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `initMetrics()` function**

Move lines 992-1062 from start.ts. Function signature:

```typescript
export async function initMetrics(
  config: MAMAConfig,
  db: Database,
  embeddingPort: number
): Promise<{
  metricsStore: MetricsStore | null;
  metricsCleanup: MetricsCleanup | null;
  healthService: HealthScoreService | null;
  healthCheckService: HealthCheckService;
  metricsInterval: ReturnType<typeof setInterval> | null;
}>;
```

- [ ] **Step 2: Update start.ts to call `initMetrics()`**
- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**

---

### Task 5: Extract MAMA Core API initialization

**Files:**

- Create: `src/cli/runtime/mama-core-init.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `initMamaCore()` function**

Move lines 1323-1574 from start.ts. Includes:

- mama-core dynamic import + DB init
- PersistentClaudeProcess for extraction (lazy init + lifecycle)
- MAMA API shape normalization
- `search()` and `searchForContext()` wrapper functions
- `mamaApiClient` construction

Function signature:

```typescript
export async function initMamaCore(config: MAMAConfig): Promise<{
  mamaApi: MAMAApiShape;
  mamaApiClient: MamaApiClient;
  connectorExtractionFn: ((prompt: string) => Promise<string>) | null;
}>;
```

- [ ] **Step 2: Update start.ts**
- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**

---

### Task 6: Extract main agent loop initialization

**Files:**

- Create: `src/cli/runtime/agent-loop-init.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `initMainAgentLoop()` function**

Move lines 1098-1321. Includes:

- Reasoning state (`reasoningLog`, `turnCount`, `autoRecallUsed`) — keep as closure-scoped
- Main `AgentLoop` construction with all callbacks
- `agentLoopClient` wrapper with `run()` and `runWithContent()`
- `buildReasoningHeader()` helper

Function signature:

```typescript
export async function initMainAgentLoop(
  config: MAMAConfig,
  oauthManager: OAuthManager,
  db: Database,
  metricsStore: MetricsStore | null,
  runtimeBackend: string
): Promise<{ agentLoop: AgentLoop; agentLoopClient: AgentLoopClient }>;
```

- [ ] **Step 2-4: Update, test, commit**

---

### Task 7: Extract memory agent initialization

**Files:**

- Create: `src/cli/runtime/memory-agent-init.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `initMemoryAgent()` function**

Move lines 1576-1725. Includes:

- Memory agent persona loading
- `AgentContext` definition
- `AgentLoop` construction (claude-sonnet-4-6, maxTurns 3)
- `memoryProcessManager` with bootstrap delivery and ack classification
- Wire to `messageRouter.setMemoryAgent()`

Note: `MessageRouter` creation (line 1578, just 3 lines) stays in start.ts since it depends on `sessionStore` and `agentLoopClient`.

- [ ] **Step 2-4: Update, test, commit**

---

### Task 8: Extract gateway initialization

**Files:**

- Create: `src/cli/runtime/gateway-init.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `initGateways()` function**

Move lines 1828-1978. Includes:

- Discord gateway construction + start
- Slack gateway construction + start
- Telegram gateway construction + start
- `gatewayMultiAgentConfig` + `gatewayMultiAgentRuntime` construction
- Wire `setDiscordGateway()`, `setTelegramGateway()` on agentLoop + toolExecutor

- [ ] **Step 2-4: Update, test, commit**

---

### Task 9: Extract gateway cross-wiring

**Files:**

- Create: `src/cli/runtime/gateway-wiring.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `wireGateways()` function**

Move lines 1980-2237. Includes:

- Gateway registry for memory save confirmations
- Health check gateway wiring
- Security alert sender wiring
- `CronResultRouter`
- Graph handler runtime wiring (getAgentStates, getSwarmTasks, etc.)
- `applyMultiAgentConfig`, `restartMultiAgentAgent`, `stopMultiAgentAgent`
- Plugin gateway loader

- [ ] **Step 2-4: Update, test, commit**

---

### Task 10: Extract schedulers + connectors

**Files:**

- Create: `src/cli/runtime/scheduler-init.ts`
- Create: `src/cli/runtime/connector-init.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `initSchedulers()` function**

Move lines 1775-1826 + 2239-2296. Includes CronScheduler, CronWorker, HeartbeatScheduler, TokenKeepAlive.

- [ ] **Step 2: Create `initConnectors()` function**

Move lines 2297-2490. Includes connectors.json loading, ConnectorRegistry, RawStore, PollingScheduler, 3-pass extraction pipeline.

- [ ] **Step 3-4: Update, test, commit**

---

### Task 11: Extract API server + routes

**Files:**

- Create: `src/cli/runtime/api-server-init.ts`
- Create: `src/cli/runtime/api-routes-init.ts`
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: Create `initApiServer()` function**

Move lines 2492-2562. Wraps `createApiServer()` call with all dependencies.

- [ ] **Step 2: Create `registerApiRoutes()` function**

Move lines 2563-3667 (~1100 lines). The largest module. Includes:

- Dashboard Agent creation + scheduling
- Wiki Agent creation + scheduling
- REST endpoints (memory, sessions, Discord/Slack send, screenshots)
- Middleware (upload, graph auth, graph handler, session proxy)
- Static assets (playground, skills API, setup page)

- [ ] **Step 3-4: Update, test, commit**

---

### Task 12: Extract server start + shutdown, assemble orchestrator

**Files:**

- Create: `src/cli/runtime/server-start.ts`
- Create: `src/cli/runtime/shutdown.ts`
- Modify: `src/cli/commands/start.ts` (final rewrite to ~250 lines)

- [ ] **Step 1: Create `startServer()` function**

Move lines 3670-3807. Server listen + WebSocket upgrade handler.

- [ ] **Step 2: Create `setupShutdownHandler()` function**

Move lines 3809-3977+. Ordered teardown + signal handlers + keep-alive.

- [ ] **Step 3: Rewrite `runAgentLoop()` as thin orchestrator**

```typescript
export async function runAgentLoop(config: MAMAConfig, options = {}) {
  const runtime: Partial<MAMARuntime> = { config };

  // Phase 1: Foundation
  const { db, oauthManager } = initFoundation(config);
  const metrics = await initMetrics(config, db, EMBEDDING_PORT);
  Object.assign(runtime, { db, oauthManager, ...metrics });

  // Phase 2: Session + Agent
  runtime.sessionStore = new SessionStore(db);
  runtime.toolExecutor = new GatewayToolExecutor({ mamaDbPath, sessionStore });
  const { agentLoop, agentLoopClient } = await initMainAgentLoop(...);
  Object.assign(runtime, { agentLoop, agentLoopClient });

  // Phase 3: MAMA Core
  const core = await initMamaCore(config);
  Object.assign(runtime, core);

  // Phase 4: Memory Agent
  runtime.messageRouter = new MessageRouter(...);
  const mem = await initMemoryAgent(runtime);
  Object.assign(runtime, mem);

  // Phase 5-6: Graph + Embedding
  // ...

  // Phase 7-11: Schedulers, Gateways, Connectors
  // ...

  // Phase 12-13: API Server + Routes
  // ...

  // Phase 14-15: Server Start + Shutdown
  await startServer(runtime as MAMARuntime);
  setupShutdownHandler(runtime as MAMARuntime);
}
```

- [ ] **Step 4: Verify the second call site**

Check `src/cli/index.ts` — the `daemon` command calls `runAgentLoop()`. Ensure signature compatibility.

- [ ] **Step 5: Full verification**

Run: `pnpm build && pnpm test`
Expected: 0 errors, 2469 tests pass

Manual smoke test: `mama start --foreground` → verify health, API, gateway

- [ ] **Step 6: Commit**

```bash
git add packages/standalone/src/cli/runtime/ packages/standalone/src/cli/commands/start.ts
git commit -m "refactor(start): thin orchestrator — start.ts reduced from 3977 to ~250 lines"
```

---

## Verification

After all tasks:

1. `pnpm build` — 0 errors
2. `pnpm test` — 2469+ tests pass
3. `pnpm typecheck` — clean
4. `mama start --foreground` → health endpoint returns ok
5. Dashboard Agent triggers and publishes briefing
6. Wiki Agent triggers on extraction (if enabled)
7. `mama stop` — clean shutdown

## Risks & Mitigations

| Risk                                                   | Mitigation                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `graphHandlerOptions` populated incrementally          | Keep it mutable; `gateway-wiring.ts` mutates in place (matches current pattern) |
| `agentLoopClient` captures reasoning state via closure | Keep as closure-scoped in `agent-loop-init.ts`                                  |
| Module-level `embeddingServer` state                   | Move to `utilities.ts` module scope + export getters                            |
| `startCommand()` must still work                       | It imports from `utilities.ts` + `daemon.ts` + calls `runAgentLoop`             |
| CLAUDE.md agent isolation rules                        | No changes to `persistent-cli-process.ts` or `claude-cli-wrapper.ts`            |
