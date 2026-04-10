# Wiki Agent — Obsidian CLI Integration Design

## Problem

Wiki Agent generates duplicate pages because it can't see existing vault content before writing. Current `ObsidianWriter` does direct file I/O with weak dedup (slug + 60% title overlap). As pages grow, this gets worse.

Examples from current vault (29 pages):

- `Weekly-2026-04-09.md` / `2026-W15-Weekly-Summary.md` / `Weekly-2026-04-09.md` — same weekly summary x3
- `April-2026-Billing.md` / `Billing-Overview-2026-04.md` — same billing summary x2
- `Internal.md` / `Internal-Meetings.md` — overlapping content

## Solution

Replace `wiki_publish` gateway tool with `obsidian(command, args)` gateway function in the code_act sandbox. The wiki agent calls Obsidian CLI commands to **search before write**, eliminating duplicates at the source.

## Architecture

```
Wiki Agent (code_act sandbox)
  → obsidian("search", {query: "KMS"})
  → obsidian("read", {file: "projects/KMS-General"})
  → obsidian("create", {name: "...", content: "...", silent: true})
  ↓
HostBridge.obsidian(command, args)
  → execFile("obsidian", [vault, command, ...args])
  → parse stdout → return to sandbox
  ↓
Obsidian App (running in background)
  → search index, backlinks, frontmatter, templates
```

## Gateway Function

Single function registered in HostBridge TOOL_REGISTRY:

```typescript
{
  name: 'obsidian',
  description: 'Execute Obsidian CLI command on the wiki vault.',
  params: [
    { name: 'command', type: 'string', required: true,
      description: 'CLI command: search, read, create, append, prepend, move, delete, find, property:set, property:get, property:list, tags, tags:counts, tags:rename, backlinks, js, daily, daily:append, daily:create' },
    { name: 'args', type: 'Record<string, string>', required: false,
      description: 'Named arguments. Keys: query, limit, file, path, name, content, template, to, old, new, tag, code, silent, overwrite, total' },
  ],
  returnType: '{ output: string; success: boolean }',
  category: 'os',
}
```

Implementation in GatewayToolExecutor:

```typescript
case 'obsidian': {
  const { command, args } = input as { command: string; args?: Record<string, string> };
  const vault = config.wiki?.vaultPath;  // from config.yaml
  const cliArgs = [vault, command];
  for (const [key, value] of Object.entries(args || {})) {
    if (value === 'true') cliArgs.push(key);       // boolean flag: silent, overwrite, total
    else cliArgs.push(`${key}=${value}`);           // named arg: query="...", file="..."
  }
  const result = execFileSync('obsidian', cliArgs, { timeout: 15000, encoding: 'utf-8' });
  return { success: true, output: result };
}
```

## Fallback

When Obsidian app is not running, CLI fails with error. Fallback to current `ObsidianWriter`:

```typescript
try {
  return execObsidianCLI(command, args);
} catch (err) {
  if (err.message.includes('not enabled') || err.message.includes('not running')) {
    // Fallback: use ObsidianWriter for write operations
    if (command === 'create') return fallbackWrite(args);
    return { success: false, error: 'Obsidian not running. Read/search unavailable.' };
  }
  throw err;
}
```

## Auto-launch

In `mama start`, before wiki agent initialization:

```typescript
// Ensure Obsidian is running for CLI access
if (wikiConfig?.enabled) {
  try {
    execSync('pgrep -x Obsidian || open -a Obsidian', { timeout: 5000 });
  } catch {
    /* non-fatal */
  }
}
```

## Wiki Agent Persona Changes

Replace `wiki_publish` workflow with Obsidian CLI workflow:

```markdown
## Tools

- **mama_search**(query, limit?) — Search MAMA memory for decisions.
- **obsidian**(command, args) — Obsidian vault CLI. Commands:
  - search: Find existing pages. `obsidian("search", {query: "KMS", limit: "5"})`
  - read: Read page content. `obsidian("read", {file: "projects/KMS-General"})`
  - create: Create/overwrite page. `obsidian("create", {name: "projects/New", content: "...", silent: "true"})`
  - append: Add to existing page. `obsidian("append", {file: "projects/KMS-General", content: "## New Section\n..."})`
  - prepend: Add to top of page. Same as append but at beginning.
  - move: Rename/move page (auto-updates backlinks). `obsidian("move", {file: "old-name", to: "new-path"})`
  - delete: Trash a page. `obsidian("delete", {file: "duplicates/Old-Page"})`
  - find: List files/folders.
  - property:set: Set frontmatter field. `obsidian("property:set", {file: "...", name: "compiled_at", value: "2026-04-09"})`
  - property:get: Read frontmatter field.
  - property:list: List all properties of a file.
  - tags: List all vault tags. `obsidian("tags")`
  - tags:counts: Tag frequency. `obsidian("tags:counts")`
  - tags:rename: Bulk rename tag across vault. `obsidian("tags:rename", {old: "meeting", new: "meetings"})`
  - backlinks: Show pages linking to a file. `obsidian("backlinks", {file: "projects/KMS-General"})`
  - js: Execute JS in Obsidian context. `obsidian("js", {code: "app.vault.getFiles().length"})`
  - daily:append: Add to daily note. `obsidian("daily:append", {content: "Wiki compiled: 6 pages"})`

## Workflow

1. mama_search → get recent decisions from memory
2. obsidian("search") → find existing pages on same topics
3. For each topic:
   a. If page exists: obsidian("read") → check content → obsidian("append") or obsidian("create", overwrite)
   b. If no page: obsidian("create") with full content
4. obsidian("property:set") → update compiled_at timestamps
5. Clean up: obsidian("move") duplicates, obsidian("delete") if needed
6. obsidian("tags:rename") if inconsistent tags found
```

## What Changes

| Component        | Before                                                       | After                                                                |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Wiki Agent tools | `mama_search` + `wiki_publish`                               | `mama_search` + `obsidian`                                           |
| Tool execution   | code_act → HostBridge → GatewayToolExecutor → ObsidianWriter | code_act → HostBridge → GatewayToolExecutor → `execFile("obsidian")` |
| Dedup            | ObsidianWriter.findExistingPage() (slug match)               | Agent searches before writing (semantic)                             |
| Index management | ObsidianWriter.updateIndex()                                 | Agent manages via obsidian create/append                             |
| Persona          | wiki_publish workflow                                        | obsidian CLI workflow                                                |
| config.yaml      | `wiki_publish` in allowed tools                              | `obsidian` in allowed tools                                          |

## What Stays

- `ObsidianWriter` class — kept as fallback
- `wiki_publish` in GatewayToolExecutor — kept as fallback path
- Dashboard Agent — unchanged
- code_act MCP path — unchanged
- `mama start` Obsidian auto-launch — new

## What Gets Removed (eventually)

- `wiki_publish` from wiki agent's allowed tools (replaced by `obsidian`)
- `wikiAgentLoop.setWikiPublisher()` wiring (fallback only)
- `walkDir` existing pages hint in prompt (agent does its own search now)

## Risk

- **Obsidian CLI is new (Feb 2026)** — API may change. Mitigation: fallback to ObsidianWriter.
- **CLI output format undocumented** — may need parsing heuristics. Mitigation: return raw output, let LLM interpret.
- **Obsidian app must run** — auto-launch + fallback covers this.

## Success Criteria

1. Zero duplicate pages on wiki compilation run
2. Existing pages updated in-place (append/overwrite) instead of creating new files
3. Backlinks maintained when pages are moved
4. Tags consistent across vault
5. Works when Obsidian is running (primary) and falls back gracefully when not
