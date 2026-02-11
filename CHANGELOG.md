# Changelog

All notable changes to this project will be documented in this file.

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
