# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added - mama-os@0.5.0-beta: Internationalization, Multi-Agent Fixes & Agent Hooks

**Internationalization** (2026-02-09)

- **Full English Translation** - Converted 538+ Korean strings to English across 35 files (CLI, gateways, onboarding, multi-agent, personas, skills, scheduler)
- **English Persona Templates** - Translated 3 built-in personas (sisyphus, developer, reviewer) to English in `templates/personas/`
- **i18n Default Language** - Changed default language from `ko` to `en` in i18n-messages and message-router
- **Korean Regex Preserved** - Korean category routing patterns remain functional for Korean-speaking users

**Multi-Agent Discord Fixes** (2026-02-08)

- **DELEGATE:: Syntax Detection** - `extractMentionedAgentIds()` now detects `DELEGATE::agent::task` patterns for proper routing
- **Bidirectional Bot Mention Routing** - Bot-to-bot mentions now route correctly in both directions
- **Live Progress Indicator** - Shows `Working... (Xs)` during long-running Discord requests
- **Infinite Loop Prevention** - Chain length limit and global cooldown prevent runaway agent loops
- **Opt-in Port Auto-Kill** - Port conflict resolution now requires explicit opt-in
- **REVIEW→DEV Routing Fix** - Unblocked mention routing during APPROVE cooldown period

**Agent Hooks** (2026-02-09)

- **PostToolUse Handler** - Auto-extracts API/function/type contracts after Write/Edit operations
- **PreCompact Handler** - Detects unsaved decisions when context reaches 80% capacity, injects compression prompt
- **StopContinuation Handler** - Auto-resumes incomplete agent responses (opt-in, max 3 retries)
- **Contract Extractor** - 5 extractors for API, function, type, SQL, and GraphQL contracts (661 lines)
- **256 New Tests** - Full coverage for all 4 hook modules

**PR Review Poller & Commit Workflow** (2026-02-09)

- **PR Review Poller** - Polls GitHub PR review comments and routes Reviewer → LEAD chain
- **5-Minute Reminders** - Unresolved PR review threads trigger periodic reminders
- **Commit+Push Instructions** - Reviewer APPROVE propagates to LEAD with commit workflow
- **Nitpick Severity Level** - PR analysis now distinguishes nitpick-level comments

**Other Features** (2026-02-08)

- **!stop Command** - Interrupt running agents from Discord with `!stop` prefix
- **Delegation System Reminders** - delegation-started/completed notifications in Discord and Slack
- **BackgroundTaskManager** - Async task delegation with SystemReminderService
- **Content Dedup** - YAML frontmatter filtering and prompt size monitoring
- **PromptEnhancer** - Native keyword detection, AGENTS.md and rules injection (44 tests)

### Changed - mama-os@0.5.0-beta

- **MessageQueue TTL** - Increased from 3 minutes to 10 minutes (agents take 200s+ on complex tasks)
- **Sisyphus Persona** - Tightened SOLO threshold: only typo-level changes (≤5 lines), everything else delegates to DevBot
- **isKorean Default** - Message router defaults to `false` (English-first)

### Fixed - mama-os@0.5.0-beta

- **Discord Message Length** - Corrected message splitting to respect 2000-char limit (was 3900), preventing `Invalid Form Body` errors
- **Cross-Channel Batch Corruption** - Fixed batch processing across different Discord channels
- **Duplicate Session Cache** - Prevented duplicate entries in session cache
- **Env Var Conflicts** - Clean conflicting MAMA environment variables in persistent CLI process
- **Graceful Shutdown** - Improved stop command reliability

### Added - mama-os@0.4.0: Multi-Agent Swarm & Agent Provisioning

**Builtin Agent Personas & Auto-Provisioning** (2026-02-07)

- **Builtin Persona Templates** - 4 persona files bundled in `templates/personas/` (sisyphus, developer, reviewer, pm)
- **Auto-Provisioning** - `provisionDefaults()` copies templates to `~/.mama/personas/` on first start
- **Default Multi-Agent Config** - Injects disabled multi_agent config into config.yaml if missing
- **Onboarding Phase 7b** - Agent team introduction during onboarding with activation option
- **OS Agent Multi-Agent Management** - OS agent can configure/activate/customize agent team anytime
- **Port Constants** - Extracted `API_PORT=3847` and `EMBEDDING_PORT=3849` as named constants

**Multi-Agent Swarm System** (2026-02-06) - Coordinated AI agents with hierarchical delegation for Discord.

- **Tool Permission Manager** - 3-tier permission system (Tier 1=full, 2/3=read-only), wildcard matching, system prompt injection
- **Category Router** - Regex-based message routing, Korean/English patterns, priority ordering, compiled regex cache
- **Task Continuation Enforcer** - Completion marker detection (DONE/완료/✅), truncation sensing, auto-retry (max 3)
- **Delegation Manager** - `DELEGATE::{agent_id}::{task}` pattern, circular prevention, depth-1 limit, Discord notifications
- **UltraWork Manager** - Autonomous multi-step sessions combining delegation + continuation, safety limits (20 steps / 30 min)
- **5-Stage Message Routing** - free_chat → explicit_trigger → category_match → keyword_match → default_agent
- **Agent Config Extensions** - `tier`, `can_delegate`, `auto_continue`, `tool_permissions` fields (backward compatible)
- **173 multi-agent tests** across 8 test files (6 new + 2 existing)

### Changed - mama-os@0.4.0

- **MultiAgentOrchestrator** - Integrated CategoryRouter for stage-3 routing
- **AgentProcessManager** - System prompt now includes tool permission and delegation sections
- **Config Types** - Synced `cli/config/types.ts` with `multi-agent/types.ts` for categories, ultrawork, task_continuation

## [0.3.16] - 2026-02-06

### Fixed - mama-os@0.3.16

- **stdin backpressure for large content**: Fixed Claude CLI hanging on 150KB+ content
  - `stdin.write()` now checks return value and waits for `drain` event if buffer full
  - Prevents zombie processes when processing Discord images with large context

- **Viewer TTS/microphone methods**: Fixed method name mismatches
  - `chat.toggleVoiceInput()` → `chat.toggleVoice()` (microphone toggle)
  - `chat.setTTSSpeed()` → `chat.setTTSRate()` (TTS speed control)

- **Discord guilds config structure**: Fixed mention-free config not being applied
  - Config must use `discord.guilds.'*'.requireMention: false` (not top-level `discord.requireMention`)
  - Gateway now correctly reads guild-based configuration

## [0.3.8] - 2026-02-06

### Fixed - mama-os@0.3.8

- **Discord image reading**: Strengthened image instruction format to MANDATORY
  - Claude CLI `-p` mode only supports text, not multimodal
  - Previous soft instruction "Use the Read tool" was often ignored
  - Now uses `**[MANDATORY IMAGE]**` format requiring Read tool before responding

### Fixed - claude-code-plugin@1.7.6

- **PreToolUse function extraction**: Now extracts function DEFINITIONS, not just calls
  - Added patterns for `function name()`, `const name = () =>`, and imports
  - Reads file content when edit content is insufficient
  - Fixed `→` format parsing in extractExpectReturns()

### Added - claude-code-plugin@1.7.6

- **PostToolUse duplicate filtering**: Prevents identical contracts from polluting DB
- **PostToolUse builds_on edges**: Auto-connects similar contracts (>80% similarity)
- **Return type extraction**: From JSDoc `@returns`, TypeScript `: ReturnType`, Python `-> Type`

## [0.3.7] - 2026-02-05

### Fixed - claude-code-plugin@1.7.5

- **PreToolUse MCP timeout**: Replaced MCP spawn with direct SQLite + embeddings (instant search)
- **Cross-platform debug path**: Uses `os.tmpdir()` fallback instead of hardcoded `/tmp`
- **Session ID fallback**: Full ISO timestamp prevents same-day session grouping

### Changed - claude-code-plugin@1.7.5

- **Debug logging gated**: Requires `MAMA_DEBUG=true` (no production overhead)
- **Hook configuration unified**: All hooks in `plugin.json` only (removed `hooks/hooks.json`)
- **handler export added**: `posttooluse-hook.js` exports `handler` for hook spec compliance

### Security - claude-code-plugin@1.7.5

- Input sanitization via `prompt-sanitizer.js`
- CodeRabbit review findings addressed

## [0.3.6] - 2026-02-05

### Fixed - claude-code-plugin@1.7.4

