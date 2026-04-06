# v0.16 API Integration: MCP Server & Plugin → mama-core v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire MCP server tools and Plugin to use mama-core v2 API (scopes + event_date), closing the 91% unscoped gap.

**Architecture:** MCP tools currently call legacy `mama.save()/recall()/suggest()` without scopes or event_date params. mama-core's `mama.save()` already accepts both — we just need to: (1) add params to MCP inputSchemas, (2) pass them through in handlers, (3) add event_date to formatter types, (4) update tests.

**Tech Stack:** JavaScript (MCP server), TypeScript (mama-core), Vitest

**Decision ref:** `decision_mama_v016_release_scope_redefined_1775470863970_so45`

---

## File Structure

| File                                                         | Action | Responsibility                                                      |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------------- |
| `packages/mcp-server/src/tools/save-decision.js`             | Modify | Add scopes + event_date to inputSchema + handler                    |
| `packages/mcp-server/src/tools/recall-decision.js`           | Modify | Add scopes to inputSchema, switch to recallMemory via mama.search() |
| `packages/mcp-server/src/tools/suggest-decision.js`          | Modify | Add scopes + event_date filtering                                   |
| `packages/mcp-server/src/tools/list-decisions.js`            | Modify | Add scopes filtering                                                |
| `packages/mcp-server/tests/tools/save-decision-v2.test.js`   | Create | Test scopes + event_date pass-through                               |
| `packages/mcp-server/tests/tools/recall-decision-v2.test.js` | Create | Test scopes pass-through                                            |
| `packages/mama-core/src/decision-formatter.ts`               | Modify | Add event_date to DecisionForFormat                                 |
| `packages/mama-core/src/mama-api.ts`                         | Modify | Add event_date to SimilarDecision                                   |

---

### Task 1: Add scopes + event_date to MCP save_decision

**Files:**

- Modify: `packages/mcp-server/src/tools/save-decision.js:164-215` (inputSchema)
- Modify: `packages/mcp-server/src/tools/save-decision.js:218-308` (handler)
- Create: `packages/mcp-server/tests/tools/save-decision-v2.test.js`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-server/tests/tools/save-decision-v2.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSaveDecisionTool } from '../../src/tools/save-decision.js';

describe('save_decision v2: scopes + event_date', () => {
  let mockMama;
  let tool;

  beforeEach(() => {
    mockMama = {
      save: vi.fn().mockResolvedValue({ success: true, id: 'test_id_123' }),
      recall: vi.fn().mockResolvedValue({ supersedes_chain: [] }),
    };
    tool = createSaveDecisionTool(mockMama);
  });

  it('passes scopes to mama.save()', async () => {
    const scopes = [{ kind: 'project', id: '/my/project' }];
    await tool.handler({
      topic: 'test_topic',
      decision: 'Use scopes',
      reasoning: 'Need isolation',
      scopes,
    });

    expect(mockMama.save).toHaveBeenCalledWith(expect.objectContaining({ scopes }));
  });

  it('passes event_date to mama.save()', async () => {
    await tool.handler({
      topic: 'test_topic',
      decision: 'Something happened',
      reasoning: 'On a specific date',
      event_date: '2024-01-15',
    });

    expect(mockMama.save).toHaveBeenCalledWith(
      expect.objectContaining({ event_date: '2024-01-15' })
    );
  });

  it('works without scopes (backward compat)', async () => {
    await tool.handler({
      topic: 'test_topic',
      decision: 'No scopes',
      reasoning: 'Legacy caller',
    });

    expect(mockMama.save).toHaveBeenCalledWith(expect.objectContaining({ topic: 'test_topic' }));
    // scopes should not be in call if not provided
    const callArgs = mockMama.save.mock.calls[0][0];
    expect(callArgs.scopes).toBeUndefined();
  });

  it('scopes appear in inputSchema', () => {
    expect(tool.inputSchema.properties.scopes).toBeDefined();
    expect(tool.inputSchema.properties.scopes.type).toBe('array');
  });

  it('event_date appears in inputSchema', () => {
    expect(tool.inputSchema.properties.event_date).toBeDefined();
    expect(tool.inputSchema.properties.event_date.type).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run tests/tools/save-decision-v2.test.js`
Expected: FAIL — scopes/event_date not in inputSchema, not passed to mama.save()

- [ ] **Step 3: Add scopes + event_date to inputSchema**

In `packages/mcp-server/src/tools/save-decision.js`, add to `inputSchema.properties` (after `risks`):

```javascript
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['global', 'user', 'channel', 'project'],
              description: 'Scope type',
            },
            id: {
              type: 'string',
              description: 'Scope identifier (e.g., project path, channel ID)',
            },
          },
          required: ['kind', 'id'],
        },
        description:
          'Memory scopes for isolation. Decisions are stored per-scope. If omitted, decision is unscoped (global). Example: [{"kind": "project", "id": "/path/to/project"}]',
      },
      event_date: {
        type: 'string',
        description:
          'ISO 8601 date when the event actually occurred (e.g., "2024-01-15"). If omitted, defaults to current time. Use this when recording decisions about past events.',
      },
