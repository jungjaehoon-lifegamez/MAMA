# v0.18 System Agent Unification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard Agent와 Wiki Agent를 별도 AgentLoop에서 AgentProcessManager(multi-agent config)로 통합하여 `delegate(dashboard-agent, task)` 호출이 작동하도록 한다.

**Architecture:** 두 에이전트를 `config.yaml` multi_agent.agents에 추가하고, `api-routes-init.ts`의 별도 AgentLoop 생성 코드를 삭제하며, cron/이벤트 트리거를 `AgentProcessManager.getSharedProcess()` 경로로 전환한다. code-act MCP를 mama-mcp-config에 병합하여 CLI 프로세스에서 `code_act` 도구를 사용할 수 있게 한다.

**Tech Stack:** TypeScript, AgentProcessManager, GatewayToolExecutor, config.yaml

---

## Root Cause

```
시스템 A (AgentProcessManager — multi-agent config):
  conductor, developer, reviewer, architect, pm
  → delegate 도구가 검색하는 곳

시스템 B (별도 AgentLoop — api-routes-init.ts):
  dashboard-agent (line 145-173)
  wiki-agent (line 270-299)
  → delegate 접근 불가
```

delegate(dashboard-agent, task) → DelegationManager.isDelegationAllowed() → agents Map에 없음 → 'Unknown target agent' 에러

## File Structure

```
Files to MODIFY:
  ~/.mama/config.yaml                                          ← dashboard-agent, wiki-agent 추가
  packages/standalone/src/cli/runtime/api-routes-init.ts       ← 별도 AgentLoop 삭제, cron을 PM 경로로 전환
  packages/standalone/src/agent/gateway-tool-executor.ts       ← getAgentProcessManager() getter 추가

Files to VERIFY (no changes expected):
  packages/standalone/src/multi-agent/agent-process-manager.ts ← 이미 getSharedProcess() 존재
  packages/standalone/src/multi-agent/delegation-manager.ts    ← config에 에이전트 추가되면 자동 인식
  packages/standalone/src/multi-agent/dashboard-agent-persona.ts ← persona 생성 유지
  packages/standalone/src/multi-agent/wiki-agent-persona.ts    ← persona 생성 유지
  packages/standalone/src/mcp/code-act-server.ts               ← 변경 없음 (HTTP proxy)

Files to CREATE:
  packages/standalone/tests/multi-agent/system-agent-unification.test.ts
```

---

## Task 1: code-act MCP를 mama-mcp-config에 병합

