# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.27.5] - 2026-07-24

Observability repairs: the report audit now sees Code-Act gather, and token
telemetry flows again on the Stage-2 workorder path.

- The full-report tool-use audit classifies the host tools a `code_act` run
  actually executed (carried as `hostToolsInvoked` in the result), ending the
  false "executed NO gateway gather tools" warning introduced when the report
  lane moved onto Code-Act in 0.27.4. A compute-only or write-only report still
  warns; the no-fallback guarantee is unchanged.
- Stage-2 workorder runs record `tokens_used` in `agent_activity` again. The
  legacy persona recorder was lost at the 07-21 cutover, blinding cost
  measurement (13,927 runs unmeasured). Usage now rides the worker run result
  through the consumer's completion events, including temporal completions,
  whose receipt arbitration path previously dropped it.
- Absent usage persists as NULL instead of a fabricated 0, so "unmeasured"
  stays distinguishable from "measured as free"; explicitly reported zeros
  still store 0, keeping aggregates comparable with the pre-cutover baseline.

## [0.27.4] - 2026-07-24

Restores the operator agent's tool surface and gives the owner console an explicit operating
discipline, after live monitoring showed the agent gathering and analysing well but handing the
next step back instead of taking it.

- The scheduled operator report now runs under a built-in least-privilege `operator-report`
  Code-Act role. Without a role the Code-Act path stripped the gateway catalogue and injected
  nothing back, so the report agent ran with zero tool definitions: full reports were delivered
  while logging "executed NO gateway gather tools - task-board substance NOT verified". The role's
  allowlist is derived from what the report is instructed to call, and its envelope still grants no
  send surface and no Trello.
- The owner console carries a stated operating discipline on every reply. It gathers before
  answering, never claims a check it did not run, synthesises instead of dumping tool output, and
  acts by default - doing reversible work (reads, analysis, ranking, drafts, and writes whose only
  audience is the 1:1 console) and reporting the outcome, while still asking first before
  irreversible effects that leave the conversation (cross-channel sends, shared-file uploads,
  credential storage, uncancellable delegation). Onboarding is deliberately excluded.
- Resumed Codex threads are re-anchored through `thread/resume`'s `baseInstructions` instead of a
  user-text `<system-reminder>` replay. The rebuild is lazy and runs only inside the resume branch,
  so live threads and the operator/worker lanes are byte-identical to before.

## [0.27.3] - 2026-07-22

- Verified owner-console Drive workflows can resolve and upload to the folder explicitly selected
  by the owner even when that shared drive is not one of the static connector deliverable roots.
  Non-owner Drive access, capability validation, and private-workspace upload containment remain
  enforced.

## [0.27.2] - 2026-07-22

- Code-Act now uses the Kagemusha five-minute composition budget so bounded multi-image Drive and
  OCR workflows do not fail at the previous 30-second whole-program deadline. Existing memory,
  call-count, concurrency, cancellation, and mutation-settlement guards are unchanged.

## [0.27.1] - 2026-07-22

Codex app-server policy changes and missing durable records are now detected before a model request
and opened with the full current policy. Concurrent Code-Act runs use isolated, wall-clock-bounded
QuickJS async WASM modules under a process-wide live-module ceiling, and nested tools receive the
deadline and parent-turn abort signals. Side-effecting calls keep their bounded slot until their
commit state and every sibling mutation settle or a finite grace expires; late and unknown outcomes
stop the model turn across native, app-server, HTTP, and MCP transports and cannot be requeued by
the workorder consumer. MCP calls serialize and latch ambiguous outcomes. Cancelled Drive downloads
clean up local artifacts, while browser screenshots use exclusive operation-owned temporary files
and reject existing, nested, or escaping destinations. The loop guard distinguishes different
Code-Act programs while still stopping identical repetition. Workorder shutdown also stops before
claiming more queued rows, preserving pending work for the restarted daemon. Full details are in
the repository root CHANGELOG.md.

## [0.27.0] - 2026-07-22

Composable owner workflows and durable Telegram parity: Drive, attachment, OCR, translation,
same-folder upload, and Telegram delivery share one owner-scoped Code-Act surface; inbound response
and report delivery progress survives daemon restarts. Full details are in the repository root
CHANGELOG.md.