- **PostToolUse Write tool bug**: Now reads entire file for Write tool (previously only Edit)
  - Fixes incorrect endpoint detection (e.g., showing `/api/checkout` when `/api/payments` was written)

### Changed - claude-code-plugin@1.7.4

- **Hook messages strengthened to MANDATORY**: Claude now follows hook instructions instead of ignoring suggestions
  - PostToolUse: "MANDATORY: Save API Contract NOW" with code template
  - PreToolUse: "MANDATORY: Create contract BEFORE coding" when no contracts exist
- **PreToolUse always passes context**: Uses exit(2) + message to inject search results to Claude
- **Hook output visibility clarified**:
  - PreToolUse/PostToolUse: exit(2) → visible to Claude as error context
  - UserPromptSubmit/SessionStart: additionalContext → quiet injection to Claude

## [0.3.5] - 2026-02-04

### Fixed - claude-code-plugin@1.7.3

- **PostToolUse Hook Auto-Injection**: PostToolUse hooks now properly display output to Claude
  - Changed exit code from 0 to 2 (blocking error mode)
  - Changed output from stdout to stderr (console.error)
  - MAMA v2 contract extraction prompts now automatically injected after Write/Edit
  - Per GitHub issue #11224: exit code 2 + stderr = visible to Claude
  - Note: Displays as "blocking error" in UI but functionality works correctly

### Changed - claude-code-plugin@1.7.3

- **PreToolUse hook visibility**: Now uses exit code 2 + stderr (visible to Claude)
- **PostToolUse hook visibility**: exit code 2 + stderr (visible to Claude)
- Auto-Save suggestions now appear immediately after code changes
- Hooks moved inline to plugin.json (official Claude Code spec)
- **PreToolUse hook re-enabled**: Contract injection before Read/Grep operations (was mistakenly removed)

## [claude-code-plugin-1.7.0] + [mama-server-1.7.0] - 2026-02-04

### Added - MAMA v2: AI Agent Consistency Engine

- **PostToolUse Hook** - Automatic contract detection and tracking
  - Detects API endpoints, function signatures, request/response schemas
  - Extracts database schemas and relationships
  - Spawns Haiku task agent for contract analysis
  - Auto-saves contracts to prevent vibe coding breakage

- **PreToolUse Hook** - Contract injection before code edits
  - Direct DB access for fast context retrieval
  - Injects relevant contracts before Read/Edit operations
  - Prevents Claude from guessing schemas

- **Contract Extractor** (`src/core/contract-extractor.js`)
  - Pattern-based contract detection
  - Multi-language support: JavaScript/TypeScript, Python, Java (Spring), Go, Rust, SQL, GraphQL
  - Similarity checking to prevent duplicates
  - Cross-language semantic matching via vector embeddings

### Fixed

- **DB Initialization** - Fixed `posttooluse-hook.js` calling vectorSearch without initDB
- **Test Cleanup** - Removed obsolete recency weighting tests (moved to MCP server)
- **Hook Enablement** - Re-enabled PreToolUse and PostToolUse for v2 features

### Changed

- **Documentation Rewrite** - Focused on decision tracking differentiation
  - Main value proposition: Tracks WHY (reasoning), not just WHAT (facts)
  - New hook: "Why Vibe Coding Breaks After Session 2"
  - Added workflow section: Auto-tracking, manual save, next session
  - Reduced README from 100+ lines to ~60 lines
  - Differentiation from regular memory systems emphasized

- **Messaging Updates** - Aligned with decision-tracking focus
  - Opening example: API contract with reasoning (not generic preferences)
  - Root cause explanation: Memory loss + Context loss + Hallucination
  - Solution: Claude checks MAMA before guessing
  - Workflow: Build → Save → Claude remembers

### Removed

- **setup.md** - Unused command file (unregistered, no tests)
  - Setup Hooks are the official pattern (not command-based wizards)

### Documentation

- **README.md** - Complete rewrite for clarity and focus
- **Package READMEs** - Updated claude-code-plugin and mcp-server
- **Supporting Docs** - Updated docs/index.md, developer-playbook.md
- **Consistency** - All examples now coding/development-related
- **Brevity** - Removed lengthy technical explanations

### Package Impact Analysis

| Package              | Version  | Impact                                            |
| -------------------- | -------- | ------------------------------------------------- |
| claude-code-plugin   | 1.7.0 ⬆️ | Major: MAMA v2 features, documentation            |
| mama-server (MCP)    | 1.7.0 ⬆️ | Minor: Documentation only                         |
| mama-core            | 1.0.1 ➡️ | None: No changes                                  |
| openclaw-mama        | 0.4.1 ➡️ | None: No changes                                  |
| mama-os (standalone) | 0.3.4 ➡️ | Changed: Image auto-translation (unrelated to v2) |

**Breaking Changes:** None - MAMA v2 features are additive

**Standalone (MAMA OS) Changes:**

- **Image Auto-Translation** (unrelated to v2): Added automatic translation prompt injection for image messages
  - Detects short messages with images (<15 chars) or image keywords
  - Auto-adds "이미지의 모든 텍스트를 한국어로 번역해주세요" prompt
  - File: `packages/standalone/src/gateways/message-router.ts`

**Migration Notes:**

- PostToolUse and PreToolUse hooks now active by default
- No user action required - contracts automatically tracked
- Existing MCP server installations compatible (no API changes)
- Standalone image auto-translation: No migration needed (additive feature)

## [mama-os-0.3.1] - 2026-02-03

### Fixed

- **PWA Favicon** - Convert favicon.ico from PNG to proper ICO format (16x16, 32x32, 48x48)
- **Favicon Route** - Add `/favicon.ico` endpoint to graph-api.js

## [mama-os-0.3.0] - 2026-02-03

### Added

- **Self-contained Context Injection** - MAMA Standalone now operates independently without MCP server
  - Checkpoint summary injection with last session state
  - Recent decisions (last 5) for quick context
  - Semantic search for related decisions based on user query
  - Configurable via `agent.contextInjection` in config

- **Hybrid Gateway/MCP Tool Routing** - Flexible tool execution modes
  - Gateway mode (default): Tools executed via GatewayToolExecutor with text-based parsing
  - MCP mode: Tools routed through MCP server for Claude Desktop compatibility
  - Configuration via `agent.tools.gateway` and `agent.tools.mcp` arrays

- **Gateway Tools Documentation** - New `gateway-tools.md` defines all available tools
  - MAMA Memory tools (search, save, update, load_checkpoint)
  - Browser automation tools (10 Playwright-based tools)
  - Utility tools (discord_send, Read, Write, Bash)

- **Website Screenshots Gallery** - "See MAMA in Action" section with phone mockups

### Changed

- **Version Bump** - Major version increase to reflect architectural changes
- **Plugin Conflict Prevention** - Claude Code plugin now skips hooks when running in MAMA OS environment

### Fixed

- **Tool ID Collision** - Changed from `Date.now()` to `crypto.randomUUID()` for unique IDs
- **SIGINT Propagation** - Fixed daemon mode signal handling with `detached: true`

## [mama-os-0.1.7] - 2026-02-03

### Added

- **Website Redesign** - Complete redesign of GitHub Pages landing page
  - New MAMA mascot icon with playful design (yellow/lavender color palette)
  - Modern typography with Fredoka (headings) + Nunito (body) fonts
  - Animated hero section with bouncing mascot and speech bubble
  - Floating blob decorations with CSS animations
  - Documentation section with 6 quick-access cards
  - Responsive design for mobile devices
  - White navigation bar with backdrop blur

### Changed

- **Website Language** - All content now in English
- **README Icon** - Added MAMA mascot icon to repository README

### Fixed

- **Browser Capture Slowness** - Changed `waitUntil` from `networkidle` to `load` for faster page captures
  - Reduced timeout from 30s to 15s
  - Fixes slow screenshot capture on heavy sites like Naver

## [mama-os-0.1.6] - 2026-02-02

### Added

- **Browser Automation Tools** - 10 Playwright-based tools
  - navigate, screenshot, click, type, get_text, scroll, wait_for, evaluate, pdf, close
  - Auto-wait for elements, multi-browser support (chromium/firefox/webkit)

### Changed

- **Migrated from Puppeteer to Playwright** - Better stability and features

## [mama-os-0.1.5] - 2026-02-02

### Added

