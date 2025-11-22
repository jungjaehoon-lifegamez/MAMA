# MAMA Plugin - Developer Playbook

**Author:** jungjaehoon
**Date:** 2025-11-21
**Version:** 1.0
**Target Audience:** Contributors to the MAMA plugin project

---

## Table of Contents

1. [Introduction](#introduction)
2. [Project Philosophy: Reuse-First](#project-philosophy-reuse-first)
3. [Architecture Overview](#architecture-overview)
4. [Development Setup](#development-setup)
5. [Code Organization](#code-organization)
6. [Migration History](#migration-history)
7. [Coding Standards](#coding-standards)
8. [Testing](#testing)
9. [Review Checklist](#review-checklist)
10. [Contributing Guidelines](#contributing-guidelines)
11. [Troubleshooting](#troubleshooting)
12. [Maintainer Sign-off](#maintainer-sign-off)

---

## Introduction

MAMA (Memory-Augmented MCP Assistant) is a **consciousness flow companion** that remembers how you think, not just what you concluded. This developer playbook helps contributors understand the architecture, code layout, and contribution rules to safely extend the plugin without reintroducing the mistakes we learned from.

### Purpose of This Document

This playbook serves as:

- **Onboarding guide** for new contributors
- **Architecture reference** for understanding code organization
- **Safety net** to prevent rewriting already-working code
- **Migration history** to understand why things are the way they are

### Who Should Read This

- Contributors adding new features or fixing bugs
- Reviewers evaluating pull requests
- Maintainers making architectural decisions
- Anyone curious about how MAMA works under the hood

---

## Project Philosophy: Reuse-First

> "Don't reinvent the wheel"

### The Reset Decision (Epic M0)

In November 2025, we made a critical decision: **stop the rewrite, embrace migration**.

**What happened:**

- We started rewriting MAMA from scratch in `mama-plugin/`
- The rewrite diverged from the PRD and fell behind the working `mcp-server/` code
- Analysis showed ~70% of required code already existed in production

**What we decided:**

- **Discard** the partial rewrite
- **Extract** proven modules from `mcp-server/src/mama/`
- **Package** them as a Claude Code plugin
- **Focus** engineering time on net-new plugin features (hooks, commands, packaging)

**Why it matters for contributors:**

- **Before contributing**: Check if the feature already exists in `mcp-server/`
- **When fixing bugs**: Look at migration history to understand code provenance
- **When designing**: Prefer extracting proven patterns over inventing new ones

**Reference:** [docs/epics.md](./epics.md), [docs/MAMA-CODE-REUSE-ANALYSIS.md](./MAMA-CODE-REUSE-ANALYSIS.md)

---

## Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MAMA Plugin Ecosystem                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Claude Code Plugin                Claude Desktop            │
│  ┌──────────────────┐              ┌──────────────┐          │
│  │ Commands         │              │              │          │
│  │ Skills           │──stdio──┐    │  MCP Client  │          │
│  │ Hooks (teaser)   │         │    │              │          │
│  └──────────────────┘         │    └──────────────┘          │
│                                │            │                 │
│                          ┌─────▼────────────▼─────┐           │
│                          │   MCP Server (stdio)   │           │
│                          │  5 Tools: save/recall/ │           │
│                          │  suggest/list/update   │           │
│                          └────────────────────────┘           │
│                                     │                         │
│                          ┌──────────▼──────────┐              │
│                          │   Core Logic        │              │
│                          │  - Embeddings       │              │
│                          │  - Vector Search    │              │
│                          │  - Graph Traversal  │              │
│                          │  - Hybrid Scoring   │              │
│                          └─────────────────────┘              │
│                                     │                         │
│                          ┌──────────▼──────────┐              │
│                          │  SQLite Database    │              │
│                          │  ~/.claude/         │              │
│                          │  mama-memory.db     │              │
│                          └─────────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

### Core Components

**1. Core Logic (`mama-plugin/src/core/`)**

- **mama-api.js**: Main API (save, recall, suggest, list, updateOutcome)
- **embeddings.js**: Transformers.js integration for semantic search
- **db-manager.js**: SQLite database operations (WAL mode, migrations)
- **relevance-scorer.js**: Hybrid scoring (semantic + recency + importance)
- **decision-tracker.js**: Evolution graph & supersedes edges
- **outcome-tracker.js**: Success/failure tracking
- **decision-formatter.js**: Context formatting with token budgets

**2. MCP Tools (`mama-plugin/src/tools/`)**

- **save-decision.js**: Save decisions/insights to memory
- **recall-decision.js**: Retrieve decision history by topic
- **suggest-decision.js**: Semantic search for relevant decisions
- **list-decisions.js**: List recent decisions chronologically
- **update-outcome.js**: Update decision outcomes (SUCCESS/FAILED/PARTIAL)

**3. Commands (`mama-plugin/commands/`)**

- User-facing slash commands (.md files)
- `/mama-save`, `/mama-recall`, `/mama-suggest`, `/mama-list`, `/mama-configure`
- Auto-discovered by Claude Code plugin system

**4. Hooks (`mama-plugin/scripts/`)**

- **userpromptsubmit-hook.js**: Context injection when user submits prompt
- **pretooluse-hook.js**: Context injection before Read/Edit/Grep tools
- **posttooluse-hook.js**: Auto-save decisions after Write/Edit tools

**5. Skills (`mama-plugin/skills/mama-context/`)**

- Always-on background context injection
- Skill wrapper for automatic invocation

**6. Database (`mama-plugin/src/db/migrations/`)**

- SQLite-only (PostgreSQL removed in M1.2)
- 4 migration files (001-004)
- WAL mode + synchronous=NORMAL for performance

### Technology Stack

**Runtime:**

- Node.js >= 18.0.0 (recommended: 22+)
- SQLite 3 (better-sqlite3 ^11.0.0)

**AI/ML:**

- @huggingface/transformers ^3.0.0 (embedding generation)
- Xenova/multilingual-e5-small (default model, 384-dim)
- sqlite-vec ^0.1.0 (vector search extension)

**MCP:**

- @modelcontextprotocol/sdk ^1.0.1
- Stdio transport (local use)

**Testing:**

- Vitest ^1.0.0 (unit + integration tests)

**Reference:** [docs/MAMA-ARCHITECTURE.md](./MAMA-ARCHITECTURE.md), [docs/MAMA-PRD.md](./MAMA-PRD.md)

---

## Development Setup

### Prerequisites

- **Node.js**: >= 18.0.0 (22+ recommended for best Transformers.js support)
- **Git**: For version control
- **Claude Code**: Latest version (for testing plugin integration)

### Installation Steps

```bash
# 1. Clone the repository
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA

# 2. Install dependencies
npm install

# 3. Verify installation
node scripts/check-compatibility.js

# 4. Run tests
npm test

# Expected output: All tests pass (100+ tests)
```

### Database Initialization

The database is automatically created on first use:

```bash
# Default location
~/.claude/mama-memory.db

# Override with environment variable
export MAMA_DATABASE_PATH=/path/to/custom/mama-memory.db
```

**Database Structure:**

- `decisions` table: Core decision storage
- `embeddings` table: Vector embeddings (384-dim)
- `supersedes` table: Evolution graph edges
- `_migrations` table: Migration history

### Running Tests

```bash
# Run all tests
npm test

# Watch mode (auto-rerun on changes)
npm run test:watch

# Run specific test file
npx vitest run tests/core/mama-api.test.js

# Run tests with coverage
npx vitest run --coverage
```

**Test Organization:**

- `tests/core/`: Core logic tests (mama-api, embeddings, db-manager)
- `tests/tools/`: MCP tool handler tests
- `tests/commands/`: Command tests
- `tests/hooks/`: Hook tests
- `tests/manifests/`: Plugin manifest validation tests

### Configuration

**User Configuration (`~/.mama/config.json`):**

```json
{
  "modelName": "Xenova/multilingual-e5-small",
  "embeddingDim": 384,
  "cacheDir": "~/.cache/huggingface/transformers"
}
```

**Plugin Configuration (`.mcp.json`):**

- MCP server transport settings
- Database path
- Environment variables

---

## Code Organization

### Directory Structure

```
mama-plugin/
├── .claude-plugin/
│   └── plugin.json           # Unified manifest (skills+hooks)
│
├── commands/                  # Slash commands (.md wrappers)
│   ├── mama-save.md
│   ├── mama-recall.md
│   ├── mama-suggest.md
│   ├── mama-list.md
│   └── mama-configure.md
│
├── src/
│   ├── commands/              # Backend command implementations
│   │   ├── mama-save.js
│   │   ├── mama-recall.js
│   │   ├── mama-suggest.js
│   │   ├── mama-list.js
│   │   └── mama-configure.js
│   │
│   ├── core/                  # Core business logic
│   │   ├── mama-api.js            # Main API
│   │   ├── embeddings.js          # Transformers.js integration
│   │   ├── db-manager.js          # SQLite operations
│   │   ├── relevance-scorer.js    # Hybrid scoring
│   │   ├── decision-tracker.js    # Evolution graph
│   │   ├── outcome-tracker.js     # Outcome tracking
│   │   ├── decision-formatter.js  # Output formatting
│   │   ├── config-loader.js       # Configuration management
│   │   ├── time-formatter.js      # Time formatting
│   │   ├── query-intent.js        # Query intent analysis
│   │   └── debug-logger.js        # Structured logging
│   │
│   ├── db/
│   │   └── migrations/            # SQLite migration scripts
│   │       ├── 001-initial-schema.sql
│   │       ├── 002-add-embeddings.sql
│   │       ├── 003-add-audit.sql
│   │       └── 004-add-outcome-tracking.sql
│   │
│   └── tools/                 # MCP tool handlers
│       ├── save-decision.js
│       ├── recall-decision.js
│       ├── suggest-decision.js
│       ├── list-decisions.js
│       ├── update-outcome.js
│       └── index.js               # Tool exports
│
├── scripts/                   # Hook executables
│   ├── userpromptsubmit-hook.js
│   ├── pretooluse-hook.js
│   ├── posttooluse-hook.js
│   ├── postinstall.js             # Tier detection
│   └── validate-manifests.js      # Manifest validation
│
├── skills/
│   └── mama-context/
│       └── SKILL.md               # Auto-context skill
│
├── tests/                     # Test suite
│   ├── commands/
│   ├── core/
│   ├── hooks/
│   ├── tools/
│   └── manifests/
│
├── .mcp.json                  # MCP server configuration
├── package.json
├── LICENSE
└── README.md
```

### Module Boundaries

**Core Logic (`src/core/`)**

- ✅ **Purpose**: Business logic, algorithms, data structures
- ✅ **Dependencies**: Only other core modules, no hooks/commands
- ✅ **Testing**: Unit tests with mocked DB
- ❌ **Avoid**: Direct CLI output, HTTP requests, file I/O (except DB)

**MCP Tools (`src/tools/`)**

- ✅ **Purpose**: MCP protocol handlers (stdio transport)
- ✅ **Dependencies**: Core modules via `../core/mama-api.js`
- ✅ **Testing**: Integration tests with real DB
- ❌ **Avoid**: Duplicating core logic, complex validation

**Commands (`commands/` + `src/commands/`)**

- ✅ **Purpose**: User-facing slash commands
- ✅ **Dependencies**: MCP tools or core API
- ✅ **Testing**: Command tests with mocked tools
- ❌ **Avoid**: Business logic (belongs in core)

**Hooks (`scripts/`)**

- ✅ **Purpose**: Claude Code hook integration
- ✅ **Dependencies**: MCP client or direct core API
- ✅ **Testing**: Hook tests with simulated events
- ❌ **Avoid**: Long-running operations (2s timeout)

### When to Edit `mcp-server` vs `mama-plugin`

**Edit `mcp-server/` when:**

- ❌ **Never** for MAMA plugin development (frozen as source of truth)
- ✅ Only if fixing bugs in the legacy MCP server deployment
- ✅ If adding features that need PostgreSQL support

**Edit `mama-plugin/` when:**

- ✅ **Always** for plugin-specific features (hooks, commands, skills)
- ✅ For SQLite-only improvements
- ✅ For Claude Code integration features
- ✅ For bug fixes that apply to the plugin

**Migration Rule:**

- If a feature exists in `mcp-server/` and works well, **extract it** instead of reimplementing
- If you need to change core logic, **consider** if it should also update `mcp-server/`
- Document provenance: "Migrated from mcp-server/src/mama/xyz.js @ commit abc123"

---

## Migration History

Understanding the migration history helps avoid repeating past mistakes and explains why code looks the way it does.

### Epic M0: Reset & Alignment (2025-11-20)

**Decision:** Halt the rewrite, adopt migration strategy

**Context:**

- Rewrite in `mama-plugin/` diverged from PRD
- `mcp-server/` had ~5,400 LOC of proven, working code
- ~70% code reuse potential identified

**Outcome:**

- Archived partial rewrite
- Established "reuse-first" principle
- Created migration epics (M1-M5)

**Reference:** [docs/epics.md](./epics.md), [docs/MAMA-CODE-REUSE-ANALYSIS.md](./MAMA-CODE-REUSE-ANALYSIS.md)

---

### Epic M1: Core Extraction (2025-11-20)

#### M1.1: Core Module Extraction

**Migrated modules** (from `mcp-server/src/mama/` → `mama-plugin/src/core/`):

- mama-api.js (882 LOC)
- embeddings.js (~400 LOC)
- decision-tracker.js (~500 LOC)
- outcome-tracker.js (~300 LOC)
- decision-formatter.js (1106 LOC)
- relevance-scorer.js (284 LOC)
- memory-store.js (90 LOC)
- time-formatter.js (~100 LOC)
- query-intent.js (~300 LOC)
- debug-logger.js (~150 LOC)
- db-manager.js (~800 LOC)

**Changes:** None (exact copies with preserved timestamps)

**Tests:** 10/10 passing (module exports verification)

**Source:** `mcp-server/` @ commit `57fd68243`

#### M1.2: SQLite-only DB Adapter

**Changes:**

- ✅ Removed PostgreSQL adapter (`db-adapter/postgresql-adapter.js`)
- ✅ Simplified adapter factory (SQLite-only)
- ✅ Fixed circular dependency (extracted `base-adapter.js`)
- ✅ Moved migrations from `src/core/migrations/` → `src/db/migrations/`
- ✅ Updated all PostgreSQL references in documentation

**Rationale:** Plugin targets local, privacy-focused storage (SQLite only)

**Tests:** 10/10 passing

#### M1.3: MCP Tool Surface Port

**Converted tools** (TypeScript → JavaScript):

- save-decision.ts → save-decision.js
- recall-decision.ts → recall-decision.js
- suggest-decision.ts → suggest-decision.js
- list-decision.ts → list-decision.js

**Changes:**

- Removed TypeScript type annotations
- Converted to CommonJS (require/module.exports)
- Updated import paths (`../../mama/` → `../core/`)
- Preserved validation logic and error handling

**LOC Reduction:** ~40% (due to TypeScript removal)

**Source:** `mcp-server/src/tools/memory/` @ commit `57fd68243`

#### M1.4: Embedding Configuration & Model Selection

**New modules:**

- config-loader.js (configuration parser)
- commands/mama-configure.js (command placeholder)

**Updated modules:**

- embeddings.js (dynamic model loading)

**Features:**

- User configuration at `~/.mama/config.json`
- Configurable embedding model, dimensions, cache directory
- Automatic pipeline reset on model change

**Tests:** 16/16 passing

**Rationale:** Users need flexibility to choose models (accuracy vs speed)

#### M1.5: Outcome & Audit Log Migration

**New files:**

- tools/update-outcome.js (MCP tool handler)

**Features:**

- Update decision outcomes (SUCCESS/FAILED/PARTIAL)
- Failure reason tracking (required for FAILED)
- Outcome metadata in all decision displays
- Emoji indicators (✅ ❌ ⚠️ ⏳)

**Tests:** 14/14 passing

**Reference:** [docs/MAMA-CODE-REUSE-ANALYSIS.md § Migration Log](./MAMA-CODE-REUSE-ANALYSIS.md#migration-log)

---

## Coding Standards

### JavaScript/Node.js Conventions

**Style:**

- Use ES6+ features (arrow functions, destructuring, async/await)
- CommonJS modules (require/module.exports) for compatibility
- 2-space indentation
- Single quotes for strings
- Semicolons required

**Naming:**

- camelCase for variables and functions
- PascalCase for classes
- UPPER_SNAKE_CASE for constants
- Descriptive names (no single-letter except loop indices)

**Example:**

```javascript
// ✅ Good
const EMBEDDING_DIM = 384;
const modelName = "Xenova/multilingual-e5-small";

async function generateEmbedding(text) {
  const result = await pipeline(text);
  return Array.from(result.data);
}

// ❌ Bad
const D = 384;
const m = "Xenova/multilingual-e5-small";

async function gen(t) {
  return Array.from((await pipeline(t)).data);
}
```

### Error Handling Patterns

**MCP Tools:**

```javascript
// ✅ Return structured errors (LLM can understand)
return {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        isError: true,
        error: "Decision not found",
        code: "DECISION_NOT_FOUND",
        details: { topic: params.topic },
      }),
    },
  ],
};

// ❌ Throw exceptions (blocks LLM understanding)
throw new McpError(ErrorCode.InternalError, "Decision not found");
```

**Core Logic:**

```javascript
// ✅ Throw descriptive errors
if (!text || text.trim() === "") {
  throw new Error("Text cannot be empty for embedding generation");
}

// ✅ Graceful degradation
try {
  const embedding = await generateEmbedding(text);
  return { success: true, embedding };
} catch (error) {
  logger.warn(
    "Embedding generation failed, falling back to exact match",
    error
  );
  return { success: false, fallbackMode: "exact_match" };
}
```

### Documentation Standards

**Function Documentation:**

```javascript
/**
 * Generate semantic embedding for given text using configured model.
 *
 * @param {string} text - Input text to embed (required, non-empty)
 * @returns {Promise<number[]>} 384-dim embedding vector
 * @throws {Error} If text is empty or model fails to load
 *
 * @example
 * const embedding = await generateEmbedding('How should I handle auth?');
 * // Returns: [0.123, -0.456, ..., 0.789] (384 floats)
 */
async function generateEmbedding(text) {
  // Implementation...
}
```

**File Headers:**

```javascript
/**
 * @file mama-api.js
 * @description Main API for MAMA plugin (save, recall, suggest, list, updateOutcome)
 * @module src/core/mama-api
 *
 * @migrated-from mcp-server/src/mama/mama-api.js @ commit 57fd68243
 * @last-updated 2025-11-20
 */
```

### Testing Requirements

**Coverage Target:** 80% line coverage minimum

**Test Structure:**

```javascript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveDecision, recallDecision } from "../src/core/mama-api.js";

describe("mama-api", () => {
  beforeEach(() => {
    // Setup: Create test DB
  });

  afterEach(() => {
    // Cleanup: Delete test DB
  });

  describe("saveDecision", () => {
    it("should save valid decision with all fields", async () => {
      const decision = {
        topic: "test_topic",
        decision: "Use approach X",
        reasoning: "Because Y",
        confidence: 0.9,
      };

      const result = await saveDecision(decision);

      expect(result.success).toBe(true);
      expect(result.decision_id).toBeDefined();
    });

    it("should reject decision with empty reasoning", async () => {
      const decision = {
        topic: "test_topic",
        decision: "Use approach X",
        reasoning: "",
        confidence: 0.9,
      };

      await expect(saveDecision(decision)).rejects.toThrow(
        "Reasoning cannot be empty"
      );
    });
  });
});
```

**Test Types:**

1. **Unit Tests**: Core logic with mocked dependencies
2. **Integration Tests**: Full workflows with real DB
3. **Regression Tests**: Critical bugs that were fixed

---

## Testing

### Test Organization

```
tests/
├── core/                      # Core logic tests
│   ├── mama-api.test.js       # API tests (save, recall, suggest, list)
│   ├── embeddings.test.js     # Embedding generation tests
│   ├── db-manager.test.js     # Database operations tests
│   └── config-loader.test.js  # Configuration tests
│
├── tools/                     # MCP tool handler tests
│   ├── save-decision.test.js
│   ├── recall-decision.test.js
│   ├── suggest-decision.test.js
│   ├── list-decisions.test.js
│   └── update-outcome.test.js
│
├── commands/                  # Command tests
│   ├── mama-save.test.js
│   ├── mama-recall.test.js
│   └── mama-list.test.js
│
├── hooks/                     # Hook tests
│   ├── userpromptsubmit.test.js
│   ├── pretooluse.test.js
│   └── posttooluse.test.js
│
└── manifests/                 # Plugin manifest validation tests
    └── plugin-manifests.test.js
```

### Running Tests

```bash
# Run all tests
npm test

# Watch mode (auto-rerun on changes)
npm run test:watch

# Run specific test suite
npx vitest run tests/core/mama-api.test.js

# Run with coverage
npx vitest run --coverage

# Debug failing test
npx vitest run tests/core/mama-api.test.js --reporter=verbose
```

### Writing Tests

**Test Checklist:**

- [ ] Tests cover happy path
- [ ] Tests cover error cases (invalid input, missing data, etc.)
- [ ] Tests cover edge cases (empty strings, null values, etc.)
- [ ] Tests clean up after themselves (delete test DB, reset state)
- [ ] Tests are deterministic (no flaky tests)
- [ ] Tests have descriptive names ("should save decision when reasoning is provided")

**Example Test:**

```javascript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { saveDecision, recallDecision } from "../src/core/mama-api.js";

describe("Decision Evolution Graph", () => {
  let testDb;

  beforeEach(() => {
    testDb = new Database(":memory:");
    // Run migrations...
  });

  afterEach(() => {
    testDb.close();
  });

  it("should create supersedes edge when saving to existing topic", async () => {
    // Arrange: Save first decision
    const decision1 = {
      topic: "auth_strategy",
      decision: "Use session cookies",
      reasoning: "Simple to implement",
    };
    const result1 = await saveDecision(decision1);

    // Act: Save second decision to same topic
    const decision2 = {
      topic: "auth_strategy",
      decision: "Use JWT tokens",
      reasoning: "Better for scaling",
    };
    const result2 = await saveDecision(decision2);

    // Assert: Supersedes edge created
    const history = await recallDecision("auth_strategy");
    expect(history.decisions).toHaveLength(2);
    expect(history.decisions[0].decision).toBe("Use JWT tokens"); // Latest first
    expect(history.decisions[1].decision).toBe("Use session cookies");
  });
});
```

---

## Review Checklist

### Pre-Commit Checklist

Before submitting a pull request:

- [ ] **Code Quality**

  - [ ] All tests pass (`npm test`)
  - [ ] No console.log statements (use debug-logger.js)
  - [ ] No commented-out code
  - [ ] No TODOs without GitHub issue references

- [ ] **Documentation**

  - [ ] Function docstrings added for new functions
  - [ ] README updated if public API changed
  - [ ] Migration notes added if porting from mcp-server

- [ ] **Testing**

  - [ ] New tests added for new features
  - [ ] Edge cases covered
  - [ ] Coverage >= 80%

- [ ] **Architecture**

  - [ ] Code in correct module (core/tools/commands/hooks)
  - [ ] No business logic in commands/hooks
  - [ ] No code duplication (DRY principle)

- [ ] **Migration Traceability** (if porting from mcp-server)
  - [ ] Source file path documented
  - [ ] Commit hash recorded
  - [ ] Changes from original noted

### Code Review Guidelines

**For Reviewers:**

- [ ] **Correctness**

  - [ ] Logic implements acceptance criteria
  - [ ] Error handling is appropriate
  - [ ] Edge cases are handled

- [ ] **Architecture**

  - [ ] Module boundaries respected
  - [ ] No unnecessary abstraction
  - [ ] Consistent with existing patterns

- [ ] **Testing**

  - [ ] Tests cover new code paths
  - [ ] Tests are maintainable
  - [ ] No flaky tests

- [ ] **Documentation**

  - [ ] Code is self-documenting
  - [ ] Complex logic has comments
  - [ ] Public API is documented

- [ ] **Reuse-First Principle**
  - [ ] Checked if feature exists in mcp-server/
  - [ ] Justified any new implementations
  - [ ] Migration provenance documented

**Review Priorities:**

1. **Correctness** (does it work?)
2. **Architecture** (does it fit?)
3. **Testing** (can we trust it?)
4. **Documentation** (can others understand it?)

### When to Ask for Help

Ask for guidance if:

- Unsure whether to reuse or reimplement
- Changing core API contracts
- Adding new dependencies
- Modifying database schema
- Unsure about migration strategy

**Where to Ask:**

- GitHub Issues (for bugs and feature requests)
- Pull Request comments (for code-specific questions)
- Team chat (for quick clarifications)

---

## Contributing Guidelines

### Picking Up a Story

1. **Check sprint-status.yaml**

   ```bash
   cat docs/sprint-artifacts/sprint-status.yaml
   ```

   Look for stories with status: `ready` or `ready-for-dev`

2. **Read the story file**

   ```bash
   cat docs/stories/story-M4.5.md
   ```

   Understand acceptance criteria and context

3. **Check for existing code**

   - Search `mcp-server/src/mama/` for related modules
   - Review `docs/MAMA-CODE-REUSE-ANALYSIS.md` for reuse opportunities

4. **Update status to in-progress**
   ```bash
   # Edit docs/sprint-artifacts/sprint-status.yaml
   # Change: ready → in_progress
   ```

### Branch Naming

```bash
# Feature branches
git checkout -b feature/story-m4-5-description

# Bug fixes
git checkout -b fix/issue-123-description

# Documentation
git checkout -b docs/update-architecture

# Refactoring
git checkout -b refactor/simplify-embeddings
```

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Test additions or fixes
- `refactor`: Code refactoring (no behavior change)
- `perf`: Performance improvements
- `chore`: Build/tooling changes

**Examples:**

```
feat(tools): Add update_outcome MCP tool

Implement update_outcome tool handler to allow updating decision
outcomes (SUCCESS/FAILED/PARTIAL) with failure reasons and
limitations.

- Validation: decisionId (required), outcome (enum), failure_reason
- Integration with outcome-tracker.js
- 14/14 tests passing

Closes #45
```

```
fix(embeddings): Clear cache when model changes

Pipeline was not resetting when user changed model via config,
causing stale embeddings. Now explicitly reset pipeline and clear
LRU cache on model change.

Fixes #52
```

### Pull Request Process

1. **Create PR from feature branch**

   - Target: `main` branch
   - Title: `Story M4.5: <Description>`
   - Description: Link to story file, list changes, test results

2. **PR Template:**

   ```markdown
   ## Story

   [Story M4.5](../docs/stories/story-M4.5.md)

   ## Changes

   - Added X feature
   - Fixed Y bug
   - Updated Z documentation

   ## Test Results
   ```

   ✓ tests/core/module.test.js (10 tests) 45ms

   ```

   ## Acceptance Criteria
   - [x] AC1: Feature X implemented
   - [x] AC2: Tests pass
   - [ ] AC3: Documentation updated (in progress)

   ## Migration Notes
   (If porting from mcp-server)
   - Source: mcp-server/src/mama/xyz.js @ commit abc123
   - Changes: Removed PostgreSQL support, updated imports
   ```

3. **Review Process**

   - Wait for reviewer assignment
   - Address feedback
   - Update tests if needed
   - Ensure CI passes

4. **Merge**
   - Squash merge (default)
   - Update story status to `review` → `done`
   - Close related GitHub issues

---

## Troubleshooting

### Common Issues

#### Issue: Tests Fail with "Database locked"

**Cause:** Multiple tests accessing the same DB file

**Fix:**

```javascript
// Use :memory: database for tests
beforeEach(() => {
  testDb = new Database(":memory:");
});
```

#### Issue: Embedding Generation Fails

**Cause:** Transformers.js model not downloaded or corrupted

**Fix:**

```bash
# Clear model cache
rm -rf ~/.cache/huggingface/transformers

# Rerun test (will re-download model)
npm test
```

#### Issue: Hook Not Firing

**Cause:** Hook script not executable

**Fix:**

```bash
chmod +x scripts/userpromptsubmit-hook.js
chmod +x scripts/pretooluse-hook.js
chmod +x scripts/posttooluse-hook.js
```

#### Issue: Migration Fails

**Cause:** Database schema mismatch

**Fix:**

```bash
# Check current schema version
sqlite3 ~/.claude/mama-memory.db "PRAGMA user_version;"

# Re-run migrations
node src/db/run-migrations.js
```

### Debug Tools

**Structured Logging:**

```javascript
const logger = require("./src/core/debug-logger.js");

logger.debug("Embedding generation started", { text: query });
logger.info("Decision saved", { id: decisionId, topic });
logger.warn("Falling back to exact match", {
  reason: "embeddings unavailable",
});
logger.error("Database error", { error: err.message });
```

**Database Inspection:**

```bash
# Open database
sqlite3 ~/.claude/mama-memory.db

# Check tables
.tables

# Query decisions
SELECT id, topic, confidence, outcome FROM decisions ORDER BY created_at DESC LIMIT 10;

# Check embeddings
SELECT COUNT(*) FROM embeddings;
```

**MCP Tool Testing:**

```bash
# Test save_decision tool
node src/tools/save-decision.js

# Test with specific input
echo '{"topic":"test","decision":"X","reasoning":"Y"}' | node src/tools/save-decision.js
```

### Where to Get Help

**Documentation:**

- [docs/MAMA-ARCHITECTURE.md](./MAMA-ARCHITECTURE.md) - Architecture decisions
- [docs/MAMA-PRD.md](./MAMA-PRD.md) - Product requirements
- [docs/epics.md](./epics.md) - Epic overview
- [mama-plugin/README.md](../mama-plugin/README.md) - User guide

**Code References:**

- [docs/MAMA-CODE-REUSE-ANALYSIS.md](./MAMA-CODE-REUSE-ANALYSIS.md) - Migration history

**Community:**

- GitHub Issues (bugs and feature requests)
- Pull Request discussions (code-specific questions)
- Team chat (quick clarifications)

---

## Maintainer Sign-off

**Reviewed by:** jungjaehoon
**Date:** 2025-11-21
**Status:** ✅ Approved for use

**Validation:**

- [x] Architecture section accurate (reviewed against MAMA-ARCHITECTURE.md)
- [x] Migration history complete (M1.1-M1.5 documented)
- [x] Coding standards align with current codebase
- [x] Testing guidelines reflect actual test structure
- [x] Contributing guidelines match team workflow
- [x] Troubleshooting covers common issues

**Next Review:** 2026-02 (3 months) or when Epic M2-M5 complete

---

**Document History:**

- 2025-11-21: v1.0 - Initial version (jungjaehoon)
- Next update: After Epic M2 completion (Hook Integration)

---

**Contributing to This Document:**
If you find errors or want to add sections, submit a PR with:

- Clear description of changes
- Validation that changes match actual codebase
- Maintainer approval before merge

---

_Generated through BMAD dev-story workflow for Story M4.4_
