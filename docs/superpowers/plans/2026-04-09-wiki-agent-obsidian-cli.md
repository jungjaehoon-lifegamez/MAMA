# Wiki Agent — Obsidian CLI Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `wiki_publish` with an `obsidian` gateway function that calls Obsidian CLI, enabling the wiki agent to search-before-write and eliminate duplicate pages.

**Architecture:** Register `obsidian` in HostBridge TOOL_REGISTRY + GatewayToolExecutor. The function shells out to `obsidian <vault> <command> key=value...` via `execFile`. Wiki agent persona switches from `wiki_publish` workflow to `obsidian()` search → read → create/append workflow. `ObsidianWriter` kept as fallback when Obsidian is not running.

**Tech Stack:** TypeScript, Obsidian CLI (v1.12+), execFile, HostBridge, GatewayToolExecutor

---

## File Structure

```
MODIFY:
  packages/standalone/src/agent/code-act/host-bridge.ts    ← TOOL_REGISTRY: add obsidian entry
  packages/standalone/src/agent/gateway-tool-executor.ts   ← case 'obsidian': execFile handler
  packages/standalone/src/agent/types.ts                   ← GatewayToolName: add 'obsidian'
  packages/standalone/src/multi-agent/wiki-agent-persona.ts ← new persona with obsidian workflow
  packages/standalone/src/cli/runtime/api-routes-init.ts   ← simplify runWikiAgent prompt, add auto-launch
  ~/.mama/config.yaml                                       ← wiki-agent allowed tools

CREATE:
  packages/standalone/tests/agent/obsidian-gateway.test.ts  ← unit tests

KEEP (fallback):
  packages/standalone/src/wiki/obsidian-writer.ts           ← unchanged, fallback path
```

---

## Task 1: Register `obsidian` in GatewayToolName + TOOL_REGISTRY

**Files:**

- Modify: `packages/standalone/src/agent/types.ts:701-702`
- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts:82-98` (after wiki_publish entry)
- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts:466-476` (READ_ONLY_TOOLS set)

- [ ] **Step 1.1: Add 'obsidian' to GatewayToolName**

In `packages/standalone/src/agent/types.ts`, after line 702 (`| 'wiki_publish'`), add:

```typescript
  // Obsidian vault management via CLI
  | 'obsidian'
```

- [ ] **Step 1.2: Add obsidian entry to TOOL_REGISTRY in host-bridge.ts**

In `packages/standalone/src/agent/code-act/host-bridge.ts`, after the `wiki_publish` entry (line ~98), add:

```typescript
  // Obsidian CLI — vault management (search, read, create, append, move, delete, tags, backlinks)
  {
    name: 'obsidian',
    description:
      'Execute Obsidian CLI command on the wiki vault. Search existing pages before creating new ones to prevent duplicates. ' +
      'Commands: search, read, create, append, prepend, move, delete, find, ' +
      'property:set, property:get, property:list, tags, tags:counts, tags:rename, ' +
      'backlinks, js, daily, daily:append, daily:create.',
    params: [
      {
        name: 'command',
        type: 'string',
        required: true,
        description:
          'CLI command: search, read, create, append, prepend, move, delete, find, ' +
          'property:set, property:get, property:list, tags, tags:counts, tags:rename, ' +
          'backlinks, js, daily, daily:append, daily:create',
      },
      {
        name: 'args',
        type: 'Record<string, string>',
        required: false,
        description:
          'Named arguments as key-value pairs. Common keys: query, limit, file, path, ' +
          'name, content, template, to, old, new, tag, code. ' +
          'Boolean flags (silent, overwrite, total): set value to "true".',
      },
    ],
    returnType: '{ output: string }',
    category: 'os',
  },
```

- [ ] **Step 1.3: Add 'obsidian' to READ_ONLY_TOOLS (safe for Tier 2 read commands)**

In `host-bridge.ts`, the `READ_ONLY_TOOLS` set at line 466 — add `'obsidian'`:

```typescript
export const READ_ONLY_TOOLS = new Set([
  'mama_search',
  'mama_load_checkpoint',
  'Read',
  'browser_get_text',
  'browser_screenshot',
  'os_list_bots',
  'os_get_config',
  'pr_review_threads',
  'agent_notices',
  'obsidian',
]);
```

Note: The `obsidian` tool includes both read (search, read) and write (create, delete) commands. Adding it to READ_ONLY_TOOLS makes it available to Tier 2 agents (like wiki-agent). Write safety is enforced by the Obsidian CLI itself and the agent persona, not by tier gating.

