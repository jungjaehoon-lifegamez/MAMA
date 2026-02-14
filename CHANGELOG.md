# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.8.6] - 2026-02-14

### Changed

- **Viewer TypeScript migration**: Converted all viewer modules (chat, dashboard, graph, memory, settings, skills) from JavaScript to TypeScript
- **Typed API client**: New fully-typed API module with proper error handling
- **Plugin hook redesign**: PreToolUse triggers on Read (decision context), PostToolUse shows lightweight reminder

### Added

- **Viewer utilities**: DebugLogger, DOM helpers, format helpers, markdown renderer with DOMPurify
- **Test utilities**: `@jungjaehoon/mama-core/test-utils` export for isolated test databases
- **Session state**: Hook session isolation via SESSION_DIR environment variable

### Fixed

- **URL encoding**: All API path parameters now use encodeURIComponent
- **Hook performance**: Simplified hook logic, removed pattern detection

## [0.8.4] - 2026-02-14

### Fixed

- **Configuration loading diagnostics**: On startup, `~/.mama/config.yaml` parsing now surfaces a clear
  hint when cron expressions like `*/10 * * * *` are provided without quotes, avoiding silent
  startup failure and reducing recovery time.
- **Standalone/core API compatibility hardening**: Added startup-time normalization around `mama-core`
  memory API adapters used by context injection and scheduled jobs to guard against export-shape drift.

## [0.8.3] - 2026-02-14

### Fixed

- **Security: Symlink escape prevention** in `graph-api.ts` persona_file validation
  - Now uses `fs.realpathSync` to resolve symlinks before path validation
- **Security: MAMA_TRUSTED_ENV guard** enforced consistently in `discord.ts` setMultiAgentConfig
- **PR Review Poller**:
  - Fixed immediate reminder firing after initial report (`lastUnresolvedReminderAt` timing)
  - Added hot-reload support via `configurePrPoller()` helper
  - `sendMessage` now throws Error instead of silent return when sender is missing
- **Array input validation** in `normalizeDiscordGuilds` to prevent numeric key coercion

### Changed

- **DebugLogger migration**: Replaced `console.log/warn/error` with DebugLogger in:
  - `discord.ts` (init/permission diagnostics)
  - `multi-bot-manager.ts` (all logging)
- **ESM import**: Replaced `require()` with ESM import for DebugLogger in `start.ts`
- **Code style**: Added braces to all single-line if statements per coding guidelines
- **Test performance**: Added `MAMA_FORCE_TIER_3=true` in orchestrator tests to skip embeddings

## [0.8.2] - 2026-02-13

### Changed

- **LLM backend strategy updated (cost-aware)**:
  - Standalone onboarding/init now supports backend-agnostic selection (`auto | claude | codex`).
  - Motivation includes rising premium model operating costs (including Opus 4.6 tiers), so runtime
    backend choice is now user/environment-driven instead of vendor-fixed defaults.
  - New users can start with whichever authenticated CLI is available and switch later without
    architecture changes.
- **Embedding server ownership clarified**:
  - Standalone (`@jungjaehoon/mama-os`) is now the default owner of HTTP embedding runtime.
  - MCP server no longer starts HTTP embedding by default; legacy opt-in via
    `MAMA_MCP_START_HTTP_EMBEDDING=true`.
- **Port model unified**:
  - API/UI: `3847`
  - Embedding/chat runtime: `3849`
  - `MAMA_EMBEDDING_PORT` is primary; `MAMA_HTTP_PORT` remains backward-compatible alias for
    embedding runtime paths.
- **Dependency ownership cleanup**:
  - Direct `@huggingface/transformers` dependency removed from `mcp-server`,
    `claude-code-plugin`, and `openclaw-plugin`.
  - Embedding warmup and checks now go through `@jungjaehoon/mama-core` exports.

### Fixed

- **MCP legacy embedding port parsing**:
  - Invalid embedding port env values no longer produce `NaN` runtime behavior in
    `packages/mcp-server/src/server.js`; fallback to `3849` is enforced.