## [0.26.0] - 2026-07-22

Telegram and Google Drive owner-workflow parity: allowlisted Telegram chats now support captions,
photos, image documents, and regular documents, while the verified owner console can browse,
download, and upload Drive files through the same role-scoped direct-tool and Code-Act contract on
Claude and Codex. Media downloads are bounded and transient, forwarded image analysis and Drive
reads remain untrusted, Drive uploads are limited to configured destinations, and Drive polling is
asynchronous and page-bounded. Full details are in the repository root CHANGELOG.md.

## [0.25.0] - 2026-07-22

Verified temporal owner-task reconciliation: MAMA can now inspect overdue owner tasks against fresh,
source-bound connector evidence and atomically resolve, finalize, or defer them through the same
role-scoped host-tool contract on Claude and Codex. The release also includes conservative receipt
migration, mixed-version task safety, and bounded shutdown handling. Full details are in the
repository root CHANGELOG.md.

## [0.24.2] - 2026-07-22

Workorder forward-compatibility patch: older binaries now ignore and preserve system workorders
whose kinds are owned by a newer MAMA OS version. Full details are in the repository root
CHANGELOG.md.

## [0.24.1] - 2026-07-21

Codex report-recovery patch: bounded durable-thread reset, full policy rebuild, replacement-session
ownership cleanup, role-scoped Code-Act worker tools, Trello envelope least privilege, and explicit
untrusted-evidence boundaries. Full details are in the repository root CHANGELOG.md.

## [0.24.0] - 2026-07-21

Native Codex app-server and Code-Act parity release, including durable managed threads and native
MAMA host tools. Full details are in the repository root CHANGELOG.md.

## [0.23.0] - 2026-07-18

The owner-console + workorder-ownership release: trust-conditional
`owner_console` role (telegram allowlist DM), artifact-hub tools
(`board_read`/`audit_findings_read`/`report_request`/`workorder_request`/
`workorder_status`), report context carry, memory-write secret filter,
forwarded-message provenance, and the flag-gated Stage-2 durable workorder
pipeline (`MAMA_STAGE2_WORKORDERS`, default off = no behavior change).
Full details in the repository root CHANGELOG.md.

## [0.22.1] - 2026-07-17

Security-utility round: telegram inbound allowlist warning + drop logging,
untrusted-content wrapping for connector-derived text, deterministic hourly
code audit (no LLM loop), security-telemetry purge. Full details in the
repository root CHANGELOG.md.

## [0.22.0] - 2026-07-16

Operator console groundwork and daemon persona boundary repair. Full details
in the repository root CHANGELOG.md.

## [0.21.0] - 2026-07-12

The operator runtime release. Full details in the repository root CHANGELOG.md.

### Added

- **Self-evolving trigger loop** — The agent authors its own triggers from recurring channel
  situations, fires them on future messages to recall memory, and folds everything into owner
  situation reports. A near-duplicate gate blocks variant triggers at authoring time, a review
  pass retires noisy ones, and a citation success circuit records `succeeded` when a delivered
  report names the fired triggers it drew on (`USED_TRIGGERS` machine trailer, stripped before
  the owner sees the report)
- **Operator board at `/ui`** — React viewer with four agent-published report slots (briefing,
  action required, decisions, pipeline) rendered live over SSE, a Triggers tab, and an owner veto
  tray; report slots persist across restarts (`~/.mama/report-slots.json`); task state comes from
  the real task ledger via the kagemusha bridge query tools, never guessed from chat
- **Wiki v5: daily journal + lessons** — The wiki agent maintains an Obsidian vault as an
  append-only daily note per day plus durable lesson pages (`lessons/clients|process|system`);
  configured via the new `wiki:` config section; Obsidian CLI calls are pinned with `vault=<name>`
- **Scheduled memory promotion** — Every 6h (configurable, `POST /api/memory/promote`) the memory
  agent promotes durable judgments from recent channel data into decisions — never task states;
  successful runs emit `memory:promoted`, which chains into wiki compilation
- **Audit alert dedup** — The hourly conductor audit diffs findings against
  `~/.mama/state/audit-findings.json`; a persistent finding alerts the owner once per 24h instead
  of every hour, MINOR findings never alert, and the audit never writes memory

