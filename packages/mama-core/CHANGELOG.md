# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-01

### Added

#### Core Modules

- **mama-api.js** - High-level API interface for MAMA operations
- **memory-store.js** - Decision CRUD operations with SQLite + sqlite-vec
- **db-manager.js** - Database initialization and migration management
- **embeddings.js** - Transformers.js embedding generation (Xenova/all-MiniLM-L6-v2)

#### Embedding Infrastructure

- **embedding-server** - HTTP server for embedding requests (port 3847)
- **embedding-client.js** - Client for embedding server communication
- **embedding-cache.js** - LRU cache for embedding vectors

#### Decision Graph

- **decision-tracker.js** - Decision evolution tracking with edge types
- **relevance-scorer.js** - Semantic similarity scoring
- **decision-formatter.js** - Decision output formatting

#### Utilities

- **config-loader.js** - Plugin configuration loading
- **debug-logger.js** - Debug logging utilities
- **memory-inject.js** - Context injection helpers

### Technical Details

- Pure JavaScript (no TypeScript compilation required)
- SQLite + sqlite-vec for vector operations
- 384-dimensional embeddings (cross-lingual: English + Korean)
- All dependencies bundled for standalone operation
