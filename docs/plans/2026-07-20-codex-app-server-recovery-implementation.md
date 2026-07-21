# Codex App-Server Recovery Implementation Plan

> Superseded for runtime architecture by
> `2026-07-20-codex-app-server-multiplex-refactor.md`. The MCP rollback transport described below
> was removed; Codex app-server is now the only supported Codex transport.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents
> available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Replace the default Codex MCP transport with the current Codex app-server protocol while
preserving the `codex-mcp` configuration contract, durable thread resume, bounded resources, and an
explicit MCP rollback switch.

**Architecture:** A low-level serial app-server runner owns one Codex thread and JSON-RPC process. A
`CodexRuntimeProcess` adapter routes stable session keys to bounded low-level runners. Atomic per-key
registry files preserve thread IDs and immutable policy fingerprints. All processes share a managed
Codex home and isolated home, while runner-specific MCP configuration is passed through non-secret
process-local overrides.

**Tech Stack:** TypeScript, Node.js child processes and filesystem APIs, Codex app-server JSON-RPC,
Vitest single-fork subprocess tests, pnpm workspaces.

**Design:** `docs/plans/2026-07-20-codex-app-server-recovery-design.md`

---

## Chunk 1: Storage and Secure Process Configuration

### Task 1: Durable Thread Registry

**Files:**

- Create: `packages/standalone/src/agent/codex-thread-registry.ts`
- Create: `packages/standalone/tests/agent/codex-thread-registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Cover these behaviors with real temporary directories:

```typescript
const registry = new CodexThreadRegistry({ rootDir });
registry.save({
  sessionKey: 'discord:channel-1',
  threadId: 'thread_1',
  model: 'gpt-5.4',
  cwd: '/workspace',
  systemPromptFingerprint: sha256('rules'),
  mcpConfigFingerprint: sha256('{}'),
});

expect(registry.load('discord:channel-1')?.threadId).toBe('thread_1');
expect(modeOf(rootDir)).toBe(0o700);
expect(modeOf(recordPath)).toBe(0o600);
```

Also test atomic concurrent writes for different keys, explicit removal of one key, invalid JSON,
schema-version mismatch, stored-key/digest mismatch, symlinked directory/record rejection, and no
silent fallback.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/standalone
pnpm vitest run tests/agent/codex-thread-registry.test.ts
```

Expected: FAIL because `codex-thread-registry.ts` does not exist.

- [ ] **Step 3: Implement the minimal registry**

Implement typed records without `any`:

```typescript
export interface CodexThreadRecord {
  version: 1;
  sessionKey: string;
  keyHash: string;
  threadId: string;
  model: string;
  cwd: string;
  systemPromptFingerprint: string;
  mcpConfigFingerprint: string;
  createdAt: string;
  lastUsedAt: string;
}
```

Use SHA-256 filenames, `lstatSync` symlink checks, `0700` directories, `0600` files, unique sibling
temporary files, and `renameSync`. Parse unknown JSON with explicit property guards. Export a
`fingerprintText(value: string): string` helper so runner policy checks use the same normalization.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 command. Expected: all registry tests pass with no warnings.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/standalone/src/agent/codex-thread-registry.ts \
  packages/standalone/tests/agent/codex-thread-registry.test.ts
git commit -m "feat(standalone): persist Codex app-server threads"
```

### Task 2: Managed Home and Secret-Safe MCP Overrides

**Files:**

- Modify: `packages/standalone/src/agent/codex-home.ts`
- Modify: `packages/standalone/tests/agent/codex-home.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Add tests for:

- an invariant `buildMAMACodexAppServerConfig()` with no runner MCP entries;
- conversion of regular and Code-Act-only MCP JSON into deterministic app-server `-c` arguments;
- exclusion of the `mama` MCP server;
- environment names in `env_vars` arguments and values only in returned child environment;
- sensitive values absent from arguments and formatted diagnostic output;
- conflicting values for one environment name rejected;
- malformed config, invalid server names, non-string commands/args/env rejected.
- existing stdio and HTTP server shapes: `cwd`, `experimental_environment`, `url`, `auth`,
  `bearer_token_env_var`, literal and environment-backed headers, `required`,
  `supports_parallel_tool_calls`, `environment_id`, startup/tool timeouts, enabled state,
  allowed/disabled tool policy, `default_tools_approval_mode`, per-tool approval mode, `scopes`, and
  `oauth_resource`;