### Security

- **Public-tree PII scrub and history rewrite** — Personal identifiers removed from the tree and
  the full git history rewritten; personal configuration lives only under `~/.mama`

## [0.20.1] - 2026-05-04

### Added

- **Context Compile runtime path** — Added the standalone service, gateway tool, HTTP integration,
  model-run lineage, and trusted `context_packet_id` save provenance for compiled evidence packets
- **Dashboard/wiki Context Compile adoption** — Managed system-agent defaults, legacy config
  migration, personas, and scheduled prompts now route evidence gathering through
  `context_compile` before falling back to `mama_search`
- **Raw-backed connector memory ingest** — Deterministic memory candidate builder and ingest
  path lift connector evidence into scope-bound memory without LLM extraction, with isolation
  tests against the case and decision stores

### Fixed

- **Code-Act policy hardening** — `/api/code-act` now requires an existing `useCodeAct: true`
  agent, intersects request allowlists with configured gateway policy, handles blocked-only policy
  safely, and avoids falling back to full MCP configs for Code-Act-only agents
- **Code-Act allowlist deny-by-default** — `resolveCodeActAgentPolicy` rejects agents whose
  resolved allowed tools are undefined or empty, `buildCodeActRole` no longer falls back to
  wildcard, and `intersectAllowedToolPolicies` distinguishes undefined (fallback) from explicit
  empty arrays (deny-all)
- **Trusted provenance fail-closed paths** — Packet-backed `mama_save` calls now reject invalid or
  unavailable trusted provenance instead of widening scopes or silently dropping `context_packet_id`,
  and `getContextPacketIdForTrustedProvenance` throws on present-but-invalid values so the
  request fails with `context_packet_denied`
- **Tier-3 context_compile fail-closed** — `handleContextCompile` checks `agentContext.tier` and
  `envelope.tier` independently so a non-Tier-3 agent context cannot mask a Tier-3 envelope via
  the previous `??` fallback
- **bindConfiguredScope canonicalization** — Project-scoped connector items now derive a single
  canonical project id from channel config, item metadata, and item.projectId for both
  `projectId` and `memoryScopeId`, and stamp a default tenant alongside the scope so configured
  channel raw evidence is no longer filtered out by the default `tenant_id` boundary
- **Envelope key TOCTOU** — `loadOrCreateLocalEnvelopeSigningKey` uses an atomic `wx`-flag write
  with EEXIST handling instead of a non-atomic `existsSync`+write, so concurrent processes
  converge on the first key written instead of overwriting each other
- **Raw-backed memory save validation** — `ingestRawBackedMemoryCandidates` now requires an
  explicit `success: true` with a non-empty `id` from `saveMemory` before counting a row as saved
- **Wiki-agent feature gating** — `normalizeLegacyMultiAgentConfig` only backfills the built-in
  `wiki-agent` when `config.wiki.enabled` is true, matching runtime provisioning by `runAgentLoop`
  and api-routes-init
- **Managed dashboard persona broader fallback** — Dashboard persona v8 falls back to
  `mama_search` on any non-success `context_compile` result, not only when the worker envelope is
  missing, and the Tools section description matches the workflow step
- **Code-Act gateway allowlist migration test** — `should upgrade old built-in Code-Act gateway
allowlists with context_compile on load` now asserts exact array equality so the migration
  cannot drop a previously allowed tool while adding `context_compile`

## [0.20.0] - 2026-05-01

### Added

- **Reactive envelope runtime** — Standalone now issues and stores signed gateway envelopes, exposes
  public health separately from authenticated envelope status, and audits scope mismatches through
  `agent_activity`
- **Worker evidence APIs** — Added authenticated memory provenance, raw search, agent situation,
  and agent graph/entity API handlers so workers can retrieve bounded evidence without direct DB
  access
- **Envelope-aware gateway tooling** — Code-Act, gateway execution, internal agent-loop calls, and
  model/tool trace paths now propagate envelope context for trusted provenance
- **Strict `mama_search` controls** — Gateway, MCP, Code-Act, ToolRegistry, and generated tool docs
  now expose `scopes`, `strict`, `strictness`, `threshold`, `disableRecency`, `includeRelated`,
  `topicPrefix`, `minLexicalSupport`, and `diagnostics`
