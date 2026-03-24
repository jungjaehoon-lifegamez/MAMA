# Memory V2 Core-First Rollout Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current standalone-first smart-memory design with a `mama-core`-first memory v2 contract shared across `mama-core`, `mcp-server`, `standalone`, and `claude-code-plugin`.

**Architecture:** Introduce canonical v2 memory types and scope-aware persistence in `mama-core`, then expose them through MCP tools and standalone runtime orchestration. Keep legacy `mama_save`, `mama_search`, `mama_add`, and `mama_profile` working as migration shims while moving the real behavior to `ingestMemory`, `recallMemory`, and `buildProfile`.

**Tech Stack:** TypeScript, JavaScript, SQLite migrations, Vitest, MCP SDK, Persistent Claude CLI processes

**Spec:** `docs/superpowers/specs/2026-03-25-memory-v2-core-first-design.md`
**Branch:** `feat/haiku-memory-layer`

---

## File Map

| File                                                                    | Action        | Responsibility                                                    |
| ----------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| `packages/mama-core/src/memory-v2/types.ts`                             | Create        | Canonical v2 memory types                                         |
| `packages/mama-core/src/memory-v2/scope-store.ts`                       | Create        | Scope persistence helpers                                         |
| `packages/mama-core/src/memory-v2/profile-builder.ts`                   | Create        | Static/dynamic/evidence profile assembly                          |
| `packages/mama-core/src/memory-v2/evolution-engine.ts`                  | Create        | Relationship resolution and conflict rules                        |
| `packages/mama-core/src/memory-v2/api.ts`                               | Create        | Canonical `ingestMemory/saveMemory/recallMemory/buildProfile` API |
| `packages/mama-core/src/mama-api.ts`                                    | Modify        | Legacy shim routing to v2 core API                                |
| `packages/mama-core/src/index.ts`                                       | Modify        | Export v2 modules                                                 |
| `packages/mama-core/src/db-manager.ts`                                  | Modify        | Scope lookup helpers and new row shapes                           |
| `packages/mama-core/db/migrations/016-add-memory-v2-columns.sql`        | Create        | Add `kind`, `status`, `summary` columns                           |
| `packages/mama-core/db/migrations/017-create-memory-scopes.sql`         | Create        | Create `memory_scopes` table                                      |
| `packages/mama-core/db/migrations/018-create-memory-scope-bindings.sql` | Create        | Create memory-to-scope binding table                              |
| `packages/mcp-server/src/tools/ingest-memory.js`                        | Create        | New `mama_ingest` tool                                            |
| `packages/mcp-server/src/tools/recall-memory.js`                        | Create        | New `mama_recall` tool                                            |
| `packages/mcp-server/src/tools/profile.js`                              | Modify        | Return v2 profile snapshot shape                                  |
| `packages/mcp-server/src/tools/add-memory.js`                           | Modify        | Legacy shim to `ingestMemory`                                     |
| `packages/mcp-server/src/server.js`                                     | Modify        | Register v2 tools and compatibility shims                         |
| `packages/standalone/src/memory/scope-context.ts`                       | Create        | Derive `project/channel/user/global` scope context                |
| `packages/standalone/src/memory/recall-bundle-formatter.ts`             | Create        | Convert `RecallBundle` to prompt-safe text                        |
| `packages/standalone/src/agent/tool-registry.ts`                        | Modify        | Register v2 memory tool names                                     |
| `packages/standalone/src/agent/types.ts`                                | Modify        | Add v2 memory tool names/types                                    |
| `packages/standalone/src/gateways/message-router.ts`                    | Modify        | Use `RecallBundle`; remove JSON-parser save path                  |
| `packages/standalone/src/agent/gateway-tool-executor.ts`                | Modify        | Route `mama_add` through v2 ingest path                           |
| `packages/standalone/src/cli/commands/start.ts`                         | Modify        | Memory agent config + scope-aware v2 wiring                       |
| `packages/standalone/src/multi-agent/memory-agent-persona.ts`           | Modify        | Autonomous memory actor persona                                   |
| `packages/claude-code-plugin/src/commands/mama-recall.js`               | Modify        | Use v2 recall bundle formatting                                   |
| `packages/claude-code-plugin/src/commands/mama-suggest.js`              | Modify        | Use v2 recall/search semantics                                    |
| `packages/claude-code-plugin/src/commands/mama-save.js`                 | Modify        | Keep low-level save shim behavior explicit                        |
| `packages/claude-code-plugin/src/commands/mama-profile.js`              | Create        | Add profile command                                               |
| `packages/claude-code-plugin/src/commands/index.js`                     | Modify        | Register profile command                                          |
| `packages/mama-core/tests/unit/*.test.ts`                               | Create/Modify | v2 core tests                                                     |
| `packages/mcp-server/tests/tools/*.test.js`                             | Create/Modify | MCP v2/compat tests                                               |
| `packages/standalone/tests/**/*.test.ts`                                | Create/Modify | Runtime + gateway integration tests                               |
| `packages/claude-code-plugin/tests/**/*.test.js`                        | Create/Modify | Command parity tests                                              |