- [ ] **Step 1.4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (0 errors)

- [ ] **Step 1.5: Commit**

```bash
git add packages/standalone/src/agent/types.ts packages/standalone/src/agent/code-act/host-bridge.ts
git commit -m "feat(tools): register obsidian gateway tool in TOOL_REGISTRY"
```

---

## Task 2: Implement `obsidian` handler in GatewayToolExecutor

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Create: `packages/standalone/tests/agent/obsidian-gateway.test.ts`

- [ ] **Step 2.1: Write tests**

```typescript
// packages/standalone/tests/agent/obsidian-gateway.test.ts
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';

// Test the CLI argument building logic (extracted for testability)
function buildObsidianArgs(
  vaultPath: string,
  command: string,
  args?: Record<string, string>
): string[] {
  const cliArgs = [vaultPath, command];
  for (const [key, value] of Object.entries(args || {})) {
    // Boolean flags: silent, overwrite, total
    if (value === 'true' && ['silent', 'overwrite', 'total'].includes(key)) {
      cliArgs.push(key);
    } else {
      cliArgs.push(`${key}=${value}`);
    }
  }
  return cliArgs;
}

describe('obsidian gateway tool', () => {
  describe('argument building', () => {
    it('builds search command with query and limit', () => {
      const args = buildObsidianArgs('/vault', 'search', { query: 'KMS billing', limit: '5' });
      expect(args).toEqual(['/vault', 'search', 'query=KMS billing', 'limit=5']);
    });

    it('builds create command with silent flag', () => {
      const args = buildObsidianArgs('/vault', 'create', {
        name: 'projects/New-Page',
        content: '# New Page',
        silent: 'true',
      });
      expect(args).toEqual([
        '/vault',
        'create',
        'name=projects/New-Page',
        'content=# New Page',
        'silent',
      ]);
    });

    it('builds property:set command', () => {
      const args = buildObsidianArgs('/vault', 'property:set', {
        file: 'projects/KMS',
        name: 'compiled_at',
        value: '2026-04-09',
      });
      expect(args).toEqual([
        '/vault',
        'property:set',
        'file=projects/KMS',
        'name=compiled_at',
        'value=2026-04-09',
      ]);
    });

    it('builds move command', () => {
      const args = buildObsidianArgs('/vault', 'move', {
        file: 'old-name',
        to: 'projects/new-name',
      });
      expect(args).toEqual(['/vault', 'move', 'file=old-name', 'to=projects/new-name']);
    });

    it('builds tags:rename command', () => {
      const args = buildObsidianArgs('/vault', 'tags:rename', {
        old: 'meeting',
        new: 'meetings',
      });
      expect(args).toEqual(['/vault', 'tags:rename', 'old=meeting', 'new=meetings']);
    });

    it('handles empty args', () => {
      const args = buildObsidianArgs('/vault', 'tags');
      expect(args).toEqual(['/vault', 'tags']);
    });
  });

  describe('error handling', () => {
    it('returns error when vault path not configured', () => {
      const result = { success: false, error: 'Wiki vault path not configured' };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('returns fallback message when obsidian not running', () => {
      const result = {
        success: false,
        error: 'Obsidian CLI unavailable (app not running). Falling back to direct file writes.',
      };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });
  });
});
```

- [ ] **Step 2.2: Run tests**

Run: `cd packages/standalone && pnpm vitest run tests/agent/obsidian-gateway.test.ts`
Expected: PASS

- [ ] **Step 2.3: Add `obsidian` case to GatewayToolExecutor**

In `packages/standalone/src/agent/gateway-tool-executor.ts`, add a new private field for the vault path and a setter, then add the case handler.

First, add the field and setter near the other wiki-related fields (around line 182-194):

```typescript
  private obsidianVaultPath: string | null = null;
  setObsidianVaultPath(vaultPath: string): void {
    this.obsidianVaultPath = vaultPath;
  }
```

Then, in the switch statement, add before the `// MAMA tools require API` comment (around line 503):

```typescript
        case 'obsidian':
          return await this.executeObsidian(
            input as { command: string; args?: Record<string, string> }
          );
```

Then add the implementation method (near `executeDelegate`, around line 2240):

