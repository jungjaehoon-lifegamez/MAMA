# Codex Code-Act Parity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Codex app-server the same MAMA Code-Act gateway surface and role enforcement as Claude, including owner-console Trello evidence access through `context_compile`.

**Architecture:** A new canonical Code-Act policy projector derives the inner HostBridge surface once from role rules, runtime blocks, model narrowing, and tier limits. Claude receives that surface as prompt declarations; Codex receives one native outer `code_act` dynamic tool whose execution enters the existing QuickJS sandbox. The reactive envelope separately admits the enabled MAMA Trello connector only for verified owner direct messages.

**Tech Stack:** TypeScript, Codex app-server JSON-RPC dynamic tools, QuickJS, MAMA GatewayToolExecutor/HostBridge, Vitest single-fork tests, YAML/JSON runtime configuration.

---

## Chunk 1: Canonical policy and Codex transport

### Task 1: Canonical Code-Act tool policy

**Files:**

- Create: `packages/standalone/src/agent/code-act/tool-policy.ts`
- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts`
- Modify: `packages/standalone/src/agent/code-act/type-definition-generator.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Test: `packages/standalone/tests/code-act/tool-policy.test.ts`
- Test: `packages/standalone/tests/code-act/host-bridge.test.ts`

- [ ] **Step 1: Write failing policy projection tests**

Test exact behaviors: wildcard expansion, block precedence, per-run disallow precedence, tier filtering, sorted deduplicated output, and model narrowing that cannot widen the role surface.

```ts
const policy = projectCodeActToolPolicy({
  allowedTools: ['*'],
  blockedTools: ['Bash', 'Write'],
  disallowedTools: ['delegate'],
  requestedAllowedTools: ['context_compile', 'Bash'],
  requestedBlockedTools: ['Bash'],
  tier: 1,
});

expect(policy.names).toEqual(['context_compile']);
expect(policy.names).not.toContain('Bash');
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/code-act/tool-policy.test.ts`

Expected: FAIL because `tool-policy.ts` does not exist.

- [ ] **Step 3: Implement the canonical projector**

Expose a typed, deterministic result from one focused module:

```ts
export interface CodeActToolPolicyInput {
  allowedTools?: string[];
  blockedTools?: string[];
  disallowedTools?: string[];
  requestedAllowedTools?: string[];
  requestedBlockedTools?: string[];
  tier: 1 | 2 | 3;
}

export interface CodeActToolPolicy {
  names: string[];
  definitions: ToolMeta[];
  fingerprintPayload: string;
}

export function projectCodeActToolPolicy(input: CodeActToolPolicyInput): CodeActToolPolicy;
```

The implementation must expand patterns against `HostBridge.getToolRegistry()`, apply role blocks and runtime disallows after allows, apply the existing numeric tier rules, intersect model-supplied `requestedAllowedTools`, subtract model-supplied `requestedBlockedTools`, sort/deduplicate all patterns and results, and serialize full parameter/return signatures into deterministic JSON for `fingerprintPayload`. Unknown model patterns must produce an explicit validation error.

- [ ] **Step 4: Replace duplicate AgentLoop resolution**

Remove the local `resolveAllowedCodeActTools()` logic from `agent-loop.ts`. Use the projector for startup instructions, per-call instructions, Codex host bridge creation, and the policy fingerprint.

- [ ] **Step 5: Make declaration generation accept the projected names**

Keep `TypeDefinitionGenerator` responsible only for rendering declarations. It must not independently widen or reinterpret the projected policy.

- [ ] **Step 6: Make QuickJS injection consume the same projection**

Change `HostBridge.injectInto()` to accept the already-projected inner tool names and register exactly that set. In `GatewayToolExecutor.executeCodeAct()`, obtain the full active gateway state with `getExecutionState()`, then project from `state.agentContext?.role`, `state.disallowedGatewayTools`, numeric tier, and the model's `allowedTools`/`blockedTools`. Pass the exact names to HostBridge. Preserve that execution state when constructing HostBridge so inner calls retain role, envelope, provenance, background-task registry, and per-run blocks.