- approved `_installedBy` metadata ignored when computing launch settings;
- unsupported fields rejected instead of silently disappearing.

Target API:

```typescript
const launch = buildCodexAppServerLaunchConfig(mcpConfigPath, process.env);
expect(launch.args).toContain('-c');
expect(launch.args.join(' ')).not.toContain('secret-token');
expect(launch.env.CODE_ACT_TOKEN).toBe('secret-token');
expect(launch.fingerprint).toMatch(/^[a-f0-9]{64}$/);
```

- [ ] **Step 2: Run tests and verify RED**

```bash
cd packages/standalone
pnpm vitest run tests/agent/codex-home.test.ts
```

Expected: FAIL because the app-server builder is missing.

- [ ] **Step 3: Implement the builder and invariant home config**

Retain `buildMAMACodexConfig()` for MCP rollback. Add focused app-server helpers. Serialize TOML
values deterministically, pass arguments as an array, merge secret values into a copied child
environment, and fingerprint the normalized effective server policy without logging its values.
Use strict record guards and throw `Error` objects for every invalid entry. Support both stdio and
HTTP Codex MCP fields already accepted by MAMA, forwarding bearer/header secrets only by validated
environment-variable name. Ignore only approved installer metadata such as `_installedBy`.

Convert every literal HTTP header value into a deterministic generated child-environment name and
emit only `env_http_headers = { header = env_name }` through `-c`; no header value may appear in argv
or process listings. Preserve already environment-backed headers and `bearer_token_env_var` names.
Reject name collisions or contradictory values. Include every effective field in the normalized MCP
policy fingerprint.

Run simultaneous full-config and Code-Act-only builder calls and prove their argument arrays and
environments stay isolated. Builder-level errors must redact environment and header values.

- [ ] **Step 4: Run Task 2 tests and existing Codex-home callers**

```bash
cd packages/standalone
pnpm vitest run tests/agent/codex-home.test.ts tests/agent/codex-auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/standalone/src/agent/codex-home.ts \
  packages/standalone/tests/agent/codex-home.test.ts
git commit -m "feat(standalone): build secure app-server launch config"
```

## Chunk 2: App-Server Transport

### Task 3: Restore and Modernize the Low-Level App-Server Runner

**Files:**

- Create: `packages/standalone/src/agent/codex-app-server-process.ts`
- Create: `packages/standalone/tests/agent/codex-app-server-process.test.ts`
- Reference only: Git object
  `53c10ab74edd93ad809fae2088122774bafd4a01:packages/standalone/src/multi-agent/codex-app-server-runtime-process.ts`

- [ ] **Step 1: Build a real fake-Codex subprocess fixture and failing protocol tests**

The executable must capture argv/environment and speak newline-delimited JSON-RPC. Tests cover:

- `initialize` then `initialized`;
- `thread/start` for an absent registry record;
- streaming `item/agentMessage/delta`, token usage, and successful `turn/completed`;
- `thread/resume` after a new runner reads an existing record;
- instruction-source validation on start and resume;
- approval request decline for command, file-change, and permissions;
- exact responses for `item/tool/requestUserInput`, `mcpServer/elicitation/request`,
  `item/tool/call`, legacy `applyPatchApproval`, legacy `execCommandApproval`, and an unknown server
  request; no request may hang waiting for a user in the headless daemon;
- failed/interrupted turns, request timeout, process exit, malformed JSON, JSON-RPC error;
- late, duplicate, and cross-thread completion ignored;
- auth refresh restart;
- policy fingerprint mismatch rejected until explicit reset;
- repeated reset uses the same shared `HOME` and `CODEX_HOME` paths.
- response IDs match request IDs, notification `threadId` and `turnId` must match the active turn,
  and every current `TurnStatus` (`completed`, `interrupted`, `failed`, `inProgress`) is handled.
- permissions denial uses the current response shape
  `{ permissions: {}, scope: 'turn', strictAutoReview: true }`.
- a fake child echoes injected MCP secrets to stderr; argv capture, errors, logs, and retained stderr
  tails must redact the value;
- a fake child ignores SIGTERM; the runner escalates to SIGKILL within the configured grace period and
  leaves no live child, timer, listener, or multiply-settled pending request.