- **Persistent process cleanup settings** — `timeouts.persistent_process_idle_ms`,
  `timeouts.persistent_process_cleanup_ms`, and `timeouts.persistent_process_pending_tool_ms`
  let operators tune how aggressively idle CLI processes are reclaimed

### Changed

- **Gateway executor architecture** — Delegation execution and gateway tool execution were split
  into clearer modules, with ToolRegistry kept as the valid-tool source of truth for generated
  prompts and executor validation
- **Connector raw stores** — Raw connector persistence now writes provenance and unified indexes so
  worker APIs can query raw evidence consistently
- **Envelope-aware memory search** — `mama_search` now defaults to effective envelope scopes and
  rejects caller scopes outside the active envelope before searching
- **Search diagnostics preservation** — Standalone search result types and handler responses now
  keep `diagnostics`, `retrieval_diagnostics`, and `contributing_leaf_diagnostics` instead of
  dropping them at API boundaries

### Fixed

- **Envelope hardening** — Reactive envelope startup, internal tool contexts, scope mismatch
  logging, authenticated status reporting, worker graph/entity visibility, and graph API internal
  error responses now have review-driven regression coverage
- **Scoped recent-list search** — No-query `mama_search` now passes scopes into recent decision
  listing instead of returning global recent decisions
- **Long-lived Claude process buildup** — Persistent CLI processes are now reclaimed after idle
  timeouts while active tool-result loops keep a bounded lease; `mama stop` also avoids unsafe
  broad kills and handles large `ps` output safely

## [0.19.1] - 2026-04-20

### Fixed

- **Claude Code auth detection** — install, init, setup, run, and status flows now prefer `claude auth status` when detecting whether Claude Code is logged in, avoiding false "auth missing" warnings on newer CLI installs that do not persist `~/.claude/.credentials.json`
- **Legacy auth fallback preserved** — older environments that still rely on `~/.claude/.credentials.json` continue to work as a fallback instead of breaking setup or status checks

### Changed

- **Postinstall guidance** — postinstall now distinguishes between "Claude CLI missing" and "Claude CLI installed but logged out", and shows `claude auth login` when re-authentication is the real fix
- **Operator docs alignment** — standalone setup/troubleshooting/commands docs now describe the shipped Claude Code login flow and generated artifact expectations

## [0.10.2] - 2026-02-22

### Added

- **Code-Act sandbox tool visibility**: Viewer reasoning header now shows which tools Codex used (e.g., `mama_search`, `Read`, `Bash`) via `onToolUse` callbacks from HostBridge
- **Shared MAMA tool handlers** (`mama-tool-handlers.ts`): Extracted `handleSave`, `handleSearch`, `handleUpdate`, `handleLoadCheckpoint` — eliminates duplication between `MCPExecutor` and `GatewayToolExecutor`
- **`GatewaySessionStore` interface**: Typed session store replacing `any` in `GatewayToolExecutor`
- **`isSearchResultItem` type guard**: Runtime validation for `listDecisions`/`suggest` results

### Changed

- **Codex streaming optimization**: Simplified system prompt loading, removed `state.json` dependency, conditional `ONBOARDING.md` loading
- **Multi-agent system prompt**: `buildToolsSection()` now uses full `gateway-tools.md` instead of hardcoded 5-tool subset — fixes Codex OS agent not knowing available tools
- **Context injection**: Skip `getRelevantContext()` on CONTINUE turns for lower token overhead
- **Gateway tools cache**: Cache `getGatewayToolsPrompt()` in production, hot-reload in dev
- **`formatContextForPrompt` hoisted**: 3 calls → 1 call per message route

### Fixed

