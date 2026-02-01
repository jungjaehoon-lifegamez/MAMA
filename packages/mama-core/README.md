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

### Core API

- **mama-api** - High-level API interface
  - `save(decision)` - Save decision
  - `recall(topic)` - Retrieve decision history
  - `suggest(query)` - Semantic search
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
- `MAMA_HTTP_PORT` - Embedding server port (default: `3847`)

## Dependencies

- **@huggingface/transformers** - Local embedding generation
- **better-sqlite3** - SQLite database
- **sqlite-vec** - Vector similarity extension

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

- 35 unit tests
- 100% passing
- Tests cover:
  - Config loader
  - Database initialization
  - Module exports

## Architecture

MAMA Core uses CommonJS modules and is designed to be shared across multiple packages:

```
packages/mama-core/
├── src/
│   ├── index.js              # Main exports
│   ├── embeddings.js         # Embedding generation
│   ├── db-manager.js         # Database management
│   ├── mama-api.js           # High-level API
│   └── db-adapter/           # Database adapter
├── db/migrations/            # SQLite migrations
└── tests/                    # Unit tests
```

## Migration Files

Database migrations are included in `db/migrations/`:

- 001-initial-decision-graph.sql
- 002-add-error-patterns.sql
- 003-add-validation-fields.sql
- (and more...)

## License

MIT - see LICENSE file for details

## Links

- [GitHub Repository](https://github.com/jungjaehoon-lifegamez/MAMA)
- [Documentation](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/docs)
- [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)

---

**Part of the MAMA monorepo** - Memory-Augmented MCP Assistant