```ts
const policy = projectCodeActToolPolicy({
  allowedTools: state.agentContext?.role.allowedTools,
  blockedTools: state.agentContext?.role.blockedTools,
  disallowedTools: state.disallowedGatewayTools,
  requestedAllowedTools: input.allowedTools,
  requestedBlockedTools: input.blockedTools,
  tier,
});
bridge.injectInto(sandbox, policy.names);
```

- [ ] **Step 7: Prove advertised and injected surfaces match**

Add a HostBridge test that records registered QuickJS function names and compares them exactly with `policy.names`, including per-run disallows and both model narrowing fields.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/code-act/tool-policy.test.ts tests/code-act/host-bridge.test.ts tests/code-act/type-definition-generator.test.ts`

Expected: all tests pass.

- [ ] **Step 9: Run the standalone typecheck**

Run: `pnpm --filter @jungjaehoon/mama-os typecheck`

Expected: exit code 0.

- [ ] **Step 10: Commit the policy unit**

```bash
git add packages/standalone/src/agent/code-act/tool-policy.ts packages/standalone/src/agent/agent-loop.ts packages/standalone/src/agent/code-act/host-bridge.ts packages/standalone/src/agent/code-act/type-definition-generator.ts packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/tests/code-act/tool-policy.test.ts packages/standalone/tests/code-act/host-bridge.test.ts
git commit -m "feat: canonicalize Code-Act tool policy"
```

### Task 2: Native Codex outer `code_act` bridge

**Files:**

- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Modify: `packages/standalone/src/agent/code-act/constants.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Test: `packages/standalone/tests/agent/agent-loop.test.ts`
- Test: `packages/standalone/tests/code-act/integration.test.ts`

- [ ] **Step 1: Add failing Codex bridge tests**

Assert that Code-Act-enabled Codex receives exactly one outer native tool named `code_act`, that its base instructions contain the projected inner declarations, and that invoking it calls the existing gateway executor with `code_act`.

```ts
expect(capturedBridge.tools.map((tool) => tool.name)).toEqual(['code_act']);
expect(capturedInstructions).toContain('context_compile');
expect(execute).toHaveBeenCalledWith(
  'code_act',
  expect.objectContaining({ code: expect.any(String) }),
  expect.objectContaining({
    agentContext: expect.objectContaining({ role }),
    envelope,
    disallowedGatewayTools,
    sourceTurnId,
    sourceMessageRef,
    modelRunId,
    backgroundTasks,
  })
);
```

Assert the outer tool's exact JSON schema requires `code`, permits optional string-array `allowedTools` and `blockedTools`, rejects extra properties, and is identical on Codex thread start. Also add a regression assertion that `useCodeAct: false` retains current individual native dynamic tools.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/agent/agent-loop.test.ts tests/code-act/integration.test.ts`

Expected: new Codex bridge assertions fail because Codex currently receives individual tools and suppresses Code-Act guidance.

- [ ] **Step 3: Build the Codex bridge from the existing registry entry**

Give the `code_act` ToolRegistry entry this exact native input schema:

```ts
{
  type: 'object',
  properties: {
    code: { type: 'string' },
    allowedTools: { type: 'array', items: { type: 'string' } },
    blockedTools: { type: 'array', items: { type: 'string' } },
  },
  required: ['code'],
  additionalProperties: false,
}
```

When `backend === 'codex' && useCodeAct`, filter `ToolRegistry.getHostToolDefinitions()` to that `code_act` definition, then execute it through the existing `AgentLoop.executeTools()` path with `toolExecutionContext`. Do not add a new evaluator or direct connector call.

- [ ] **Step 4: Inject Code-Act guidance for Codex**

