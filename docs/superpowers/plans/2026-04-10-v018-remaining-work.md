# v0.18 Remaining Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete v0.18 agent swarm + output layer — fix mama_save null ref, add conductor skill injection, remove playground system, unify SQLite driver.

**Architecture:** Sequential 4-task execution. Each task is independently verifiable and committed atomically. Tasks 1-2 are surgical fixes. Task 3 is a larger removal+migration. Task 4 is a driver swap.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Express, Viewer (vanilla TS modules)

---

### Task 1: Fix mama_save Null Ref

**Files:**

- Modify: `packages/standalone/src/cli/runtime/agent-loop-init.ts:103`

- [ ] **Step 1: Read the current AgentLoop constructor call**

Confirm line 103 passes only 2 args (oauthManager, options) with no executorOptions:

```ts
// Current (broken):
const agentLoop = new AgentLoop(oauthManager, {
  backend: runtimeBackend,
  // ... options
});
```

AgentLoop constructor signature (agent-loop.ts:298):

```ts
constructor(
  _oauthManager: OAuthManager,
  options: AgentLoopOptions = {},
  _clientOptions?: ClaudeClientOptions,
  executorOptions?: GatewayToolExecutorOptions
)
```

- [ ] **Step 2: Add executorOptions as 4th argument**

In `packages/standalone/src/cli/runtime/agent-loop-init.ts`, change the AgentLoop constructor call. The closing of the options object (2nd arg) ends with a large block. Find the closing `});` of the constructor and change it to pass `undefined` for 3rd arg and executorOptions for 4th:

Replace the closing of the constructor call. Find the line that has the closing `});` after the `onTurn` callback block ends (it will be after the `onTurn: (turn) => { ... }` block). Change:

```ts
  });
```

to:

```ts
  }, undefined, {
    mamaDbPath: config.database.path.replace(/^~/, homedir()),
  });
```

`config.database.path` is `string` from `MAMAConfig.database.path`. The `~` replacement uses `homedir()` already imported at line 18.

- [ ] **Step 3: Verify fix**

Run: `pnpm build`
Expected: No type errors.

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Runtime verification**

```bash
mama stop && mama start
# Wait for startup, then check daemon.log for mama_save errors:
grep -i "mama_save\|mamaDbPath\|initializeMAMA" ~/.mama/logs/daemon.log | tail -20
```

Expected: No null ref errors. mamaDbPath should show the resolved path.

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/cli/runtime/agent-loop-init.ts
git commit -m "fix(agent): pass executorOptions to AgentLoop — fixes mama_save null ref"
```

---

### Task 2: Conductor Skill Injection

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts:2156-2263`
- Modify: `packages/standalone/src/agent/gateway-tools.md:79-81`
- Modify: `packages/standalone/src/agent/types.ts:692`

- [ ] **Step 1: Add skill field to delegate type**

In `packages/standalone/src/agent/types.ts`, the `executeDelegate` method uses an inline type. We need to also update the GatewayToolName union — no change needed there since `delegate` already exists. But we need to check if there's a named DelegateInput type.

Search for `DelegateInput` in types.ts. If it doesn't exist, the inline type in executeDelegate is the only place. The inline type at line 2156 is:

```ts
private async executeDelegate(input: {
  agentId: string;
  task: string;
  background?: boolean;
}): Promise<GatewayToolResult> {
```

Add `skill?: string` to this inline type:

```ts
private async executeDelegate(input: {
  agentId: string;
  task: string;
  background?: boolean;
  skill?: string;
}): Promise<GatewayToolResult> {
```

- [ ] **Step 2: Add skill injection logic in executeDelegate**

In `packages/standalone/src/agent/gateway-tool-executor.ts`, after line 2216 (where `delegationPrompt` is first assigned), add skill injection:

```ts
let delegationPrompt = this.delegationManagerRef.buildDelegationPrompt(sourceAgentId, task);

// Inject skill content if specified
if (input.skill) {
  const skillPath = join(homedir(), '.mama', 'skills', `${input.skill}.md`);
  if (existsSync(skillPath)) {
    const skillContent = readFileSync(skillPath, 'utf-8');
    delegationPrompt = skillContent + '\n\n---\n\n' + delegationPrompt;
  }
}
```

Also add the same injection in the background delegation path (after line 2188):

```ts
const delegationPrompt = this.delegationManagerRef!.buildDelegationPrompt(sourceAgentId, task);
// Inject skill content if specified
let finalPrompt = delegationPrompt;
if (input.skill) {
  const skillPath = join(homedir(), '.mama', 'skills', `${input.skill}.md`);
  if (existsSync(skillPath)) {
    const skillContent = readFileSync(skillPath, 'utf-8');
    finalPrompt = skillContent + '\n\n---\n\n' + delegationPrompt;
  }
}
await process.sendMessage(finalPrompt);
```

- [ ] **Step 3: Update gateway-tools.md**

In `packages/standalone/src/agent/gateway-tools.md`, update the delegate documentation (line 81):

Replace:

```markdown
- **delegate**(agentId, task, background?) — Delegate a task to another agent. The target agent has its own persona, tools, and persistent session. Use this to assign specialized work (coding, review, research) to the right agent. Returns the agent's response.
```

With:

```markdown
- **delegate**(agentId, task, background?, skill?) — Delegate a task to another agent. The target agent has its own persona, tools, and persistent session. Use this to assign specialized work (coding, review, research) to the right agent. Optional `skill` loads `~/.mama/skills/{skill}.md` and prepends it to the delegation prompt. Returns the agent's response.
```

- [ ] **Step 4: Verify**

Run: `pnpm build`
Expected: No type errors.

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/src/agent/gateway-tools.md
git commit -m "feat(delegate): add skill injection — conductor can pass workflow skills to sub-agents"
```

---

### Task 3: Playground Removal + Log Viewer Migration

This is the largest task. Two phases: 3a creates a native logs module, 3b removes all playground code.

**Files:**

- Create: `packages/standalone/public/viewer/src/modules/logs.ts`
- Modify: `packages/standalone/public/viewer/viewer.html`
- Modify: `packages/standalone/public/viewer/src/modules/chat.ts`
- Modify: `packages/standalone/public/viewer/src/modules/skills.ts`
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Modify: `packages/standalone/src/agent/gateway-tools.md`
- Modify: `packages/standalone/src/agent/types.ts`
- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts`
- Modify: `packages/standalone/src/api/index.ts`
- Delete: `packages/standalone/public/viewer/src/modules/playground.ts`
- Delete: `packages/standalone/templates/playgrounds/` (all 4 HTML files)

#### Phase 3a: Create Native Logs Module

- [ ] **Step 1: Create logs.ts module**

Create `packages/standalone/public/viewer/src/modules/logs.ts`. This replaces the iframe-based `mama-log-viewer.html`. Core functionality: poll `/api/logs/daemon`, filter by level/source, search, auto-scroll.