Use these schema-valid headless responses:

```typescript
itemToolRequestUserInput: { answers: {} }
mcpServerElicitationRequest: { action: 'decline', content: null, _meta: null }
dynamicToolCall: {
  success: false,
  contentItems: [{ type: 'inputText', text: 'Native app-server tools are disabled by MAMA' }],
}
commandExecutionApproval: { decision: 'decline' }
fileChangeApproval: { decision: 'decline' }
legacyApplyPatchApproval: { decision: 'denied' }
legacyExecCommandApproval: { decision: 'denied' }
unknownServerRequest: JSON-RPC error code -32601
```

Keep the Vitest fixture hermetic: it must not invoke or require an installed Codex binary. Protocol
drift is checked by a separate local preflight in Task 7, pinned to `codex-cli 0.144.0`.

Use current protocol shapes generated by `codex app-server generate-ts`, notably:

```typescript
initialize: { clientInfo, capabilities: null }
thread/start: { model, cwd, approvalPolicy: 'never', sandbox, baseInstructions, config }
thread/resume: { threadId, model, cwd, approvalPolicy: 'never', sandbox }
turn/start: { threadId, input: [{ type: 'text', text, text_elements: [] }] }
```

- [ ] **Step 2: Run the new test and verify RED**

```bash
cd packages/standalone
pnpm vitest run tests/agent/codex-app-server-process.test.ts
```

Expected: FAIL because the runner module is missing.

- [ ] **Step 3: Implement the minimal runner from the historical baseline**

Selectively port JSON-RPC request tracking, stdout/stderr handling, auth fingerprinting, executable
resolution, notification parsing, and approval denial. Replace per-session homes with constructor
options:

```typescript
interface CodexAppServerProcessOptions {
  sessionKey: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  command?: string;
  requestTimeout?: number;
  codexHome?: string;
  isolatedHome?: string;
  registryRoot?: string;
  mcpConfigPath?: string;
}
```

Use `~/.mama/.codex`, `~/.mama/codex-runtime/home`, and the per-key registry by default. Write only
the invariant config into the managed Codex home. Use process-local launch arguments and environment
from Task 2. Send `initialized` after successful initialization. Validate immutable thread policy
before resume. Never catch an error and return an empty response.

Prepare shared config and synchronized auth with atomic sibling-write/rename operations and `0600`
permissions. Overlapping runner starts must produce identical intact files. On timeout or `stop()`,
settle every pending operation exactly once, remove readline/process listeners, clear timers, send
SIGTERM, and escalate to SIGKILL after a fixed bounded grace period if the child ignores termination.
The kill timer must be unref'd and cancelled when the child exits.

- [ ] **Step 4: Run the focused protocol tests and verify GREEN**

Run the Task 3 command. Expected: all subprocess protocol tests pass.

- [ ] **Step 5: Run type checking for the new transport**

```bash
cd packages/standalone
pnpm typecheck
```

Expected: exit 0 with no `any` or interface errors.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/standalone/src/agent/codex-app-server-process.ts \
  packages/standalone/tests/agent/codex-app-server-process.test.ts
git commit -m "feat(standalone): restore Codex app-server transport"
```

## Chunk 3: Adapter, Configuration, and Stable Routing

### Task 4: Bounded Multi-Session Adapter and MCP Rollback

**Files:**

- Modify: `packages/standalone/src/agent/model-runner.ts`
- Modify: `packages/standalone/src/multi-agent/runtime-process.ts`
- Modify: `packages/standalone/tests/agent/model-runner.test.ts`
- Modify: `packages/standalone/tests/multi-agent/codex-runtime-runner.test.ts`

- [ ] **Step 1: Write a failing stable-routing type contract test**

Add a type assertion before changing production types:

```typescript
expectTypeOf<PromptOptions>().toMatchTypeOf<{ sessionKey?: string }>();
```

Run:

```bash
cd packages/standalone
pnpm vitest run tests/agent/model-runner.test.ts
pnpm typecheck
```

Expected: type checking fails because `sessionKey` is absent.

- [ ] **Step 2: Add `PromptOptions.sessionKey` and verify the contract GREEN**

Add the optional stable routing key to `model-runner.ts`, rerun Step 1, and require exit 0.

- [ ] **Step 3: Write failing adapter contract tests**

Extend the existing real-runner tests with fake Codex executables. Cover:

- default transport `app-server` and explicit `mcp` delegation;
- different stable keys executing concurrently;
- same-key busy rejection;
- `resumeSession: false` resetting only one key;
- adapter metrics aggregated at its prompt boundary;
- `isHealthy`, idempotent `stop`, and default-key `getSessionId` behavior;
- dead child eviction followed by registry-backed resume;
- idle eviction, LRU eviction, all-busy capacity rejection, and timer cancellation.
- per-call model, system prompt, request timeout, resolved-CWD policy, reset, and missing-key errors;
- `setSessionId` changing only the default route and `setSystemPrompt` affecting only new/reset
  threads;
- policy mismatch errors preserve the existing registry record.

Add options:

```typescript
type CodexTransport = 'app-server' | 'mcp';