Update `getCodeActInstructions('codex', names)` to describe the native app-server `code_act` function. Remove references to the retired `mcp__code-act__code_act` transport while retaining QuickJS restrictions.

- [ ] **Step 5: Preserve non-Code-Act behavior**

Keep the existing host bridge branch unchanged for Codex agents with `useCodeAct: false`.

- [ ] **Step 6: Route Claude and Codex through the shared executor**

Make both the Claude parsed-JavaScript path and the Codex native-tool path invoke `GatewayToolExecutor.execute('code_act', input, toolExecutionContext)` through `AgentLoop.executeTools()`. Remove AgentLoop's private QuickJS `executeCodeAct()` implementation, or prove it has no remaining call sites. This prevents Claude from bypassing the canonical GatewayToolExecutor projection.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/agent/agent-loop.test.ts tests/code-act/integration.test.ts tests/agent/tool-registry.test.ts`

Expected: all tests pass.

- [ ] **Step 8: Commit the transport unit**

Before committing, run `pnpm --filter @jungjaehoon/mama-os typecheck` and expect exit code 0.

```bash
git add packages/standalone/src/agent/agent-loop.ts packages/standalone/src/agent/code-act/constants.ts packages/standalone/src/agent/tool-registry.ts packages/standalone/tests/agent/agent-loop.test.ts packages/standalone/tests/code-act/integration.test.ts
git commit -m "feat: expose Code-Act through Codex app-server"
```

### Task 3: Role defaults and session policy identity

**Files:**

- Modify: `packages/standalone/src/cli/config/types.ts`
- Modify: `packages/standalone/src/cli/runtime/agent-loop-init.ts`
- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Test: `packages/standalone/tests/cli/config-manager.test.ts`
- Test: `packages/standalone/tests/cli/runtime/message-router-config.test.ts`
- Test: `packages/standalone/tests/agent/agent-loop.test.ts`
- Test: `packages/standalone/tests/agent/codex-app-server-process.test.ts`

- [ ] **Step 1: Add failing role-default tests**

Assert the default `owner_console` allowlist contains `code_act`, while the existing `Bash`, `Write`, `save_integration_token`, and `delegate` blocks remain.

- [ ] **Step 2: Add failing front-door activation tests**

Assert Code-Act is enabled for the regular front door unless the agent explicitly sets `useCodeAct: false`. Assert viewer/operator delegation mode still forces it off.

- [ ] **Step 3: Add failing AgentLoop and app-server fingerprint tests**

In `agent-loop.test.ts`, hold the caller-supplied base fingerprint constant, vary a projected inner signature or tier, and assert the fingerprint passed to the runner changes. In `codex-app-server-process.test.ts`, feed those two effective fingerprints to the same session and expect the existing explicit mismatch/reset error rather than thread reuse.

- [ ] **Step 4: Run tests and verify RED**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/cli/config-manager.test.ts tests/cli/runtime/message-router-config.test.ts tests/agent/agent-loop.test.ts tests/agent/codex-app-server-process.test.ts`

Expected: the new default, activation, and inner-policy identity assertions fail.

- [ ] **Step 5: Implement default and activation changes**

Add only `code_act` to the owner allowlist. Keep customized persisted role definitions fail-closed. Compute the front-door setting as enabled unless explicitly false, while preserving the `osAgentMode` override.

- [ ] **Step 6: Augment caller fingerprint in AgentLoop**

Pass a fingerprint formed from the caller value plus the projector's stable `fingerprintPayload`, tier, canonical allow/block/disallow inputs, and outer Code-Act schema. The app-server process keeps its existing dynamic-tool schema hashing.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/cli/config-manager.test.ts tests/cli/runtime/message-router-config.test.ts tests/agent/agent-loop.test.ts tests/agent/codex-app-server-process.test.ts`

Expected: all tests pass.

- [ ] **Step 8: Commit the role/session unit**

