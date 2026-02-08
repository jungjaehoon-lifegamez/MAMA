# CLAUDE CODE PLUGIN CORE MODULES

**Generated:** 2026-02-08  
**Location:** packages/claude-code-plugin/src/core/  
**Status:** Code duplication (unavoidable)

---

## OVERVIEW

27 JavaScript modules duplicated from `@jungjaehoon/mama-core`. Claude Code plugins cannot have npm dependencies—all code must be self-contained. This creates version skew risk between mama-core and plugin snapshots.

**Plugin version:** snapshot of mama-core from 2025-11-21  
**mama-core version:** current

---

## DUPLICATED MODULES

```text
src/core/
├── mama-api.js              # High-level API (save/recall/suggest/update)
├── embeddings.js            # Local Transformers.js embeddings
├── db-manager.js            # SQLite + sqlite-vec initialization
├── memory-store.js          # Decision CRUD operations
├── decision-tracker.js      # Decision graph management
├── relevance-scorer.js      # Semantic similarity scoring
├── decision-formatter.js    # Output formatting
├── embedding-cache.js       # In-memory embedding cache
├── embedding-client.js      # HTTP embedding server client
├── outcome-tracker.js       # Decision outcome updates
├── config-loader.js         # Configuration management
├── debug-logger.js          # Logging utilities
├── errors.js                # Error classes
├── time-formatter.js        # Time formatting
├── query-intent.js          # Query intent detection
├── contract-extractor.js    # API contract extraction
├── session-utils.js         # Session state management
├── memory-inject.js         # Context injection
├── prompt-sanitizer.js      # Prompt sanitization
├── transparency-banner.js   # Tier transparency UI
├── hook-metrics.js          # Hook performance metrics
├── mcp-client.js            # MCP server client (plugin-specific)
├── ollama-client.js         # Ollama integration (plugin-specific)
└── db-adapter/              # Database adapter interface
    ├── index.js
    ├── base-adapter.js
    ├── sqlite-adapter.js
    └── statement.js
```

---

## DIVERGENCE FROM MAMA-CORE

**Plugin-specific modules (not in mama-core):**

- `mcp-client.js` - MCP server communication
- `ollama-client.js` - Ollama embedding fallback

**Missing from plugin (mama-core only):**

- HTTP embedding server (`embedding-server/`)
- WebSocket server components

---

## VERSION SKEW RISK

**Problem:** Bug fixes in mama-core don't propagate to plugin automatically.

**Example scenario:**

1. Bug found in `relevance-scorer.js` (mama-core)
2. Fix applied to `packages/mama-core/src/relevance-scorer.js`
3. Plugin still has old version in `packages/claude-code-plugin/src/core/relevance-scorer.js`
4. Users experience different behavior between MCP server and plugin hooks

---

## SYNC REQUIREMENT (CRITICAL)

**MUST DO:** Apply bug fixes to BOTH locations:

```bash
# Fix in mama-core
vim packages/mama-core/src/relevance-scorer.js

# Copy to plugin
cp packages/mama-core/src/relevance-scorer.js \
   packages/claude-code-plugin/src/core/relevance-scorer.js
```

**MUST NOT:** Assume changes in mama-core automatically update plugin.

---

## MITIGATION STRATEGY

**Option 1 (Current):** Manual sync + version tracking in comments  
**Option 2 (Future):** Bundle mama-core at build time (esbuild/rollup)  
**Option 3 (Ideal):** Claude Code supports npm dependencies (not available)

**Tracking:** Add version comments to duplicated files:

```javascript
// Synced from @jungjaehoon/mama-core (2025-11-21)
```

---

## NOTES

- **Why duplication?** Claude Code plugin distribution model requires self-contained files
- **Test coverage:** Plugin tests verify core modules independently (134 tests)
- **Maintenance burden:** ~27 files × 2 locations = high risk of drift
- **Future work:** Automate sync checks in CI/CD (compare file hashes)