- **Discord file attachment**: Auto-attach files when response contains outbound file paths
  - Pattern detection: `파일 위치:`, `File:`, `Path:`, `saved at:`
  - Auto-detect `~/.mama/workspace/media/outbound/` paths
  - Supports all file types (images, PDFs, documents)

- **Image path preservation**: Claude now remembers image paths across conversation turns
  - Added `localPath` property to ContentBlock type
  - Text blocks with path info now pass through message-router
  - Files saved to `~/.mama/workspace/media/inbound/` instead of `/tmp/`

### Fixed

- **mama-os**: CLI `--version` now reads from package.json instead of hardcoded value
- **mama-os**: Version fallback changed from hardcoded '0.1.4' to 'unknown'
- **plugin**: Removed unused `_info` function in validate-manifests.js
- **plugin**: Execute bit tests now skip on Windows for cross-platform compatibility

## [mama-os-0.1.1] - 2026-02-01

### Fixed

**Code Review Fixes (PR #8)**

- **Schema Timestamp Convention** - Aligned all migration files to use milliseconds (`unixepoch() * 1000`)
  - Fixed latent bug where schema DEFAULT (seconds) didn't match app code (milliseconds)
  - Added migration 011 with validation trigger to auto-convert accidental second-based inserts
  - All 7 migration files updated for consistency

- **Server & Client Improvements**
  - Added `res.resume()` in `isEmbeddingServerRunning()` to properly drain HTTP response sockets
  - Made ollama-client error check more specific with regex pattern for model not found errors
  - Consolidated ollama-client to mama-core (removed duplicate from mcp-server, 388 lines saved)
  - Fixed WebSocket shutdown sequence - terminate clients before closing HTTP server

- **Code Quality**
  - Added defensive null checks for IP extraction in WebSocket handler
  - Fixed timer leak in memory-inject Promise.race pattern
  - Added safe JSON.parse helper with fallback
  - Fixed route ordering bug in session API (`/api/sessions/last-active` was unreachable)
  - Updated relevance-scorer to use 'pending' key instead of null for OUTCOME_WEIGHTS

- **Documentation**
  - Updated memory-inject AC #1 comment to reflect actual 5s timeout for LLM latency
  - Removed outdated "Respects process.exit signals" from progress-indicator header
  - Added explicit timestamp convention comment in db-manager.js

- **CI/Testing**
  - Fixed pre-commit hook to set `CI=true` for skipping tests requiring external services
  - Updated Node.js requirement from >=18 to >=22 (native module compatibility)

---

## [mama-os-0.1.0] - 2026-02-01

### Added

**MAMA OS v0.1.0 - Your AI Operating System**

- **New Package: `@jungjaehoon/mama-os` (v0.1.0)** - Your AI Operating System with gateway integrations and autonomous agent capabilities
  - **CLI Commands**: `mama init`, `mama start`, `mama stop`, `mama status`, `mama run`, `mama setup`
  - **Agent Loop**: Autonomous conversation loop with Claude API integration
  - **Gateway Support**: Discord, Slack, Telegram bot integrations
  - **Skills System**: Pluggable skill architecture with loader and matcher
  - **Onboarding Wizard**: 9-phase autonomous discovery with personality quiz
  - **Scheduler**: Cron-based job scheduling with heartbeat monitoring
  - **OAuth Manager**: Authentication for external services
  - **MAMA OS Viewer**: Integrated graph viewer and mobile chat interface

- **New Package: `@jungjaehoon/mama-core`** - Shared core functionality
  - **DB Adapter**: Unified database abstraction layer (SQLite)
  - **Embedding Server**: HTTP server for fast embedding generation (port 3847)
  - **Memory Store**: Decision storage and retrieval
  - **Decision Tracker**: Graph-based decision relationship tracking
  - **Query Intent**: Natural language query interpretation
  - **Relevance Scorer**: Semantic similarity scoring

**Onboarding & Discovery**

- **9-Phase Autonomous Onboarding** - Interactive setup wizard for new users
  - Phase 1-4: Introduction, personality quiz, workspace setup, exploration
  - Phase 5-7: Features summary, security review, integrations
  - Phase 8-9: Demo showcase, finalization with ritual
- **Personality Quiz** - User preference detection for personalized experience
- **Skills Integration** - Pre-built skills (document-analyze, image-translate, heartbeat-report)
- **Cron/Heartbeat Features** - Scheduled task execution and health monitoring

**Architecture Improvements**

- **Monorepo Cleanup** - Removed sprint planning files and obsolete documentation
- **Package Consolidation** - Clear separation of concerns (standalone, core, mcp-server, plugins)
- **Gateway Architecture** - Message routing, session management, context injection
- **Concurrency Control** - Lane-based concurrency with session keys

### Changed

- **Project Structure** - Added `packages/standalone` and `packages/mama-core` to monorepo
- **Documentation** - Removed obsolete MAMA OS planning docs (phase4-8, master plan, vision)
- **Build System** - Updated to support standalone TypeScript compilation

### Removed

- **Sprint Files** - Deleted `.sisyphus/` directory and temporary planning documents
- **Test Scripts** - Removed one-time test scripts (luna-bot.js, test-_.js, verify-_.mjs)
- **Obsolete Docs** - Removed phase implementation plans and mobile chat integration plan

### Notes

- **MAMA OS Initial Release (0.1.0)** - First public release of standalone agent
- **Package Split** - Core functionality moved to `mama-core` for better reusability

---

## [1.6.0] - 2026-01-30

### Added

- **GitHub Pages Landing Page** - https://jungjaehoon-lifegamez.github.io/MAMA
  - Mobile-responsive design with quick install guides
  - Platform-specific installation instructions
  - Visual feature showcase
- **`/mama-setup` Wizard Command** - Guided onboarding for first-time users
  - 5-step validation (Node.js, npm, SQLite, embedding model, database)
  - Clear progress indicators with emoji status (⏳ loading, ✅ ready)
  - Automatic remediation suggestions for common issues
- **Progress Indicators During Setup** - No more silent waits
  - Model download progress (⏳ Downloading embedding model...)
  - Database initialization feedback (✅ Database initialized)
  - Clear status updates throughout first-time setup
- **`tier-validator.js` Module** - Centralized tier validation logic
  - Shared validation across setup wizard and configure command
  - Consistent tier detection and remediation guidance
- **Installation Verification Script** - `npm run verify`
  - Detects Tier 1 vs Tier 2 status
  - Provides remediation guidance for degraded mode
  - Validates all critical dependencies
- **Mermaid Flowcharts** - Visual troubleshooting guides
  - Decision trees for Tier 2 remediation
  - Flowcharts in troubleshooting documentation
  - Easier navigation of common issues

### Improved

- **README.md** - Now prominently links to Tier 2 Remediation Guide
  - Reduced confusion about degraded mode
  - Clear path to upgrade from Tier 2 to Tier 1
- **First-Time User Experience** - Significantly enhanced
  - No more silent 1-2 minute waits during initialization
  - Clear feedback at every step
  - Proactive guidance for common setup issues

### Fixed

- **User Confusion About Tier 2 Status** - Guide now prominently linked in README
  - Users understand what Tier 2 means
  - Clear steps to remediate and upgrade to Tier 1

## [1.5.11] - 2026-01-28

### Fixed

- **Hooks Path Resolution** - Fixed plugin hooks path for correct loading
  - Changed `./hooks/hooks.json` → `../hooks/hooks.json` (relative to plugin.json in `.claude-plugin/`)
  - Updated `validate-manifests.js` to resolve hooks path correctly

## [openclaw-plugin-0.2.3] - 2026-01-28

### Fixed

- **CodeRabbit Review Feedback** - Addressed all code review issues from PR #6
  - Fixed hooks path resolution: `./hooks/hooks.json` → `../hooks/hooks.json` (relative to plugin.json location)
  - Added guard for missing `better-sqlite3` in postinstall scripts
  - Re-verify native module load after `prebuild-install` (success doesn't guarantee loadability)
  - Resolve `better-sqlite3` through `@jungjaehoon/mama-server` dependency path

### Changed

- **TypeScript Improvements**
  - Use `Static<typeof pluginConfigSchema>` for type-safe PluginConfig
  - Add warning when `initMAMA` called with different config after initialization

### Documentation

- **JSDoc Coverage** - Improved from 66.67% to 80%+
  - Added docstrings to `mamaPlugin` and `register` method
  - Added docstrings to postinstall `main` functions in both packages

## [mcp-server-1.5.11] - 2026-01-28

### Added

- **Postinstall Script** - New `scripts/postinstall.js` for automatic `better-sqlite3` prebuild installation
  - Ensures native module is ready after npm install
  - Uses shared utility `scripts/ensure-sqlite-prebuild.js` in monorepo
  - Falls back to inline logic when installed from npm

## [1.5.10] - 2026-01-28

### Fixed

- **Plugin MCP Connection Failure** - Fixed `Cannot find package '@huggingface/transformers'` error
  - Plugin hooks use `embeddings.js` which falls back to local model when HTTP server unavailable
  - Added missing `@huggingface/transformers` dependency to plugin `package.json`
  - Previously worked only when HTTP embedding server was running on port 3847
  - Now plugin cache survives updates without manual `npm install`

## [openclaw-plugin-0.2.2] - 2026-01-28

### Fixed

- **Postinstall Model Download** - Fixed `Cannot find package '@huggingface/transformers'` in postinstall
  - Added `@huggingface/transformers` dependency for postinstall script model pre-download

## [openclaw-plugin-0.2.1] - 2026-01-27

### Fixed

- **Reasoning truncation losing link info** - `builds_on`, `debates`, `synthesizes` patterns now preserved
  - Auto-recall and mama_search both extract link patterns from reasoning
  - Shows truncated reasoning + separate 🔗 link line if pattern found after truncation point
  - Fixes context loss when reasoning graph connections were cut off

## [openclaw-plugin-0.2.0] - 2026-01-27

### Added

- **OpenClaw Plugin** - Native plugin for OpenClaw/Moltbot gateway integration
  - **Auto-recall**: Semantic search on `before_agent_start` based on user prompt
  - **4 native tools**: `mama_search`, `mama_save`, `mama_load_checkpoint`, `mama_update`
  - **Auto-capture detection**: Pattern matching for decision-like messages on `agent_end`
  - **Context injection**: Injects relevant memories via `prependContext` return value

### Changed

- **Tool descriptions**: Enhanced with "REQUIRED WORKFLOW" guidance
  - `mama_save`: Now instructs "Call mama_search FIRST to find related decisions"
  - `mama_search`: Now shows "⚠️ TRIGGERS - Call this BEFORE mama_save"

### Technical

- Uses lifecycle hooks (`api.on("before_agent_start")`) instead of bootstrap hooks
- Direct module integration (no HTTP/REST) via `@jungjaehoon/mama-server` workspace dependency
- Published to npm as `@jungjaehoon/openclaw-mama`

## [1.5.9] - 2026-01-26

### Fixed

- **Plugin Installation Error** - Fixed "hooks: Invalid input" validation error during plugin install
  - Removed `hooks` field from `plugin.json` - Claude Code rejects path strings
  - Claude Code auto-discovers `hooks/hooks.json` from plugin root directory
  - Follows official plugin pattern (hookify, security-guidance, etc.)

- **HuggingFace Model Cache Location** - Fixed model re-download on every npm install
  - Changed cache from `node_modules/` to `~/.cache/huggingface/transformers/`
  - 465MB model persists across reinstalls
  - Respects `HF_HOME` and `TRANSFORMERS_CACHE` environment variables

### Changed

- **Sync Plugin Workflow** - Auto-update `marketplace.json` version on sync
  - Extracts version/description from `plugin.json`
  - Updates marketplace manifest automatically
  - No manual marketplace.json editing required

## [1.5.8] - 2026-01-08

### Fixed

- **Hook Schema Compatibility** - Fixed Claude Code hook validation errors
  - Claude Code updated hook output validation to be stricter
  - Fixed both `SessionStart` and `UserPromptSubmit` hooks
  - Removed unsupported fields: `decision`, `reason` (top level), `systemMessage` (hookSpecificOutput)
  - Now outputs only valid schema: `{ hookSpecificOutput: { hookEventName, additionalContext } }`
  - Fixes "Hook JSON output validation failed: Invalid input" error

## [1.5.7] - 2025-11-30

### Changed

- **Checkpoint Linking via Search-First Pattern** - Align with decision workflow
  - Removed post-save hint display (wrong timing - already saved)
  - Enhanced save tool prompt: checkpoint also requires "search first"
  - LLM now calls search before checkpoint save, includes "Related decisions: xxx" in summary
  - Same pattern as decisions: search → link → save
  - Cleaner approach: prompt-driven, no code-level forcing

## [1.5.6] - 2025-11-30

### Fixed

- **Checkpoint Related Decisions - Wrong Handler** - Fixed feature added to wrong location
  - 1.5.5 added to `checkpoint-tools.js` but production uses `server.js` unified save handler
  - Now correctly implemented in `server.js` handleSave() for type='checkpoint'
  - Same functionality: semantic search (threshold 0.8), displays related decisions hint

## [1.5.5] - 2025-11-30

### Added

- **Checkpoint Related Decisions Display** - `save_checkpoint` now shows related decisions before saving
  - Automatic semantic search (threshold 0.8) for decisions related to checkpoint summary
  - Displays hint: "🔗 Related Decisions Found (consider linking in summary)"
  - LLM can judge whether to link or not - no forced meaningless connections
  - Improves graph connectivity without noise
  - Related decision: checkpoint_related_decisions_display

## [1.5.4] - 2025-11-30

### Fixed

- **Viewer saveOutcome Bug** - Fixed TypeError when changing decision outcome from pending to success
  - Element ID mismatch: `outcome-select` → `detail-outcome-select`
  - Graph viewer now correctly updates decision outcomes

### Added

- **Security Guide Dashboard Method** - Added Cloudflare Zero Trust setup via Dashboard (Method A)
  - Recommended approach for first-time users
  - No domain zone authorization required
  - Step-by-step guide with screenshots
  - Comparison table: CLI vs Dashboard methods

## [1.5.3] - 2025-11-29

### Removed

- **Mobile Chat Auto-Checkpoint** - Removed 5-minute idle auto-save feature to reduce noise in decision database
  - **Why**: Chat logs are not work context. Auto-saving meaningless conversations polluted the checkpoint database, interfering with SessionStart hook's ability to surface relevant work state
  - **Philosophy**: "Auto-save/link creates noise. LLM should proactively decide when to save" - only intentional saves create meaningful context
  - Manual `/checkpoint` command still available for users who need it
  - **Impact**: Checkpoints now only contain actual work state (open_files, next_steps) instead of chat message history
  - Related decision: checkpoint_purpose_conflict, mobile_auto_checkpoint_removal

## [1.5.2] - 2025-11-29

### Added

- **SessionStart Proactive Greeting** - LLM now proactively greets users and provides context summary on simple greetings
  - Displays last checkpoint summary with relative timestamps
  - Shows 5 most recent decisions with outcome indicators (✅/❌/⏳)
  - Provides contextual suggestions based on previous work
  - Supports multiple languages (English, Korean, etc.)
  - Example: User says "hi" → LLM responds: "Hello! 👋 Last time you were working on X. Would you like to continue?"
- **MCP Tool Examples** - Added few-shot examples to `save` tool prompt for improved LLM understanding
  - User decision: "Let's use token bucket" → save(topic="rate_limiter", decision="Token bucket", ...)
  - Auto-discovery: "Library X conflicts with Y" → save(topic="lib_conflict", decision="Avoid X+Y", ...)

### Changed

- **SessionStart Hook Context** - Enhanced session initialization with rich context
  - Queries 5 most recent decisions and last active checkpoint from database
  - Formats timestamps as human-readable relative time (e.g., "3m ago", "2h ago", "5d ago")
  - Truncates long text for readability (80 chars for checkpoint summary, 60 for decisions)
  - Adds clear instructions for LLM to act on greeting messages proactively

## [1.5.1] - 2025-11-28

### Added

**MAMA Mobile v1.5 - Mobile Chat & PWA Support**

![MAMA Mobile Chat Interface](docs/images/1.5-chat.png)

> **What's New in v1.5?** Real-time mobile chat with Claude Code, voice input/output, PWA installation, and enterprise-grade security.

#### Mobile Chat (NEW)

**Talk to Claude Code from your phone** - Real-time WebSocket-based chat interface

- **Voice Input** - Press microphone button to speak (automatic language detection)
- **Text-to-Speech** - Hear Claude's responses with adjustable speed (1.8x default)
- **Hands-free Mode** - Auto-listen after TTS completes for continuous conversation
- **Slash Commands** - `/save`, `/search`, `/checkpoint`, `/resume`, `/help`
- **Auto-Checkpoint** - Saves session state after 5 minutes idle
- **Session Resume** - Automatically detect and resume previous sessions
- **MCP Tool Display** - See real-time tool execution (Read, Write, Bash, etc.)
- **Long Press to Copy** - Hold message for 750ms to copy text

**Platform Support:**

- ✅ **Claude Code Plugin** - Full support (uses `claude` CLI subprocess)
- ❌ **Claude Desktop (MCP)** - Not supported (MCP servers only, no CLI)
- Graph Viewer works in both environments

#### PWA Support (NEW)

**Install MAMA as a mobile app** - Progressive Web App with offline capability

- **App Installation** - "Add to Home Screen" on Chrome/Safari
- **Service Worker** - Offline capability with static asset caching
- **App Icons** - 192x192 and 512x512 PNG icons
- **Mobile-Optimized** - Meta tags, theme color, viewport settings
- **Standalone Mode** - Runs like a native app (no browser UI)

#### Touch Optimization (NEW)

**Mobile-first UX improvements**

- **Long Press to Copy** - 750ms press on messages to copy text
- **44px Touch Targets** - Mobile-optimized button sizing for all controls
  - Chat controls (Send, Voice, TTS, Mic)
  - Sidebar tabs (Memory, Chat)
  - Memory save button
- **Responsive Layout** - Adapts to phone, tablet, desktop

#### Checkpoint API (NEW)

**Session save/resume for mobile workflow continuity**

- **POST /api/checkpoint/save** - Save session checkpoint with summary, open files, and next steps
- **GET /api/checkpoint/load** - Load latest active checkpoint for session resume
- Integrated with `mama.saveCheckpoint()` and `mama.loadCheckpoint()` functions
- Auto-checkpoint after 5 minutes idle
- Session resume banner with one-click restore

#### External Access & Security (NEW)

**Access MAMA from anywhere with enterprise-grade security**

- **Cloudflare Zero Trust** - Production-grade security (RECOMMENDED)
  - Google/GitHub/Microsoft account authentication
  - 2FA automatically enforced
  - Email restriction (only your email can access)
  - No token management needed
  - Complete 15-minute setup guide in `docs/guides/security.md`

- **Token Authentication** - Quick testing (local network, temporary access)
  - `MAMA_AUTH_TOKEN` environment variable
  - Bearer token + query parameter support
  - Automatic security warnings on external access

- **Feature Controls** - Disable features you don't use
  - `/mama-configure --disable-http` - Disable all web features
  - `/mama-configure --disable-websocket` - Disable Mobile Chat only
  - `/mama-configure --enable-all` - Enable everything
  - `/mama-configure --generate-token` - Generate secure auth token

### Fixed

- **Language Auto-Detection** - Voice input/TTS now use browser language instead of hardcoded Korean
- **Memory Leaks** - Properly cleanup WebSocket connections on page close
- **WebSocket Connection** - Fixed session management preventing chat from connecting
- **PWA Installation** - Service Worker and manifest now load correctly
- **Connection Status** - Status indicator displays correctly in all cases
- **Session Errors** - Graceful handling of expired sessions with auto-recovery

### Documentation

- **Security Guide (NEW)** - `docs/guides/security.md`
  - Cloudflare Zero Trust setup guide (15 minutes)
  - Token authentication for testing
  - Threat scenarios and best practices

- **Mobile Access Guide** - Enhanced with configuration and security
  - Platform compatibility (Claude Code vs Claude Desktop)
  - Production deployment with Cloudflare Zero Trust
  - Quick testing with token authentication

- **Configuration Command** - `/mama-configure` documentation
  - Security settings management
  - Feature enable/disable controls

---

## [1.4.5] - 2025-11-27

### Improved

**Graph Viewer UX Enhancements**

![MAMA Reasoning Graph v1.4.5](docs/images/reasoning-graph1.4.5.png)

- **Checkpoint Sidebar**: Always-visible timeline panel showing session checkpoints
- **Draggable Detail Panel**: Decision detail panel can be dragged by title
- **Custom Scrollbars**: Thin 6px dark-themed scrollbars (webkit + Firefox)
- **Layout**: Detail panel positioned left of checkpoint sidebar (no overlap)

---

## [1.4.4] - 2025-11-27

### Added

- **Checkpoint Timeline Sidebar**: `/checkpoints` API endpoint + sidebar UI
- **Expandable Checkpoint Items**: View timestamp, summary, open files, next steps
- **Related Decision Links**: Click to navigate to decisions referenced in checkpoints

---

## [1.4.3] - 2025-11-27

### Fixed

- **Port Environment Variable**: Unified to support both `MAMA_HTTP_PORT` and `MAMA_EMBEDDING_PORT`

---

## [1.4.2] - 2025-11-27

### Added

- **MAMA_HTTP_PORT**: Environment variable for custom HTTP server port (default: 3847)
- Enables dual WSL/Windows environments to use different ports

---

## [1.4.1] - 2025-11-27

### Fixed

- **npm Package**: Include CSS/HTML files in published package (`src/**/*.css`, `src/**/*.html`)

---

## [1.4.0] - 2025-11-27

### Added

**Graph Viewer** - Interactive visualization of your reasoning graph.

![MAMA Reasoning Graph](docs/images/reasoning-graph.png)

#### Features

- **Interactive Graph Visualization**: vis.js-powered network graph with physics simulation
- **Legend Panel**: Visual guide for edge types (supersedes, builds_on, debates, synthesizes) and node sizes
- **Node Size by Connections**: Nodes scale based on connection count (1-2: small → 11+: large)
- **3-Depth Highlight**: Click a node to highlight connected nodes up to 3 levels deep with BFS traversal
- **Dimming Effect**: Unconnected nodes/edges fade to 10% opacity when a node is selected
- **Topic Filter**: Dropdown to filter graph by topic
- **Detail Panel**: View full decision details, reasoning, similar decisions, and update outcomes
- **Similar Decisions**: Shows semantically similar decisions with similarity percentages
- **Outcome Update**: Quick save of decision outcomes (SUCCESS/FAILED/PARTIAL) from the detail panel

#### Endpoints

| Endpoint  | Description                                   |
| --------- | --------------------------------------------- |
| `/viewer` | Interactive graph visualization UI            |
| `/graph`  | JSON API returning nodes, edges, and metadata |

#### Technical Details

- Built on existing HTTP embedding server (port 3847)
- No additional dependencies (vis.js loaded from CDN)
- Real-time graph updates via REST API
- Dark theme optimized for extended viewing

---

## [1.3.1] - 2025-11-26

### Changed

**AX-Focused Tool Descriptions** - Enhanced tool descriptions for better LLM guidance.

- **⚡ TRIGGERS**: Added Korean/English trigger phrases to each tool
  - save: "기억해줘", "remember", "decided", "결정했어"
  - search: "뭐였더라", "what did we decide", "이전에"
  - update: "이거 안됐어", "this didn't work", "성공했어"
  - load_checkpoint: "이어서", "continue", "where were we", "지난번"

- **🔗 Workflow Hints**: Cross-tool connection guidance
  - save: "Call 'search' first to find related decisions"
  - load_checkpoint: "Call 'search' to refresh related decisions after loading"

- **💡 TIP**: Best practice hints embedded in descriptions
  - "High similarity (>0.8) = likely related, consider linking"
  - "Include 'builds_on: <id>' or 'debates: <id>' to link decisions"

---

## [1.3.0] - 2025-11-26

### Added

**Collaborative Reasoning Graph** - Decisions now form a connected graph through explicit relationships.

#### Epic 1: Collaborative Save

- **Auto-search on save**: When saving a decision, MAMA automatically searches for similar existing decisions
- **similar_decisions**: Returns up to 2 related decisions with similarity scores
- **collaboration_hint**: Suggests how to relate new decisions (build-on, debate, synthesize)
- **reasoning_graph**: Shows topic depth and latest decision in chain

#### Epic 2: Reasoning Graph Edges

- **New edge types**: `builds_on`, `debates`, `synthesizes` (in addition to existing `supersedes`, `refines`, `contradicts`)
- **Reasoning field parsing**: Auto-detects edge references in reasoning text
  - Pattern: `builds_on: decision_xxx`, `debates: decision_yyy`, `synthesizes: [id1, id2]`
- **Edge-connected search results**: Related decisions appear with `related_to` and `edge_reason` fields
- **Multi-agent collaboration**: Edge types track decision evolution across multiple LLM sessions. During v1.3 development, multiple LLMs debated protocol design choices, with `debates` and `synthesizes` edges recording the reconciliation process.

#### Epic 3: AX Polish

- **Case-insensitive outcome**: `update` tool accepts `success`, `SUCCESS`, `failed`, `FAILED`, `failure` etc.
- **Enhanced tool descriptions**: Added COLLABORATION MODES and 5-LAYER REASONING guidance

### Changed

- **Search result ordering**: Primary results followed by their edge-connected decisions (interleaved)
- **Edge approval default**: Auto-detected edges are approved by default (`approved_by_user=1`)

### Database

- **Migration 010**: Extended `decision_edges` CHECK constraint to include new edge types

---

## [1.2.4] - 2025-11-25

### Fixed

- **Checkpoint Save Bug**: Fixed `Too few parameter values` error when saving checkpoints via `save` tool

---

## [1.2.3] - 2025-11-25

### Changed

- **Enhanced All Tool Descriptions**: All 4 MCP tools now have context-aware descriptions based on actual usage patterns
  - `save`: 4-section checkpoint format, 5-layer decision narrative
  - `search`: Use cases (prior art, context after checkpoint, debugging), decision evolution inference
  - `update`: Real-world validation timing (days/weeks later), failure learning importance
  - `load_checkpoint`: Staleness warning, verification-first workflow

---

## [1.2.2] - 2025-11-25

### Added

- **5-Layer Narrative Guide in Tool Descriptions**: LLMs now see structured format guides even without slash commands
  - Checkpoint `summary`: 4-section format (🎯 Goal & Progress, ✅ Evidence, ⏳ Unfinished & Risks, 🚦 Next Agent Briefing)
  - Checkpoint `next_steps`: DoD and verification commands hint
  - Decision `reasoning`: 5-layer narrative (Context, Evidence, Alternatives, Risks, Rationale)

### Fixed

- **Search Tool Bug**: Fixed `decisions.map is not a function` error when `suggest()` returns null

---

## [1.2.1] - 2025-11-25

### Changed

- **Plugin Commands Simplified**: 7 commands → 5 commands with shorter names

| Old Command        | New Command        | Notes                     |
| ------------------ | ------------------ | ------------------------- |
| `/mama-save`       | `/mama:decision`   | Shorter, clearer          |
| `/mama-recall`     | `/mama:search`     | Unified with suggest/list |
| `/mama-suggest`    | `/mama:search`     | Unified                   |
| `/mama-list`       | `/mama:search`     | Use without query         |
| `/mama-checkpoint` | `/mama:checkpoint` | Same                      |
| `/mama-resume`     | `/mama:resume`     | Same                      |
| `/mama-configure`  | `/mama:configure`  | Same                      |

- **Command Naming**: Changed from `/mama-*` to `/mama:*` format (plugin namespace)

### Documentation

- `docs/reference/commands.md`: Rewritten for 5 simplified commands

---

## [1.2.0] - 2025-11-25

### Why This Release?

**The Core Insight: LLM Can Infer Relationships**

MAMA v1.1 added 11+ MCP tools including link governance (propose/approve/reject). But analysis revealed:

- 366 auto-generated "refines" links were 100% cross-topic noise
- Only "supersedes" edges (same topic) were reliable
- LLM can infer refines/contradicts relationships from time-ordered search results

**Design Principle:** Fewer tools = more LLM flexibility. More tools = more constraints.

### Breaking Changes

**MCP Tools reduced from 11 to 4:**

| Old Tool (v1.1)     | New Equivalent (v1.2)           |
| ------------------- | ------------------------------- |
| `save_decision`     | `save` with `type='decision'`   |
| `save_checkpoint`   | `save` with `type='checkpoint'` |
| `recall_decision`   | `search` with query             |
| `suggest_decision`  | `search` with query             |
| `list_decisions`    | `search` without query          |
| `update_outcome`    | `update`                        |
| `load_checkpoint`   | `load_checkpoint` (unchanged)   |
| `propose_link`      | **Removed**                     |
| `approve_link`      | **Removed**                     |
| `reject_link`       | **Removed**                     |
| `get_pending_links` | **Removed**                     |

### Changed

- **MCP Tool Consolidation**: 11 tools → 4 tools (save, search, update, load_checkpoint)
  - `save`: Unified tool with `type` parameter ('decision' or 'checkpoint')
  - `search`: Unified tool - semantic search with query, list recent without query
  - `update`: Simplified outcome update
  - `load_checkpoint`: Unchanged

- **Auto-Link Generation Removed**: `decision-tracker.js` no longer creates refines/contradicts edges
  - LLM infers relationships from time-ordered search results
  - Only supersedes edges remain (same topic, automatic)

- **Tool Descriptions Enhanced**: Added supersedes concept to help new LLMs understand evolution tracking
  - "Same topic = new decision supersedes previous, creating evolution chain"

### Removed

- **Link Governance Tools**: propose_link, approve_link, reject_link, get_pending_links
- **Auto-Link Code**: Functions for generating refines/contradicts edges
- **406 Noise Links**: Migration 009 removed all refines (366) and contradicts (40) links

### Added

- **HTTP Embedding Server**: Shared embedding service for fast hook execution
  - MCP server runs HTTP embedding server on `127.0.0.1:3847`
  - Model stays loaded in memory - ~150ms hook latency (vs 2-9s before)
  - Endpoints: `/health`, `/embed`, `/embed/batch`

- **Migration 009**: `009-remove-auto-links.sql` for cleaning noise links
- **listCheckpoints API**: `mama.listCheckpoints()` for unified search

### Documentation

- `docs/reference/api.md`: Complete rewrite for 4-tool architecture
- `docs/reference/commands.md`: Added MCP tool mappings
- `docs/explanation/decision-graph.md`: Updated edge types (supersedes only)
- `CLAUDE.md`: Updated MCP Tools section
- `README.md`: Updated to v1.2.0 with new tool catalog

---

## [1.1.0] - 2025-11-25

### Why This Release?

**The Core Problem with v1.0: "It remembered, but couldn't be trusted"**

MAMA v1.0 could save and search decisions, but had three fundamental issues:

1. **Link Noise Problem**: Auto-generated links created more noise than signal. LLMs indiscriminately created connections that polluted search results, making it impossible for users to distinguish meaningful relationships from spurious ones.

2. **Context Loss Problem**: The "what" was saved, but the "why" was lost. Looking at `auth_strategy: JWT` three months later, you couldn't know why that choice was made, what alternatives were considered, or what risks were accepted.

3. **Restart Cost Problem**: When sessions broke, you had to re-explain everything from scratch. Agents failed to restore previous context, or restored it incompletely.

### What v1.1 Solves

| Problem            | v1.0                        | v1.1                                                                     |
| ------------------ | --------------------------- | ------------------------------------------------------------------------ |
| Link Trust         | LLM auto-generation (noisy) | Propose→Approve flow (user verified)                                     |
| Decision Context   | Only topic + decision       | 5-layer narrative (evidence, alternatives, risks, reasoning, continuity) |
| Session Continuity | Manual restoration          | Zero-context restart (28ms)                                              |
| Quality Tracking   | None                        | Auto-generated coverage/quality reports                                  |
| Legacy Cleanup     | No tools                    | Safe migration utilities                                                 |

### Expected Benefits

- **Link Precision**: Only approved links affect search → Target 95% noise reduction
- **Decision Reusability**: Fully understand "why that decision" even 3 months later
- **Agent Handoff**: No context loss when another agent takes over
- **Quality Visibility**: Instantly see which decisions lack narrative depth

---

### Use Cases: How to Experience the Changes

#### Use Case 1: Trustworthy Links (Link Governance)

**Before (v1.0)**: Search results included dozens of auto-generated links, most irrelevant.

**After (v1.1)**:

```bash
# LLM proposes a link (not yet active)
mama.propose_link(from="auth_strategy", to="security_audit", reason="JWT choice affects audit scope")

# You review and approve only meaningful ones
mama.get_pending_links()  # See what's proposed
mama.approve_link(from="auth_strategy", to="security_audit")  # Approve

# Now searches only return approved, high-quality links
mama.suggest("authentication")  # Clean results, no noise
```

#### Use Case 2: Complete Decision Context (5-Layer Narrative)

**Before (v1.0)**:

```
topic: database_choice
decision: PostgreSQL
# That's it. Why PostgreSQL? What else was considered? Unknown.
```

**After (v1.1)**:

```bash
mama.save(
  topic="database_choice",
  decision="PostgreSQL with read replicas",
  reasoning="Need ACID compliance for financial transactions, plus read scaling for analytics",
  evidence=["benchmark_results.md", "compliance_audit_2025.pdf"],
  alternatives="Considered MongoDB (rejected: no ACID), MySQL (rejected: weaker JSON support)",
  risks="Operational complexity of replica lag management"
)

# 3 months later, everything is preserved:
mama.recall("database_choice")
# Returns full context: why, what else, what risks, what evidence
```

#### Use Case 3: Zero-Context Restart (Session Continuity)

**Before (v1.0)**: New session = start over, re-explain project context.

**After (v1.1)**:

```bash
# End of session - save state
mama.save_checkpoint(
  summary="Implemented auth module, blocked on rate limiter design",
  next_steps="1. Research token bucket vs leaky bucket 2. Check Redis compatibility"
)

# New session (even different agent)
mama.load_checkpoint()
# Returns in 28ms:
# - Recent decisions with full narrative
# - Related links (approved only)
# - Exactly where you left off
```

#### Use Case 4: Quality Monitoring (Coverage Reports)

**New in v1.1**:

```bash
mama.generate_quality_report()

# Output:
# Narrative Coverage: 45% (55/122 decisions have complete narrative)
# Link Coverage: 78% (95/122 decisions have at least one link)
#
# Recommendations:
# - 67 decisions missing evidence/alternatives/risks
# - 27 decisions have no connections to other decisions
```

#### Use Case 5: Safe Legacy Cleanup (Migration Tools)

**For existing v1.0 users**:

```bash
# Step 1: See what would be cleaned
mama.scan_auto_links()
# Shows: 458 auto-links found, 42 protected (have approval)

# Step 2: Backup first
mama.create_link_backup()
# Saved to ~/.claude/mama-backups/links-backup-2025-11-25.json

# Step 3: Clean with dry-run
mama.deprecate_auto_links(dry_run=True)
# Preview: Would remove 416 links, keep 42 approved

# Step 4: Execute
mama.deprecate_auto_links(dry_run=False)

# Step 5: Verify
mama.validate_cleanup_result()
# SUCCESS: Remaining auto-link ratio 3.2% (target: <5%)
```

---

### Technical Deep Dive: AI-to-AI Communication Architecture

> **Key Insight**: MAMA is fundamentally an **AI-to-AI communication system**.
> The prompts and injected context are designed to guide one LLM instance (current session)
> using decisions made by previous LLM instances (past sessions), with human approval as the trust layer.

#### 1. The AI-to-AI Communication Model

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   LLM (Past)    │────▶│     MAMA DB     │────▶│  LLM (Current)  │
│  Session N-1    │     │  + Embeddings   │     │   Session N     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │ Writes decisions      │ Stores with           │ Receives context
        │ with reasoning        │ vector embeddings     │ via hook injection
        │                       │                       │
        ▼                       ▼                       ▼
   "I chose JWT          Semantic search         "Previous session
    because..."          finds relevant           chose JWT for
                         past decisions           scaling reasons"
```

**The Human Role**: Not the primary audience, but the **trust gatekeeper**

- Approves/rejects LLM-proposed links
- Confirms decision saves
- Reviews checkpoint honesty

#### 2. Decision Prompts: Guiding LLM Output Quality

**Tool Description Prompt** (what the LLM sees when saving):

```
save_decision: Save a decision to MAMA's memory for future reference.

IMPORTANT - Graph Connectivity: Reuse the SAME topic name for related
decisions to create decision graphs. Example: Use 'auth_strategy' for ALL
authentication decisions, not 'auth_strategy_v1', 'auth_strategy_v2'.

Parameters:
- topic: Decision topic identifier. Use lowercase with underscores.
         REUSE SAME TOPIC for related decisions to create supersedes edges.

- reasoning: Why this decision was made. This is REQUIRED - never leave empty.
             Explain the context, alternatives considered, and rationale.
             IMPORTANT: Use English for better semantic search.
```

**Prompt Effectiveness Assessment:**

| Prompt Element                 | Intent             | Actual Behavior   | Gap?                               |
| ------------------------------ | ------------------ | ----------------- | ---------------------------------- |
| "REQUIRED - never leave empty" | Force reasoning    | LLMs comply       | No                                 |
| "Reuse SAME topic"             | Graph connectivity | Inconsistent      | Yes - LLMs often create new topics |
| "Use English"                  | Better embeddings  | Usually followed  | No                                 |
| "lowercase with underscores"   | Consistent naming  | Sometimes ignored | Minor                              |

**Known Prompt Gaps:**

1. **Topic Reuse**: Despite explicit instruction, LLMs often create `auth_v2` instead of reusing `auth`
2. **Evidence Format**: No strict format → varied quality (some paths, some prose)
3. **Confidence Calibration**: LLMs tend toward 0.8-0.9 regardless of actual certainty

#### 3. Checkpoint Prompts: Honest AI-to-AI Handoff

**Verification Prompt** (injected when checkpoint command detected):

```
You're saving a checkpoint - a message to the NEXT AI that will continue this work.

Write honestly so the next session can understand and continue effectively.

## Common Oversights

**Before writing "complete":**
- Did you include file paths? (e.g., db-manager.js:354)
- Did you run tests? (npm test)
- Did you re-read the AC? (you might have missed something)

**Be honest about incomplete work:**
- "I didn't finish this part"
- "I skipped this because..."
- "I forgot about..."

It's okay. Just write it down.
```

**Checkpoint Schema Prompt** (tool description):

```
save_checkpoint: Save the current session state.

Required format (be honest, include unfinished work):
1) Goal & Progress: What was the goal and how far did you get?
2) Evidence: Files/logs/commands + status [Verified | Not run | Assumed]
3) Unfinished & Risks: Remaining work, unrun tests, risks/unknowns
4) Next Agent Briefing: Definition of Done + quick commands to run