```

- [ ] **Step 4: Pass scopes + event_date in handler**

In `packages/mcp-server/src/tools/save-decision.js`, update the handler destructuring (line ~219) to include:

```javascript
const {
  topic,
  decision,
  reasoning,
  confidence = 0.5,
  type = 'user_decision',
  outcome = 'pending',
  evidence,
  alternatives,
  risks,
  scopes,
  event_date,
} = params || {};
```

And update the `mamaApi.save()` call (line ~297) to include:

```javascript
const result = await mamaApi.save({
  topic,
  decision,
  reasoning,
  confidence,
  type,
  outcome,
  evidence,
  alternatives,
  risks,
  trust_context: trustContext,
  ...(scopes && { scopes }),
  ...(event_date && { event_date }),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run tests/tools/save-decision-v2.test.js`
Expected: PASS (all 5 tests)

- [ ] **Step 6: Run full MCP test suite to check no regressions**

Run: `cd packages/mcp-server && pnpm test`
Expected: 276+ tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src/tools/save-decision.js packages/mcp-server/tests/tools/save-decision-v2.test.js
git commit -m "feat(mcp): add scopes + event_date to save_decision tool"
```

---

### Task 2: Add scopes to MCP recall_decision

**Files:**

- Modify: `packages/mcp-server/src/tools/recall-decision.js`
- Create: `packages/mcp-server/tests/tools/recall-decision-v2.test.js`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-server/tests/tools/recall-decision-v2.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';

// We need to mock mama-core before importing the tool
vi.mock('@jungjaehoon/mama-core/mama-api', () => ({
  recall: vi.fn().mockResolvedValue('# Recall result'),
}));

const mama = await import('@jungjaehoon/mama-core/mama-api');
const { recallDecisionTool } = await import('../../src/tools/recall-decision.js');

describe('recall_decision v2: scopes', () => {
  it('has scopes in inputSchema', () => {
    expect(recallDecisionTool.inputSchema.properties.scopes).toBeDefined();
  });

  it('passes format option to mama.recall()', async () => {
    await recallDecisionTool.handler({ topic: 'test', format: 'json' });
    expect(mama.recall).toHaveBeenCalledWith('test', expect.objectContaining({ format: 'json' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run tests/tools/recall-decision-v2.test.js`
Expected: FAIL — no scopes in inputSchema

- [ ] **Step 3: Add scopes + format to recall_decision inputSchema and handler**

In `packages/mcp-server/src/tools/recall-decision.js`, update `inputSchema.properties`:

```javascript
      topic: {
        type: 'string',
        description:
          "Decision topic to recall (e.g., 'auth_strategy'). Use the EXACT SAME topic name used in save_decision to see full decision evolution graph.",
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: "Output format. Default: 'markdown'",
      },
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['global', 'user', 'channel', 'project'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        description: 'Filter recall results by scope. If omitted, returns all scopes.',
      },
```

Update handler to destructure and pass:

```javascript
  async handler(params, _context) {
    const { topic, format = 'markdown', scopes } = params || {};

    // ... validation ...

    const history = await mama.recall(topic, {
      format,
      ...(scopes && { scopes }),
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run tests/tools/recall-decision-v2.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd packages/mcp-server && pnpm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/tools/recall-decision.js packages/mcp-server/tests/tools/recall-decision-v2.test.js
git commit -m "feat(mcp): add scopes + format to recall_decision tool"
```

---

### Task 3: Add scopes to MCP suggest_decision and list_decisions

**Files:**

- Modify: `packages/mcp-server/src/tools/suggest-decision.js`
- Modify: `packages/mcp-server/src/tools/list-decisions.js`

- [ ] **Step 1: Add scopes to suggest_decision inputSchema**

In `packages/mcp-server/src/tools/suggest-decision.js`, add to `inputSchema.properties`:

```javascript
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['global', 'user', 'channel', 'project'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        description: 'Filter suggestions by scope. If omitted, searches all scopes.',
      },
```

Update handler destructuring:

```javascript
const { userQuestion, recencyWeight, recencyScale, recencyDecay, disableRecency, scopes } =
  params || {};
```

Update mama.suggest() call:

```javascript
const suggestions = await mama.suggest(userQuestion, {
  format: 'markdown',
  recencyWeight,
  recencyScale,
  recencyDecay,
  disableRecency,
  ...(scopes && { scopes }),
});
```

- [ ] **Step 2: Add scopes to list_decisions inputSchema**

In `packages/mcp-server/src/tools/list-decisions.js`, add to `inputSchema.properties`:

```javascript
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['global', 'user', 'channel', 'project'] },
            id: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        description: 'Filter list by scope. If omitted, lists all scopes.',
      },
```

Update handler:

```javascript
const { limit = 20, scopes } = params || {};
// ...
const list = await mama.list({ limit, format: 'markdown', ...(scopes && { scopes }) });
```

- [ ] **Step 3: Run full MCP test suite**

Run: `cd packages/mcp-server && pnpm test`
Expected: All pass (no behavioral change for callers without scopes)

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/tools/suggest-decision.js packages/mcp-server/src/tools/list-decisions.js
git commit -m "feat(mcp): add scopes to suggest_decision + list_decisions"
```

---

### Task 4: Add event_date to mama-core formatter types

**Files:**

- Modify: `packages/mama-core/src/decision-formatter.ts:20-42` (DecisionForFormat)
- Modify: `packages/mama-core/src/mama-api.ts:83-90` (SimilarDecision)

- [ ] **Step 1: Add event_date to DecisionForFormat**

In `packages/mama-core/src/decision-formatter.ts`, add to `DecisionForFormat` interface (after `risks`):

```typescript
  /** ISO 8601 date when the event actually occurred. Null if not set. */
  event_date?: string | null;
```

- [ ] **Step 2: Add event_date to SimilarDecision**

In `packages/mama-core/src/mama-api.ts`, add to `SimilarDecision` interface (after `created_at`):

```typescript
  event_date?: string | null;
```

- [ ] **Step 3: Run mama-core tests**

Run: `cd packages/mama-core && pnpm test`
Expected: 77+ tests pass (type additions only, no behavioral change)

- [ ] **Step 4: Commit**

```bash
git add packages/mama-core/src/decision-formatter.ts packages/mama-core/src/mama-api.ts
git commit -m "feat(core): add event_date to DecisionForFormat + SimilarDecision types"
```

---

### Task 5: Full test suite + version bump

**Files:**

- Modify: `packages/standalone/package.json` (version → 0.16.0)
- Modify: `packages/mama-core/package.json` (version → check if bump needed)

- [ ] **Step 1: Run all tests across all packages**

Run: `pnpm test`
Expected: All packages pass (mama-core 77+, mcp-server 276+, plugin 328+)

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Verify scopes/event_date in MCP tools**

```bash
grep -n "scopes" packages/mcp-server/src/tools/save-decision.js
grep -n "event_date" packages/mcp-server/src/tools/save-decision.js
grep -n "scopes" packages/mcp-server/src/tools/recall-decision.js
grep -n "scopes" packages/mcp-server/src/tools/suggest-decision.js
grep -n "scopes" packages/mcp-server/src/tools/list-decisions.js
```

Expected: All tools have scopes; save has event_date

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: v0.16 API integration complete — all packages wired to v2"
```

---

## Scope Boundaries (NOT in this plan)

- **MCP ingestConversation tool** — separate plan (HIGH priority but independent)
- **Plugin save scopes** — Plugin delegates to MCP; once MCP has scopes, Plugin inherits
- **search_narrative scopes** — uses separate search engine, not mama-core API
- **Standalone changes** — already v2 connected
- **Version bump** — do after PR review
