# Codex Dynamic Tool Bridge Implementation Plan

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` when a task can
> be reviewed independently. Use TDD for every production behavior change.

**Goal:** Run the existing MAMA gateway workflows through Codex app-server native dynamic tools
without changing the Claude runtime or rewriting report, memory, skill, or trigger workflows.

**Architecture:** `AgentLoop` supplies a run-local host-tool bridge built from `ToolRegistry` and
the existing `executeTools` path. `CodexRuntimeProcess` forwards that bridge to the shared
`CodexAppServerProcess`. The app-server process advertises the tools on `thread/start`, routes
`item/tool/call` to the matching pending turn, and replies on the original JSON-RPC request.

**Tech Stack:** TypeScript, Codex app-server JSON-RPC, existing `GatewayToolExecutor`, Vitest
single-fork subprocess tests, pnpm workspaces.

**Design:** `docs/plans/2026-07-20-codex-app-server-multiplex-refactor.md`

---

## Chunk 1: Native Codex gateway bridge

### Task 1: Define the run-local host-tool contract

**Files:**

- Modify: `packages/standalone/src/agent/model-runner.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Test: `packages/standalone/tests/agent/model-runner.test.ts`
- Test: `packages/standalone/tests/agent/tool-registry.test.ts`

- [ ] Add a failing test for converting filtered `ToolRegistry` entries into app-server dynamic
      function specs with names, descriptions, and permissive object input schemas.
- [ ] Add failing role-policy cases proving an empty allowed set advertises no tools, blocked and
      per-run disallowed tools cannot be advertised, and `viewerOnly` tools are available only to an
      authorized viewer run.
- [ ] Assert every advertised name comes from filtered `ToolRegistry` metadata and no MAMA
      dynamic-tool name starts with `mcp__`.
- [ ] Run the two focused tests and confirm the new assertion fails because the bridge contract and
      conversion do not exist.
- [ ] Add the minimal typed host-tool definition, execution result, and run-local handler contract.
- [ ] Add the minimal `ToolRegistry` conversion while preserving the existing Markdown prompt API.
- [ ] Re-run the focused tests and confirm they pass.

Run:

```bash
cd packages/standalone
pnpm vitest run tests/agent/model-runner.test.ts tests/agent/tool-registry.test.ts
```

Expected: first RED for missing dynamic-tool conversion, then exit `0`.

### Task 2: Advertise and execute Codex dynamic tools

**Files:**

- Modify: `packages/standalone/src/agent/codex-app-server-process.ts`
- Test: `packages/standalone/tests/agent/codex-app-server-process.test.ts`

- [ ] Extend the fake app-server with a mode that asserts `thread/start.dynamicTools`, sends an
      `item/tool/call` server request, waits for the client reply, and only then completes the turn.
- [ ] Add failing tests for successful, failed, malformed, cross-thread, and missing-handler calls.
- [ ] Add failing tests for early, duplicate, stale-connection, over-budget, repeated-tool, and
      intentional stop-tool calls.
- [ ] Add a concurrent two-thread case proving each `item/tool/call` reaches only its own run-local
      handler.
- [ ] Run the focused test and confirm the expected failure is the current disabled-tool response.
- [ ] Store the run-local bridge on `PendingTurn`, validate `threadId`, `turnId`, `callId`, tool name,
      namespace, and arguments, then await the handler and reply exactly once.
- [ ] Bind replies to the originating child generation, serialize calls within a turn, and remove
      callbacks on completion, failure, timeout, shutdown, and reconnect.
- [ ] Keep command, file, permission, user-input, elicitation, and unknown requests declined.
- [ ] Add `dynamicTools` only on new `thread/start`; resumed threads retain their original policy.
- [ ] Include the canonical dynamic-tool set in the durable thread-policy fingerprint so changed
      tool capabilities require an explicit thread reset.
- [ ] Re-run the focused test and confirm all subprocess lifecycle tests pass.

Run:

```bash
cd packages/standalone
pnpm vitest run tests/agent/codex-app-server-process.test.ts
```

Expected: first RED with `success: false`, then exit `0`.

### Task 3: Reuse AgentLoop tool execution for Codex

**Files:**

- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Modify: `packages/standalone/src/gateways/message-router.ts`
- Modify: `packages/standalone/src/multi-agent/runtime-process.ts`
- Test: `packages/standalone/tests/agent/agent-loop.test.ts`
- Test: `packages/standalone/tests/multi-agent/codex-runtime-runner.test.ts`

- [ ] Add a failing AgentLoop test proving a Codex host-tool request uses the existing executor,
      envelope context, progress callbacks, and serialized gateway result.
- [ ] Add a failing runtime test proving the run-local bridge reaches the low-level app-server.
- [ ] Add regressions proving literal Codex Markdown `tool_call` and JavaScript blocks cannot execute
      tools while Claude Markdown tool execution remains unchanged.
- [ ] Run both tests and confirm the bridge is currently absent.
- [ ] Build the bridge only for `backend === 'codex' && isGatewayMode`; Claude keeps its existing
      prompt and text parsing path.