Before committing, run `pnpm --filter @jungjaehoon/mama-os typecheck` and expect exit code 0.

```bash
git add packages/standalone/src/cli/config/types.ts packages/standalone/src/cli/runtime/agent-loop-init.ts packages/standalone/src/agent/agent-loop.ts packages/standalone/tests/cli/config-manager.test.ts packages/standalone/tests/cli/runtime/message-router-config.test.ts packages/standalone/tests/agent/agent-loop.test.ts packages/standalone/tests/agent/codex-app-server-process.test.ts
git commit -m "fix: align Codex Code-Act role policy"
```

## Chunk 2: Trello evidence boundary

### Task 4: Shared connector configuration loader

**Files:**

- Create: `packages/standalone/src/connectors/config-loader.ts`
- Modify: `packages/standalone/src/cli/runtime/connector-init.ts`
- Test: `packages/standalone/tests/connectors/config-loader.test.ts`

- [ ] **Step 1: Write failing loader tests**

Cover the real `ConnectorsConfig = Record<string, ConnectorConfig>` shape: valid enabled Trello, valid disabled Trello, missing file, malformed JSON, and invalid `enabled`, `pollIntervalMinutes`, `channels`, or `auth` fields. Missing configuration yields a successful empty connector set. Malformed or structurally invalid configuration yields a typed failure and never enables a connector.

- [ ] **Step 2: Run loader tests and verify RED**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/connectors/config-loader.test.ts`

Expected: FAIL because the shared loader does not exist.

- [ ] **Step 3: Implement one strict read/parse function**

Expose a synchronous, discriminated result so both synchronous envelope bootstrap and asynchronous connector initialization can consume it:

```ts
export type ConnectorConfigLoadResult =
  | { ok: true; config: ConnectorsConfig; enabledNames: ReadonlySet<string> }
  | {
      ok: false;
      error: ConnectorConfigLoadError;
      config: Record<string, never>;
      enabledNames: ReadonlySet<string>;
    };

export function loadConnectorConfig(path?: string): ConnectorConfigLoadResult;
```

Resolve the default path to `~/.mama/connectors.json`, validate every connector's `enabled`, `pollIntervalMinutes`, `channels`, and `auth` fields against the existing framework interfaces, normalize record keys to lowercase, and expose an immutable enabled-name set.

- [ ] **Step 4: Replace connector-init's local parser**

Use the shared loader for connector registration. On typed failure, log the error explicitly and continue with an empty config, preserving the current fail-closed startup behavior and existing connector construction behavior. Envelope bootstrap will independently handle the same typed result, log it, and inject an empty enabled-name set; malformed configuration remains visible but never widens authorization.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/connectors/config-loader.test.ts tests/connectors/resolve-poll-minutes.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit the loader unit**

Before committing, run `pnpm --filter @jungjaehoon/mama-os typecheck` and expect exit code 0.

```bash
git add packages/standalone/src/connectors/config-loader.ts packages/standalone/src/cli/runtime/connector-init.ts packages/standalone/tests/connectors/config-loader.test.ts
git commit -m "refactor: share connector configuration loading"
```

### Task 5: Verified-owner Trello envelope scope

**Files:**

- Modify: `packages/standalone/src/cli/runtime/envelope-bootstrap.ts`
- Modify: `packages/standalone/src/envelope/reactive-config.ts`
- Test: `packages/standalone/tests/cli/runtime/envelope-bootstrap.test.ts`
- Test: `packages/standalone/tests/envelope/reactive-config.test.ts`
- Test: `packages/standalone/tests/envelope/code-act-context.test.ts`
- Test: `packages/standalone/tests/agent/context-compile-tool.test.ts`

- [ ] **Step 1: Add failing route-policy tests**

Assert `trello` is present only when all are true: connector enabled, message is a direct owner-console route, sender ownership is verified, and the effective role configuration contains the `owner_console` definition that MessageRouter can resolve. Assert it is absent for group messages, unverified senders, a missing owner role, disabled/missing/malformed connector configuration, and non-owner routes.

- [ ] **Step 2: Add failing real boundary tests**

Execute Code-Act JavaScript that calls:

```js
const result = context_compile({
  task: 'current Trello work',
  connectors: ['trello'],
});
return result;
```

Sandbox functions are synchronous from the model's perspective, so the script must not use `HostBridge.` or `await`. Verify allowed owner execution reaches a real `GatewayToolExecutor`. Verify group/unverified/disabled/missing-owner-role cases reject with `connector_out_of_scope` before context compilation or the raw connector query runs.

- [ ] **Step 3: Run envelope tests and verify RED**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/cli/runtime/envelope-bootstrap.test.ts tests/envelope/reactive-config.test.ts tests/envelope/code-act-context.test.ts tests/agent/context-compile-tool.test.ts`