---

## Chunk 1: `mama-core` Contract And Schema

### Task 1: Add Canonical Memory V2 Types

**Files:**

- Create: `packages/mama-core/src/memory-v2/types.ts`
- Modify: `packages/mama-core/src/index.ts`
- Test: `packages/mama-core/tests/unit/memory-v2-types.test.ts`
- Test: `packages/mama-core/tests/unit/module-exports.test.js`

- [ ] **Step 1: Write the failing test**

Create `packages/mama-core/tests/unit/memory-v2-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type {
  MemoryScopeKind,
  MemoryEdgeType,
  MemoryRecord,
  ProfileSnapshot,
  RecallBundle,
} from '../../src/memory-v2/types.js';

describe('Memory V2 types', () => {
  it('should allow the approved scope kinds', () => {
    const scopes: MemoryScopeKind[] = ['global', 'user', 'channel', 'project'];
    expect(scopes).toEqual(['global', 'user', 'channel', 'project']);
  });

  it('should expose the approved edge types', () => {
    const edges: MemoryEdgeType[] = ['supersedes', 'builds_on', 'synthesizes', 'contradicts'];
    expect(edges).toContain('contradicts');
  });

  it('should build a recall bundle shape', () => {
    const bundle: RecallBundle = {
      profile: { static: [], dynamic: [], evidence: [] } as ProfileSnapshot,
      memories: [] as MemoryRecord[],
      graph_context: { primary: [], expanded: [], edges: [] },
      search_meta: { query: 'auth', scope_order: ['project'], retrieval_sources: ['vector'] },
    };
    expect(bundle.search_meta.query).toBe('auth');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-types.test.ts`

Expected: FAIL with `Cannot find module '../../src/memory-v2/types.js'`

- [ ] **Step 3: Add the type module**

Create `packages/mama-core/src/memory-v2/types.ts` with the approved contract:

```ts
export type MemoryScopeKind = 'global' | 'user' | 'channel' | 'project';
export type MemoryKind = 'decision' | 'preference' | 'constraint' | 'lesson' | 'fact';
export type MemoryStatus = 'active' | 'superseded' | 'contradicted' | 'stale';
export type MemoryEdgeType = 'supersedes' | 'builds_on' | 'synthesizes' | 'contradicts';

export interface MemoryScopeRef {
  kind: MemoryScopeKind;
  id: string;
}

export interface MemoryRecord {
  id: string;
  topic: string;
  kind: MemoryKind;
  summary: string;
  details: string;
  confidence: number;
  status: MemoryStatus;
  scopes: MemoryScopeRef[];
  source: {
    package: 'mama-core' | 'mcp-server' | 'standalone' | 'claude-code-plugin';
    source_type: string;
    user_id?: string;
    channel_id?: string;
    project_id?: string;
  };
  created_at: number | string;
  updated_at: number | string;
}

export interface MemoryEdge {
  from_id: string;
  to_id: string;
  type: MemoryEdgeType;
  reason?: string;
}

export interface ProfileSnapshot {
  static: MemoryRecord[];
  dynamic: MemoryRecord[];
  evidence: Array<{ memory_id: string; topic: string; why_included: string }>;
}

export interface RecallBundle {
  profile: ProfileSnapshot;
  memories: MemoryRecord[];
  graph_context: {
    primary: MemoryRecord[];
    expanded: MemoryRecord[];
    edges: MemoryEdge[];
  };
  search_meta: {
    query: string;
    scope_order: MemoryScopeKind[];
    retrieval_sources: string[];
  };
}
```

Update `packages/mama-core/src/index.ts` to export the new module.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-types.test.ts tests/unit/module-exports.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/memory-v2/types.ts packages/mama-core/src/index.ts packages/mama-core/tests/unit/memory-v2-types.test.ts packages/mama-core/tests/unit/module-exports.test.js
git commit -m "feat(memory-v2): add canonical core types"
```

### Task 2: Add Scope-Aware Schema

**Files:**

- Create: `packages/mama-core/db/migrations/016-add-memory-v2-columns.sql`
- Create: `packages/mama-core/db/migrations/017-create-memory-scopes.sql`
- Create: `packages/mama-core/db/migrations/018-create-memory-scope-bindings.sql`
- Modify: `packages/mama-core/src/db-manager.ts`
- Test: `packages/mama-core/tests/unit/memory-v2-scope-schema.test.ts`

- [ ] **Step 1: Write the failing DB test**

Create `packages/mama-core/tests/unit/memory-v2-scope-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { initDB, getAdapter } from '../../src/db-manager.js';