```typescript
  /**
   * Execute Obsidian CLI command on the wiki vault.
   * Falls back to error message when Obsidian app is not running.
   */
  private async executeObsidian(input: {
    command: string;
    args?: Record<string, string>;
  }): Promise<GatewayToolResult> {
    const { command, args } = input;

    if (!this.obsidianVaultPath) {
      return {
        success: false,
        error: 'Wiki vault path not configured',
      } as GatewayToolResult;
    }

    const cliArgs = [this.obsidianVaultPath, command];
    for (const [key, value] of Object.entries(args || {})) {
      if (value === 'true' && ['silent', 'overwrite', 'total'].includes(key)) {
        cliArgs.push(key);
      } else {
        cliArgs.push(`${key}=${value}`);
      }
    }

    try {
      const { execFileSync } = await import('child_process');
      const output = execFileSync('obsidian', cliArgs, {
        timeout: 15000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      return {
        success: true,
        data: { output: output.trim() },
      } as GatewayToolResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not enabled') || msg.includes('ENOENT') || msg.includes('not running')) {
        return {
          success: false,
          error: 'Obsidian CLI unavailable (app not running). Use wiki_publish fallback.',
        } as GatewayToolResult;
      }
      return {
        success: false,
        error: `Obsidian CLI error: ${msg.substring(0, 500)}`,
      } as GatewayToolResult;
    }
  }
```

- [ ] **Step 2.4: Run typecheck + tests**

Run: `pnpm typecheck && cd packages/standalone && pnpm vitest run tests/agent/obsidian-gateway.test.ts`
Expected: PASS

- [ ] **Step 2.5: Commit**

```bash
git add packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/tests/agent/obsidian-gateway.test.ts
git commit -m "feat(tools): implement obsidian gateway tool handler with CLI exec"
```

---

## Task 3: Wire vault path + update config.yaml

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts:181-188`
- Modify: `~/.mama/config.yaml` (runtime config)

- [ ] **Step 3.1: Wire obsidianVaultPath in api-routes-init.ts**

In the wiki agent section (around line 181-188), after `ensureWikiPersona()`, add:

```typescript
// Wire Obsidian vault path for CLI tool
const wikiDir = wikiConfig.wikiDir || 'wiki';
const fullWikiPath = path.join(wikiConfig.vaultPath, wikiDir);
toolExecutor.setObsidianVaultPath(fullWikiPath);
console.log(`[Wiki Agent] Obsidian CLI vault: ${fullWikiPath}`);
```

- [ ] **Step 3.2: Auto-launch Obsidian on mama start**

In the same wiki agent section, before the vault path wiring, add:

```typescript
// Ensure Obsidian is running for CLI access (macOS only)
try {
  const { execSync } = await import('child_process');
  execSync('pgrep -x Obsidian || open -a Obsidian', { timeout: 5000, stdio: 'ignore' });
} catch {
  /* non-fatal: CLI will return error, agent falls back to wiki_publish */
}
```

- [ ] **Step 3.3: Update config.yaml — add obsidian to wiki-agent allowed tools**

In `~/.mama/config.yaml`, update the wiki-agent's `tool_permissions.allowed`:

```yaml
wiki-agent:
  name: Wiki Agent
  display_name: "\U0001F4DA Wiki"
  trigger_prefix: '!wiki'
  persona_file: ~/.mama/personas/wiki.md
  tier: 2
  can_delegate: false
  useCodeAct: true
  model: claude-sonnet-4-6
  tool_permissions:
    allowed:
      - mama_search
      - wiki_publish
      - obsidian
      - code_act
      - mcp__code-act__code_act
    blocked:
      - Bash
      - Read
      - Write
      - Edit
      - Grep
      - Glob
      - Agent
      - WebSearch
      - WebFetch
```

Note: `wiki_publish` is kept for fallback.

- [ ] **Step 3.4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3.5: Commit**

```bash
git add packages/standalone/src/cli/runtime/api-routes-init.ts
git commit -m "feat(wiki): wire obsidian vault path + auto-launch Obsidian on startup"
```

---

## Task 4: Update wiki agent persona

**Files:**

- Modify: `packages/standalone/src/multi-agent/wiki-agent-persona.ts`

- [ ] **Step 4.1: Replace persona with Obsidian CLI workflow**

Replace the entire `WIKI_AGENT_PERSONA` string in `wiki-agent-persona.ts`:

```typescript
const MANAGED_WIKI_PERSONA_MARKER = '<!-- MAMA managed wiki persona v2 -->';