Before saving: scan for TODOs or missing tests and state them plainly.
```

**Prompt Effectiveness Assessment:**

| Prompt Element                     | Intent               | Actual Behavior    | Gap? |
| ---------------------------------- | -------------------- | ------------------ | ---- |
| "message to NEXT AI"               | Frame as handoff     | Improves structure | No   |
| "[Verified \| Not run \| Assumed]" | Explicit status      | Often omitted      | Yes  |
| "scan for TODOs"                   | Pre-save check       | Rarely done        | Yes  |
| "be honest about incomplete"       | Reduce optimism bias | Noticeably better  | No   |

**Known Prompt Gaps:**

1. **Status Tags**: LLMs frequently write prose instead of `[Verified]` tags
2. **TODO Scanning**: Instruction exists but LLMs don't actually grep for TODOs
3. **File Paths**: Sometimes generic ("the auth file") instead of specific

#### 4. Context Injection: How Past AI Informs Current AI

**Hook Output Format** (injected into LLM context on every user message):

```
MAMA found 3 related topics:

1. auth_strategy (88% match)
   "Use JWT with refresh tokens for stateless auth"
   3 days ago | Recency: 95% | Final: 90%
   mama.recall('auth_strategy')

2. session_management (82% match)
   "Redis for session storage with 24h TTL"
   5 days ago | Recency: 90% | Final: 85%

