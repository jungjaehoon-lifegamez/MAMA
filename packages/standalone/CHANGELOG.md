# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-01

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