interface CodexRuntimeProcessOptions {
  transport?: CodexTransport;
  defaultSessionKey?: string;
  maxRunners?: number;
  idleTimeoutMs?: number;
  // retain existing options
}
```

- [ ] **Step 4: Run adapter tests and verify RED**

```bash
cd packages/standalone
pnpm vitest run tests/multi-agent/codex-runtime-runner.test.ts
```

Expected: new app-server routing assertions fail.

- [ ] **Step 5: Implement adapter routing**

Keep `backendType = 'codex-mcp'`. In app-server mode route `PromptOptions.sessionKey` or the explicit
default key to a low-level runner. Track request metrics in the adapter. Store runner last-used time,
evict only idle runners, preserve registry records, and unref the cleanup timer. In MCP mode preserve
the existing `CodexMCPProcess` behavior. Unknown transports throw before any child starts.

Resolve `cwd` before policy comparison. Forward each per-call model and timeout. Reject missing keys,
attempted system-prompt mutation, and immutable policy changes. Treat `resumeSession: false` as the
only reset authorization. `setSessionId` changes the default routing key without touching in-flight
routes; `setSystemPrompt` updates the default used only by new/reset threads.

- [ ] **Step 6: Run adapter and low-level tests**

```bash
cd packages/standalone
pnpm vitest run tests/multi-agent/codex-runtime-runner.test.ts \
  tests/agent/codex-app-server-process.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/standalone/src/agent/model-runner.ts \
  packages/standalone/src/multi-agent/runtime-process.ts \
  packages/standalone/tests/agent/model-runner.test.ts \
  packages/standalone/tests/multi-agent/codex-runtime-runner.test.ts
git commit -m "feat(standalone): route Codex sessions through app-server"
```

### Task 5: Wire Stable Session Keys and Transport Configuration End-to-End

**Files:**

- Modify: `packages/standalone/src/agent/agent-loop.ts`
- Modify: `packages/standalone/src/agent/types.ts`
- Modify: `packages/standalone/src/cli/config/types.ts`
- Modify: `packages/standalone/src/cli/config/config-manager.ts`
- Modify: `packages/standalone/src/cli/runtime/agent-loop-init.ts`
- Modify: `packages/standalone/src/cli/runtime/gateway-init.ts`
- Modify: `packages/standalone/src/cli/commands/run.ts`
- Modify: `packages/standalone/src/cli/commands/status.ts`
- Create: `packages/standalone/tests/cli/commands/status.test.ts`
- Modify: `packages/standalone/src/multi-agent/types.ts`
- Modify: `packages/standalone/src/multi-agent/agent-process-manager.ts`
- Modify relevant tests under `packages/standalone/tests/agent/`, `tests/cli/`, and
  `tests/multi-agent/`
- Create: `packages/standalone/tests/cli/run-command-codex.test.ts`

- [ ] **Step 1: Write failing propagation and validation tests**

Assert:

- `PromptOptions.sessionKey` receives `buildChannelKey(source, channelId)` while the random
  `sessionId` remains available to Claude;
- `freshSession` sends `resumeSession: false` and resets the correct Codex key;
- config accepts only `app-server | mcp` and defaults missing `codex_transport` to `app-server`;
- `AgentLoop` and `AgentProcessManager` select the configured transport;
- `AgentProcessManager` passes its full channel key as `defaultSessionKey`;
- legacy backend `codex` and canonical `codex-mcp` both honor the selector;
- Claude ignores the Codex transport setting;
- Code-Act agents retain their agent-specific `mcpConfigPath`.
- generated Code-Act-only configuration uses atomic rename and mode `0600` under concurrent agent
  startup, or is replaced with an equivalent in-memory normalized config path;
- Codex resume/policy errors are surfaced without entering the Claude-only automatic session reset
  branch at `agent-loop.ts:1255-1290`;
- `mama run` passes `codex_transport` and stable key `cli:run` so repeated CLI invocations can resume.
- `mama status` prints `Codex transport: app-server|mcp` whenever either Codex backend alias is active.

- [ ] **Step 2: Run selected tests and verify RED**

```bash
cd packages/standalone
pnpm vitest run tests/agent/agent-loop.test.ts tests/cli/config-manager.test.ts \
  tests/multi-agent/agent-process-manager-env.test.ts tests/cli/run-command-codex.test.ts \
  tests/cli/commands/status.test.ts