```ts
/**
 * Logs Module — native log viewer replacing playground iframe.
 * Polls /api/logs/daemon with incremental fetching (since/tail).
 */

const POLL_INTERVAL = 2000;
const DEFAULT_TAIL = 500;

interface LogLine {
  raw: string;
  timestamp: string;
  source: string;
  level: string;
  message: string;
}

export class LogsModule {
  private lines: LogLine[] = [];
  private filteredLines: LogLine[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastModified = '';
  private paused = false;
  private searchQuery = '';
  private levelFilter: Set<string> = new Set(['ERROR', 'WARN', 'INFO', 'DEBUG']);
  private autoScroll = true;

  init(): void {
    this.bindEvents();
    this.startPolling();
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private bindEvents(): void {
    const searchInput = document.getElementById('logs-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.searchQuery = searchInput.value.toLowerCase();
        this.applyFilters();
      });
    }

    const pauseBtn = document.getElementById('logs-pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        this.paused = !this.paused;
        pauseBtn.textContent = this.paused ? 'Resume' : 'Pause';
      });
    }

    document.querySelectorAll<HTMLElement>('[data-log-level]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const level = btn.dataset.logLevel!;
        if (this.levelFilter.has(level)) {
          this.levelFilter.delete(level);
          btn.classList.remove('active');
        } else {
          this.levelFilter.add(level);
          btn.classList.add('active');
        }
        this.applyFilters();
      });
    });

    const container = document.getElementById('logs-container');
    if (container) {
      container.addEventListener('scroll', () => {
        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
        this.autoScroll = atBottom;
      });
    }
  }

  private async startPolling(): Promise<void> {
    await this.fetchLogs();
    this.pollTimer = setInterval(() => {
      if (!this.paused) this.fetchLogs();
    }, POLL_INTERVAL);
  }

  private async fetchLogs(): Promise<void> {
    try {
      const params = new URLSearchParams({ tail: String(DEFAULT_TAIL) });
      if (this.lastModified) params.set('since', this.lastModified);

      const res = await fetch(`/api/logs/daemon?${params}`);
      if (res.status === 304) return;
      if (!res.ok) return;

      this.lastModified = res.headers.get('x-last-modified') || '';
      const text = await res.text();
      const newLines = text
        .split('\n')
        .filter(Boolean)
        .map((raw) => this.parseLine(raw));

      if (this.lastModified) {
        // Incremental: append new lines
        this.lines.push(...newLines);
        // Cap at 5000 lines
        if (this.lines.length > 5000) {
          this.lines = this.lines.slice(-5000);
        }
      } else {
        this.lines = newLines;
      }

      this.applyFilters();
    } catch {
      // Polling errors are silent
    }
  }

  private parseLine(raw: string): LogLine {
    // Format: [2026-04-10T12:00:00.000Z] [SOURCE] LEVEL message
    const match = raw.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(ERROR|WARN|INFO|DEBUG)\s*(.*)/);
    if (match) {
      return { raw, timestamp: match[1], source: match[2], level: match[3], message: match[4] };
    }
    return { raw, timestamp: '', source: '', level: 'INFO', message: raw };
  }

  private applyFilters(): void {
    this.filteredLines = this.lines.filter((line) => {
      if (!this.levelFilter.has(line.level)) return false;
      if (this.searchQuery && !line.raw.toLowerCase().includes(this.searchQuery)) return false;
      return true;
    });
    this.render();
  }

  private render(): void {
    const container = document.getElementById('logs-container');
    if (!container) return;

    const countEl = document.getElementById('logs-count');
    if (countEl) countEl.textContent = `${this.filteredLines.length} lines`;

    const fragment = document.createDocumentFragment();
    for (const line of this.filteredLines) {
      const div = document.createElement('div');
      div.className = `logs-line logs-level-${line.level.toLowerCase()}`;
      div.innerHTML = `<span class="logs-ts">${this.escapeHtml(line.timestamp)}</span> <span class="logs-src">${this.escapeHtml(line.source)}</span> <span class="logs-lvl">${line.level}</span> <span class="logs-msg">${this.escapeHtml(line.message)}</span>`;
      fragment.appendChild(div);
    }

    container.innerHTML = '';
    container.appendChild(fragment);

    if (this.autoScroll) {
      container.scrollTop = container.scrollHeight;
    }
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
```

- [ ] **Step 2: Replace logs tab HTML in viewer.html**

In `packages/standalone/public/viewer/viewer.html`, replace the logs tab content (lines 413-416):

Replace:

```html
<!-- Logs Tab -->
<div class="tab-content" id="tab-logs">
  <iframe
    id="logs-iframe"
    style="width:100%;height:100%;border:none;border-radius:8px;"
    loading="lazy"
  ></iframe>
</div>
```

With:

```html
<!-- Logs Tab -->
<div class="tab-content" id="tab-logs">
  <div class="flex-1 flex flex-col w-full h-full overflow-hidden p-2 md:p-3">
    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-2">
        <h1 class="text-sm font-bold text-gray-900">Daemon Logs</h1>
        <span id="logs-count" class="text-[10px] text-gray-400">0 lines</span>
      </div>
      <div class="flex items-center gap-1">
        <button
          id="logs-pause-btn"
          class="px-2 py-1 text-[10px] rounded bg-gray-100 hover:bg-gray-200 text-gray-700"
        >
          Pause
        </button>
      </div>
    </div>
    <div class="flex items-center gap-1 mb-2">
      <input
        id="logs-search"
        type="text"
        placeholder="Search logs..."
        class="flex-1 px-2 py-1 text-[10px] border border-gray-200 rounded bg-white focus:outline-none focus:border-indigo-300"
      />
      <button
        data-log-level="ERROR"
        class="active px-1.5 py-0.5 text-[9px] rounded bg-red-100 text-red-700 font-medium"
      >
        ERR
      </button>
      <button
        data-log-level="WARN"
        class="active px-1.5 py-0.5 text-[9px] rounded bg-yellow-100 text-yellow-700 font-medium"
      >
        WARN
      </button>
      <button
        data-log-level="INFO"
        class="active px-1.5 py-0.5 text-[9px] rounded bg-blue-100 text-blue-700 font-medium"
      >
        INFO
      </button>
      <button
        data-log-level="DEBUG"
        class="active px-1.5 py-0.5 text-[9px] rounded bg-gray-100 text-gray-600 font-medium"
      >
        DBG
      </button>
    </div>
    <div
      id="logs-container"
      class="flex-1 overflow-y-auto font-mono text-[10px] bg-gray-50 rounded border border-gray-200 p-1 leading-relaxed"
    ></div>
  </div>
</div>
```

- [ ] **Step 3: Wire LogsModule into viewer.html**

In the script section of `viewer.html`:

a) Add import (after line 1131, the ConnectorFeedModule import):

```js
import { LogsModule } from '/viewer/js/modules/logs.js';
```

b) Instantiate (after line 1143):

```js
const logs = new LogsModule();
```

c) Update switchTab for logs (replace lines 1225-1230):

Replace:

```js
        } else if (tabName === 'logs') {
          const iframe = document.getElementById('logs-iframe');
          if (iframe && !iframe.src) {
            iframe.src = '/playgrounds/mama-log-viewer.html';
          }
        }
```

With:

```js
        } else if (tabName === 'logs') {
          logs.init();
        }
```

- [ ] **Step 4: Add logs CSS to viewer.html**

Add in the `<style>` section of viewer.html:

```css
.logs-line {
  padding: 1px 4px;
  border-bottom: 1px solid #f0f0f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.logs-level-error {
  background: #fef2f2;
}
.logs-level-warn {
  background: #fffbeb;
}
.logs-ts {
  color: #9ca3af;
  margin-right: 4px;
}
.logs-src {
  color: #6366f1;
  margin-right: 4px;
}
.logs-lvl {
  font-weight: 600;
  margin-right: 4px;
}
.logs-level-error .logs-lvl {
  color: #dc2626;
}
.logs-level-warn .logs-lvl {
  color: #d97706;
}
.logs-level-info .logs-lvl {
  color: #2563eb;
}
.logs-level-debug .logs-lvl {
  color: #6b7280;
}
[data-log-level].active {
  opacity: 1;
}
[data-log-level]:not(.active) {
  opacity: 0.4;
}
```

- [ ] **Step 5: Build and verify logs module**

Run: `pnpm build`
Expected: No type errors, `logs.js` generated in `public/viewer/js/modules/`.

- [ ] **Step 6: Commit Phase 3a**

```bash
git add packages/standalone/public/viewer/src/modules/logs.ts packages/standalone/public/viewer/viewer.html
git commit -m "feat(viewer): native logs module replacing playground iframe"
```

#### Phase 3b: Remove Playground Infrastructure

