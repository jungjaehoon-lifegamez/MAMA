# @jungjaehoon/mama-core

Shared core modules for MAMA (Memory-Augmented MCP Assistant).

## What is MAMA Core?

MAMA Core is a shared package containing the fundamental modules used by all MAMA packages:

- **mcp-server**: MCP protocol server
- **claude-code-plugin**: Claude Code plugin
- **standalone**: Standalone HTTP server

This package provides embedding generation, database management, decision tracking, and other core functionality without the transport layer (MCP/HTTP).

## Installation

```bash
npm install @jungjaehoon/mama-core
# or
pnpm add @jungjaehoon/mama-core
```

## Usage

### Import Everything

```javascript
const mama = require('@jungjaehoon/mama-core');

// Access all exported functions
const embedding = await mama.generateEmbedding('your text');
await mama.initDB();
```

### Import Specific Modules

```javascript
const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
const { initDB, getDB } = require('@jungjaehoon/mama-core/db-manager');
const mamaApi = require('@jungjaehoon/mama-core/mama-api');
```

## Available Modules

### Embedding Modules

- **embeddings** - Generate embeddings using Transformers.js
  - `generateEmbedding(text)` - Single text embedding
  - `generateBatchEmbeddings(texts)` - Batch embedding generation
  - `cosineSimilarity(a, b)` - Similarity calculation

- **embedding-cache** - In-memory embedding cache
  - `embeddingCache.get(key)` - Retrieve cached embedding
  - `embeddingCache.set(key, value)` - Store embedding
  - `embeddingCache.clear()` - Clear cache

- **embedding-client** - HTTP client for embedding server
  - `isServerRunning()` - Check server availability
  - `getEmbeddingFromServer(text)` - Get embedding via HTTP
  - `getServerStatus()` - Server health check

### Database Modules

- **db-manager** - SQLite database initialization
  - `initDB()` - Initialize database with migrations
  - `getDB()` - Get database connection
  - `closeDB()` - Close connection

- **db-adapter** - Database adapter interface
  - `createAdapter(type)` - Create SQLite adapter
  - Supports prepared statements and transactions

- **memory-store** - Decision storage operations
  - CRUD operations for decisions
  - Vector similarity search

### Memory API

- **memory/api** - Scoped memory operations
  - `saveMemory(input)` - Save typed memory with scopes (preference, fact, decision, lesson, constraint)
  - `recallMemory(query, options)` - Truth-aware recall with scope filtering
  - `buildProfile(scopes)` - Build memory profile (static/dynamic/evidence)
  - `ingestMemory(input)` - Ingest raw content as memory
  - `ingestConversation(input)` - Decompose conversations into typed memory units via optional LLM extraction
  - `evolveMemory(input)` - Resolve graph edges between memories
  - `buildMemoryBootstrap(params)` - Build memory agent bootstrap context
  - `createAuditAck(input)` - Create audit acknowledgment
  - `recordMemoryAudit(input)` - Record channel audit with state management

- **memory/truth-store** - Truth projection layer
  - `projectMemoryTruth(row)` - Write truth projection
  - `queryRelevantTruth(params)` - Query current truth with scope/query filtering
  - `queryTruthByTopic(topic)` - Get truth rows for a topic

- **memory/evolution-engine** - Graph edge resolution
  - `resolveMemoryEvolution(input)` - Determine supersedes/builds_on edges

- **memory/extraction-prompt** - LLM extraction for conversation ingestion
  - `buildExtractionPrompt(messages)` - Build structured prompt for memory extraction
  - `parseExtractionResponse(response)` - Parse LLM JSON response into typed units

- **memory/channel-summary-state-store** - Channel state management
  - `recordChannelAudit(input)` - Accumulate audit outcomes into channel state

### Core API (Legacy)

- **mama-api** - High-level API interface (wraps memory API)
  - `save(decision)` - Save decision
  - `recall(topic)` - Retrieve decision history
  - `suggest(query)` - Semantic search with hybrid FTS5 + vector + recency
  - `updateOutcome(id, outcome)` - Update decision outcome

- **decision-tracker** - Decision graph management
  - `learnDecision(decision)` - Learn from decision
  - `createEdgesFromReasoning(reasoning)` - Parse decision links

- **relevance-scorer** - Semantic similarity scoring
  - `scoreRelevance(query, decisions)` - Score decision relevance
  - Combines vector, graph, and recency signals

### Configuration

- **config-loader** - Configuration management
  - `loadConfig()` - Load MAMA configuration
  - `getModelName()` - Get embedding model name
  - `getEmbeddingDim()` - Get embedding dimensions
  - `updateConfig(config)` - Update configuration

## Environment Variables

- `MAMA_DB_PATH` - Database file path (default: `~/.claude/mama-memory.db`)
- `MAMA_EMBEDDING_PORT` - Embedding server port (default: `3849`)
- `MAMA_HTTP_PORT` - Backward-compatible alias for embedding server port

## Dependencies

- **@huggingface/transformers** - Local embedding generation
- **node:sqlite** - Built-in SQLite runtime (Node.js 22+)
- **Pure-TS cosine similarity** - Vector search (no native extensions)

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Watch mode
pnpm test:watch
```

## Test Coverage

- 72 unit tests across 17 test files
- 100% passing
- Tests cover:
  - Config loader, database initialization, module exports
  - Memory API (save, recall, profile)
  - Truth store, evolution engine, scope schema
  - Channel summary, channel summary state
  - Event store, finding store, bootstrap builder
  - Legacy shim compatibility

## Architecture

MAMA Core uses CommonJS modules and is designed to be shared across multiple packages:

```
packages/mama-core/
├── src/
│   ├── index.ts              # Main exports
│   ├── embeddings.ts         # Embedding generation
│   ├── db-manager.ts         # Database management
│   ├── mama-api.ts           # High-level API (wraps memory API)
│   ├── db-adapter/           # Database adapter (SQLite)
│   └── memory/               # Memory infrastructure
│       ├── types.ts          # MemoryRecord, MemoryScopeRef, RecallBundle, etc.
│       ├── api.ts            # saveMemory, recallMemory, buildProfile, etc.
│       ├── truth-store.ts    # Truth projection layer
│       ├── extraction-prompt.ts  # LLM extraction prompt + parser
│       ├── evolution-engine.ts  # Graph edge resolution
│       ├── scope-store.ts    # Scope management
│       ├── event-store.ts    # Audit event persistence
│       ├── finding-store.ts  # Audit finding persistence
│       ├── channel-summary-store.ts       # Channel summaries
│       ├── channel-summary-state-store.ts # Channel state reducer
│       ├── bootstrap-builder.ts           # Memory agent bootstrap
│       └── profile-builder.ts             # Profile classification
├── db/migrations/            # SQLite migrations (001-023)
└── tests/                    # 16 test files, 59 tests
```

## Migration Files

Database migrations are included in `db/migrations/` (001-023):

- 001-013: Core schema (decisions, embeddings, graph edges)
- 014: Add is_static column
- 015: FTS5 full-text search index
- 016: Memory kind/status/summary columns
- 017-018: Memory scopes and scope bindings
- 019-020: Memory events and audit findings
- 021: Memory truth projection
- 022-023: Channel summaries and state

## License

MIT - see LICENSE file for details

## Links

- [GitHub Repository](https://github.com/jungjaehoon-lifegamez/MAMA)
- [Documentation](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/docs)
- [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)

---

**Part of the MAMA monorepo** - Memory-Augmented MCP Assistant
