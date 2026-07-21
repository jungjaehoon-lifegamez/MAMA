# Codex app-server multiplex refactor

## Decision

MAMA uses Codex app-server as its only Codex transport. One runtime owns one app-server
connection, initializes it once, and maps MAMA session keys to durable Codex threads on that
connection.

The former `codex mcp-server` transport and `agent.codex_transport` selector are removed. MCP
configuration used by Codex to expose external tools is unrelated and remains supported.

## Runtime contract

- Different session keys may execute concurrently on one app-server connection.
- Turns for the same session key execute in order.
- Notifications route by `threadId` and `turnId`.
- Thread policy and durable thread IDs remain in `CodexThreadRegistry`.
- App-server overload error `-32001` is retried with bounded exponential backoff and jitter.
- Connection or protocol failure rejects all active turns; the next request starts one fresh
  connection and resumes registered threads.

## Provider-specific gateway tool bridge

Claude keeps its existing persistent CLI and text Gateway path. Codex uses the app-server's
client-provided dynamic-tool protocol instead of asking the model to print Markdown
`tool_call` blocks.

- `AgentLoop`, `GatewayToolExecutor`, report, memory, skill, and trigger workflows remain shared.
- `ToolRegistry` remains the source of tool names and descriptions. The Codex mapping supplies an
  object JSON schema without parsing the human-readable `params` string; existing
  `GatewayToolExecutor` validation stays authoritative for arguments. Exposure is intersected with
  the per-run role's allowed/blocked patterns, viewer-only rules, and AgentLoop disallowed tools.
  Codex does not expose Codex shell, file, browser, app, plugin, or MCP-native MAMA tools.
- When app-server sends `item/tool/call`, the pending Codex turn routes the request to a run-local
  host callback. That callback reuses `AgentLoop.executeTools`, preserving envelope checks,
  `GatewayToolExecutor`, post-tool processing, metrics, and UI progress callbacks.
- The app-server process replies on the original JSON-RPC request with the existing gateway result.
  Tool failures return `success: false`; protocol validation failures fail the turn loudly.
- Concurrent sessions keep separate run-local callbacks, selected by `threadId` and `turnId`.
- The canonical dynamic-tool set is included in the durable thread policy fingerprint. A changed
  schema or role policy cannot silently resume a thread with stale tool capabilities.
- Calls are deduplicated by `callId`, serialized within one turn, and bounded by AgentLoop's call
  and repeated-tool limits. Different threads may execute tools concurrently. A successful
  `stopAfterSuccessfulTools` call ends the Codex turn through the app-server interrupt path without
  converting the intentional stop into an error.
- Early tool requests wait for the matching `turn/start` response. Pending callbacks and request
  IDs are discarded on every completion, failure, timeout, shutdown, and reconnect; late results
  are bound to the child connection that issued the request and cannot reply to a replacement.
- Codex failures invoke `onError` exactly once before the prompt promise rejects. Claude behavior is
  unchanged.

The Codex backend no longer depends on text parsing for tool selection or result continuation.
MessageRouter omits the Markdown Gateway catalog for Codex and AgentLoop skips Markdown tool parsing
for Codex. Text prompting and parsing remain a Claude compatibility path and are not removed by this
refactor.

## Removed architecture

- Global Codex busy lock shared by unrelated channels.
- One app-server child process per session and its LRU eviction policy.
- `CodexMCPProcess` and the `codex mcp-server` rollback path.
- Runtime/config transport branching.

## Verification

- Concurrent independent sessions use one process and one initialization.
- Overlapping turns for one session are serialized.
- Durable thread resume and policy mismatch protections remain covered.
- Authentication isolation, redaction, shutdown, timeout, and malformed protocol tests remain.
- Real daemon verification must include overlapping background and Telegram requests.
- `thread/start` advertises filtered dynamic tools from `ToolRegistry`.
- A fake app-server `item/tool/call` executes through the real gateway bridge and receives its
  JSON-RPC result before the turn completes.
- Malformed, unknown, and failed tool calls cannot be converted into empty successful responses.
- Early, duplicate, cross-thread, stale-connection, over-budget, repeated, and stop-tool calls have
  explicit regression coverage.
- Telegram `report_request`, `board_read`, memory save/recall, and a multi-turn failed-tool recovery
  complete without Markdown `tool_call` output.