describe('Memory V2 scope schema', () => {
  it('should create memory_scopes and memory_scope_bindings tables', async () => {
    await initDB();
    const adapter = getAdapter();

    const scopes = adapter
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_scopes'`)
      .all();
    const bindings = adapter
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_scope_bindings'`)
      .all();

    expect(scopes).toHaveLength(1);
    expect(bindings).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-scope-schema.test.ts`

Expected: FAIL because the new tables do not exist yet

- [ ] **Step 3: Add migrations and DB helpers**

Create `packages/mama-core/db/migrations/016-add-memory-v2-columns.sql`:

```sql
ALTER TABLE decisions ADD COLUMN kind TEXT DEFAULT 'decision'
  CHECK (kind IN ('decision', 'preference', 'constraint', 'lesson', 'fact'));
ALTER TABLE decisions ADD COLUMN status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'superseded', 'contradicted', 'stale'));
ALTER TABLE decisions ADD COLUMN summary TEXT;
UPDATE decisions SET summary = decision WHERE summary IS NULL;
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (16, 'Add memory v2 kind/status/summary columns');
```

Create `packages/mama-core/db/migrations/017-create-memory-scopes.sql`:

```sql
CREATE TABLE IF NOT EXISTS memory_scopes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('global', 'user', 'channel', 'project')),
  external_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  UNIQUE(kind, external_id)
);
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (17, 'Create memory scopes table');
```

Create `packages/mama-core/db/migrations/018-create-memory-scope-bindings.sql`:

```sql
CREATE TABLE IF NOT EXISTS memory_scope_bindings (
  memory_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (memory_id, scope_id),
  FOREIGN KEY (memory_id) REFERENCES decisions(id) ON DELETE CASCADE,
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_scope_bindings_scope_id
  ON memory_scope_bindings(scope_id);
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (18, 'Create memory scope bindings table');
```

In `packages/mama-core/src/db-manager.ts`, add helpers:

```ts
export async function ensureMemoryScope(kind: string, externalId: string): Promise<string> {
  /* ... */
}
export async function bindMemoryToScope(
  memoryId: string,
  scopeId: string,
  isPrimary = false
): Promise<void> {
  /* ... */
}
export async function listScopesForMemory(
  memoryId: string
): Promise<Array<{ kind: string; id: string }>> {
  /* ... */
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-scope-schema.test.ts tests/unit/db-initialization.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/db/migrations/016-add-memory-v2-columns.sql packages/mama-core/db/migrations/017-create-memory-scopes.sql packages/mama-core/db/migrations/018-create-memory-scope-bindings.sql packages/mama-core/src/db-manager.ts packages/mama-core/tests/unit/memory-v2-scope-schema.test.ts
git commit -m "feat(memory-v2): add scope-aware schema"
```

### Task 3: Add Scope Store, Profile Builder, And Evolution Engine

**Files:**

- Create: `packages/mama-core/src/memory-v2/scope-store.ts`
- Create: `packages/mama-core/src/memory-v2/profile-builder.ts`
- Create: `packages/mama-core/src/memory-v2/evolution-engine.ts`
- Test: `packages/mama-core/tests/unit/memory-v2-profile-builder.test.ts`
- Test: `packages/mama-core/tests/unit/memory-v2-evolution-engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/mama-core/tests/unit/memory-v2-profile-builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyProfileEntries } from '../../src/memory-v2/profile-builder.js';

describe('profile builder', () => {
  it('should split static and dynamic memories', () => {
    const result = classifyProfileEntries([
      { id: '1', kind: 'preference', summary: 'Concise answers', status: 'active', scopes: [] },
      {
        id: '2',
        kind: 'decision',
        summary: 'Current repo uses pnpm',
        status: 'active',
        scopes: [],
      },
    ]);

    expect(result.static).toHaveLength(1);
    expect(result.dynamic).toHaveLength(1);
  });
});
```

Create `packages/mama-core/tests/unit/memory-v2-evolution-engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveMemoryEvolution } from '../../src/memory-v2/evolution-engine.js';