- [ ] **Step 7: Remove playground tab HTML from viewer.html**

In `packages/standalone/public/viewer/viewer.html`, delete the entire playground tab div (lines 789-810):

```html
<!-- Playground Tab -->
<div class="tab-content" id="tab-playground">... entire block ...</div>
```

Also remove the playground nav buttons — search for `data-tab="playground"` and remove those `<button>` elements if they exist. (Note: current nav doesn't show a playground button — it was replaced by logs. Verify by searching.)

Remove the playground import (line 1130):

```js
import { PlaygroundModule } from '/viewer/js/modules/playground.js';
```

Remove the playground instantiation (line 1141):

```js
const playground = PlaygroundModule;
```

Remove the playground switchTab case (line 1223-1224):

```js
        } else if (tabName === 'playground') {
          playground.init();
```

- [ ] **Step 8: Remove playground code from chat.ts**

In `packages/standalone/public/viewer/src/modules/chat.ts`:

a) Remove the property (line 162):

```ts
playgroundAwaitingResponse = false;
```

b) Remove the relay call (line 1022):

```ts
this.relayToPlayground(this.currentStreamText);
```

c) Remove the entire `relayToPlayground` method (lines 1041-1068):

```ts
relayToPlayground(content: string): void {
  ...entire method...
}
```

- [ ] **Step 9: Remove playground code from skills.ts**

In `packages/standalone/public/viewer/src/modules/skills.ts`:

a) Remove PlaygroundModule import (line 16):

```ts
import { PlaygroundModule } from './playground.js';
```

b) In `editInSkillLab` method (lines 455-472), remove the `switchTab('playground')` call and `PlaygroundModule.openSkillLab()` call. Replace the method body with a simple alert or no-op:

```ts
  async editInSkillLab(source: string, id: string): Promise<void> {
    // Playground removed — skill editing now via CLI only
    alert('Skill editing is available via CLI: mama skill edit <id>');
  },
```

c) In `openNewSkillLab` method (lines 478-485), same treatment:

```ts
  openNewSkillLab(): void {
    alert('Create new skills via CLI: mama skill create');
  },
```

- [ ] **Step 10: Remove playground API routes from api-routes-init.ts**

In `packages/standalone/src/cli/runtime/api-routes-init.ts`:

Delete the playground seeding block (lines 999-1076) — directory setup, template copying, index repair.

Delete the static serving route (line 1121):

```ts
apiServer.app.use('/playgrounds', express.static(playgroundsDir));
```

Delete GET `/api/playgrounds` endpoint (lines 1123-1154).

Delete DELETE `/api/playgrounds/:slug` endpoint (lines 1156-1181).

Delete the console.log confirmation (line 1182):

```ts
console.log('✓ Playground API available at /api/playgrounds');
```

Keep the daemon log API (`/api/logs/daemon`) which is between lines 1079-1118 — this is used by the new logs module.

- [ ] **Step 11: Remove playground_create from tool system**

In `packages/standalone/src/agent/tool-registry.ts`, remove lines 250-256:

```ts
// Playground
register({
  name: 'playground_create',
  ...
});
```

In `packages/standalone/src/agent/gateway-tool-executor.ts`, remove the case (lines 501-505):

```ts
case 'playground_create':
  return await this.executePlaygroundCreate(
    input as { name: string; html: string; description?: string }
  );
```

Also find and remove the `executePlaygroundCreate` method definition (search for `private.*executePlaygroundCreate`).

In `packages/standalone/src/agent/code-act/host-bridge.ts`, remove the playground tool definition (lines 356-373).

In `packages/standalone/src/agent/types.ts`, remove `'playground_create'` from GatewayToolName union (line 692).

In `packages/standalone/src/agent/gateway-tools.md`, remove the Playground section (lines 67-69):

```markdown
## Playground

- **playground_create**(name, html?, file_path?, description?) — ...
```

- [ ] **Step 12: Simplify X-Frame-Options in api/index.ts**

In `packages/standalone/src/api/index.ts` (lines 130-140), simplify the middleware:

