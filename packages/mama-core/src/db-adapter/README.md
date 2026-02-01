# Database Adapter Layer

## Overview

Abstraction layer for MAMA database to support both SQLite (development/testing) and PostgreSQL (production on Railway).

## Architecture

```
mama-api.js
    ↓
memory-store.js (business logic)
    ↓
DatabaseAdapter (interface)
    ↓
├── SQLiteAdapter (better-sqlite3 + sqlite-vss)
└── PostgreSQLAdapter (pg + pgvector)
```

## Decision Rationale

**Topic**: mama_db_adapter_pattern
**Decision**: Abstract database layer with driver-specific implementations
**Reasoning**:

1. **Environment Flexibility**: SQLite for local/testing, PostgreSQL for production
2. **Zero Breaking Changes**: Existing memory-store.js API remains unchanged
3. **Vector Search Portability**: sqlite-vss → pgvector migration path
4. **Testing Simplicity**: Fast SQLite tests, production PostgreSQL validation

## Adapter Interface

All adapters must implement:

```javascript
class DatabaseAdapter {
  // Connection
  connect(config) → db
  disconnect()
  isConnected() → boolean

  // Prepared Statements
  prepare(sql) → Statement
  exec(sql)
  transaction(fn) → result

  // Vector Search
  vectorSearch(embedding, limit) → results
  insertEmbedding(rowid, embedding)

  // Utility
  getLastInsertRowid() → number
}
```

## Implementation Files

- `index.js` - Factory + environment detection
- `sqlite-adapter.js` - SQLite implementation (current behavior)
- `postgresql-adapter.js` - PostgreSQL implementation
- `statement.js` - Statement wrapper (unified interface)

## Environment Variable

```bash
# Default: SQLite
MAMA_DB_PATH=~/.mama/memories.db

# PostgreSQL (Railway)
MAMA_DATABASE_URL=postgresql://user:pass@host:5432/mama_db
```

**Detection Logic**:

- If `MAMA_DATABASE_URL` set → PostgreSQL
- Else → SQLite with `MAMA_DB_PATH`

## Migration Strategy

### Phase 1: Adapter Layer (Current)

1. Create adapter interface
2. Extract SQLite logic to SQLiteAdapter
3. Update memory-store.js to use adapter

### Phase 2: PostgreSQL Support

1. Implement PostgreSQLAdapter
2. Convert migration SQL files
3. Add pgvector support

### Phase 3: Testing

1. Run existing tests with SQLite
2. Add PostgreSQL integration tests
3. Validate on Railway

## Performance Requirements

- Prepared statement caching
- Connection pooling (PostgreSQL only)
- Transaction batching support
- Vector search < 100ms (p95)

## Backward Compatibility

✅ Existing code works without changes
✅ SQLite remains default for development
✅ Environment variable controls database type
✅ No API changes to memory-store.js