---
System Status: Tier 1 | 287ms | 3 decisions injected
```

**Design Rationale:**

- **Teaser Format**: Shows preview only → LLM must explicitly request full context
- **Recall Command**: `mama.recall('topic')` teaches LLM how to get more
- **Recency Score**: Gaussian decay (σ=30 days) → older decisions fade
- **Transparency Line**: LLM knows injection happened (no hidden context)

**Injection Effectiveness Assessment:**

| Design Choice                | Intent           | Actual Behavior       | Gap?  |
| ---------------------------- | ---------------- | --------------------- | ----- |
| Preview only (60 chars)      | Reduce noise     | Works well            | No    |
| `mama.recall()` hint         | Teach retrieval  | LLMs sometimes ignore | Minor |
| Similarity threshold 0.6-0.7 | Relevance filter | Good balance          | No    |
| 500 token budget             | Prevent overflow | Never exceeded        | No    |

#### 5. Session Restore: Complete AI-to-AI Context Transfer

**load_checkpoint Output Structure:**

```json
{
  "data": {
    "checkpoint": {
      "id": 65,
      "summary": "Implemented auth module, blocked on rate limiter",
      "open_files": ["src/auth/jwt.js", "tests/auth.test.js"],
      "status": "active"
    },
    "narrative": [
      {
        "topic": "auth_strategy",
        "decision": "JWT with refresh tokens",
        "reasoning": "Stateless for horizontal scaling...",
        "evidence": ["benchmark.md", "security-review.pdf"],
        "alternatives": ["Session cookies (rejected: stateful)"],
        "risks": "Token theft if not using httpOnly",
        "outcome": "SUCCESS",
        "confidence": 0.9
      }
    ],
    "links": [
      {
        "from_id": "decision_auth_123",
        "to_id": "decision_security_456",
        "relationship": "refines",
        "reason": "Auth choice affects audit requirements",
        "approved_by_user": true
      }
    ],
    "nextSteps": {
      "unfinished": ["Rate limiter design pending"],
      "recommendations": ["Research token bucket vs leaky bucket"],
      "risks": ["Token theft without httpOnly"]
    }
  }
}
```

**5-Layer Narrative Structure:**

| Layer       | Field                   | AI-to-AI Purpose                                  |
| ----------- | ----------------------- | ------------------------------------------------- |
| Specificity | `decision`              | What was decided (unambiguous)                    |
| Reasoning   | `reasoning`             | Why (enables current AI to understand trade-offs) |
| Evidence    | `evidence`              | Proof (current AI can verify)                     |
| Tension     | `alternatives`, `risks` | What was rejected (prevents re-exploration)       |
| Continuity  | `outcome`, `links`      | How it connects (graph traversal)                 |

#### 6. Link Governance: Human-in-the-Loop Trust

**The Problem**: AI-to-AI links without validation = noise amplification

**v1.1 Solution**: Proposal → Human Approval → Active

```
Current LLM: "I notice auth_strategy relates to security_audit"
             mama.propose_link(from="auth_strategy", to="security_audit",
                               relationship="refines",
                               reason="JWT choice affects audit scope")