```

Expected: failures for missing transport and stable session-key propagation.

- [ ] **Step 3: Implement the minimum propagation changes**

Add `CodexTransport = 'app-server' | 'mcp'` and `codex_transport?: CodexTransport` to config/runtime
option types, validate it, default at the
construction boundary, pass it through CLI initialization, and provide the stable key on every Codex
prompt. Remove the obsolete warning that `freshSession` cannot reset a Codex thread once the new
contract is active. Update user-facing comments from “Codex MCP protocol” to the compatible Codex
backend wording where behavior changed.

Restrict the existing automatic “retry with new session” block to Claude-specific CLI errors. Codex
thread-not-found, resume, or policy failures must propagate; only an explicit caller reset may replace
the registered thread. Make Code-Act derived configuration writes atomic with unique temporary files,
rename, symlink rejection, and `0600` permissions unless the implementation eliminates the file.

- [ ] **Step 4: Run focused tests and type checking**

```bash
cd packages/standalone
pnpm vitest run tests/agent/agent-loop.test.ts tests/cli/config-manager.test.ts \
  tests/multi-agent/agent-process-manager-env.test.ts tests/multi-agent/codex-runtime-runner.test.ts \
  tests/cli/run-command-codex.test.ts tests/cli/commands/status.test.ts
pnpm typecheck
```

Expected: exit 0.

- [ ] **Step 5: Commit Task 5**

```bash
git add packages/standalone/src packages/standalone/tests
git commit -m "feat(standalone): configure Codex app-server routing"
```

## Chunk 4: Operational Visibility and Verification

### Task 6: Report Legacy App-Server Storage Without Deleting It

**Files:**

- Create: `packages/standalone/src/agent/codex-legacy-storage.ts`
- Create: `packages/standalone/tests/agent/codex-legacy-storage.test.ts`
- Modify: `packages/standalone/src/cli/commands/status.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/tests/cli/commands/status.test.ts`
- Create: `packages/standalone/tests/cli/start-command.test.ts`

- [ ] **Step 1: Write failing storage inspection tests**

Use temporary directories to verify absent, empty, and populated legacy roots. The inspector returns
the resolved root, immediate session-directory count, recursive byte size, `exists`, `complete`, and
`truncated`. It must reject symlink roots and never delete or mutate contents. Bound traversal to
100,000 entries or 10 seconds, whichever comes first. A partial byte count must be labeled partial;
it must never be presented as the measured total. Status output labels the root as unused legacy
storage and prints no cleanup claim. Startup performs existence/count detection only and emits one
warning without a recursive scan.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd packages/standalone
pnpm vitest run tests/agent/codex-legacy-storage.test.ts \
  tests/cli/commands/status.test.ts tests/cli/start-command.test.ts
```

Expected: the new inspection and startup-warning contracts fail before implementation.

- [ ] **Step 3: Implement read-only inspection and status output**

Use `lstatSync`, `readdirSync`, and bounded explicit traversal. Throw on symlinks or unreadable paths;
do not return dummy zero data for failures. Startup emits one warning when the legacy root exists;
status performs the potentially slower size measurement on demand.

- [ ] **Step 4: Run Task 6 tests and verify GREEN**

Run the Task 6 command with the confirmed status-test filename. Expected: PASS and source fixtures
remain present after inspection.

- [ ] **Step 5: Commit Task 6**