Expected: owner Trello is currently out of scope.

- [ ] **Step 4: Thread enabled connector names into envelope bootstrap**

Call the synchronous shared loader once inside `buildRuntimeEnvelopeBootstrap()`. On success, inject the immutable enabled-name set into reactive policy configuration. On typed failure, emit an explicit configuration error and inject an empty set. Do not read the file on every message and do not make bootstrap asynchronous.

- [ ] **Step 5: Add the narrow Trello scope rule**

Extend only the verified owner-console branch that currently adds `kagemusha`; require the same effective `owner_console` definition used by role resolution, append `trello` if and only if enabled, and deduplicate the raw connector list.

- [ ] **Step 6: Preserve result and failure semantics**

In `context-compile-tool.test.ts`, construct a real `GatewayToolExecutor` with the real context-compile service and a controllable raw connector query adapter. Assert an enabled Trello query with no evidence succeeds with an empty packet/evidence result. Make the Trello adapter throw and assert Code-Act returns an explicit tool failure. Do not use a mocked GatewayToolExecutor for these two boundary tests and do not add fallback data.

- [ ] **Step 7: Run envelope tests and verify GREEN**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/cli/runtime/envelope-bootstrap.test.ts tests/envelope/reactive-config.test.ts tests/envelope/code-act-context.test.ts tests/agent/context-compile-tool.test.ts tests/envelope/trust-boundary-negative.test.ts`

Expected: all tests pass.

- [ ] **Step 8: Commit the boundary unit**

Before committing, run `pnpm --filter @jungjaehoon/mama-os typecheck` and expect exit code 0.

```bash
git add packages/standalone/src/cli/runtime/envelope-bootstrap.ts packages/standalone/src/envelope/reactive-config.ts packages/standalone/tests/cli/runtime/envelope-bootstrap.test.ts packages/standalone/tests/envelope/reactive-config.test.ts packages/standalone/tests/envelope/code-act-context.test.ts packages/standalone/tests/agent/context-compile-tool.test.ts
git commit -m "feat: admit Trello for verified owner evidence"
```

## Chunk 3: Cross-backend proof and runtime activation

### Task 6: Claude/Codex parity regression suite

**Files:**

- Modify: `packages/standalone/tests/code-act/integration.test.ts`
- Modify: `packages/standalone/tests/gateways/tool-ad-coherence.test.ts`
- Modify: `packages/standalone/tests/agent/agent-loop.test.ts`

- [ ] **Step 1: Add parity assertions**

For identical role, tier, blocks, and disallowed inputs, run real Claude-mode and Codex-mode AgentLoop instances with capturing runners. Parse the declarations actually present in each effective system prompt and compare advertised inner names, every parameter name/type/required flag, and return type. Do not compare two direct calls to the projector. Separately assert the intended outer difference: Claude text protocol versus exactly one Codex native `code_act` definition.

- [ ] **Step 2: Run parity tests and verify they pass**

Run: `pnpm --filter @jungjaehoon/mama-os exec vitest run tests/code-act/integration.test.ts tests/gateways/tool-ad-coherence.test.ts tests/agent/agent-loop.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Run standalone typecheck and build**

