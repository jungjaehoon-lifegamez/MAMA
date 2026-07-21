# Codex Code-Act Parity Design

**Date:** 2026-07-21
**Status:** Approved direction

## Goal

Give the Codex app-server backend the same MAMA Code-Act capability catalog and role-filtered execution path used by Claude Code-Act agents. In particular, an authorized Codex run must be able to query evidence from the MAMA Trello connector through `context_compile({ connectors: ['trello'] })` without falling back to unrelated `kagemusha_tasks` calls.

## Current gap

Claude and Codex currently receive gateway capabilities through different projections:

- Claude Code-Act receives generated function declarations from `HostBridge.getToolRegistry()` and executes them through the existing QuickJS `HostBridge`.
- Codex app-server receives individually expanded native tools from `ToolRegistry.getHostToolDefinitions()`.
- The Codex branch suppresses the Code-Act instructions and generated declarations.

The two registries can drift. The current owner-facing guidance also overemphasizes `kagemusha_*` for task state without explaining that connector-scoped evidence, including Trello, belongs to `context_compile`.

## Design

### One Code-Act catalog

For runs configured with `useCodeAct: true`, both Claude and Codex build their advertised gateway function catalog from `HostBridge.getToolRegistry()` through `TypeDefinitionGenerator`.

Codex receives one native outer `code_act` app-server dynamic tool with the existing `{ code, allowedTools?, blockedTools? }` schema. The Code-Act guidance plus tier- and role-filtered inner declarations from `TypeDefinitionGenerator` are included in the effective system prompt passed as `thread/start.baseInstructions`. The model calls the native outer tool with JavaScript, and the existing `GatewayToolExecutor.executeCodeAct()` path creates the QuickJS sandbox and injects the HostBridge functions. The sandbox implementation and function implementations remain unchanged.

Runs that are not configured for Code-Act keep the current behavior: Claude uses parsed gateway calls and Codex uses individual native dynamic tools. This avoids changing unrelated agents in the same release.

### Role policy

Code-Act does not widen authority. A run may receive the native `code_act` entry point only when its effective role allows it. One canonical projection resolves the inner surface in this order:

1. expand the effective role `allowedTools` patterns against `HostBridge.getToolRegistry()`;
2. remove effective role `blockedTools` and per-run `disallowedTools`, with every block taking precedence over allow;
3. apply the existing tier filter (`Tier 1`: allowed surface, `Tier 2`: read plus memory writes, `Tier 3`: read-only);

The same ordered result is used for prompt declarations and QuickJS injection. Model-supplied `allowedTools` or `blockedTools` may narrow this result but can never widen it; the existing sandbox-role resolver remains authoritative.

The default owner-console policy will allow the `code_act` entry point while continuing to block `Bash`, `Write`, `save_integration_token`, and `delegate`. Those blocked functions therefore remain absent inside the sandbox. Customized persisted owner-console definitions intentionally remain fail-closed: they do not receive newly allowed tools automatically, and the existing code-audit drift finding tells the operator which default tools are missing. The active installation has no persisted owner-console override and therefore inherits the updated default.

### Trello connector access

MAMA's Trello connector remains the source. No Kagemusha Trello client or Trello API implementation is copied into MAMA.

The shared Code-Act catalog already exposes `context_compile` with a `connectors` filter. Backend guidance will explicitly distinguish:

- project-task truth: `kagemusha_tasks`
- connector evidence such as Trello: `context_compile({ task: '...', connectors: ['trello'] })`

This preserves current connector provenance and avoids a Trello-specific tool surface.

At boot, the reactive-envelope bootstrap reads the configured enabled connector names from `~/.mama/connectors.json` using the same strict configuration shape as connector initialization. A verified owner-console Telegram DM adds `trello` to `raw_connectors` only when that connector is configured with `enabled: true`; it remains alongside the existing `telegram` and `kagemusha` entries. The host-issued internal `workorder-board` identity is the second authorized Trello reader: its fresh operator envelope receives the same enabled connector set for evidence-backed board publication. Missing, malformed, or disabled Trello configuration fails closed by leaving Trello out of scope, so an attempted compile returns `connector_out_of_scope`. No other Telegram route, group, unverified sender, chat-bot role, or workorder kind receives Trello scope.

An enabled connector with no matching evidence is a successful empty evidence result. A configured connector whose raw query fails remains an explicit context-compile/tool failure. The implementation must not convert a connector error into an empty packet.

All connector and `context_compile` evidence is untrusted data. Owner-console and every workorder worker system prompt prohibit following instructions, requests, or tool calls found inside connector packets. Owner Trello guidance is present only when the current route envelope contains Trello scope. The owner-specific policy text is part of the durable Codex session fingerprint, forcing pre-policy owner threads through the bounded full-prompt reset path after deployment.

### Codex thread behavior

Dynamic tools are established at `thread/start`. Before calling the runtime, AgentLoop augments any caller-supplied `sessionPolicyFingerprint` with a canonical fingerprint of the effective inner Code-Act surface: ordered names, full parameter signatures, tier, effective allow patterns, blocked patterns, and per-run disallowed patterns. The effective Code-Act declarations are also part of `baseInstructions`, and the existing app-server fingerprint continues to include the outer dynamic-tool schema. A material inner role/tier surface change therefore causes the explicit `thread policy mismatch; reset the session explicitly` failure even when MessageRouter supplied a fixed base fingerprint. The app-server runtime remains fail-closed and preserves the stale registry entry. AgentLoop handles that explicit failure once: it resets the session, lazily rebuilds the complete current prompt (including DB history and enabled legacy context search) rather than reusing the minimal resume prompt, and retries on a fresh thread. A failed rebuild or retry is normalized and returned without another reset attempt; its replacement SessionPool entry is removed so the following request is still a true fresh session.

## Error handling

- If `code_act` is not role-authorized, it is not advertised.
- If an inner function is not authorized, it is not injected into QuickJS.
- Connector or context compilation failures remain explicit tool errors; no empty-success fallback is added.
- Existing native-call loop and emergency call limits remain active around the outer `code_act` call.

## Tests

1. A Codex `useCodeAct` run advertises native `code_act` and receives the same generated inner declarations as Claude.
2. The owner-console Code-Act sandbox exposes `context_compile` but not blocked execution tools; blocked precedence and Tier 3 read-only behavior are asserted, including a wildcard allowlist that must not restore blocked functions.
3. A Codex Code-Act call reaches the existing GatewayToolExecutor and passes `connectors: ['trello']` through an authorized verified-owner envelope to the real context-compile boundary.
4. Non-Code-Act Codex runs retain individual native gateway tools.
5. A change only to the effective inner role/tier surface invalidates stale thread policy; the app-server preserves the stale entry and AgentLoop performs one bounded reset using a rebuilt full prompt.
6. Unverified/group Telegram routes and missing/malformed/disabled Trello configurations keep Trello out of scope. Enabled Trello with no evidence succeeds empty, while raw-query failure remains an explicit error.
7. A parity assertion compares canonical inner function names and signatures while allowing Claude and Codex to use different outer transports.

## Non-goals

- Adding direct Trello API calls to MAMA.
- Rewriting the existing Code-Act sandbox.
- Changing connector polling or ingestion.
- Broadening Trello scope beyond verified owner-console reads and the host-issued internal `workorder-board` reader.