```bash
git add packages/standalone/src/agent/codex-legacy-storage.ts \
  packages/standalone/src/cli/commands/status.ts \
  packages/standalone/src/cli/commands/start.ts packages/standalone/tests
git commit -m "feat(standalone): report legacy Codex session storage"
```

### Task 7: Full Verification and Local Runtime Cutover

**Files:**

- Modify only if required by verified behavior: `packages/standalone/src/**`
- Runtime configuration outside Git: `~/.mama/config.yaml`

- [ ] **Step 1: Run the complete focused Codex suite**

```bash
cd packages/standalone
pnpm vitest run tests/agent/codex-thread-registry.test.ts \
  tests/agent/codex-home.test.ts \
  tests/agent/codex-app-server-process.test.ts \
  tests/multi-agent/codex-runtime-runner.test.ts \
  tests/agent/agent-loop.test.ts \
  tests/cli/config-manager.test.ts \
  tests/multi-agent/agent-process-manager-env.test.ts \
  tests/agent/codex-legacy-storage.test.ts \
  tests/cli/run-command-codex.test.ts \
  tests/cli/commands/status.test.ts \
  tests/cli/start-command.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run standalone verification**

```bash
cd packages/standalone
pnpm typecheck
pnpm test
pnpm build
```

Expected: every command exits 0.

- [ ] **Step 3: Run root verification**

```bash
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
pnpm test
pnpm build
```

Expected: every command exits 0. Do not change Vitest parallelism.

- [ ] **Step 4: Review source/build consistency**

Safely remove only the ignored standalone build output, rebuild, and verify source/build parity:

```bash
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
test "$(pwd)" = "$repo_root"
git check-ignore -q packages/standalone/dist
find packages/standalone/dist -mindepth 1 -delete
pnpm --dir packages/standalone build
test -f packages/standalone/dist/agent/codex-app-server-process.js
test ! -e packages/standalone/dist/multi-agent/codex-app-server-runtime-process.js
git status --short --ignored packages/standalone/dist
```

Every assertion must exit 0. Do not use `pnpm clean` because it also removes `node_modules`.

- [ ] **Step 5: Back up runtime configuration and switch transport**

Stop MAMA first and create a permission-restricted backup without printing contents:

```bash
repo_root="$(git rev-parse --show-toplevel)"
mama_state_root="${HOME}/.mama"
cd "$repo_root"
if pnpm --dir packages/standalone start -- status | rg -q 'Status: Running'; then
  pnpm --dir packages/standalone start -- stop
fi
if [ -d "$mama_state_root/codex-app-server" ]; then
  find "$mama_state_root/codex-app-server" -mindepth 1 -maxdepth 1 -print \
    | sort > /tmp/mama-legacy-codex-before.txt
else
  printf 'absent\n' > /tmp/mama-legacy-codex-before.txt
fi
backup_dir="$mama_state_root/backups/codex-app-server-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
cp -p "$mama_state_root/config.yaml" "$backup_dir/config.yaml"
if [ -d "$mama_state_root/.codex" ]; then
  cp -Rp "$mama_state_root/.codex" "$backup_dir/managed-codex"
fi
chmod -R go-rwx "$backup_dir"
test "$(stat -f '%Lp' "$backup_dir")" = "700"
ln -sfn "$backup_dir" "$mama_state_root/backups/codex-app-server-latest"
```

Record the resolved `backup_dir` for rollback without displaying file contents. Use `apply_patch` on
`~/.mama/config.yaml` to set:

```yaml
agent:
  backend: codex-mcp
  codex_transport: app-server
