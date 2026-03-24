# Memory V2 Core-First Redesign

**Date:** 2026-03-25
**Status:** Draft
**Branch:** `feat/haiku-memory-layer`

## Goal

Redesign MAMA's memory system around a shared core contract used by all packages.

This iteration takes the strongest parts of Supermemory's public model and adapts them to
MAMA's architecture:

1. Autonomous memory evolution instead of append-only storage
2. Profile-aware recall instead of raw search-only retrieval
3. Scoped memory for user/channel/project separation

This iteration explicitly does **not** include external document connectors or third-party
sync pipelines. Those are deferred to a later update.

## Why This Redesign Exists

The current branch successfully added several useful capabilities:

- hybrid retrieval (`embedding + FTS5`)
- `is_static` for long-term preferences
- `mama_profile`
- per-turn memory injection
- memory-agent scaffolding in standalone

But the current standalone memory-agent design is structurally wrong for the target behavior:

- the agent is configured as a JSON extractor instead of a memory actor
- TypeScript code still performs the real save logic
- graph evolution is not autonomous
- profile assembly is shallow
- scope is implicit and inconsistent across packages

The result is a system that resembles "smart extraction" more than "complete memory context".

## Product Scope

### In Scope

- common memory contract in `mama-core`
- autonomous graph memory behavior
- profile-aware recall
- scoped memory (`user`, `channel`, `project`, `global`)
- package-wide API/tool alignment across:
  - `mama-core`
  - `mcp-server`
  - `standalone`
  - `claude-code-plugin`

### Out of Scope

- Notion / Slack / Gmail / S3 / Google Drive connectors
- PDF / image / audio / video ingestion pipelines
- remote sync services
- cross-device memory synchronization

## Design Principles

### 1. Core First

`mama-core` becomes the single semantic source of truth. All packages may expose different
interfaces, but they must share one memory model.

### 2. Evolution, Not Append

Memory is not just "save another row". New information may replace, refine, contradict, or
merge with existing memory.

### 3. Recall Is Context, Not Search Results

The default retrieval output should be usable as prompt context. It must combine:

- relevant memories
- graph relationships
- profile summary
- scope-aware ranking

### 4. Explicit Scope

Every memory must be attributable to a scope boundary. This prevents cross-project pollution
while preserving reusable long-term preferences.

### 5. Legacy Compatibility During Migration

Existing tools may remain as compatibility shims during rollout, but the new core contract is
the canonical design target.

## Package Responsibilities

### `packages/mama-core`

Owns:

- canonical data model
- scope resolution
- profile assembly
- hybrid retrieval
- graph evolution rules
- migration helpers

Does not own:

- gateway-specific prompts
- MCP tool protocol details
- standalone memory-agent persona text

### `packages/mcp-server`

Acts as a thin MCP-facing facade over the core contract.

Responsibilities:

- expose new v2 tools
- keep legacy tools working during migration
- translate MCP payloads to core inputs/outputs

### `packages/standalone`

Acts as the autonomous runtime.

Responsibilities:

- memory-agent orchestration
- per-turn memory recall and injection
- gateway/source metadata extraction
- scoped context resolution at runtime

### `packages/claude-code-plugin`

Acts as the constrained local client.

Responsibilities:

- keep duplicated core logic semantically aligned with `mama-core`
- expose the same memory semantics even if implementation is bundled/copied

## Core V2 Model

### Memory Scope

```ts
type MemoryScopeKind = 'global' | 'user' | 'channel' | 'project';

interface MemoryScopeRef {
  kind: MemoryScopeKind;
  id: string;
}
```

Scope rules:

- `global`: cross-project durable memory such as coding style or role preference
- `user`: memories tied to a person across sessions
- `channel`: conversation-local memory tied to a gateway thread/room/chat
- `project`: repository or workspace memory

Each memory may belong to multiple scopes. Example:

- "Use Vitest in this repo" -> `project`
- "User prefers concise answers" -> `user` + `global`
- "This Telegram thread is for release triage" -> `channel`

### Memory Record

```ts
type MemoryKind = 'decision' | 'preference' | 'constraint' | 'lesson' | 'fact';
type MemoryStatus = 'active' | 'superseded' | 'contradicted' | 'stale';

interface MemoryRecord {
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
```

### Memory Edge

```ts
type MemoryEdgeType = 'supersedes' | 'builds_on' | 'synthesizes' | 'contradicts';

interface MemoryEdge {
  from_id: string;
  to_id: string;
  type: MemoryEdgeType;
  reason?: string;
}
```

`supersedes` remains the primary "latest truth" mechanism.

`contradicts` becomes first-class in the v2 contract even if rollout is staged.

### Profile Snapshot

```ts
interface ProfileSnapshot {
  static: MemoryRecord[];
  dynamic: MemoryRecord[];
  evidence: Array<{
    memory_id: string;
    topic: string;
    why_included: string;
  }>;
}
```

Interpretation:

- `static`: durable preferences and identity-level facts
- `dynamic`: current project/task/channel context likely to change
- `evidence`: traceability to underlying memories

### Recall Bundle

