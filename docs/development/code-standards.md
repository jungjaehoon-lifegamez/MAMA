# Code Standards

Coding conventions and quality standards for MAMA.

---

## Quick Rules

### Non-Negotiable Rules

```javascript
// ❌ FORBIDDEN
return { bones: [] };           // Dummy/fallback data
if (error) return defaultValue; // Silent fallback
const x: any = getData();       // `any` type
console.log('debug info');      // console.log

// ✅ REQUIRED
if (!data) throw new Error("Data required");
const x: Decision = getData();  // Proper typing
DebugLogger.log('debug info');  // Use DebugLogger
```

---

## File Organization

### Directory Structure

```
mama-plugin/
├── src/
│   ├── core/           # Business logic (DB, embeddings, scoring)
│   ├── commands/       # /mama-* command handlers
│   ├── hooks/          # Hook implementations
│   └── skills/         # Auto-context skill
├── scripts/            # Hook entry points
├── tests/              # Test suite
└── docs/               # Documentation
```

### File Size Limits

- **Maximum file length:** 1000 lines
- **Maximum function length:** 40 lines
- **Recommended file length:** <300 lines

**If file exceeds limit:** Split into modules.

---

## TypeScript Standards

### Type Safety

```typescript
// ❌ BAD: `any` type
function process(data: any) {
  return data.value;
}

// ✅ GOOD: Proper typing
interface Decision {
  topic: string;
  decision: string;
  reasoning: string;
}

function process(data: Decision): string {
  return data.decision;
}
```

### No Implicit Any

```typescript
// tsconfig.json
{
  "compilerOptions": {
    "noImplicitAny": true,
    "strict": true
  }
}
```

---

## Naming Conventions

### Functions

```javascript
// ✅ Verb + noun (action-oriented)
function saveDecision() { }
function getEmbedding() { }
function computeSimilarity() { }

// ❌ Avoid noun-only names
function decision() { }  // Unclear action
```

### Variables

```javascript
// ✅ Descriptive names
const embeddings = [];
const similarityThreshold = 0.5;

// ❌ Single letters (except loop indices)
const e = [];
const t = 0.5;
```

### Constants

```javascript
// ✅ UPPER_SNAKE_CASE for true constants
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

// ❌ Don't use for regular variables
const RESULTS = [];  // Should be `results`
```

---

## Error Handling

### Throw Errors, Don't Return Nulls

```javascript
// ❌ BAD: Silent failure
function getDecision(id) {
  if (!exists(id)) return null;  // Caller must check
  return decision;
}

// ✅ GOOD: Explicit error
function getDecision(id) {
  if (!exists(id)) {
    throw new Error(`Decision ${id} not found`);
  }
  return decision;
}
```

### No Dummy/Fallback Data

```javascript
// ❌ FORBIDDEN: Dummy data
function getBones() {
  if (error) return { bones: [] };  // Silent failure
}

// ✅ REQUIRED: Throw error
function getBones() {
  if (error) throw new Error("Failed to load bones");
}
```

---

## Logging

### Use DebugLogger

```javascript
// ❌ FORBIDDEN
console.log('Search results:', results);
console.error('Failed to load model');

// ✅ REQUIRED
import { DebugLogger } from './core/debug-logger.js';

DebugLogger.log('Search results:', results);
DebugLogger.error('Failed to load model');
```

### No Debug Logs in Production

```javascript
// Remove before commit
DebugLogger.log('TODO: remove this debug');
```

---

## Comments

### When to Comment

```javascript
// ✅ GOOD: Explain WHY, not WHAT
// Use cosine similarity instead of Euclidean distance
// because we care about direction, not magnitude
const similarity = cosineSimilarity(v1, v2);

// ❌ BAD: Obvious comments
// Calculate similarity
const similarity = cosineSimilarity(v1, v2);
```

### No TODO/FIXME in Commits

```javascript
// ❌ FORBIDDEN in commits
// TODO: Fix this later
// FIXME: Handle edge case

// ✅ ALLOWED during development (must remove before commit)
```

---

## Testing Standards

### Test Coverage

- **Unit tests:** >80% coverage
- **Integration tests:** All commands/hooks
- **Regression tests:** All bug fixes

### Test Real Implementation

```javascript
// ❌ FORBIDDEN: Mock internal code
class MockSceneGraph { }
test('uses SceneGraph', () => {
  const mock = new MockSceneGraph();
  // ...
});

// ✅ REQUIRED: Test real implementation
test('exports all bones', () => {
  const bones = createBones(3);
  expect(JSON.parse(exportSkeleton()).bones).toHaveLength(3);
});
```

**See also:** [Testing Guide](testing.md)

---

## Performance Standards

### Latency Targets

| Operation | Target (p95) |
|-----------|-------------|
| Hook injection | <500ms |
| Embedding generation | <30ms |
| Vector search | <100ms |
| Decision save | <50ms |

### Measure, Don't Estimate

```javascript
// ✅ GOOD: Measure actual performance
const start = Date.now();
await operation();
const duration = Date.now() - start;
DebugLogger.log(`Operation took ${duration}ms`);

// ❌ BAD: Assume performance
// This should be fast enough (no measurement)
```

---

## Documentation Standards

### Code Documentation

```javascript
/**
 * Computes cosine similarity between two vectors.
 *
 * @param {number[]} v1 - First vector
 * @param {number[]} v2 - Second vector
 * @returns {number} Similarity score (0.0-1.0)
 * @throws {Error} If vectors have different dimensions
 */
function cosineSimilarity(v1, v2) {
  // Implementation
}
```

### Update Docs with Code

**When changing code, also update:**
- User-facing docs (tutorials/, guides/)
- Reference docs (reference/)
- FR mapping (reference/fr-mapping.md)

---

## Git Commit Standards

### Commit Message Format

```
<type>: <description>

[optional body]

[optional footer]
```

**Types:**
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation only
- `test:` Tests
- `refactor:` Code refactoring (no behavior change)
- `perf:` Performance improvement

**Examples:**

```
feat: Add recency boosting to search

Implements FR10 (recency boosting) with exponential decay.
Default weight is 30% (configurable).

Closes #42
```

```
fix: Prevent null pointer in graph expansion

Bug: Graph expansion crashed when decision had no supersedes links.
Fix: Check for null before traversing.

Regression test added.
```

---

## Review Checklist

Before submitting PR, verify:

- [ ] All tests pass (`npm test`)
- [ ] No `any` types
- [ ] No `console.log`
- [ ] No TODO/FIXME comments
- [ ] File length <1000 lines
- [ ] Function length <40 lines
- [ ] Test coverage >80%
- [ ] Documentation updated
- [ ] Performance measured (if applicable)

---

## See Also

- [Developer Playbook](developer-playbook.md) - Development setup
- [Testing Guide](testing.md) - Test standards
- [Contributing Guide](contributing.md) - How to contribute
- [Architecture](../explanation/architecture.md) - System design