```

Query `model/list` before editing the model:

```bash
set -o pipefail
test "$(codex --version)" = "codex-cli 0.144.0"
schema_dir=$(mktemp -d)
codex app-server generate-ts --out "$schema_dir"
rg -q 'thread/resume' "$schema_dir/ClientRequest.ts"
rg -q 'item/tool/requestUserInput' "$schema_dir/ServerRequest.ts"
model_response=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"mama-verifier","title":"MAMA verifier","version":"0.23.0"},"capabilities":null}}' \
  '{"jsonrpc":"2.0","method":"initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"model/list","params":{"limit":100}}' \
  | codex app-server --stdio \
  | jq -c 'select(.id == 2 and .result != null)')
test -n "$model_response"
jq -e '.id == 2 and (.result.data | length > 0)' <<<"$model_response" >/dev/null
```

Require one `id:2` result and choose the configured current model only if listed. Do not delete
legacy storage.

- [ ] **Step 6: Restart and verify the live connection**

With MAMA stopped, execute two independent CLI processes using the same stable `cli:run` key:

```bash
repo_root="$(git rev-parse --show-toplevel)"
mama_state_root="${HOME}/.mama"
cd "$repo_root"
pnpm --dir packages/standalone start -- run 'Reply exactly: MAMA_CODEX_TURN_1'
thread_before=$(jq -r 'select(.sessionKey == "cli:run") | .threadId' \
  "$mama_state_root"/codex-runtime/threads/*.json | tail -1)
test -n "$thread_before" && test "$thread_before" != "null"
pnpm --dir packages/standalone start -- run 'Reply exactly: MAMA_CODEX_TURN_2'
thread_after=$(jq -r 'select(.sessionKey == "cli:run") | .threadId' \
  "$mama_state_root"/codex-runtime/threads/*.json | tail -1)
test "$thread_before" = "$thread_after"
```

Then verify daemon restart commands and status:

```bash
set -o pipefail
repo_root="$(git rev-parse --show-toplevel)"
mama_state_root="${HOME}/.mama"
cd "$repo_root/packages/standalone"
wait_for_mama_health() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if curl -fsS http://127.0.0.1:3847/health >/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo 'MAMA health endpoint was not ready within 60 seconds' >&2
  return 1
}
send_daemon_prompt() {
  VERIFY_PROMPT="$1" pnpm --dir "$repo_root/packages/standalone" exec node <<'NODE'
const WebSocket = require('ws');
const token = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
const url = new URL('ws://127.0.0.1:3847/ws?sessionId=codex-live-verification');
if (token) url.searchParams.set('token', token);
const ws = new WebSocket(url);
let attached = false;
let output = '';
const timer = setTimeout(() => {
  console.error('viewer prompt timed out');
  ws.terminate();
  process.exitCode = 1;
}, 300000);
ws.on('open', () => ws.send(JSON.stringify({
  type: 'attach', sessionId: 'codex-live-verification', osAgentMode: true, language: 'ko'
})));
ws.on('message', (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type === 'attached' && !attached) {
    attached = true;
    ws.send(JSON.stringify({
      type: 'send',
      sessionId: 'codex-live-verification',
      content: process.env.VERIFY_PROMPT,
      viewerContext: { currentTab: 'verification' }
    }));
  } else if (message.type === 'stream') {
    output += message.content || '';
  } else if (message.type === 'error') {
    clearTimeout(timer);
    console.error(message.error || 'viewer error');
    ws.close();
    process.exitCode = 1;
  } else if (message.type === 'stream_end') {
    clearTimeout(timer);
    if (!output.trim()) process.exitCode = 1;
    ws.close();
  }
});
ws.on('error', (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
NODE
}

cd "$repo_root"
pnpm --dir packages/standalone start -- start
wait_for_mama_health
pnpm --dir packages/standalone start -- status | tee /tmp/mama-codex-status.txt
rg -q 'Status: Running' /tmp/mama-codex-status.txt
rg -q 'Backend: codex-mcp' /tmp/mama-codex-status.txt
rg -q 'Codex transport: app-server' /tmp/mama-codex-status.txt
send_daemon_prompt 'Reply exactly: MAMA_DAEMON_TURN_1'
send_daemon_prompt 'Reply exactly: MAMA_DAEMON_TURN_2'
daemon_thread_before=$(jq -r 'select(.sessionKey == "viewer:mama_os_main") | .threadId' \
  "$mama_state_root"/codex-runtime/threads/*.json | tail -1)
test -n "$daemon_thread_before" && test "$daemon_thread_before" != "null"
pnpm --dir packages/standalone start -- stop
pnpm --dir packages/standalone start -- start
wait_for_mama_health
pnpm --dir packages/standalone start -- status | tee /tmp/mama-codex-status-restarted.txt
rg -q 'Status: Running' /tmp/mama-codex-status-restarted.txt
rg -q 'Backend: codex-mcp' /tmp/mama-codex-status-restarted.txt
rg -q 'Codex transport: app-server' /tmp/mama-codex-status-restarted.txt
send_daemon_prompt 'Reply exactly: MAMA_DAEMON_TURN_3'
daemon_thread_after=$(jq -r 'select(.sessionKey == "viewer:mama_os_main") | .threadId' \
  "$mama_state_root"/codex-runtime/threads/*.json | tail -1)
test "$daemon_thread_before" = "$daemon_thread_after"
```

Inspect service logs for authentication/schema failures using the configured logging path without
printing auth/config files. The `viewer:mama_os_main` equality proves daemon-channel resume across
restart. Stop the daemon and verify the independent CLI route after another process restart:

```bash
mama_state_root="${HOME}/.mama"
pnpm --dir packages/standalone start -- stop
pnpm --dir packages/standalone start -- run 'Reply exactly: MAMA_CODEX_TURN_3'
cli_thread_after_restart=$(jq -r 'select(.sessionKey == "cli:run") | .threadId' \
  "$mama_state_root"/codex-runtime/threads/*.json | tail -1)
test "$thread_before" = "$cli_thread_after_restart"
if [ -d "$mama_state_root/codex-app-server" ]; then
  find "$mama_state_root/codex-app-server" -mindepth 1 -maxdepth 1 -print \
    | sort > /tmp/mama-legacy-codex-after.txt
else
  printf 'absent\n' > /tmp/mama-legacy-codex-after.txt
fi
cmp -s /tmp/mama-legacy-codex-before.txt /tmp/mama-legacy-codex-after.txt
du -sh "$mama_state_root/.codex" "$mama_state_root/codex-runtime"
```

- [ ] **Step 7: Exercise explicit rollback only if live verification fails**

Use `apply_patch` to set `agent.codex_transport: mcp`, then run:

```bash
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
if pnpm --dir packages/standalone start -- status | rg -q 'Status: Running'; then
  pnpm --dir packages/standalone start -- stop
fi
pnpm --dir packages/standalone start -- start
for _attempt in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3847/health >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3847/health >/dev/null
pnpm --dir packages/standalone start -- status | tee /tmp/mama-mcp-rollback-status.txt
rg -q 'Status: Running' /tmp/mama-mcp-rollback-status.txt
rg -q 'Backend: codex-mcp' /tmp/mama-mcp-rollback-status.txt
rg -q 'Codex transport: mcp' /tmp/mama-mcp-rollback-status.txt
```

If the entire configuration must be restored, the approved full rollback explicitly selects Claude.
Use these guarded commands; immediately after restoring `config.yaml`, use `apply_patch` on
`~/.mama/config.yaml` to set `agent.backend: claude` before the restart command:

```bash
set -o pipefail
repo_root="$(git rev-parse --show-toplevel)"
mama_state_root="${HOME}/.mama"
cd "$repo_root"
backup_dir=$(realpath "$mama_state_root/backups/codex-app-server-latest")
case "$backup_dir" in
  "$mama_state_root"/backups/codex-app-server-*) ;;
  *) echo 'Invalid rollback backup path' >&2; exit 1 ;;
esac
test -f "$backup_dir/config.yaml"
if pnpm --dir packages/standalone start -- status | rg -q 'Status: Running'; then
  pnpm --dir packages/standalone start -- stop
fi
cp -p "$backup_dir/config.yaml" "$mama_state_root/config.yaml"
chmod 600 "$mama_state_root/config.yaml"
if [ -d "$backup_dir/managed-codex" ]; then
  test ! -e "$backup_dir/post-failure-managed-codex"
  if [ -d "$mama_state_root/.codex" ]; then
    mv "$mama_state_root/.codex" "$backup_dir/post-failure-managed-codex"
  fi
  cp -Rp "$backup_dir/managed-codex" "$mama_state_root/.codex"
  chmod -R go-rwx "$mama_state_root/.codex"
fi
pnpm --dir packages/standalone start -- start
for _attempt in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3847/health >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:3847/health >/dev/null
pnpm --dir packages/standalone start -- status | tee /tmp/mama-rollback-status.txt
rg -q 'Status: Running' /tmp/mama-rollback-status.txt
rg -q 'Backend: claude' /tmp/mama-rollback-status.txt
```

The move preserves the failed managed Codex state for diagnosis. Report the original app-server
error. Do not silently perform fallback in code.

- [ ] **Step 8: Final code review and handoff**

Dispatch a whole-diff reviewer after all per-task spec and quality reviews. Resolve every blocking
finding, rerun the affected focused tests, then repeat the full verification commands before making
any completion claim.