- **mama_save checkpoint crash**: `sessionStore.getRecentMessages()` didn't exist — `any` type hid it. Replaced with `getHistory('current')`
- **checkpoint search**: `mama_search(type='checkpoint')` returned 0 results — now routes to correct checkpoints table
- **Gateway tool result consistency**: All executor results now include `{ success: true }` for HostBridge compatibility
- **loadCheckpoint HostBridge compatibility**: Added `success` field to raw DB checkpoint results
- **CONTINUE path skill injection**: Always run prompt enhance regardless of session type
- **PR #41 code review fixes** (4 rounds):
  - `esc()` quote escaping for attribute injection safety
  - Stale pin/selection indices after log trimming
  - `postMessage` targetOrigin scoped (was wildcard `'*'`)
  - `in` operator guard against non-object primitives
  - `savePins()` localStorage sync on clear
  - `diffTailLines` optimization

## [0.9.1] - 2026-02-16

### Added

- **Agent git identity configuration**: Each multi-agent bot can now have its own git identity for commits
  - New `git_identity` field in agent config: `{ name: string, email: string }`
  - PR review workspaces automatically configure git user based on agent identity
  - Prevents accidental GitHub account impersonation by using local-only email domains

### Fixed

- **Agent process pool exhaustion**: Fixed pool getting stuck at "2/2 busy" after timeouts
  - Root cause: Timeout aborts `Promise.race()` but underlying `wrapper.prompt()` continues running
  - Process marked `busy=false` in pool but `isReady()=false` in runtime → "zombie" state
  - `releaseProcess()` now detects and kills zombie processes immediately
  - `getAvailableProcess()` cleans up zombies before attempting new process creation

### Performance

- **Viewer chat panel optimization**: Significant performance improvements for chat panel
  - Lazy WebSocket session initialization (defer until panel open)
  - DocumentFragment batch DOM insertion for chat history
  - DOM message limit (100 messages max) to prevent slowdown
  - requestAnimationFrame batching for scroll/resize operations
  - content-visibility CSS for inactive tabs (memory tab exempted for checkpoints)
  - GPU compositing for chat panel animations
  - CDN preconnect hints and resource preload
  - Reduced font weights (8→4) and pinned lucide version
  - Scoped scrollbar CSS to prevent global style overhead

## [0.8.4] - 2026-02-14

### Fixed

- **Configuration safety**: Improve `mama start` diagnostics when `~/.mama/config.yaml` cron fields use
  unquoted expressions like `*/10 * * * *`, which YAML parses as an alias.
  - Added explicit guidance to quote such cron values on startup failure.
- **Runtime resilience**: Keep `mama-core` API compatibility while injecting context by validating and
  normalizing search/save/update interfaces before wiring `ContextInjector`.

## [0.8.2] - 2026-02-13

### Changed

- **Backend-agnostic initialization** (2026-02-13)
  - `mama init` now supports `--backend auto|claude|codex`.
  - Auto mode selects an authenticated backend CLI based on local environment.
  - Added explicit guidance when no backend authentication exists.
- **Cost-aware backend flexibility** (2026-02-13)
  - Documentation and onboarding now describe LLM-agnostic backend operation.
  - This change was prioritized to mitigate premium model cost pressure (including Opus 4.5 pricing
    increases) by allowing users to choose/rotate backend per environment.

## [0.5.0-beta] - 2026-02-09

### Added

**Internationalization** (2026-02-09)

- **Full English Translation** - Converted 538+ Korean strings to English across 35 files
  - CLI commands (init, setup, run, status, stop) — all user-facing messages
  - Gateway handlers (Discord, Slack) — progress indicators, PR review notifications
  - Onboarding wizard (9 phases) — awakening dialogue, personality quiz, security docs
  - Multi-agent system — i18n defaults, delegation messages, system reminders
  - Skills, scheduler, memory logger — all remaining Korean strings
- **English Persona Templates** - Translated 3 builtin personas to English
  - `sisyphus.md` — Tier 1 Orchestrator
  - `developer.md` — Tier 2 Implementation Specialist
  - `reviewer.md` — Tier 3 Code Quality Guardian
- **i18n Default Language** — Changed from `ko` to `en` in i18n-messages and message-router
- **Korean Regex Preserved** — Category routing patterns still support Korean users

**Multi-Agent Discord Fixes** (2026-02-08)