System: Link saved as PENDING (approved_by_user = false)
        → Does NOT appear in searches
        → Does NOT influence recall results
        → Waits for human review

Human: mama.approve_link(from="auth_strategy", to="security_audit")
       # Link now ACTIVE - appears in searches, affects recall

System: Link approved (approved_by_user = true)
        → Now included in search results
        → Contributes to context injection
```

**Trust Flow Summary:**

```
LLM Proposes → User Reviews → User Approves/Rejects → System Enforces
     ↑                              ↓
     │                    Only approved links
     │                    affect AI behavior
     │                              ↓
     └──────── Feedback ──────────┘
```

#### 7. Summary: The Complete Trust Pipeline

```
┌────────────────────────────────────────────────────────────────────────┐
│                     MAMA v1.1 AI-to-AI Trust Pipeline                  │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                │
│  │ LLM Writes  │───▶│   Human     │───▶│ LLM Reads   │                │
│  │  Decision   │    │  Approves   │    │  Context    │                │
│  └─────────────┘    └─────────────┘    └─────────────┘                │
│        │                  │                  │                         │
│        │ Prompts guide    │ Links gated      │ Injection format        │
│        │ structure        │ by approval      │ guides retrieval        │
│        │                  │                  │                         │
│        ▼                  ▼                  ▼                         │
│   5-layer narrative   Only approved      Preview + recall hint         │
│   required fields     links active       teaches next AI               │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│  Trustworthiness Factors:                                              │
│  ✓ Reasoning required (not optional)                                   │
│  ✓ Links require human approval                                        │
│  ✓ Checkpoints prompt honesty                                          │
│  ✓ Quality metrics surface gaps                                        │
│  ⚠ Topic reuse inconsistent (prompt gap)                               │
│  ⚠ Status tags often omitted (prompt gap)                              │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Added

