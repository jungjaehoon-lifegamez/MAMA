# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.5] - 2026-02-01

### Changed

- Migrated core modules to `@jungjaehoon/mama-core` package
- Now uses mama-core as dependency for shared functionality

### Fixed

- Improved embedding server startup reliability
- Better error handling for database initialization

## [1.6.0] - 2026-01-28

### Added

#### MCP Tools (4 core tools)

- **save** - Save decisions (`type='decision'`) or checkpoints (`type='checkpoint'`)
- **search** - Semantic search with optional query parameter
- **update** - Update decision outcomes (success/failed/partial)
- **load_checkpoint** - Resume previous session

#### Decision Graph (v1.3)

- **Edge types**: `supersedes`, `builds_on`, `debates`, `synthesizes`
- Auto-detection from reasoning field patterns
- Time-ordered search results for evolution tracking

#### Infrastructure

- HTTP Embedding Server on port 3847
- Model warm-up for faster first requests
- Graph visualization endpoint

### Technical Details

- Stdio-based MCP transport
- @modelcontextprotocol/sdk integration
- SQLite + sqlite-vec for vector operations

## [1.5.0] - 2026-01-15

### Added

- Initial MCP server implementation
- Basic save/search/update tools
- SQLite database integration

### Changed

- Migrated from prototype to production architecture