- **DELEGATE:: Syntax Detection** — `extractMentionedAgentIds()` detects delegation patterns for routing
- **Bidirectional Bot Mention Routing** — Bot-to-bot mentions route correctly in both directions
- **Live Progress Indicator** — `Working... (Xs)` shown during long-running Discord requests
- **Infinite Loop Prevention** — Chain length limit + global cooldown prevent runaway loops
- **Opt-in Port Auto-Kill** — Port conflict resolution requires explicit opt-in
- **REVIEW→DEV Routing Fix** — Unblocked mention routing during APPROVE cooldown

**Agent Hooks** (2026-02-09)

- **PostToolUse Handler** — Auto-extracts contracts after Write/Edit operations (fire-and-forget)
- **PreCompact Handler** — Detects unsaved decisions at 80% context capacity
- **StopContinuation Handler** — Auto-resumes incomplete responses (opt-in, max 3 retries)
- **Contract Extractor** — 5 extractors: API, function, type, SQL, GraphQL (661 lines)
- **256 New Tests** — Full coverage for all hook modules

**Other Features** (2026-02-08)

- **!stop Command** — Interrupt running agents from Discord
- **Delegation System Reminders** — Started/completed notifications in Discord and Slack
- **BackgroundTaskManager & SystemReminderService** — Async task delegation infrastructure
- **Content Dedup** — YAML frontmatter filtering and prompt size monitoring
- **PromptEnhancer** — Native keyword detection, AGENTS.md injection (44 tests)

### Changed

- **MessageQueue TTL** — Increased from 3 minutes to 10 minutes (agents need 200s+ for complex tasks)
- **Sisyphus Persona** — SOLO mode restricted to typo-level changes (≤5 lines); everything else delegates
- **isKorean Default** — Message router defaults to `false` (English-first)
- **i18n Default** — Default language switched from `ko` to `en`

### Fixed

- **Cross-Channel Batch Corruption** — Fixed batch processing across different Discord channels
- **Duplicate Session Cache Entries** — Prevented duplicate entries in session cache
- **Env Var Conflicts** — Clean conflicting MAMA environment variables in persistent CLI process
- **Graceful Shutdown** — Improved stop command reliability
- **Magic Number Extraction** — Replaced hardcoded values with named constants

## [0.4.0] - 2026-02-07

### Added

**Builtin Agent Personas & Auto-Provisioning** (2026-02-07)

- **Builtin Persona Templates** - 4 persona files bundled in `templates/personas/`
  - `sisyphus.md` - Tier 1 Orchestrator (plans, delegates, verifies)
  - `developer.md` - Tier 2 Implementation Specialist (implements, tests, reports)
  - `reviewer.md` - Tier 3 Code Quality Guardian (reviews, approves/rejects)
  - `pm.md` - Optional Product Manager agent
- **Auto-Provisioning** - `provisionDefaults()` copies templates to `~/.mama/personas/` on first start
- **Default Multi-Agent Config** - Injects disabled multi_agent config into config.yaml if missing
- **Onboarding Phase 7b** - Agent team introduction during onboarding with activation option
- **OS Agent Multi-Agent Management** - OS agent can configure/activate/customize agent team anytime
- **Port Constants** - Extracted `API_PORT=3847` and `EMBEDDING_PORT=3849` as named constants

**Multi-Agent Swarm** (2026-02-06) - Coordinated AI agents with hierarchical delegation for Discord.

- **3-Tier Agent Hierarchy** - Tier 1 (full tools + delegation), Tier 2 (read-only advisory), Tier 3 (scoped execution)
- **Tool Permission Manager** - Per-agent tool access control with wildcard matching and system prompt enforcement
- **Category Router** - Regex-based message routing with Korean/English patterns and priority ordering
- **Task Continuation** - Auto-resume incomplete responses with completion markers (DONE/완료/✅) and truncation detection
- **Delegation Manager** - `DELEGATE::{agent_id}::{task}` pattern with circular prevention and depth-1 limit
- **UltraWork Mode** - Autonomous multi-step sessions combining delegation + continuation (max 20 steps / 30 min)
- **5-Stage Routing Pipeline** - free_chat → explicit_trigger → category_match → keyword_match → default_agent
- **Agent Config** - New fields: `tier`, `can_delegate`, `auto_continue`, `tool_permissions`
- **Config Sections** - `categories`, `ultrawork`, `task_continuation` in multi_agent config

### Changed