#### Environment & Deployment (Epic 1)

- **Workspace Installation**: pnpm workspace monorepo structure verified
- **Environment Variables**: `MAMA_DB_PATH`, `MAMA_SERVER_TOKEN` standardized
- **Token Masking**: Sensitive data protection in logs (`server.js:64-90`)
- **MCP Tool Catalog**: Complete tool documentation in `docs/reference/api.md`

#### Narrative Preservation (Epic 2)

- **5-Layer Narrative**: `evidence`, `alternatives`, `risks` fields in save_decision
- **Search Narrative Tool**: `search_narrative` for semantic search across narrative fields
- **Zero-Context Restart**: `load_checkpoint` returns full/summary/minimal context modes

#### Link Governance (Epic 3)

- **Proposal Flow**: `propose_link`, `approve_link`, `reject_link`, `get_pending_links`
- **Link Metadata**: `created_by`, `approved_by_user`, `decision_id`, `evidence`, `reason`
- **Audit Trail**: Append-only `link_audit_log` table with timestamps

#### Quality Metrics (Epic 4)

- **Coverage Report**: `generate_quality_report` with narrative/link coverage metrics
- **Restart Metrics**: `get_restart_metrics` with p50/p95/p99 latency tracking
- **Thresholds**: Configurable targets with automatic recommendations

