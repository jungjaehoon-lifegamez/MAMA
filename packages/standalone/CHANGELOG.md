# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