- **Docs/runtime command drift**:
  - Mobile/security/troubleshooting docs now consistently use `mama start` for MAMA OS runtime
    workflows and align systemd/PM2 examples with current startup model.

### Documentation

- Updated architecture, performance, reference, tutorial, installation, and troubleshooting docs
  to match current runtime boundaries and port responsibilities.

## [mama-core-1.1.0] - 2026-02-13

### Changed

- **TypeScript Migration**: Complete rewrite of all 30+ JS files to TypeScript
  - All source files now `.ts` with strict type checking
  - Exported type definitions for downstream consumers
  - Proper interface definitions for all public APIs
  - `tsconfig.json` added with strict mode configuration
  - CommonJS compatibility maintained via named exports

### Added

- **Type Interfaces**: 50+ new type definitions
  - `DecisionRecord`, `CheckpointRow`, `PreparedStatement`
  - `DeprecateAutoLinksResult`, `ScanAutoLinksResult`, `DeleteAutoLinksResult`
  - `CreateLinkBackupResult`, `RestoreLinkBackupResult`, `VerifyBackupResult`
  - `SaveParams`, `SaveResult`, `SearchResult`, `RecallResult`, `UpdateResult`
  - `SuggestOptions`, `SuggestResult`, `QualityReport`, `QualityRecommendation`
- **Runtime Validation**: Type guards for LLM response parsing
  - `isDecisionAnalysisResult()`, `isQueryIntentResult()` validators
- **Safety Guards**:
  - Cycle detection in supersedes chain walks (prevents infinite loops)
  - Nullish coalescing (`??`) for values where `0` is valid
  - Depth limits (MAX_CHAIN_DEPTH=1000) for graph traversals

### Fixed

- **WebSocket Security**: Internal error details no longer exposed to clients
- **Interval Leak**: try/finally now properly wraps interval lifetime
- **Cron Race Condition**: Graceful handling when job removed during execution

### Technical Debt

- Removed duplicate `PreparedStatement` interfaces (consolidated to `db-adapter/statement.ts`)
- Removed duplicate `DecisionRecord` interfaces (consolidated to `db-manager.ts`)
- Async/await annotations retained for future-proofing (sync SQLite adapter today)

## [0.8.0] - 2026-02-12

### Added

- **Webchat Media Upload**: Image/PDF upload with drag & drop, preview thumbnails, and Claude Vision integration
  - Supported formats: JPEG, PNG, GIF, WebP, SVG, PDF (20MB max, auto-compress >5MB)
  - `/api/upload` and `/api/media/:filename` endpoints
  - WebSocket `attachments` protocol for real-time image processing
- **TTS (Text-to-Speech)**: Auto-read assistant responses with voice
  - Toggle via speaker icon, speed control 0.5x-2.0x (default 1.8x for Korean)
  - Markdown/emoji stripping for clean speech output
  - Hands-free mode: auto-start STT after TTS completes
- **STT (Speech-to-Text)**: Voice input with auto-silence detection (2.5s)
  - Continuous recognition for multiple sentences
  - Auto language detection (Korean/English)
- **Image Analysis**: Claude Vision API integration via `ImageAnalyzer`
  - Singleton client caching for performance
  - Prompt injection sanitization (`sanitizeUserPrompt`)
  - Path validation to prevent LFI attacks
- **Hybrid MCP+Gateway Mode**: Both MCP servers and gateway tools can run simultaneously
  - `--mcp-config` and `--strict-mcp-config` flags passed to Claude CLI
  - Gateway tools (browser, media, PR review) available alongside MCP tools
  - Enables rich ecosystem: external databases, APIs via MCP + MAMA-native tools
- **Cron Job Lock Timeout**: 10-minute default lock timeout prevents stuck jobs
- **Dashboard Reorganization**: Agent selection in floating chat, session improvements
- **BaseGateway Abstract Class**: Deduplicated common gateway logic (Discord, Slack, Telegram)
- **Graph API**: `/api/graph/decisions`, `/api/graph/checkpoints` endpoints for decision visualization
- **Browser Tools**: `browser_open`, `browser_screenshot`, `browser_click` in gateway-tools.md
- **Lightbox Viewer**: Click images in chat to view full-size with zoom/pan