#### Migration Tools (Epic 5)

- **Scan**: `scan_auto_links` identifies v0 auto-generated links
- **Backup**: `create_link_backup` with SHA-256 checksums
- **Cleanup**: `execute_link_cleanup` with batch processing and transactions
- **Validate**: `validate_cleanup_result` with success criteria evaluation

#### Documentation (Epic 6)

- **MCP Protocol Spec**: `docs/reference/api.md` with request/response formats
- **Deployment Guide**: `docs/guides/deployment.md` for release workflow
- **Migration Guide**: `docs/guides/migration-v0-to-v1.1.md` for v0 users

### Changed

- **Link Policy**: Auto-generation → Proposal + Approval model
- **Token Masking**: Enhanced protection in all log outputs
- **Error Format**: Standardized `{error: {code, message, details}}`

### Deprecated

- **Auto-generated links**: v0 auto-links flagged for removal
- Links without `approved_by_user=true` excluded from searches

### Fixed

- Embedding memory leak in long-running sessions
- Race condition in concurrent checkpoint saves

### Security

- Token masking in all log outputs
- PII protection (email partial masking)
- File path home directory masking (`~/...`)

---

## [1.0.2] - 2025-11-22

### Fixed

- MCP server startup error on Windows
- SQLite connection pool exhaustion

---

## [1.0.1] - 2025-11-21

### Fixed

- Plugin postinstall script path resolution
- Hook timing issues on slow systems

---

## [1.0.0] - 2025-11-21

### Added

- Initial release of MAMA monorepo
- **MCP Server** (`@jungjaehoon/mama-server`):
  - `save_decision` - Save decisions with embeddings
  - `recall_decision` - Retrieve by topic
  - `suggest_decision` - Semantic search
  - `list_decisions` - Browse all decisions
  - `update_outcome` - Track decision outcomes
  - `save_checkpoint` / `load_checkpoint` - Session continuity
- **Claude Code Plugin** (`mama`):
  - `/mama-save` - Save decision command
  - `/mama-recall` - Recall by topic
  - `/mama-suggest` - Semantic suggestions
  - `/mama-list` - List decisions
  - `/mama-checkpoint` - Save session state
  - `/mama-resume` - Resume session
  - `/mama-configure` - View/modify settings
- **Auto-context injection**: UserPromptSubmit and PreToolUse hooks
- **Tier transparency**: System status display (Tier 1/2/3)
- **Local-first**: SQLite + sqlite-vec for embeddings
- **Multilingual support**: Xenova/multilingual-e5-small model

### Technical

- pnpm workspace monorepo structure
- 597+ tests (unit, integration, regression)
- Node.js >= 18.0.0 required

---

[Unreleased]: https://github.com/jungjaehoon-lifegamez/MAMA/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/jungjaehoon-lifegamez/MAMA/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/jungjaehoon-lifegamez/MAMA/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/jungjaehoon-lifegamez/MAMA/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/jungjaehoon-lifegamez/MAMA/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jungjaehoon-lifegamez/MAMA/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jungjaehoon-lifegamez/MAMA/releases/tag/v1.0.0