Run: `pnpm --filter @jungjaehoon/mama-os typecheck`

Expected: exit code 0.

Run: `pnpm --filter @jungjaehoon/mama-os build`

Expected: exit code 0.

- [ ] **Step 4: Run repository verification gates**

Run: `pnpm test`

Expected: exit code 0 with the single-fork Vitest configuration unchanged.

Run: `pnpm build`

Expected: exit code 0.

Run: `pnpm lint`

Expected: exit code 0.

Run: `pnpm format:check`

Expected: exit code 0.

- [ ] **Step 5: Commit regression coverage**

```bash
git add packages/standalone/tests/code-act/integration.test.ts packages/standalone/tests/gateways/tool-ad-coherence.test.ts packages/standalone/tests/agent/agent-loop.test.ts
git commit -m "test: prove Claude and Codex Code-Act parity"
```

### Task 7: Runtime activation and evidence

**Files:**

- Verify: `~/.mama/config.yaml`
- Verify: `~/.mama/connectors.json`
- Verify: MAMA runtime status and logs

- [ ] **Step 1: Inspect effective runtime settings**

Run `pnpm --dir packages/standalone start status` and `launchctl print gui/$(id -u)/com.mama.server` first. Confirm the active front-door agent does not explicitly set `useCodeAct: false`, Trello is enabled, and no customized owner role removes `code_act`. Treat a successful `launchctl print` as launchd ownership; otherwise require `Watchdog: Active` before using the repository CLI restart. Use only the proven owner and never start a competing daemon. Do not expose connector credentials in output.

- [ ] **Step 2: Restart the built runtime**

If launchd owns the runtime, run:

```bash
launchctl kickstart -k gui/$(id -u)/com.mama.server
```

If the built-in watchdog owns it, run:

```bash
pnpm --dir packages/standalone start stop
pnpm --dir packages/standalone start start
```

Each command must exit 0 before proceeding. If neither launchd nor the built-in watchdog proves ownership, do not restart; report the runtime activation step as blocked rather than killing or duplicating the process.

- [ ] **Step 3: Confirm runtime status**

Run: `pnpm --dir packages/standalone start status`

Expected status fields: `Status: Running`, `Backend: codex`, and `Codex transport: app-server`.

- [ ] **Step 4: Inspect logs for connector health**

Inspect only the post-restart portion of `~/.mama/logs/daemon.log`. Confirm the Trello connector initialization/polling marker and absence of Code-Act sandbox or dynamic-tool errors. Codex app-server is lazy and has no guaranteed startup marker, so do not claim initialization from this log; prove it after a live request through persisted successful native-tool traces.

- [ ] **Step 5: Exercise verified owner Trello evidence access**

Send an authorized owner Telegram direct-message request that requires Trello evidence. Read the resulting persisted tool-trace records and confirm ordered successful records for outer `code_act` followed by nested `context_compile`, with the same model-run/provenance chain; this is the Codex app-server initialization proof. Resolve the returned `context_packet_id` through the existing trusted context-packet lookup and count only source references whose connector is `trello`, without printing evidence content. Confirm no direct Trello API function and no Kagemusha Trello function is used. Report only connector name, trace/model-run/gateway-call/context-packet IDs, execution status, and source-reference count—never Trello content or credentials. Do not depend on nonexistent dynamic-tool or context-compile log markers.

If no authorized owner Telegram request can be sent from this environment, leave this checkbox incomplete and report it as an operational verification gap. Automated code/test completion may still be reported, but live end-to-end completion may not.

- [ ] **Step 6: Record final evidence**

Report changed files, exact verification commands and exit codes, test counts, runtime status, and the connector path observed. If live message injection is unavailable, report that limitation separately without weakening the code/test completion claim.
