# v0.18 에이전트 결과 공유 Plan (원래 목표 복귀)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dashboard/Wiki Agent의 결과를 Conductor가 받을 수 있도록 한다. 현재 결과는 ReportStore(메모리)와 Obsidian vault(파일)에만 저장되어 Conductor가 접근 불가.

**Architecture:** 두 가지 경로로 해결:

1. **Memory 경로**: report_publish/wiki_publish 후 mama memory에 요약 자동 저장 → Conductor가 mama_search로 조회
2. **Event 경로**: AgentEventBus에 완료 이벤트 emit → agent_notices 도구로 Conductor가 조회

**이전 작업과의 관계:** delegate gateway tool (8 commits)은 메커니즘으로 유효. 이 plan은 그 위에 **적용 대상**(Dashboard/Wiki Agent)과 **결과 공유**를 추가.

---

## 현재 상태 (탐색 결과)

```
Dashboard Agent:
  30분마다 실행 → mama_search → report_publish → ReportStore(in-memory) → SSE → Viewer
  ❌ memory에 저장 안 됨 → Conductor가 mama_search로 조회 불가
  ❌ EventBus에 완료 이벤트 없음

Wiki Agent:
  extraction:completed 이벤트 → mama_search → wiki_publish → ObsidianWriter → vault 파일
  ❌ memory에 저장 안 됨
  △ wiki:compiled 이벤트는 있지만 Intelligence API에 미노출

Conductor:
  /api/intelligence/summary → Dashboard HTML 조회 가능 (REST)
  /api/intelligence/notices → 최근 agent:action 이벤트 조회 (REST)
  ❌ 도구로 조회할 방법 없음 (gateway tool 없음)
```

---

## Task 1: report_publish 후 memory에 자동 저장

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts` (report_publish handler)
- Reference: `packages/standalone/src/cli/runtime/api-routes-init.ts:172-181` (report publisher wiring)

- [ ] **Step 1.1: report_publish handler에서 memory 저장 추가**

`gateway-tool-executor.ts`의 report_publish tool handler를 찾아서, 보고서를 ReportStore에 저장한 **후** mama memory에도 요약을 저장:

```typescript
// report_publish 핸들러 내부, reportPublisher 콜백 호출 후:
if (this.mamaToolHandlers) {
  const textSummary = String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated =
    textSummary.length > 1500 ? textSummary.substring(0, 1500) + '...' : textSummary;
  void this.mamaToolHandlers
    .handleSave({
      topic: 'dashboard_briefing',
      decision: `Dashboard briefing (${new Date().toISOString().split('T')[0]}): ${truncated}`,
      reasoning: 'Auto-saved by dashboard agent after report_publish',
      scopes: [{ kind: 'global', id: 'system' }],
    })
    .catch(() => {
      /* non-fatal */
    });
}
```

- [ ] **Step 1.2: Run tests, commit**

---

## Task 2: wiki_publish 후 memory에 자동 저장

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts` (wiki_publish handler)

- [ ] **Step 2.1: wiki_publish handler에서 memory 저장 추가**

```typescript
// wiki_publish 핸들러 내부, wikiPublisher 콜백 호출 후:
if (this.mamaToolHandlers && Array.isArray(pages)) {
  const pageSummary = pages
    .map((p: any) => `- ${p.title || p.path} (${p.type || 'page'})`)
    .join('\n');
  const summary = `Wiki compilation (${new Date().toISOString().split('T')[0]}): ${pages.length} pages\n${pageSummary}`;
  void this.mamaToolHandlers
    .handleSave({
      topic: 'wiki_compilation',
      decision: summary,
      reasoning: 'Auto-saved by wiki agent after wiki_publish',
      scopes: [{ kind: 'global', id: 'system' }],
    })
    .catch(() => {
      /* non-fatal */
    });
}
```

- [ ] **Step 2.2: Run tests, commit**

---