Replace:

```ts
app.use((req, res, next) => {
  if (!req.path.startsWith('/playgrounds/')) {
    res.setHeader('X-Frame-Options', 'DENY');
  } else {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
```

With:

```ts
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
```

- [ ] **Step 13: Delete playground files**

```bash
rm packages/standalone/public/viewer/src/modules/playground.ts
rm -rf packages/standalone/templates/playgrounds/
```

- [ ] **Step 14: Verify no playground references remain**

```bash
grep -r "playground" packages/standalone/src/ packages/standalone/public/viewer/src/ --include="*.ts" -l
```

Expected: No results (or only test files / comments).

- [ ] **Step 15: Build and test**

Run: `pnpm build`
Expected: No type errors, no missing imports.

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 16: Commit Phase 3b**

```bash
git add -A
git commit -m "refactor: remove playground system — logs module is now native viewer tab"
```

---

### Task 4: DB node:sqlite to better-sqlite3 Unification

**Files:**

- Modify: `packages/standalone/package.json`
- Modify: `packages/standalone/src/sqlite.ts`

- [ ] **Step 1: Add better-sqlite3 dependency**

In `packages/standalone/package.json`, add to dependencies:

```json
"better-sqlite3": "^12.8.0"
```

And to devDependencies:

```json
"@types/better-sqlite3": "^7.6.13"
```

(Match versions from `packages/mama-core/package.json`.)

Run: `pnpm install`

- [ ] **Step 2: Rewrite sqlite.ts wrapper**

Replace the entire contents of `packages/standalone/src/sqlite.ts`. The new wrapper uses better-sqlite3 directly. The API surface stays identical — 25 consumers need zero changes.

```ts
/**
 * SQLite wrapper for standalone using better-sqlite3.
 * API-compatible with the previous node:sqlite wrapper.
 */

import BetterSqlite3 from 'better-sqlite3';

export interface SQLiteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SQLiteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => SQLiteRunResult;
}

export type SQLiteDatabase = Database;

export default class Database {
  private db: BetterSqlite3.Database;
  readonly driver: 'better-sqlite3' = 'better-sqlite3';

  constructor(path: string) {
    this.db = new BetterSqlite3(path);
  }

  prepare(sql: string): SQLiteStatement {
    const stmt = this.db.prepare(sql);
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      run: (...params: unknown[]) => {
        const result = stmt.run(...params);
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      },
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    return this.db.pragma(sql, options);
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return this.db.transaction(fn) as T;
  }

  close(): void {
    this.db.close();
  }

  get open(): boolean {
    return this.db.open;
  }
}
```

- [ ] **Step 3: Build and test**

Run: `pnpm build`
Expected: No type errors.

Run: `pnpm test`
Expected: All 2512+ tests pass. The wrapper API is identical, so no consumer changes needed.

- [ ] **Step 4: Runtime verification**

```bash
mama stop && mama start
curl http://localhost:3847/health
```

Expected: Health check passes, DB operations work normally.

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/package.json packages/standalone/src/sqlite.ts pnpm-lock.yaml
git commit -m "refactor(db): migrate standalone from node:sqlite to better-sqlite3"
```

---

### Task 5: Final Verification

- [ ] **Step 1: Full test suite**

```bash
pnpm test
```

Expected: All tests pass.

- [ ] **Step 2: Runtime end-to-end**

```bash
mama stop && mama start
# Check health
curl http://localhost:3847/health
# Check daemon.log for errors
tail -50 ~/.mama/logs/daemon.log
# Verify viewer loads (open in browser)
# Verify Logs tab shows daemon log lines
# Verify no playground tab exists
```

- [ ] **Step 3: Grep for residual issues**

```bash
# No playground references in source
grep -r "playground" packages/standalone/src/ --include="*.ts" -l
# No node:sqlite references (except docs/comments)
grep -r "node:sqlite" packages/standalone/src/ --include="*.ts" -l
```

Expected: No results.
