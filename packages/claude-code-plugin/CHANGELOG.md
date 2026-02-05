# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.5] - 2026-02-05

### Fixed

- **PreToolUse MCP timeout**: Replaced MCP spawn with direct SQLite + embeddings
  - Eliminates 1800ms timeout issue
  - Contract search now instant via vectorSearch
- **Cross-platform debug path**: Uses `os.tmpdir()` fallback instead of hardcoded `/tmp`
- **Session ID fallback**: Full ISO timestamp prevents same-day session grouping

### Changed

- **Debug logging gated**: Now requires `MAMA_DEBUG=true` environment variable
  - Prevents I/O overhead in production
  - No unbounded log growth
- **Hook configuration unified**: All hooks defined in `plugin.json` only
  - Removed redundant `hooks/hooks.json`
- **handler export added**: `posttooluse-hook.js` exports `handler` for hook spec compliance

### Security

- **Input sanitization**: All user inputs sanitized via `prompt-sanitizer.js`
- **CodeRabbit review findings**: Addressed all actionable items

## [1.7.4] - 2026-02-05

### Fixed

- **PostToolUse Write tool bug**: Now reads entire file for Write tool (previously only Edit)
  - Fixes incorrect endpoint detection when using Write tool
  - Both Edit and Write now extract contracts from full file content

### Changed

- **Hook messages strengthened**: Changed from suggestions to MANDATORY instructions
  - PostToolUse: "MANDATORY: Save API Contract NOW" with code template
  - PreToolUse: "MANDATORY: Create contract BEFORE coding" when no contracts found
- **PreToolUse context injection**: Always passes context to Claude via exit(2) + message
  - Previously silent when no contracts found
  - Now shows search results and reasoning summary

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