### Changed

- **Session Reset Warning**: Now bilingual (English + Korean)
- **System Prompt Optimization**: Gateway tools embedded directly to prevent truncation
- **DebugLogger**: Consistent logging across all modules (no more console.log)
- **Multi-Agent Free Chat**: Only responds to explicitly mentioned agents

### Fixed

- **Double Image Analysis**: Discord gateway now always clears contentBlocks after analysis
- **Port Conflict**: Stale process cleanup on startup
- **Prompt Overflow**: Enforced system prompt truncation and auto-session reset
- **Safari Compatibility**: Removed lookbehind regex patterns for iOS support
- **ESM Import**: Fixed `matchAll` with proper import syntax

### Security

- **LFI Prevention**: Server ignores client `filePath`, reconstructs from `filename` only
- **Filename XSS**: Sanitization with `escapeHtml` and `escapeAttr` for attribute contexts
- **Prompt Injection**: `sanitizeFilenameForPrompt` and `sanitizeUserPrompt` guards
- **Path Traversal**: `allowedBase` validation on all file operations
- **MCP Args Masking**: Sensitive arguments redacted in logs
- **MAMA_TRUSTED_ENV**: Hard gate for dangerous operations

### Removed

- **Gemini Workflows**: Removed unused `.github/workflows/gemini-*.yml` and `.github/commands/gemini-*.toml`

## [0.7.1] - 2026-02-12

### Fixed

- **Config preservation**: Custom config sections (scheduling, etc.) no longer lost on restart
- **Cron job persistence**: Jobs created via Settings UI now saved to config.yaml and survive restarts
- **Cron job loading**: Config-defined scheduling.jobs now loaded into scheduler on startup
- **Setup auth error**: Local requests no longer require MAMA_AUTH_TOKEN for config updates
- **Zombie process cleanup**: `mama stop` now kills processes holding ports 3847/3849

## [0.7.0] - 2026-02-12

### Added

- **Skill System**: Unified skill registry with 3 sources (MAMA, Cowork, External GitHub repos)
  - Skills Marketplace UI in Viewer (browse, install, toggle, search)
  - Agent auto-detects installed skills by keyword matching in system prompt
  - `mama init` copies default skill templates to `~/.mama/skills/`
  - Path traversal protection (`validateSkillName`) on all skill endpoints
- **Cron Scheduler**: Dashboard + Settings UI for scheduled job management
  - Create/edit/delete/toggle cron jobs from Viewer
  - Agent knows cron API via `gateway-tools.md` documentation
- **Token Tracker**: Per-agent token usage tracking with cost breakdown
  - Dashboard cards (today/week/month) with agent breakdown bars
  - `/api/tokens/summary` and `/api/tokens/by-agent` endpoints
- **Floating Chat**: Draggable/resizable chat panel overlay on all Viewer tabs
- **Codex Backend**: OpenAI Codex CLI as alternative agent backend
- **PR Review Workflow**: Multi-agent autonomous PR review with LEAD delegation
  - `pr_review_threads` gateway tool for agent autonomy
  - Background task delegation (`DELEGATE_BG`) with workspace isolation
  - Auto-checkout PR branch, parallel delegation, busy retry
- **Gateway Tools**: `pr_review_threads`, `pr_review_reply` for PR interaction
- **Work Tracker**: Agent task tracking across multi-agent delegation chains
- **Ecosystem Support**: Anthropic Cowork plugins, MCP servers, GitHub repos all installable via agent or UI

### Changed

- `SkillRegistry` constructor no longer requires `builtinSkillsDir` parameter
- `dangerouslySkipPermissions` defaults to `false` in Discord gateway
- Agent system prompt now includes all installed skill directives
- `console.*` replaced with `DebugLogger` in viewer modules and multi-agent-base
- README rewritten: removed "vibe coding" section, added skill/cron/ecosystem showcase

### Fixed