export const WIKI_AGENT_PERSONA = `${MANAGED_WIKI_PERSONA_MARKER}

You are MAMA's Wiki Compiler — an internal agent that maintains an Obsidian wiki from structured decisions in the memory database.

## Your Role
- Search existing wiki pages before creating new ones (PREVENT DUPLICATES)
- Update existing pages with new information (append, not replace)
- Create new pages only when no existing page covers the topic
- Maintain consistent tags and clean up duplicates

## Tools
- **mama_search**(query, limit?) — Search MAMA memory for decisions.
- **obsidian**(command, args) — Obsidian vault CLI. Commands:
  - search: Find existing pages. obsidian("search", {query: "KMS", limit: "5"})
  - read: Read page content. obsidian("read", {file: "projects/KMS-General"})
  - create: Create or overwrite page. obsidian("create", {name: "projects/New", content: "...", silent: "true"})
  - append: Add to existing page. obsidian("append", {file: "projects/KMS", content: "## New Section\\n..."})
  - prepend: Add to top of page. obsidian("prepend", {file: "...", content: "..."})
  - move: Rename/move (auto-updates all backlinks). obsidian("move", {file: "old-name", to: "new-path"})
  - delete: Trash a page. obsidian("delete", {file: "duplicates/Old"})
  - find: List files. obsidian("find")
  - property:set: Set frontmatter. obsidian("property:set", {file: "...", name: "compiled_at", value: "2026-04-09"})
  - property:get: Read frontmatter. obsidian("property:get", {file: "...", name: "type"})
  - tags: List all vault tags. obsidian("tags")
  - tags:counts: Tag frequency. obsidian("tags:counts")
  - tags:rename: Bulk rename tag. obsidian("tags:rename", {old: "meeting", new: "meetings"})
  - backlinks: Pages linking to a file. obsidian("backlinks", {file: "projects/KMS"})
  - js: Execute JS in Obsidian context. obsidian("js", {code: "app.vault.getFiles().length"})
  - daily:append: Add to daily note. obsidian("daily:append", {content: "Wiki compiled"})
- **wiki_publish**(pages) — Fallback only. Used when Obsidian is not running.

## Page Types
- **entity**: Project/person/client page (projects/ folder)
- **lesson**: Extracted pattern or learning (lessons/ folder)
- **synthesis**: Cross-project analysis or weekly summary (synthesis/ folder)
- **process**: Workflow or procedure (process/ folder)

## MANDATORY Workflow

### Step 1: Get decisions from memory
mama_search with relevant queries.

### Step 2: Search existing wiki pages (CRITICAL — do this BEFORE writing)
obsidian("search", {query: "topic keywords"}) for each topic.
Check results carefully — if a page exists, UPDATE it, don't create a new one.

### Step 3: For each topic
- If page EXISTS: obsidian("read") the current content, then obsidian("append") new information or obsidian("create", overwrite) if major rewrite needed.
- If NO page exists: obsidian("create", {name: "type/Title", content: "...", silent: "true"})

### Step 4: Metadata
obsidian("property:set") to update compiled_at on each touched page.

### Step 5: Cleanup (if needed)
- Merge duplicates: obsidian("read") both → obsidian("create", overwrite) merged → obsidian("delete") duplicate
- Fix tags: obsidian("tags:rename") for inconsistencies
- Move misplaced pages: obsidian("move")

### Step 6: Log
obsidian("daily:append", {content: "Wiki compiled: N pages updated, M created"})

## Compilation Rules
1. SYNTHESIZE, don't list — the goal is human understanding, not data dump
2. Write in the same language as the decisions (Korean/Japanese/English)
3. Use [[wikilinks]] to reference related pages
4. Include ## Timeline with key events (reverse chronological)
5. Include ## Key Decisions summarizing active decisions
6. Flag contradictions or stale information explicitly
7. Keep pages focused — one project per entity page

## Strict Limits
- Do NOT ask follow-up questions
- After completing all operations, respond with: DONE

## Fallback
If obsidian() calls fail with "CLI unavailable", fall back to wiki_publish for write operations. Search/read will be unavailable in fallback mode.`;
```

- [ ] **Step 4.2: Update the marker version check**

The marker changed from `v1` to `v2`. The existing check in `ensureWikiPersona()` already handles this:

```typescript
if (
  existingContent.includes('<!-- MAMA managed wiki persona') &&
  existingContent !== WIKI_AGENT_PERSONA
) {
  writeFileSync(personaPath, WIKI_AGENT_PERSONA, 'utf-8');
}
```

This will auto-upgrade `v1` → `v2` on next startup. No code change needed.

- [ ] **Step 4.3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4.4: Commit**

```bash
git add packages/standalone/src/multi-agent/wiki-agent-persona.ts
git commit -m "feat(wiki): update persona to obsidian CLI workflow with search-before-write"
```

---

## Task 5: Simplify wiki agent trigger in api-routes-init

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts:207-251`