**Why:** AgentProcessManager가 생성하는 CLI 프로세스는 `mama-mcp-config.json`을 MCP config으로 사용. 현재 이 파일에 `code-act` 엔트리가 없어서, CLI 프로세스가 `code_act` MCP tool을 사용할 수 없음.

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts:125-143`

- [ ] **Step 1.1: Write test — code-act MCP entry merging**

```typescript
// packages/standalone/tests/multi-agent/system-agent-unification.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('system agent unification', () => {
  describe('code-act MCP merging', () => {
    it('adds code-act entry to mama-mcp-config.json', () => {
      // Given an existing mama-mcp-config with external MCPs
      const existing = {
        mcpServers: {
          pubmed: { type: 'http', url: 'https://example.com/mcp' },
        },
      };

      // When we merge the code-act entry
      const codeActEntry = {
        'code-act': {
          command: 'node',
          args: ['/path/to/code-act-server.js'],
          env: { MAMA_SERVER_PORT: '3847' },
        },
      };
      const merged = {
        mcpServers: { ...existing.mcpServers, ...codeActEntry },
      };

      // Then the merged config has both entries
      expect(merged.mcpServers['code-act']).toBeDefined();
      expect(merged.mcpServers['code-act'].command).toBe('node');
      expect(merged.mcpServers.pubmed).toBeDefined();
    });

    it('does not duplicate code-act if already present', () => {
      const existing = {
        mcpServers: {
          'code-act': { command: 'node', args: ['/old/path.js'] },
        },
      };
      const codeActEntry = {
        'code-act': { command: 'node', args: ['/new/path.js'] },
      };
      const merged = {
        mcpServers: { ...existing.mcpServers, ...codeActEntry },
      };
      // Overwrites with correct path, no duplicate
      expect(merged.mcpServers['code-act'].args[0]).toBe('/new/path.js');
      expect(Object.keys(merged.mcpServers).filter((k) => k === 'code-act')).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 1.2: Run test to verify it passes**

Run: `cd packages/standalone && pnpm vitest run tests/multi-agent/system-agent-unification.test.ts`
Expected: PASS

- [ ] **Step 1.3: Modify api-routes-init.ts — merge code-act into mama-mcp-config**

In `api-routes-init.ts`, replace the separate `code-act-mcp-config.json` generation (lines 125-143) with a merge into `mama-mcp-config.json`:

```typescript
// Merge code-act MCP server into mama-mcp-config.json
// This makes code_act available to ALL CLI processes (including AgentProcessManager agents)
const mamaMcpConfig = path.join(homedir(), '.mama', 'mama-mcp-config.json');
const codeActServerPath = path.join(__dirname, '../../mcp/code-act-server.js');
try {
  const existing = existsSync(mamaMcpConfig)
    ? JSON.parse(readFileSync(mamaMcpConfig, 'utf-8'))
    : { mcpServers: {} };
  existing.mcpServers['code-act'] = {
    command: 'node',
    args: [codeActServerPath],
    env: { MAMA_SERVER_PORT: String(EMBEDDING_PORT) },
  };
  writeFileSync(mamaMcpConfig, JSON.stringify(existing, null, 2), 'utf-8');
} catch (err) {
  console.warn('[api-routes-init] Failed to merge code-act into MCP config:', err);
}
```

- [ ] **Step 1.4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 1.5: Commit**

```bash
git add packages/standalone/src/cli/runtime/api-routes-init.ts packages/standalone/tests/multi-agent/system-agent-unification.test.ts
git commit -m "feat(mcp): merge code-act into mama-mcp-config for all CLI processes"
```

---

## Task 2: config.yaml에 dashboard-agent, wiki-agent 추가

**Why:** AgentProcessManager와 DelegationManager는 `config.yaml.multi_agent.agents`에서 에이전트 목록을 읽음. 여기에 등록되지 않은 에이전트는 delegate 대상으로 인식되지 않음.

**Files:**

- Modify: `~/.mama/config.yaml`

- [ ] **Step 2.1: Add test — config includes system agents**

Append to `system-agent-unification.test.ts`:

```typescript
describe('config.yaml agent registration', () => {
  it('dashboard-agent config has required fields', () => {
    const dashboardAgent = {
      name: 'Dashboard Agent',
      display_name: '📊 Dashboard',
      trigger_prefix: '!dashboard',
      persona_file: '~/.mama/personas/dashboard.md',
      tier: 2,
      can_delegate: false,
      useCodeAct: true,
      model: 'claude-sonnet-4-6',
      tool_permissions: {
        allowed: ['mama_search', 'report_publish', 'code_act'],
        blocked: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Grep',
          'Glob',
          'Agent',
          'WebSearch',
          'WebFetch',
        ],
      },
    };
    expect(dashboardAgent.tier).toBe(2);
    expect(dashboardAgent.can_delegate).toBe(false);
    expect(dashboardAgent.useCodeAct).toBe(true);
    expect(dashboardAgent.persona_file).toBe('~/.mama/personas/dashboard.md');
  });

  it('wiki-agent config has required fields', () => {
    const wikiAgent = {
      name: 'Wiki Agent',
      display_name: '📚 Wiki',
      trigger_prefix: '!wiki',
      persona_file: '~/.mama/personas/wiki.md',
      tier: 2,
      can_delegate: false,
      useCodeAct: true,
      model: 'claude-sonnet-4-6',
      tool_permissions: {
        allowed: ['mama_search', 'wiki_publish', 'code_act'],
        blocked: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Grep',
          'Glob',
          'Agent',
          'WebSearch',
          'WebFetch',
        ],
      },
    };
    expect(wikiAgent.tier).toBe(2);
    expect(wikiAgent.useCodeAct).toBe(true);
    expect(wikiAgent.persona_file).toBe('~/.mama/personas/wiki.md');
  });

  it('DelegationManager recognizes dashboard-agent after config load', () => {
    // Import DelegationManager directly for unit test
    const { DelegationManager } = require('../../src/multi-agent/delegation-manager.js');
    const agents = [
      { id: 'conductor', name: 'Conductor', tier: 1, can_delegate: true, enabled: true },
      { id: 'dashboard-agent', name: 'Dashboard', tier: 2, can_delegate: false, enabled: true },
      { id: 'wiki-agent', name: 'Wiki', tier: 2, can_delegate: false, enabled: true },
    ];
    const dm = new DelegationManager(agents);

    const dashCheck = dm.isDelegationAllowed('conductor', 'dashboard-agent');
    expect(dashCheck.allowed).toBe(true);

    const wikiCheck = dm.isDelegationAllowed('conductor', 'wiki-agent');
    expect(wikiCheck.allowed).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run test**

Run: `cd packages/standalone && pnpm vitest run tests/multi-agent/system-agent-unification.test.ts`
Expected: PASS

- [ ] **Step 2.3: Add entries to ~/.mama/config.yaml**

Under `multi_agent.agents`, add after the `pm` entry:

```yaml
dashboard-agent:
  name: Dashboard Agent
  display_name: "\U0001F4CA Dashboard"
  trigger_prefix: '!dashboard'
  persona_file: ~/.mama/personas/dashboard.md
  tier: 2
  can_delegate: false
  useCodeAct: true
  model: claude-sonnet-4-6
  tool_permissions:
    allowed:
      - mama_search
      - report_publish
      - code_act
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
      - code_act
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

- [ ] **Step 2.4: Commit**

```bash
git add packages/standalone/tests/multi-agent/system-agent-unification.test.ts
git commit -m "feat(config): register dashboard-agent and wiki-agent in multi_agent config"
```

Note: `~/.mama/config.yaml` is not in git — it's a runtime config file.

---

## Task 3: GatewayToolExecutor에 getAgentProcessManager() getter 추가

**Why:** `api-routes-init.ts`에서 cron 트리거가 AgentProcessManager에 접근해야 함. 현재 `agentProcessManager`는 private field.

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts:176`

- [ ] **Step 3.1: Add getter method**

After `setDelegationManager()` (line 209), add:

```typescript
/** Get AgentProcessManager (for cron/event triggers that need direct process access) */
getAgentProcessManager(): AgentProcessManager | null {
  return this.agentProcessManager;
}
```

- [ ] **Step 3.2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3.3: Commit**

```bash
git add packages/standalone/src/agent/gateway-tool-executor.ts
git commit -m "feat(tools): expose getAgentProcessManager() getter for cron triggers"
```

---

## Task 4: api-routes-init.ts — 별도 AgentLoop 삭제 + cron 전환

**핵심 변경.** 이 Task가 전체 통합의 본체.

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts`

**변경 범위:**

1. 별도 `dashboardAgentLoop` 생성 코드 삭제 (lines 145-191)
2. `dashboardAgentLoop.setReportPublisher()` 삭제 (이미 shared toolExecutor에 wired)
3. 별도 `wikiAgentLoop` 생성 코드 삭제 (lines 270-316)
4. `wikiAgentLoop.setWikiPublisher()` 삭제 (이미 shared toolExecutor에 wired)
5. cron을 `toolExecutor.getAgentProcessManager().getSharedProcess()` 경로로 전환

**유지:**

- `toolExecutor.setReportPublisher()` (line 106) — shared publisher, code-act path에서 사용
- `toolExecutor.setWikiPublisher()` (line 259) — 동일
- `ensureDashboardPersona()` 호출 — persona 파일 생성 보장
- `ensureWikiPersona()` 호출 — persona 파일 생성 보장
- cron intervals 및 manual trigger API endpoints
- ObsidianWriter setup (wiki publisher callback에서 사용)

- [ ] **Step 4.1: Replace Dashboard Agent section**

Replace the entire Dashboard Agent block (lines 117-234) with:

```typescript
// ── Dashboard Agent ─────────────────────────────────────────────────
const { ensureDashboardPersona } = await import('../../multi-agent/dashboard-agent-persona.js');
ensureDashboardPersona(); // Ensure persona file exists for AgentProcessManager
console.log('[Dashboard Agent] Persona ensured at ~/.mama/personas/dashboard.md');

// Merge code-act MCP server into mama-mcp-config.json
// Makes code_act available to all CLI processes (AgentProcessManager agents)
const codeActServerPath = path.join(__dirname, '../../mcp/code-act-server.js');
try {
  const mamaMcpConfigPath = path.join(homedir(), '.mama', 'mama-mcp-config.json');
  const existing = existsSync(mamaMcpConfigPath)
    ? JSON.parse(readFileSync(mamaMcpConfigPath, 'utf-8'))
    : { mcpServers: {} };
  existing.mcpServers['code-act'] = {
    command: 'node',
    args: [codeActServerPath],
    env: { MAMA_SERVER_PORT: String(EMBEDDING_PORT) },
  };
  writeFileSync(mamaMcpConfigPath, JSON.stringify(existing, null, 2), 'utf-8');
} catch (err) {
  console.warn('[api-routes-init] Failed to merge code-act into MCP config:', err);
}

// Dashboard cron: 30-min interval via AgentProcessManager
const dashboardPrompt =
  'Analyze current project data and write an executive briefing. Use mama_search to find recent decisions, then use report_publish to publish your briefing HTML in the "briefing" slot.';

const runDashboardAgent = async () => {
  const pm = toolExecutor.getAgentProcessManager();
  if (!pm) {
    console.warn('[Dashboard Agent] AgentProcessManager not available yet');
    return;
  }
  try {
    console.log('[Dashboard Agent] Starting briefing generation...');
    const process = await pm.getSharedProcess('dashboard-agent');
    await process.sendMessage(dashboardPrompt);
    console.log('[Dashboard Agent] Briefing published');
  } catch (err) {
    console.error('[Dashboard Agent] Error:', err instanceof Error ? err.message : err);
  }
};

// First run after 10s, then every 30 min
setTimeout(runDashboardAgent, 10_000);
setInterval(runDashboardAgent, 30 * 60 * 1000);

// Manual trigger
apiServer.app.post('/api/report/agent-refresh', requireAuth, async (_req, res) => {
  runDashboardAgent().catch(() => {});
  res.json({ ok: true, message: 'Dashboard agent triggered' });
});
```

- [ ] **Step 4.2: Replace Wiki Agent section**

Replace the Wiki Agent block (lines 242-411) with:

```typescript
// ── Wiki Agent ──────────────────────────────────────────────────────
const wikiConfig = config.wiki as
  | { enabled?: boolean; vaultPath?: string; wikiDir?: string }
  | undefined;

if (wikiConfig?.enabled && wikiConfig.vaultPath) {
  const { ensureWikiPersona } = await import('../../multi-agent/wiki-agent-persona.js');
  const { ObsidianWriter } = await import('../../wiki/obsidian-writer.js');

  ensureWikiPersona(); // Ensure persona file exists for AgentProcessManager
  const obsWriter = new ObsidianWriter(wikiConfig.vaultPath, wikiConfig.wikiDir || 'wiki');
  obsWriter.ensureDirectories();
  console.log(`[Wiki Agent] Persona ensured, vault: ${obsWriter.getWikiPath()}`);

  // Wire wiki_publish tool to shared gateway executor (used by code-act path)
  toolExecutor.setWikiPublisher((pages) => {
    for (const page of pages) {
      obsWriter.writePage(page as import('../../wiki/types.js').WikiPage);
    }
    if (pages.length > 0) {
      obsWriter.updateIndex(pages as import('../../wiki/types.js').WikiPage[]);
      obsWriter.appendLog('compile', `Published ${pages.length} pages`);
    }
    console.log(`[Wiki Agent] Published ${pages.length} pages to vault`);

    eventBus.emit({
      type: 'wiki:compiled',
      pages: (pages as Array<{ path?: string }>).map((p) => p.path || ''),
    });
  });

  // Wiki trigger via AgentProcessManager
  const runWikiAgent = async () => {
    const pm = toolExecutor.getAgentProcessManager();
    if (!pm) {
      console.warn('[Wiki Agent] AgentProcessManager not available yet');
      return;
    }
    try {
      console.log('[Wiki Agent] Starting compilation...');

      // Build list of existing wiki pages so LLM reuses exact paths
      let existingPages: string[] = [];
      try {
        const walkDir = (dir: string, prefix: string): string[] => {
          const entries: string[] = [];
          for (const f of readdirSync(dir)) {
            const full = path.join(dir, f);
            const rel = prefix ? `${prefix}/${f}` : f;
            if (statSync(full).isDirectory()) {
              entries.push(...walkDir(full, rel));
            } else if (f.endsWith('.md') && f !== 'log.md') {
              entries.push(rel);
            }
          }
          return entries;
        };
        existingPages = walkDir(obsWriter.getWikiPath(), '');
      } catch {
        /* non-fatal */
      }

      const existingPagesHint =
        existingPages.length > 0
          ? `\n\nExisting wiki pages (reuse these exact paths, do NOT create duplicates):\n${existingPages.map((p) => `- ${p}`).join('\n')}\n\nCRITICAL: Do NOT include frontmatter (--- blocks) or # Title heading in content. System adds both automatically.`
          : '\n\nCRITICAL: Do NOT include frontmatter (--- blocks) or # Title heading in content. System adds both automatically.';

      const wikiPrompt = `Search for recent decisions across all projects using mama_search, then compile them into wiki pages and publish with wiki_publish.${existingPagesHint}`;

      const process = await pm.getSharedProcess('wiki-agent', { requestTimeout: 600_000 });
      await process.sendMessage(wikiPrompt);
      console.log('[Wiki Agent] Compilation complete');
    } catch (err) {
      console.error('[Wiki Agent] Error:', err instanceof Error ? err.message : err);
    }
  };

  // Event-driven: compile when extraction completes
  eventBus.on('extraction:completed', () => runWikiAgent());

  // Emit agent:action notices when wiki pages are compiled
  eventBus.on('wiki:compiled', (event) => {
    if (event.type === 'wiki:compiled') {
      for (const page of event.pages) {
        eventBus.emit({
          type: 'agent:action',
          agent: 'Wiki Agent',
          action: 'compiled',
          target: page,
        });
      }
    }
  });

  // Manual trigger API
  apiServer.app.post('/api/wiki/compile', requireAuth, async (_req, res) => {
    runWikiAgent().catch(() => {});
    res.json({ ok: true, message: 'Wiki compilation triggered' });
  });

  // First run after 15s
  setTimeout(runWikiAgent, 15_000);

  console.log('[Wiki Agent] Ready — triggers: extraction:completed event, POST /api/wiki/compile');
}
```

- [ ] **Step 4.3: Clean up unused imports**

Remove from `api-routes-init.ts` imports:

- `AgentLoop` import (line 27) — if no longer used elsewhere in the file
- `AgentContext` type import — if only used by deleted code

Keep:

- `GatewayToolExecutor` import
- `readFileSync`, `writeFileSync`, `existsSync`, `readdirSync`, `statSync` — still used
- All other existing imports

- [ ] **Step 4.4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4.5: Run full test suite**

Run: `pnpm test`
Expected: All pass

- [ ] **Step 4.6: Commit**

```bash
git add packages/standalone/src/cli/runtime/api-routes-init.ts
git commit -m "refactor(agents): unify dashboard/wiki into AgentProcessManager, remove separate AgentLoops"
```

---

## Task 5: E2E 검증

**필수:** daemon.log 확인 없이 성공을 주장하지 않는다.

- [ ] **Step 5.1: MAMA OS 재시작**

```bash
mama stop && mama start
```

- [ ] **Step 5.2: Health check**

```bash
curl http://localhost:3847/health
```

Expected: `{"status":"ok",...}`

- [ ] **Step 5.3: Dashboard agent trigger**

```bash
curl -X POST http://localhost:3847/api/report/agent-refresh
```

Expected: `{"ok":true,"message":"Dashboard agent triggered"}`

- [ ] **Step 5.4: Check daemon.log for dashboard success**

```bash
tail -100 ~/.mama/logs/daemon.log | grep -v 'GET /api/' | grep -i 'dashboard\|report_publish\|briefing'
```

Expected: `[Dashboard Agent] Briefing published` — no errors

- [ ] **Step 5.5: Conductor audit trigger (delegate test)**

```bash
curl -X POST http://localhost:3847/api/conductor/audit
```

- [ ] **Step 5.6: Check daemon.log for delegate success**

```bash
tail -100 ~/.mama/logs/daemon.log | grep -v 'GET /api/' | grep -i 'delegate\|error\|Error\|Unknown'
```

Expected:

- NO `Unknown target agent: dashboard-agent`
- NO `Unknown target agent: wiki-agent`
- Delegate success logs present

- [ ] **Step 5.7: Wiki agent trigger (if wiki enabled)**

```bash
curl -X POST http://localhost:3847/api/wiki/compile
```

- [ ] **Step 5.8: Check daemon.log for wiki success**

```bash
tail -50 ~/.mama/logs/daemon.log | grep -i 'wiki\|wiki_publish'
```

Expected: `[Wiki Agent] Compilation complete` — no errors

---

## Execution Order

```
Task 1: code-act MCP 병합              ← MCP config 수정 (5분)
  ↓
Task 2: config.yaml 에이전트 추가       ← 런타임 config (5분)
  ↓
Task 3: getter 메서드 추가              ← 1줄 (2분)
  ↓
Task 4: api-routes-init 리팩토링        ← 핵심 변경 (20분)
  ↓
Task 5: E2E 검증                       ← daemon.log 필수 확인
```

## Verification Checklist

- [ ] `pnpm typecheck` — 0 errors
- [ ] `pnpm test` — all pass
- [ ] `mama start` — no startup errors
- [ ] Dashboard agent runs via AgentProcessManager (not separate AgentLoop)
- [ ] Wiki agent runs via AgentProcessManager (not separate AgentLoop)
- [ ] `delegate(dashboard-agent, task)` — no 'Unknown target agent' error
- [ ] `delegate(wiki-agent, task)` — no 'Unknown target agent' error
- [ ] `report_publish` — updates reportStore + SSE broadcast (via code-act → HostBridge)
- [ ] `wiki_publish` — writes to Obsidian vault (via code-act → HostBridge)
- [ ] daemon.log clean — no delegate/agent errors