- [ ] Omit the Markdown Gateway catalog and skip Markdown tool parsing only for Codex.
- [ ] Implement the bridge handler by calling existing `executeTools` with one `ToolUseBlock`.
- [ ] Forward allowed/disallowed tool policy through the advertised tool list and executor context.
- [ ] Preserve max-turn, repeated-tool, and `stopAfterSuccessfulTools` behavior inside the native
      Codex tool chain with a run-local call budget, the existing 15-repeat limit, and an intentional
      app-server interrupt after a successful stop tool.
- [ ] Resolve that intentional stop successfully without `onError`; keep a real app-server
      `interrupted` status as a rejected failure.
- [ ] Re-run both tests and confirm they pass.

Run:

```bash
cd packages/standalone
pnpm vitest run tests/agent/agent-loop.test.ts tests/multi-agent/codex-runtime-runner.test.ts
```

Expected: first RED for an absent bridge, then exit `0`.

### Task 4: Match Codex failure callbacks

**Files:**

- Modify: `packages/standalone/src/multi-agent/runtime-process.ts`
- Test: `packages/standalone/tests/multi-agent/codex-runtime-runner.test.ts`

- [ ] Add a failing test that a Codex prompt failure calls `onError` exactly once and rejects with
      the same error.
- [ ] Add callback-throws and AgentLoop-level double-notification cases.
- [ ] Make `CodexRuntimeProcess` the sole callback owner; callback failure cannot replace the
      original prompt error.
- [ ] Re-run the test and confirm it passes without changing Claude behavior.

Run:

```bash
cd packages/standalone
pnpm vitest run tests/multi-agent/codex-runtime-runner.test.ts tests/agent/agent-loop.test.ts
```

Expected RED: `onError` is not called. Expected GREEN: exit `0`, one callback and one rejection.

---

## Chunk 2: Remove remaining Claude-only provider selection

### Task 5: Make memory agent inherit the selected backend

**Files:**

- Modify: `packages/standalone/src/cli/runtime/memory-agent-init.ts`
- Test: `packages/standalone/tests/cli/runtime/memory-agent-init.test.ts`

- [ ] Add failing cases for explicit memory override and global Codex inheritance.
- [ ] Remove the hardcoded Claude context value and use explicit memory backend, then runtime
      backend, then Claude only as the compatibility default.
- [ ] Re-run the focused test.

Run:

```bash
cd packages/standalone
pnpm vitest run tests/cli/runtime/memory-agent-init.test.ts
```

Expected RED: global Codex still constructs a Claude memory agent. Expected GREEN: exit `0`.

### Task 6: Route trigger author and review through the configured model runner

**Files:**

- Modify: `packages/standalone/src/operator/trigger-author.ts`
- Modify: `packages/standalone/src/operator/trigger-review.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Test: `packages/standalone/tests/operator/trigger-author.test.ts`
- Test: `packages/standalone/tests/operator/trigger-review.test.ts`

- [ ] Add failing tests showing neither module invokes the `claude` binary when a Codex runner is
      provided.
- [ ] Add start-command wiring coverage proving Codex uses the provider runner while explicit
      Claude configuration retains the current CLI invocation.
- [ ] Replace direct `claude -p` business calls with an injected provider-specific JSON task runner.
- [ ] Preserve existing trigger parsing, validation, persistence, and firing code.
- [ ] Re-run the focused tests.

Run:

```bash
cd packages/standalone
pnpm vitest run tests/operator/trigger-author.test.ts tests/operator/trigger-review.test.ts
```

Expected RED: Codex wiring still invokes `claude`. Expected GREEN: exit `0` and Claude compatibility
assertions remain green.

---

## Chunk 3: Verification and rollout

### Task 7: Static and focused regression verification

- [ ] Run formatting only on touched files.
- [ ] Run all focused tests from Tasks 1-6.
- [ ] Run standalone typecheck, lint, and build.
- [ ] Run the standalone test suite with the required single-fork configuration.
- [ ] Run root `pnpm build` and `pnpm test` if the standalone suite is green.

Run:

```bash
pnpm --filter @jungjaehoon/mama-os typecheck
pnpm lint
pnpm --filter @jungjaehoon/mama-os build
pnpm --filter @jungjaehoon/mama-os test
pnpm build
pnpm test
```

Expected: every command exits `0` with Vitest still using one fork.

### Task 8: Runtime and Telegram verification

- [ ] Rebuild MAMA OS and restart only the existing MAMA daemon.
- [ ] Confirm health, Telegram connection, and Codex app-server initialization.
- [ ] Send an owner-channel report request and verify `report_request` is executed by the existing
      report machinery rather than fabricated from carry text.
- [ ] Verify `board_read`, memory save/recall, a failed-tool recovery, two concurrent sessions, and
      restart/resume.
- [ ] Confirm logs contain no Codex Markdown `tool_call` dependency and no disabled
      `item/tool/call` response.
- [ ] Run an independent code review of the final diff and resolve blocking findings.

Completion requires runtime evidence, not only unit tests.