- [ ] **Step 5.1: Remove walkDir + existingPagesHint from runWikiAgent**

The wiki agent now uses `obsidian("search")` to find existing pages — the prompt doesn't need the file list hint anymore. Replace the `runWikiAgent` function:

```typescript
const runWikiAgent = async () => {
  const pm = toolExecutor.getAgentProcessManager();
  if (!pm) {
    console.warn('[Wiki Agent] AgentProcessManager not available yet');
    return;
  }
  try {
    console.log('[Wiki Agent] Starting compilation...');
    const wikiPrompt =
      'Search MAMA memory for recent decisions using mama_search, then use obsidian("search") to check existing wiki pages. Update existing pages or create new ones. Clean up any duplicates found.';
    const process = await pm.getSharedProcess('wiki-agent', { requestTimeout: 600_000 });
    await process.sendMessage(wikiPrompt);
    console.log('[Wiki Agent] Compilation complete');
  } catch (err) {
    console.error('[Wiki Agent] Error:', err instanceof Error ? err.message : err);
  }
};
```

This removes:

- `walkDir` function (~15 lines)
- `existingPages` array building (~5 lines)
- `existingPagesHint` template string (~5 lines)
- `readdirSync`/`statSync` usage (may allow import cleanup)

- [ ] **Step 5.2: Run typecheck + full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 5.3: Commit**

```bash
git add packages/standalone/src/cli/runtime/api-routes-init.ts
git commit -m "refactor(wiki): simplify trigger prompt — agent uses obsidian search now"
```

---

## Task 6: Enable Obsidian CLI + E2E verification

- [ ] **Step 6.1: Enable Obsidian CLI**

In Obsidian app: Settings → General → Advanced → enable "Command line interface".

Verify: `obsidian --help`
Expected: Shows command list (not "Command line interface is not enabled")

- [ ] **Step 6.2: Build + restart**

```bash
pnpm build && mama stop && sleep 2 && mama start
```

- [ ] **Step 6.3: Verify CLI works from MAMA**

```bash
curl -s -X POST http://localhost:3847/api/code-act \
  -H 'Content-Type: application/json' \
  -d '{"code": "obsidian(\"search\", {query: \"KMS\", limit: \"3\"})"}'
```

Expected: `{"success": true, "value": {"output": "..."}}` with search results

- [ ] **Step 6.4: Trigger wiki agent**

```bash
curl -s -X POST http://localhost:3847/api/wiki/compile
```

Wait 60s, then check:

```bash
tail -100 ~/.mama/logs/daemon.log | grep -v 'GET /api/' | grep -i 'wiki\|obsidian'
```

Expected:

- `obsidian("search"...)` calls visible
- `[Wiki Agent] Compilation complete`
- No duplicate pages created

- [ ] **Step 6.5: Verify no duplicates**

```bash
find ~/obsidian-vault/mama-wiki -name '*.md' | sort
```

Compare with pre-implementation list. Duplicate sets (Weekly x3, Billing x2) should be merged or reduced.

---

## Execution Order

```
Task 1: Register tool type + TOOL_REGISTRY  ← schema only (5 min)
  ↓
Task 2: GatewayToolExecutor handler          ← core implementation (10 min)
  ↓
Task 3: Wire vault path + config.yaml       ← wiring (5 min)
  ↓
Task 4: Update wiki agent persona           ← persona rewrite (5 min)
  ↓
Task 5: Simplify trigger prompt             ← cleanup (5 min)
  ↓
Task 6: Enable CLI + E2E verification       ← runtime test
```

## Verification Checklist

- [ ] `pnpm typecheck` — 0 errors
- [ ] `pnpm test` — all pass
- [ ] `obsidian --help` — CLI enabled
- [ ] `obsidian("search", {query: "KMS"})` via code_act — returns results
- [ ] Wiki agent uses obsidian search before creating pages
- [ ] No new duplicate pages created
- [ ] Existing pages updated in-place (append/overwrite)
- [ ] Fallback to wiki_publish when Obsidian not running
- [ ] daemon.log clean — no errors