- **MultiAgentOrchestrator** - Integrated CategoryRouter between explicit triggers and keyword matching
- **AgentProcessManager** - System prompt includes tool permission and delegation sections
- **MultiAgentDiscordHandler** - Updated reason types for category_match, delegation, ultrawork

## [0.3.3] - 2026-02-04

### Fixed

- **Gateway Tools Missing on Resume** - Fixed critical bug where Gateway Tools documentation was not available when resuming CLI sessions
  - System prompt (including Gateway Tools) is now always injected for safety
  - CLI uses cached context when available, falls back to provided prompt if session lost
  - Ensures tools work even after daemon restart or session timeout
  - Fixes "MAMA 검색 도구에 접근할 수 없어서" error in Viewer

### Changed

- **Session Resumption Safety** - Always inject system prompt even for resumed sessions
  - Prevents tool unavailability when CLI session is lost
  - CLI efficiently uses cached context when valid
  - Minor token overhead for reliability

## [0.3.2] - 2026-02-03

### Added

- **CLI Session Resumption** - 90%+ token savings via `--resume` flag
  - First message uses `--session-id` with full system prompt injection
  - Subsequent messages use `--resume` (CLI maintains its own context)
  - SessionPool tracks `isNew` flag for session state
  - Token reduction: ~8,600 → ~3 tokens per message

- **Role-Aware Agent Context** - Platform-specific permissions
  - `RoleManager` class for role-based permission management
  - `AgentContext` type captures platform, role, and capabilities
  - `ContextPromptBuilder` generates role-aware system prompts
  - Source-based role mapping: viewer=os_agent, discord=chat_bot, etc.

- **Discord Channel Names** - Human-readable session display
  - Shows `#channel-name (Server Name)` instead of channel IDs
  - Backfills channel names when Discord bot connects
  - `channel_name` column added to messenger_sessions table

- **Dashboard Enhancements**
  - Discord icon for Discord sessions
  - Display channel names in session list
  - Session management controls
  - Memory module improvements

### Changed

- **MessageRouter** - Integrated session resumption logic
  - Checks `isNewCliSession` from SessionPool
  - Conditionally skips system prompt for resumed sessions
  - Passes `resumeSession` option to AgentLoop

- **ClaudeCLIWrapper** - Added `--resume` flag support
  - New `resumeSession` option in prompt() method
  - Uses `--resume <session-id>` for continuing sessions
  - Skips system prompt injection when resuming

### Performance

- **Token Usage** - 99.9% reduction for subsequent messages
  - Before: ~8,600 tokens/message (system prompt + 50 turn history)
  - After: ~3 tokens/message (CLI maintains context)
  - 30-minute session timeout with automatic reset

## [0.3.0] - 2026-02-03

### Added

- **Self-Contained Context Injection** - MAMA Standalone now includes built-in context injection
  - `ContextInjector` class for session startup and per-message context
  - Automatic checkpoint loading and recent decisions retrieval
  - Replaces dependency on Claude Code plugin hooks
  - Environment variable `MAMA_DAEMON=1` prevents duplicate injection

- **Gateway Tools Mode** - Direct tool execution without MCP dependency
  - 18 built-in tools: MAMA Memory (4), Browser (10), Utility (4)
  - `tool_call` block format for LLM tool invocation
  - `GatewayToolExecutor` for self-contained execution

- **Hybrid Tool Routing** - Configurable Gateway/MCP tool selection
  - Per-tool selection via dashboard settings
  - Category-based organization (Memory, Browser, Utility)
  - Visual tool status in Dashboard tab

- **Gateway Tools Documentation** - Extracted to `gateway-tools.md`
  - Comprehensive parameter documentation
  - Usage examples and format specification

### Changed

- **Tool ID Generation** - Switched from `Date.now()` to `randomUUID()`
  - Prevents ID collisions in high-throughput scenarios
  - Addresses Gemini Code Assist security review

- **Version Bump** - Major version to 0.3.0 for new features

### Fixed

- **Plugin Hook Duplication** - Skip injection when `MAMA_DAEMON=1` is set
- **Test Timeout** - Increased Claude CLI wrapper test timeout to 60s

## [0.1.8] - 2026-02-03

### Changed

