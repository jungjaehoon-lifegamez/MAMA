# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