- `isAuthenticated(req)` check added to `POST /api/restart` and `PUT /api/config`
- `JSON.parse` wrapped in try/catch for `gh` CLI output in gateway-tool-executor
- PR review poller: `L` prefix formatting when line number is null
- PR review poller: `resolvedCount` accuracy with filtered thread subsets
- Lone surrogate stripping before sending to Claude API
- Multi-agent: prevent hallucinated file paths in delegation
- Agent message queue: drain on enqueue, correct agent cwd
- Stop command: properly kill lingering daemon processes

### Security

- Path traversal validation on all skill name inputs
- Source validation on DELETE/PUT skill endpoints
- CSRF protection via `isAuthenticated` on state-changing endpoints
- `dangerouslySkipPermissions` default hardened to `false`

## [0.6.1] - 2026-02-10

### Fixed

- Gateway Read tool file size guard (200KB limit) preventing 10MB+ prompt overflow from large files (e.g. daemon.log)
- Gateway Read tool parameter flexibility: accept `path`, `file_path`, and `file` to prevent agent hallucination from failed tool calls
- Gateway tools system info: replaced incorrect `systemctl` commands with `mama status/stop/start`
- Added tool call rules to prevent agent fabrication when tools fail

## [0.6.0] - 2026-02-10

### Added

- ESLint TypeScript support with `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`
- TypeScript override in `.eslintrc.json` with `no-unused-vars`, `no-explicit-any` (warn), `no-require-imports` (warn)
- Typed Graph API (`graph-api.ts`) with `graph-api-types.ts` for all handler types
- `ContentBlock` interface for Claude stream protocol (`text`, `tool_use`, `tool_result`)
- `MultiAgentHandlerBase` abstract class extracting shared Discord/Slack infrastructure
- Authentication guard (`isAuthenticated`) on config-writing endpoints (`PUT /api/config`, `PUT /api/multi-agent/agents/:id`)
- Timing-safe token comparison (`crypto.timingSafeEqual`) to prevent side-channel attacks
- Input validation for agent config fields (tier, enabled, cooldown_ms, can_delegate)
- `safeParseJsonArray` for defensive JSON.parse on DB data

### Changed

- Lint scripts now include `.ts` files (`--ext .js,.mjs,.ts`)
- `lint-staged` unified to `*.{js,mjs,ts}` with eslint + prettier
- `format`/`format:check` scripts include `.ts` files
- `maskToken` standardized to `***[redacted]***` format with consistent `isMaskedToken` detection
- `dangerouslySkipPermissions` default changed from `true` to `false` in Discord gateway
- `body.confidence || 0.8` changed to `body.confidence ?? 0.8` (preserves zero)
- `body.outcome` uses `String()` instead of unsafe `as string` cast
- `start.ts` migrated `require('../../api/graph-api.js')` to ES import
- Redundant `require('fs'/'path'/'os'/'http')` calls removed across agent-loop.ts and start.ts
- `onboarding-state.ts` uses top-level `unlinkSync` import instead of inline `require`

### Fixed

- 70+ ESLint errors (no-unused-vars, prefer-const, no-useless-escape, no-empty, no-control-regex)
- 208 ESLint warnings (no-explicit-any, no-require-imports) suppressed with targeted disable comments
- Token masking mismatch: `isMaskedToken` regex now matches `maskToken` output format
- CORS headers centralized in `createGraphHandler` instead of per-route duplication
- `req.url` null guard before URL construction in graph handler
- Missing `afterEach` import in content-dedup.test.ts
- Missing `vi` import in yaml-frontmatter.test.ts
- Explicit `ChainState` return type on `MultiAgentHandlerBase.getChainState()`
- Pre-existing postinstall.test.js failure (empty config.json JSON.parse)

### Removed

- Outdated architecture docs (`docs/architecture-current-state-2026-02-08.md`, `docs/architecture-mama-swarm-2026-02-06.md`)
- Legacy `graph-api.js` (replaced by TypeScript `graph-api.ts`)

## [0.5.1] - 2026-02-09

### Fixed

- Plugin load error from agents entry in plugin.json

## [0.5.0] - 2026-02-08

### Added

- Multi-agent swarm system with 6-phase architecture
- Plugin hooks streamlining, OMC overlap removal