- **Viewer Brand Unification** - Complete UI renewal with MAMA brand identity
  - Typography: Fredoka (headings) + Nunito (body)
  - Color palette: Yellow #FFCE00, Lavender #EDDBF7, Black #131313, Blush #FF9999
  - Removed dark mode (light-only design)
  - Added MAMA mascot icon to header

### Fixed

- **Graph Viewer Text Visibility** - Changed node label color from white to black (#131313)
- **SVG Icon Serving** - Added route for `/viewer/icons/*.svg` files
- **Theme Init Error** - Removed dark mode toggle references causing null errors
- **Agent Model Options** - Updated to current Claude models (Sonnet 4, Opus 4.5, Haiku 3.5)

## [0.1.7] - 2026-02-02

### Fixed

- **Daemon Mode Stability** - Fixed SIGINT propagation issue when running via systemd
  - Added `detached: true` to Claude CLI subprocess spawn
  - Prevents parent process signals from terminating Claude sessions

## [0.1.6] - 2026-02-02

### Added

- **Browser Automation Tools** - 10 Playwright-based tools for web automation
  - `browser_navigate` - Navigate to URL
  - `browser_screenshot` - Take screenshot (viewport or full page)
  - `browser_click` - Click element by selector
  - `browser_type` - Type text into element
  - `browser_get_text` - Extract page text
  - `browser_scroll` - Scroll page (up/down/top/bottom)
  - `browser_wait_for` - Wait for element
  - `browser_evaluate` - Execute JavaScript
  - `browser_pdf` - Generate PDF
  - `browser_close` - Close browser

### Changed

- **Migrated from Puppeteer to Playwright** - Better stability, auto-wait, multi-browser support

## [0.1.5] - 2026-02-02

### Added

- **Discord File Attachment** - Auto-attach files when response contains outbound paths
  - Pattern detection: `파일 위치:`, `File:`, `Path:`, `saved at:`
  - Auto-detect `~/.mama/workspace/media/outbound/` paths
  - Supports all file types (images, PDFs, documents)

- **Image Path Preservation** - Claude remembers image paths across conversation turns
  - Added `localPath` property to ContentBlock type
  - Text blocks with path info now pass through message-router
  - Files saved to `~/.mama/workspace/media/inbound/` instead of `/tmp/`

## [0.1.4] - 2026-02-01

### Changed

- **OpenClaw Compatibility** - Updated all Clawdbot references to OpenClaw throughout codebase
- Renamed internal references from Clawdbot patterns to OpenClaw patterns
- Updated documentation and comments for consistency

### Added

- **Onboarding Auto-Redirect** - Automatic redirect to viewer after completing onboarding wizard
- WebSocket setup wizard enhancements for better UX
- Tool handlers for phases 7, 8, 9 of onboarding

### Fixed

- Onboarding completion detection with proper tool handlers
- Setup WebSocket redirect message handling

## [1.0.0] - 2026-01-28

### Added

#### Core Foundation

- **OAuth Token Manager** - Claude Pro OAuth token reading and automatic refresh
- **Agent Loop Engine** - Claude API calls with MCP tool execution loop
- **CLI** - `mama init/start/stop/status` commands for daemon management

#### Scheduling

- **Cron Scheduler** - node-cron based job scheduling with cron expressions
- **Heartbeat API** - `/api/heartbeat` and `/api/cron` REST endpoints
- **Schedule Persistence** - SQLite-based schedule storage with crash recovery

#### Messenger Integration

- **Discord Gateway** - discord.js v14 bot with DM and channel mention support
- **Slack Gateway** - Socket Mode integration with thread context preservation
- **Message Router** - Unified message routing with session management
- **Context Injector** - Proactive MAMA decision retrieval for context-aware responses

#### Infrastructure

- **Session Store** - Conversation session management with rolling context
- **Message Splitter** - Platform-aware message chunking (2000 chars for Discord, 40000 for Slack)
- **Job Locking** - Distributed job execution safety with SQLite locks

### Dependencies

- Requires Claude Pro subscription
- Node.js 22+
- Claude Code (OAuth token source)

### Technical Details

- TypeScript implementation with full type definitions
- 335 unit and integration tests
- Express.js based API server
- SQLite database for persistence