describe('evolution engine', () => {
  it('should choose supersedes for same-topic replacement', () => {
    const result = resolveMemoryEvolution({
      incoming: { topic: 'auth_strategy', summary: 'Use sessions' },
      existing: [{ id: 'old', topic: 'auth_strategy', summary: 'Use JWT' }],
    });

    expect(result.edges[0]?.type).toBe('supersedes');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-profile-builder.test.ts tests/unit/memory-v2-evolution-engine.test.ts`

Expected: FAIL with missing module or missing export errors

- [ ] **Step 3: Implement the modules**

Implement focused helpers:

- `scope-store.ts`
  - load scope ids in recall order
  - map `project/channel/user/global` references to DB ids
- `profile-builder.ts`
  - classify static vs dynamic using `kind`, `status`, scope, and `is_static`
  - emit evidence rows
- `evolution-engine.ts`
  - same topic -> `supersedes`
  - same scope conflicting summary -> `contradicts`
  - related topic with overlapping nouns -> `builds_on`
  - multi-memory merge -> `synthesizes`

Keep these rules deterministic in phase 1. Do not call an LLM from the core engine.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-profile-builder.test.ts tests/unit/memory-v2-evolution-engine.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/memory-v2/scope-store.ts packages/mama-core/src/memory-v2/profile-builder.ts packages/mama-core/src/memory-v2/evolution-engine.ts packages/mama-core/tests/unit/memory-v2-profile-builder.test.ts packages/mama-core/tests/unit/memory-v2-evolution-engine.test.ts
git commit -m "feat(memory-v2): add profile and evolution helpers"
```

---

## Chunk 2: Core API And Legacy Compatibility

### Task 4: Add Canonical V2 Core API

**Files:**

- Create: `packages/mama-core/src/memory-v2/api.ts`
- Modify: `packages/mama-core/src/index.ts`
- Test: `packages/mama-core/tests/unit/memory-v2-api.test.ts`

- [ ] **Step 1: Write the failing API test**

Create `packages/mama-core/tests/unit/memory-v2-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { saveMemory, recallMemory, buildProfile } from '../../src/memory-v2/api.js';

describe('memory v2 api', () => {
  it('should save and recall a scoped memory', async () => {
    const saved = await saveMemory({
      topic: 'test_scope_contract',
      kind: 'decision',
      summary: 'Use pnpm in this repo',
      details: 'Repo standard',
      scopes: [{ kind: 'project', id: 'repo:test' }],
      source: { package: 'mama-core', source_type: 'test', project_id: 'repo:test' },
    });

    const recall = await recallMemory('pnpm', {
      scopes: [{ kind: 'project', id: 'repo:test' }],
      includeProfile: true,
    });

    expect(saved.success).toBe(true);
    expect(recall.memories.some((item) => item.topic === 'test_scope_contract')).toBe(true);
    expect(recall.profile).toBeDefined();
  });

  it('should build a profile snapshot', async () => {
    const profile = await buildProfile([{ kind: 'project', id: 'repo:test' }]);
    expect(profile).toHaveProperty('static');
    expect(profile).toHaveProperty('dynamic');
    expect(profile).toHaveProperty('evidence');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-api.test.ts`

Expected: FAIL because `memory-v2/api.js` does not exist yet

- [ ] **Step 3: Implement `memory-v2/api.ts`**

Add:

```ts
export async function saveMemory(input) {
  /* normalize -> save -> bind scopes -> evolve */
}
export async function recallMemory(query, options = {}) {
  /* hybrid search + scope filter + profile */
}
export async function buildProfile(scopes, options = {}) {
  /* static/dynamic/evidence */
}
export async function ingestMemory(input) {
  /* structured fallback + hook point for memory actor */
}
export async function evolveMemory(input) {
  /* call evolution-engine */
}
```

Implementation rules:

- `saveMemory` owns v2 writes
- `recallMemory` returns `RecallBundle`, not markdown
- `buildProfile` must not depend on standalone
- `ingestMemory` may initially normalize raw content into `saveMemory` input and leave autonomous actor integration to standalone

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-api.test.ts tests/unit/memory-v2-profile-builder.test.ts tests/unit/memory-v2-evolution-engine.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/memory-v2/api.ts packages/mama-core/src/index.ts packages/mama-core/tests/unit/memory-v2-api.test.ts
git commit -m "feat(memory-v2): add canonical core api"
```

### Task 5: Route Legacy `mama-api` Through V2

**Files:**

- Modify: `packages/mama-core/src/mama-api.ts`
- Test: `packages/mama-core/tests/unit/memory-v2-legacy-shims.test.ts`
- Test: `packages/mama-core/tests/unit/is-latest-filter.test.ts`

- [ ] **Step 1: Write the failing compatibility test**

Create `packages/mama-core/tests/unit/memory-v2-legacy-shims.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import mama from '../../src/mama-api.js';

describe('legacy shims', () => {
  it('should keep mama.save working', async () => {
    const result = await mama.save({
      topic: 'legacy_save_contract',
      decision: 'Keep legacy save alive',
      reasoning: 'Migration shim',
    });

    expect(result.success).toBe(true);
  });

  it('should keep mama.suggest working while exposing recall bundle support', async () => {
    const result = await mama.suggest('legacy save', { limit: 5 });
    expect(result).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify baseline behavior**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-legacy-shims.test.ts tests/unit/is-latest-filter.test.ts`

Expected: PASS before refactor, then keep it PASS after refactor

- [ ] **Step 3: Refactor `mama-api.ts`**

Update `mama-api.ts` so:

- `save()` delegates structured writes to `saveMemory()`
- `suggest()` uses `recallMemory()` internally, then formats legacy markdown/text output
- `mama_profile`-relevant helpers route through `buildProfile()`
- legacy output shapes remain stable for older callers

Do not delete existing public methods in this task.

- [ ] **Step 4: Run tests to verify compatibility**

Run: `pnpm -C packages/mama-core vitest run tests/unit/memory-v2-legacy-shims.test.ts tests/unit/is-latest-filter.test.ts tests/unit/module-exports.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/mama-api.ts packages/mama-core/tests/unit/memory-v2-legacy-shims.test.ts packages/mama-core/tests/unit/is-latest-filter.test.ts
git commit -m "refactor(memory-v2): route legacy mama api through v2 core"
```

---

## Chunk 3: MCP Server Facade

### Task 6: Add `mama_ingest` And `mama_recall`

**Files:**

- Create: `packages/mcp-server/src/tools/ingest-memory.js`
- Create: `packages/mcp-server/src/tools/recall-memory.js`
- Modify: `packages/mcp-server/src/server.js`
- Test: `packages/mcp-server/tests/tools/ingest-memory.test.js`
- Test: `packages/mcp-server/tests/tools/recall-memory.test.js`

- [ ] **Step 1: Write the failing tool tests**

Create `packages/mcp-server/tests/tools/ingest-memory.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { execute } from '../../src/tools/ingest-memory.js';

describe('mama_ingest tool', () => {
  it('should reject missing content', async () => {
    const result = await execute({});
    expect(result.success).toBe(false);
  });
});
```

Create `packages/mcp-server/tests/tools/recall-memory.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { execute } from '../../src/tools/recall-memory.js';

describe('mama_recall tool', () => {
  it('should return a recall bundle shape', async () => {
    const result = await execute({ query: 'auth', limit: 5 });
    expect(result).toHaveProperty('success');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/mcp-server vitest run tests/tools/ingest-memory.test.js tests/tools/recall-memory.test.js`

Expected: FAIL with missing tool module errors

- [ ] **Step 3: Add the new tools**

Implement:

- `ingest-memory.js`
  - tool name: `mama_ingest`
  - call `mama.ingestMemory(...)`
- `recall-memory.js`
  - tool name: `mama_recall`
  - call `mama.recallMemory(...)`
  - return bundle JSON, not markdown

Register both tools in `server.js` and update server instructions to prefer:

- `mama_recall` before work
- `mama_ingest` for raw content
- `mama_save` only for explicit structured writes

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/mcp-server vitest run tests/tools/ingest-memory.test.js tests/tools/recall-memory.test.js tests/tools/load-checkpoint.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/ingest-memory.js packages/mcp-server/src/tools/recall-memory.js packages/mcp-server/src/server.js packages/mcp-server/tests/tools/ingest-memory.test.js packages/mcp-server/tests/tools/recall-memory.test.js
git commit -m "feat(memory-v2): add ingest and recall MCP tools"
```

### Task 7: Keep MCP Compatibility Tools Working

**Files:**

- Modify: `packages/mcp-server/src/tools/add-memory.js`
- Modify: `packages/mcp-server/src/tools/profile.js`
- Test: `packages/mcp-server/tests/tools/search-narrative.test.js`
- Test: `packages/mcp-server/tests/tools/profile-v2.test.js`

- [ ] **Step 1: Write the failing compatibility/profile test**

Create `packages/mcp-server/tests/tools/profile-v2.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { execute } from '../../src/tools/profile.js';

describe('mama_profile v2', () => {
  it('should return static, dynamic, and evidence fields', async () => {
    const result = await execute({ limit: 10 });
    expect(result.success).toBe(true);
    expect(result.profile).toHaveProperty('static');
    expect(result.profile).toHaveProperty('dynamic');
    expect(result.profile).toHaveProperty('evidence');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/mcp-server vitest run tests/tools/profile-v2.test.js`

Expected: FAIL because current `mama_profile` returns a flat list

- [ ] **Step 3: Update compatibility tools**

Modify:

- `add-memory.js`
  - legacy shim to `mama.ingestMemory`
  - keep existing message semantics for older callers
- `profile.js`
  - call `mama.buildProfile(...)`
  - return `{ static, dynamic, evidence }`
  - keep top-level `success` and `count` fields

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/mcp-server vitest run tests/tools/profile-v2.test.js tests/tools/search-narrative.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/add-memory.js packages/mcp-server/src/tools/profile.js packages/mcp-server/tests/tools/profile-v2.test.js packages/mcp-server/tests/tools/search-narrative.test.js
git commit -m "refactor(memory-v2): keep MCP compatibility tools on v2 core"
```

---

## Chunk 4: Standalone Runtime

### Task 8: Add Scope Context And Recall Bundle Formatting

**Files:**

- Create: `packages/standalone/src/memory/scope-context.ts`
- Create: `packages/standalone/src/memory/recall-bundle-formatter.ts`
- Test: `packages/standalone/tests/gateways/memory-scope-context.test.ts`

- [ ] **Step 1: Write the failing scope test**

Create `packages/standalone/tests/gateways/memory-scope-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveMemoryScopes } from '../../src/memory/scope-context.js';

describe('standalone memory scope context', () => {
  it('should derive project, channel, and user scopes from a gateway message', () => {
    const scopes = deriveMemoryScopes({
      source: 'telegram',
      channelId: 'chat-1',
      userId: 'user-1',
      projectId: '/repo/demo',
    });

    expect(scopes.map((item) => item.kind)).toEqual(['project', 'channel', 'user', 'global']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/standalone vitest run tests/gateways/memory-scope-context.test.ts`

Expected: FAIL with missing module error

- [ ] **Step 3: Implement scope derivation helpers**

Add:

- `deriveMemoryScopes({ source, channelId, userId, projectId })`
- `formatRecallBundle(bundle, options)` that produces:
  - compact profile block
  - relevant memories block
  - graph context block

Keep formatting size-aware; hard-cap the final injected text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/standalone vitest run tests/gateways/memory-scope-context.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/memory/scope-context.ts packages/standalone/src/memory/recall-bundle-formatter.ts packages/standalone/tests/gateways/memory-scope-context.test.ts
git commit -m "feat(memory-v2): add standalone scope context helpers"
```

### Task 9: Replace The JSON Extractor Memory-Agent Path

**Files:**

- Modify: `packages/standalone/src/cli/commands/start.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Modify: `packages/standalone/src/agent/types.ts`
- Modify: `packages/standalone/src/gateways/message-router.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/multi-agent/memory-agent-persona.ts`
- Test: `packages/standalone/tests/gateways/message-router.test.ts`
- Test: `packages/standalone/tests/agent/gateway-tool-executor.test.ts`
- Test: `packages/standalone/tests/multi-agent/agent-process-manager-env.test.ts`

- [ ] **Step 1: Add the failing integration assertions**

Extend `packages/standalone/tests/gateways/message-router.test.ts` with:

```ts
it('should not parse JSON facts and save them directly in the router', async () => {
  const router = createRouterUnderTest();
  const spy = vi.spyOn(router['mamaApi'], 'save');
  await router['triggerMemoryAgent']('User: hi', 'Assistant: hello');
  expect(spy).not.toHaveBeenCalled();
});
```

Extend `packages/standalone/tests/agent/gateway-tool-executor.test.ts` with:

```ts
it('should route mama_add through ingestMemory instead of fact JSON parsing', async () => {
  // assert executor calls v2 ingest path
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/standalone vitest run tests/gateways/message-router.test.ts tests/agent/gateway-tool-executor.test.ts tests/multi-agent/agent-process-manager-env.test.ts`

Expected: FAIL because current implementation still parses JSON facts and directly saves them

- [ ] **Step 3: Rewire the runtime**

Make these changes:

- `start.ts`
  - change memory agent from `tier: 3` / `blocked: ['*']` to explicit permission set:
    - allowed: `mama_recall`, `mama_save`, optionally `mama_profile`
    - blocked: `Read`, `Write`, `Edit`, `Bash`, `NotebookEdit`
- `tool-registry.ts` and `types.ts`
  - register `mama_ingest` and `mama_recall`
  - keep `mama_add` and `mama_search` as compatibility names during migration
- `memory-agent-persona.ts`
  - remove JSON-only extractor contract
  - instruct agent to:
    1. recall relevant memory
    2. decide whether to save/update/contradict
    3. use memory tools directly
- `message-router.ts`
  - replace direct JSON parsing + `this.mamaApi.save(...)`
  - call v2 ingest/recall path
  - inject `RecallBundle` output instead of hand-built memory block
- `gateway-tool-executor.ts`
  - route `mama_add` to `ingestMemory`
  - do not parse `facts` JSON locally

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/standalone vitest run tests/gateways/message-router.test.ts tests/agent/gateway-tool-executor.test.ts tests/multi-agent/agent-process-manager-env.test.ts`

Expected: PASS

- [ ] **Step 5: Build standalone**

Run: `pnpm -C packages/standalone build`

Expected: PASS with `gateway-tools.md generated`

- [ ] **Step 6: Commit**

```bash
git add packages/standalone/src/cli/commands/start.ts packages/standalone/src/agent/tool-registry.ts packages/standalone/src/agent/types.ts packages/standalone/src/gateways/message-router.ts packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/src/multi-agent/memory-agent-persona.ts packages/standalone/tests/gateways/message-router.test.ts packages/standalone/tests/agent/gateway-tool-executor.test.ts packages/standalone/tests/multi-agent/agent-process-manager-env.test.ts
git commit -m "feat(memory-v2): convert standalone memory agent to autonomous actor"
```

### Task 10: Inject Profile-Aware Recall Bundles

**Files:**

- Modify: `packages/standalone/src/gateways/message-router.ts`
- Modify: `packages/standalone/src/memory/recall-bundle-formatter.ts`
- Test: `packages/standalone/tests/gateways/message-router.test.ts`

- [ ] **Step 1: Write the failing injection test**

Add to `packages/standalone/tests/gateways/message-router.test.ts`:

```ts
it('should inject static profile, dynamic profile, and relevant memories', async () => {
  const prompt = await buildInjectedPromptForTest();
  expect(prompt).toContain('[MAMA Profile]');
  expect(prompt).toContain('[MAMA Memories]');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/standalone vitest run tests/gateways/message-router.test.ts -t "inject static profile"`

Expected: FAIL because current injection is not bundle-based

- [ ] **Step 3: Implement bundle injection**

Update message-router injection flow to:

1. derive scope context
2. call `recallMemory(query, { scopes, includeProfile: true })`
3. format bundle with `formatRecallBundle`
4. inject compact profile + memories + graph context

Keep prompt size under the existing dynamic-context limits.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/standalone vitest run tests/gateways/message-router.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/gateways/message-router.ts packages/standalone/src/memory/recall-bundle-formatter.ts packages/standalone/tests/gateways/message-router.test.ts
git commit -m "feat(memory-v2): inject profile-aware recall bundles"
```

---

## Chunk 5: Claude Code Plugin Alignment

### Task 11: Add Plugin Profile Command And V2 Recall Semantics

**Files:**

- Create: `packages/claude-code-plugin/src/commands/mama-profile.js`
- Modify: `packages/claude-code-plugin/src/commands/index.js`
- Modify: `packages/claude-code-plugin/src/commands/mama-recall.js`
- Modify: `packages/claude-code-plugin/src/commands/mama-suggest.js`
- Test: `packages/claude-code-plugin/tests/commands/mama-profile-command.test.js`
- Test: `packages/claude-code-plugin/tests/commands/mama-commands.test.js`

- [ ] **Step 1: Write the failing plugin tests**

Create `packages/claude-code-plugin/tests/commands/mama-profile-command.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { mamaProfileCommand } from '../../src/commands/mama-profile.js';

describe('/mama-profile', () => {
  it('should return static, dynamic, and evidence sections', async () => {
    const result = await mamaProfileCommand({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('Static Profile');
    expect(result.message).toContain('Dynamic Profile');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `MAMA_FORCE_TIER_3=true pnpm -C packages/claude-code-plugin vitest run tests/commands/mama-profile-command.test.js tests/commands/mama-commands.test.js`

Expected: FAIL because the profile command does not exist

- [ ] **Step 3: Update plugin commands**

Implement:

- `mama-profile.js`
  - call `mama.buildProfile(...)`
  - render static/dynamic/evidence sections
- `mama-recall.js`
  - detect `RecallBundle` shape and render profile-aware output
- `mama-suggest.js`
  - keep working against legacy surface, but prefer bundle-aware formatting when available

Do not break old `/mama-save`, `/mama-list`, `/mama-recall` workflows in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `MAMA_FORCE_TIER_3=true pnpm -C packages/claude-code-plugin vitest run tests/commands/mama-profile-command.test.js tests/commands/mama-commands.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/src/commands/mama-profile.js packages/claude-code-plugin/src/commands/index.js packages/claude-code-plugin/src/commands/mama-recall.js packages/claude-code-plugin/src/commands/mama-suggest.js packages/claude-code-plugin/tests/commands/mama-profile-command.test.js packages/claude-code-plugin/tests/commands/mama-commands.test.js
git commit -m "feat(memory-v2): align plugin commands with profile-aware recall"
```

---

## Chunk 6: Verification, Cleanup, And Rollout

### Task 12: Run Cross-Package Verification

**Files:**

- Modify as needed based on failures from previous chunks
- Test: existing monorepo suites

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm -C packages/mama-core vitest run tests/unit/memory-v2-types.test.ts tests/unit/memory-v2-scope-schema.test.ts tests/unit/memory-v2-profile-builder.test.ts tests/unit/memory-v2-evolution-engine.test.ts tests/unit/memory-v2-api.test.ts tests/unit/memory-v2-legacy-shims.test.ts
pnpm -C packages/mcp-server vitest run tests/tools/ingest-memory.test.js tests/tools/recall-memory.test.js tests/tools/profile-v2.test.js
pnpm -C packages/standalone vitest run tests/gateways/memory-scope-context.test.ts tests/gateways/message-router.test.ts tests/agent/gateway-tool-executor.test.ts tests/multi-agent/agent-process-manager-env.test.ts
MAMA_FORCE_TIER_3=true pnpm -C packages/claude-code-plugin vitest run tests/commands/mama-profile-command.test.js tests/commands/mama-commands.test.js
```

Expected: ALL PASS

- [ ] **Step 2: Run builds**

Run:

```bash
pnpm -C packages/mama-core build
pnpm -C packages/standalone build
pnpm -C packages/mama-core typecheck
pnpm -C packages/standalone typecheck
```

Expected: PASS

- [ ] **Step 3: Run monorepo verification**

Run:

```bash
pnpm test
pnpm build
```

Expected: PASS

- [ ] **Step 4: Manual runtime smoke tests**

Run:

```bash
node packages/standalone/dist/cli/index.js stop
node packages/standalone/dist/cli/index.js start
curl http://127.0.0.1:3847/api/memory-agent/stats
```

Expected:

- daemon starts cleanly
- stats endpoint returns JSON
- no startup errors about missing memory tools

- [ ] **Step 5: Gateway round-trip**

Perform one real round-trip in Telegram or another configured gateway:

1. send a message that creates a project-scoped decision
2. send a second message that should recall it
3. confirm injected recall reflects:
   - project scope first
   - profile block present
   - direct JSON fact parsing path no longer used

- [ ] **Step 6: Commit fixes if verification surfaces regressions**

```bash
git add -A
git commit -m "fix(memory-v2): address verification regressions"
```

### Task 13: Mark Old Plans As Historical And Prepare Handoff

**Files:**

- Modify: `docs/superpowers/specs/2026-03-24-memory-agent-redesign.md`
- Modify: `docs/superpowers/plans/2026-03-24-memory-agent-redesign.md`
- Modify: `docs/superpowers/plans/2026-03-24-haiku-memory-layer-phase1.md` (if retained)
- Modify: `docs/superpowers/plans/2026-03-24-haiku-memory-layer-phase2-3.md` (if retained)

- [ ] **Step 1: Mark legacy docs as historical**

Add a short note at the top of retained old docs:

```md
> Historical document. Active implementation baseline: `docs/superpowers/specs/2026-03-25-memory-v2-core-first-design.md` and `docs/superpowers/plans/2026-03-25-memory-v2-core-first.md`.
```

- [ ] **Step 2: Save checkpoint**

After all verification passes, save a checkpoint that records:

- memory v2 contract status
- package verification results
- remaining follow-up limited to connectors/document ingest

- [ ] **Step 3: Commit doc/handoff updates**

```bash
git add docs/superpowers/specs/2026-03-24-memory-agent-redesign.md docs/superpowers/plans/2026-03-24-memory-agent-redesign.md docs/superpowers/plans/2026-03-24-haiku-memory-layer-phase1.md docs/superpowers/plans/2026-03-24-haiku-memory-layer-phase2-3.md docs/superpowers/plans/2026-03-25-memory-v2-core-first.md
git commit -m "docs(memory-v2): mark old plans historical and add rollout handoff"
```