```ts
interface RecallBundle {
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

This is the default unit of prompt injection.

## Core V2 API

### Canonical Functions

```ts
ingestMemory(input): Promise<IngestResult>
saveMemory(input): Promise<SaveResult>
recallMemory(query, options): Promise<RecallBundle>
buildProfile(scope, options?): Promise<ProfileSnapshot>
evolveMemory(input): Promise<EvolutionResult>
```

### Function Intent

- `ingestMemory`
  - accepts raw content or summarized content
  - may call an autonomous memory actor
  - should be used for conversations and unstructured input

- `saveMemory`
  - low-level structured write
  - used when caller already knows topic/kind/summary/details

- `recallMemory`
  - hybrid retrieval + graph expansion + scope filtering + optional profile assembly

- `buildProfile`
  - returns static/dynamic/evidence for a given scope context

- `evolveMemory`
  - explicit relationship resolution for advanced callers
  - may remain internal in phase 1, but the model must exist now

## Legacy Tool Mapping

During migration:

- `mama_add` -> `ingestMemory`
- `mama_save` -> `saveMemory`
- `mama_search` -> `recallMemory`
- `mama_profile` -> `buildProfile`

New MCP-facing names are allowed in v2:

- `mama_ingest`
- `mama_recall`
- `mama_profile`

`mama_save` should remain available as a lower-level explicit write tool until clients migrate.

## Autonomous Memory Graph

### Required Behavior

The standalone memory agent must stop behaving like a JSON extractor.

Instead, it should:

1. receive conversation content plus scope context
2. call `recallMemory` to inspect existing relevant memory
3. decide whether to create, update, supersede, synthesize, or contradict
4. call `saveMemory` for chosen output
5. emit relationship intent or direct edge creation metadata

### Forbidden Behavior

- no JSON-only memory persona as the primary mechanism
- no TypeScript-side hardcoded "parse facts then save each one" pipeline
- no toolless memory agent that cannot inspect prior memory state

## Profile Model

### Static Profile

Contains durable facts such as:

- preferred response style
- preferred tools/frameworks
- long-term role or collaboration rules

### Dynamic Profile

Contains currently relevant but changing context such as:

- active repository conventions
- current branch intent
- current task constraints
- channel- or project-specific operating rules

### Evidence Rule

Every profile item must be traceable to underlying memories. Profile output must never be a
free-floating summary with no evidence path.

## Scope Resolution

### Initial Scope Cascade

Default recall order:

1. `project`
2. `channel`
3. `user`
4. `global`

Rationale:

- current repo decisions should dominate repo work
- channel context should outrank broad personal preferences
- user/global memory remains available as fallback

### Initial Scope Derivation

Package defaults:

- `standalone`
  - `project` from cwd/workspace root when available
  - `channel` from gateway conversation id
  - `user` from gateway user id
- `mcp-server`
  - `project` from cwd or configured workspace
  - `user` optional unless explicitly passed
- `claude-code-plugin`
  - `project` from repo root
  - `user` optional/local identity

### Conflict Rule

If two active memories conflict across scopes:

- same-scope contradiction -> prefer latest non-contradicted active memory
- narrower scope beats broader scope
- `project` beats `global`
- `channel` beats `user` only for channel-local behavior

## Retrieval Strategy

`recallMemory` should preserve the branch's existing retrieval gains:

- embedding search
- FTS5 search
- graph expansion
- `is_static` / profile-aware boosts
- recency-aware tie-breaking

But output should be promoted from "search results" to "context bundle".

## Package Rollout Strategy

### Phase A: Core Contract

- add v2 types and canonical functions in `mama-core`
- keep existing v1 exports working
- add scope-aware storage and recall path

### Phase B: MCP Facade

- add `mama_ingest` and `mama_recall`
- keep `mama_add`, `mama_search`, `mama_save` as shims
- expose richer profile output

### Phase C: Standalone Runtime

- replace JSON extractor memory-agent flow
- use autonomous recall + save loop
- inject `RecallBundle` into prompts

### Phase D: Plugin Alignment

- port v2 contract semantics into duplicated plugin core
- verify meaning parity with `mama-core`

## Testing Strategy

### Core

- scope filtering tests
- profile assembly tests
- conflict resolution tests
- graph evolution tests
- legacy shim compatibility tests

### MCP Server

- new v2 tool contract tests
- old tool compatibility tests
- serialized response shape tests

### Standalone

- memory-agent integration tests
- per-turn recall injection tests
- channel/user/project scope derivation tests
- gateway e2e for automatic memory evolution

### Plugin

- parity tests for v2 recall/profile semantics

## Key Risks

### 1. Semantic Drift Across Packages

The plugin duplicates core logic. Any v2 redesign must include an explicit sync strategy or
behavior will diverge again.

### 2. Graph Pollution

Autonomous evolution can create incorrect edges. Evidence, observability, and tests must be
first-class.

### 3. Scope Misclassification

If scope derivation is wrong, useful memory may disappear or leak across projects.

### 4. Prompt Bloat

Profile + graph + scoped recall can grow too large. Recall output must be size-aware.

## Success Criteria

1. `mama-core` defines the canonical v2 memory contract
2. all packages use the same memory semantics
3. memory evolution is autonomous, not JSON-parser-driven
4. recall returns profile + relevant memories + graph context
5. scope-aware recall prevents cross-project memory pollution
6. legacy tools still function during migration
7. external document ingestion and connectors remain cleanly deferred