## Task 3: Dashboard Agent 완료 이벤트 emit

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts` (dashboard agent publisher callback)

- [ ] **Step 3.1: report publisher에서 EventBus 이벤트 발행**

`api-routes-init.ts`의 dashboard agent report publisher wiring (line 172-181)에서, 보고서 발행 후 EventBus에 이벤트 emit:

```typescript
// 기존 reportPublisher callback 내부에 추가:
eventBus.emit({
  type: 'agent:action',
  agent: 'dashboard-agent',
  action: 'publish',
  target: 'briefing',
});
```

- [ ] **Step 3.2: Run tests, commit**

---

## Task 4: agent_notices gateway tool 등록 + 구현

**Files:**

- Modify: `packages/standalone/src/agent/tool-registry.ts`
- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts`

- [ ] **Step 4.1: tool-registry에 agent_notices 등록**

```typescript
{
  name: 'agent_notices',
  description: 'Get recent agent activity notices (dashboard reports, wiki compilations, delegations). Use to check what other agents have done recently.',
  category: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max notices (default: 10)' },
    },
  },
}
```

- [ ] **Step 4.2: GatewayToolExecutor에 handler 구현**

```typescript
case 'agent_notices': {
  const limit = Number(input.limit) || 10;
  const eventBus = this.getAgentEventBus();
  if (!eventBus) {
    return { success: true, data: { notices: [] } };
  }
  const notices = eventBus.getRecentNotices(limit);
  return {
    success: true,
    data: {
      notices: notices.map(n => ({
        agent: n.agent,
        action: n.action,
        target: n.target,
        timestamp: new Date(n.timestamp).toISOString(),
      })),
    },
  };
}
```

- [ ] **Step 4.3: HostBridge TOOL_REGISTRY에 추가 (tier 1+2 접근 가능)**

- [ ] **Step 4.4: Run tests, commit**

---

## Task 5: Conductor persona에 결과 조회 안내

**Files:**

- Modify: `~/.mama/personas/conductor.md`

- [ ] **Step 5.1: 에이전트 결과 조회 방법 안내 추가**

```markdown
## Agent Result Querying

- `mama_search({query: "dashboard_briefing"})` — 최근 Dashboard 브리핑 조회
- `mama_search({query: "wiki_compilation"})` — 최근 Wiki 컴파일 결과 조회
- `agent_notices({limit: 5})` — 최근 에이전트 활동 (발행, 컴파일, 위임) 조회
```

---

## Task 6: e2e 검증

- [ ] **Step 6.1: Dashboard Agent 수동 트리거**

```bash
curl -X POST http://localhost:3847/api/report/agent-refresh
```

- [ ] **Step 6.2: mama_search로 briefing 조회 확인**

```bash
curl -s http://localhost:3847/api/intelligence/notices?limit=5
# agent: dashboard-agent, action: publish 확인
```

- [ ] **Step 6.3: mama memory에 dashboard_briefing 토픽 확인**

- [ ] **Step 6.4: Wiki compile 후 wiki_compilation 토픽 확인**

---

## Execution Order

```
Task 1: report_publish → memory 저장     ← ~10줄
Task 2: wiki_publish → memory 저장       ← ~10줄
Task 3: Dashboard 완료 이벤트            ← ~5줄
Task 4: agent_notices 도구               ← ~30줄
Task 5: Conductor persona               ← persona 수정
Task 6: e2e 검증                         ← 수동 테스트
```

## 원래 체크포인트와의 정합성 확인

| 체크포인트 우선순위      | 이 plan의 task                    | 상태         |
| ------------------------ | --------------------------------- | ------------ |
| 1. 멀티에이전트 통합     | delegate gateway tool (이전 세션) | ✅ 완료      |
| 2-1. Dashboard 결과 공유 | Task 1 + Task 3                   | 이번 구현    |
| 2-2. Wiki 결과 공유      | Task 2                            | 이번 구현    |
| 2-3. Conductor가 조회    | Task 4 + Task 5                   | 이번 구현    |
| 3. 히스토리 인제스트     | Kagemusha compiler (이전 세션)    | ✅ 기본 완료 |
