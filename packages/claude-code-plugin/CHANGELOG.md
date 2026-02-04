# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.3] - 2026-02-04

### Fixed

- **PostToolUse Hook Auto-Injection**: PostToolUse hooks now properly display output to Claude
  - Changed exit code from 0 to 2 (blocking error mode)
  - Changed output from stdout to stderr (console.error)
  - MAMA v2 contract extraction prompts now automatically injected after Write/Edit
  - Per GitHub issue #11224: exit code 2 + stderr = visible to Claude
  - Note: Displays as "blocking error" in UI but functionality works correctly

### Changed

- **PreToolUse hook visibility**: Now uses exit code 2 + stderr (visible to Claude)
- **PostToolUse hook visibility**: exit code 2 + stderr (visible to Claude)
- Auto-Save suggestions now appear immediately after code changes
- **PreToolUse hook re-enabled**: Contract injection before Read/Grep operations (was mistakenly removed)

## [1.6.5] - 2026-02-01

### Added

- HTTP Embedding Server integration (port 3847)
- Faster embedding requests (~150ms vs previous cold starts)
- Model stays in memory for quick responses

### Fixed

- Hook performance improvements for UserPromptSubmit
- Better error handling for embedding failures

## [1.6.0] - 2026-01-28

### Added

#### Commands

- `/mama-save` - Save decisions to memory
- `/mama-recall` - Search decisions by query
- `/mama-suggest` - Find related decisions
- `/mama-list` - Browse all decisions
- `/mama-configure` - Plugin settings

#### Hooks

- **UserPromptSubmit** - Context injection on every prompt (75% threshold, 40 token teaser)
- **PreToolUse** - Context injection before Read/Edit/Grep (70% threshold, file-specific)
- **PostToolUse** - Track decision outcomes after tool execution

#### Skills

- `mama-context` - Auto-context injection specification

### Technical Details

- Pure JavaScript implementation
- MCP protocol integration via .mcp.json
- 134 tests (100% pass rate)

## [1.5.0] - 2026-01-15

### Added

- Initial Claude Code plugin implementation
- Basic hooks and commands structure
- MCP server integration
