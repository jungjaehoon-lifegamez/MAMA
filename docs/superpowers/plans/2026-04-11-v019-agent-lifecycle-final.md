# v0.19 Agent Lifecycle — Final Implementation Plan

> 이전 플랜들은 전부 폐기. 이 문서가 유일한 구현 가이드.

## v0.19의 진짜 목적

완벽한 에이전트를 한번에 만드는 것이 아니다. **추적 → 검증 → 개선 루프가 돌아가는 시스템**을 만드는 것이다.

```
에이전트 동작
  → activity 기록 (뭘 했는지, 결과, 소요시간, 에러)
  → 사용자가 Activity 탭에서 확인 (투명성)
  → Conductor audit에서 패턴 분석 (자동 검증)
  → 개선 제안 ("search 안 하고 save만 함", "중복 67%")
  → 사용자 승인 → agent_update → 새 버전
  → 다시 동작 → Before/After 비교
  → 반복
```

이 루프가 모든 에이전트에 동일하게 적용된다:

- Wiki Agent: "0 pages 반복" 감지 → cron 주기 조정
- Memory Agent: "search 없이 save만" 감지 → search-before-save 추가
- News Agent: "irrelevant 비율 높음" 감지 → 프롬프트 개선
- Issue Tracker: "timeout 반복" 감지 → 커넥터 설정 수정

**하루아침에 완성이 아니라, 추적/검증/개선이 가능한 인프라를 만드는 것.**

## 그래프 활용 Gap — 인프라는 있지만 에이전트가 안 쓴다

MAMA 메모리 시스템은 이미 지식 그래프를 갖추고 있다:

- **엣지:** supersedes, builds_on, debates, synthesizes (양방향)
- **그래프 확장:** recallMemory → expandWithGraph() → supersedes chain + semantic edges 자동 추적
- **진실 투영:** 현재 truth만 recall에 표면화
- **스코프:** project/channel/user/global 격리

**문제: 에이전트들이 이 그래프를 만들지도 읽지도 않음.**

| 에이전트        | 현재                                | 필요                                                                |
| --------------- | ----------------------------------- | ------------------------------------------------------------------- |
| Memory Agent    | search 없이 save → 엣지 안 생김     | save 전 mama_search → 같은 topic이면 supersedes, 관련이면 builds_on |
| Wiki Agent      | graph_context.expanded 무시         | expanded 활용 → 관련 디시전 체인을 하나의 wiki 섹션으로 통합        |
| Conductor audit | 그래프 품질 체크 없음               | 고아 노드, 미해결 contradicts, stale chain 감지                     |
| 모든 에이전트   | mama_save 시 builds_on 참조 안 넣음 | reasoning에 `builds_on: {id}` 포함 → 엣지 자동 생성                 |

**v0.19 추적→검증→개선 루프로 점진적 개선:**

1. activity에서 "search 없이 save만 함" 패턴 감지
2. Conductor가 "builds_on 참조를 넣도록" 에이전트 프롬프트 개선 제안
3. 사용자 승인 → agent_update → 재테스트 → Before/After

## 에이전트 가시성 — 사용자가 보는 3개 화면

### 화면 1: Agents 탭 — 한눈에 상태 파악

```
┌─── Agents ──────────────────────────────────────────────┐
│                                                          │
│ ⚠ 1 agent needs attention: wiki-agent 3 consecutive errors │
│                                                          │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│ │🎯 Conductor  │  │📊 Dashboard  │  │📚 Wiki       │    │
│ │ sonnet-4-6   │  │ sonnet-4-6   │  │ sonnet-4-6   │    │
│ │ ● Active 2m  │  │ ● Idle 1h    │  │ ● Error 15m  │    │
│ │         [ON] │  │         [ON] │  │         [ON] │    │
│ └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                          │
│ ┌──────────────┐                                         │
│ │🔍 QA Monitor │                                         │
│ │ sonnet-4-6   │                                         │
│ │ ◉ Running... │  ← delegate 진행 중 (pulse)            │
│ │         [ON] │                                         │
│ └──────────────┘          [+ New Agent]                  │
└──────────────────────────────────────────────────────────┘
```

상태:

- `◉ Running...` (녹색 pulse) — delegate 실행 중
- `● Active 2m` (녹색) — 마지막 성공 5분 이내
- `● Idle 1h` (노랑) — 5분 이상 무활동
- `● Error 15m` (빨강) — 마지막이 task_error
- `● Disabled` (회색) — enabled: false

데이터: 현재 구현 기준 `GET /api/agents`는 `last_activity`만 제공하고, alert/summary는 `GET /api/agents/activity-summary`에서 온다. `is_running`은 아래 4b의 future work다.

### 화면 2: Activity 탭 — 에이전트별 실행 이력

```
┌─── 📚 Wiki Agent ─────────────────────────────────┐
│ ← Agents    📚 Wiki Agent  v3                      │
│ [Config] [Persona] [Tools] [Activity] [History]    │
│─────────────────────────────────────────────────── │
│                                                     │
│ ❌ wiki compilation failed                          │
│    v3 · 45200ms · 2026-04-11 14:32                 │
│    Error: Obsidian vault path not accessible        │
│                                                     │
│ ❌ wiki compilation failed                          │
│    v3 · 30000ms · 2026-04-11 13:00                 │
│    Error: timeout                                   │
│                                                     │
│ ✅ wiki compilation complete — 12 pages             │
│    v3 · 23400ms · 2026-04-11 10:15                 │
│                                                     │
│ 🧪 Testing with 3 items — 85/100          ▼        │
│    v2 · 34500ms · 2026-04-10 16:00                 │
│    ┌─────────────────────────────────────┐          │
│    │ ✅ PASS  compile system pages       │          │
│    │ ✅ PASS  compile project pages      │          │
│    │ ❌ FAIL  cross-reference links      │          │
│    └─────────────────────────────────────┘          │
│                                                     │
│ ▶️ wiki compilation started                         │
│    v2 · 0ms · 2026-04-10 15:58                     │
└─────────────────────────────────────────────────────┘
```

데이터: `GET /api/agents/{id}/activity?limit=20` → task_start/complete/error + test_run (expandable)

### 화면 3: 채팅 — Conductor가 능동적으로 보고

```
┌─── Chat ───────────────────────────────────────────┐
│                                                     │
│ [Conductor] 매시간 감사 결과:                       │
│ ✅ Dashboard: 브리핑 최신 (2시간 전)                │
│ ⚠️ Wiki Agent: 에러 3회 연속                        │
│    마지막 에러: "vault path not accessible"          │
│    제안: vault 경로 확인 필요                       │
│ ✅ 프로젝트 태스크: 지연 없음                       │
│                                                     │
│ ──── delegate 진행 알림 ────                        │
│                                                     │
│ [Conductor] QA Monitor에게 작업 위임 중...          │
│ [Conductor] QA Monitor 완료 (2340ms)                │
│ 결과: 3건 분석, 2건 정상, 1건 경고                  │
│                                                     │
│ ──── 에이전트 생성 ────                             │
│                                                     │
│ [사용자] 에이전트 만들어줘                          │
│ [Conductor] 커넥터: Drive ✓ Sheets ✓ Kagemusha ✓   │
│ 만들겠습니다: Delivery Monitor                      │
│ 진행할까요?                                         │
│                                                     │
│ [_입력_____________________________] [전송]         │
└─────────────────────────────────────────────────────┘
```

Conductor 보고 시점:

- 매시간 audit → audit-checklist.md → 결과를 채팅에 보고
- delegate 시작/완료 → toast + 채팅 인라인
- 에이전트 생성/테스트 → Agent Factory flow 결과
- 이상 감지 → 에러 연속 → 즉시 채팅 알림

### 전체 데이터 흐름

```
Conductor가 delegate(wiki-agent, task) 호출
  │
  ├── [실시간] viewer_notify → toast "wiki-agent working..."
  ├── [실시간] is_running: true → 카드 "◉ Running..."
  │
  ├── executeDelegate()
  │   ├── logActivity(task_start) → agent_activity DB
  │   ├── AgentProcessManager → Claude CLI → 작업 수행
  │   └── logActivity(task_complete or task_error)
  │
  ├── [실시간] viewer_notify → toast "completed" or "failed"
  ├── [실시간] is_running: false → 카드 상태 갱신
  │
  ├── [Activity 탭] GET /api/agents/wiki-agent/activity → 로그 표시
  │
  └── [매시간 audit] GET /api/agents/activity-summary
      → Conductor가 채팅에 보고
```

---

## 실제 사용 시나리오 — activity가 투명성을 제공하는 방법

### 시나리오 1: Wiki Agent 블랙박스 해소

현재 Wiki Agent는 메모리 기반 델타 업데이트를 하지만 사용자가 볼 수 없음. activity 기록으로:

```
Activity 탭 (wiki-agent):
│ ✅ wiki compilation — 12 pages (3 new, 9 delta)  │ ← 유용한 작업
│    v3 · 23400ms · 14:30                           │
│ ✅ wiki compilation — 0 pages (no changes)        │ ← 불필요한 작업 감지!
│    v3 · 8200ms · 13:00                            │
│ ✅ wiki compilation — 0 pages (no changes)        │ ← 또 불필요!
│    v3 · 7800ms · 12:00                            │
```

사용자가 알 수 있는 것:

- "0 pages" 반복 → **불필요한 작업** → cron 주기 조정 필요
- duration 23초 vs 8초 → 실제 작업 vs 빈 실행 구분
- Conductor audit: "Wiki Agent 4회 중 2회 무작업. cron 조정할까요?"

### 시나리오 2: 사용자가 만든 에이전트 (News Monitor)

```
사용자: "외부 뉴스 모니터 에이전트 만들어줘"
  → agent_create → config.yaml 추가 → 테스트

운영 중 Activity 탭 (news-monitor):
│ ✅ news scan — 3 items saved to mama             │
│    output: "15 scanned, 3 relevant (AI reg...)"  │
│ ❌ news scan failed                               │
│    Error: web_fetch timeout on feed URL           │ ← 어디서 멈췄는지
│ ✅ news scan — 0 items (nothing relevant)         │

Wiki Agent가 받아가는 흐름:
  news-monitor → mama_save(topic: "news_ai") → 메모리 DB
  → wiki-agent 다음 compile 시 mama_search로 발견
  → wiki page "AI Industry Updates" 업데이트
  → Activity: "2 pages: AI-Industry-Updates(new from news-monitor)"
```

### 시나리오 3: 사용자 직접 제어 (Conductor = OS Agent)

```
사용자: "wiki 컴파일 멈춰"
  → agent_update(wiki-agent, {enabled: false})
  → Activity: "⚙️ config_change — disabled by user"
  → 카드: ● Disabled [OFF]

사용자: "news-monitor 퀄리티 낮아. 프롬프트 수정해"
  → agent_update(news-monitor, v1→v2, {system: "개선"})
  → agent_test → retest
  → Activity: "🧪 v1: 60점 → v2: 85점" (Before/After)
```

### 시나리오 4: Issue Tracker Agent — 커넥터 연결 + 에이전트 간 전달

```
issue-tracker → 커넥터(Kagemusha) raw 데이터 수집
             → 분석 → mama_save(topic: "daily_brief")
             → Conductor에게 보고 → Dashboard/Wiki가 참조

Activity 탭 (issue-tracker):
│ ✅ issue scan — 3 overdue, 1 blocked              │
│    output: "42 tasks scanned. 3 overdue, 1 block" │
│ ✅ brief saved to mama                             │

채팅: "[Conductor] Issue Tracker 보고: 3건 지연, 1건 블로킹"
Dashboard: "브리핑: 지연 태스크 3건 주의"
Wiki: "Project Status 페이지 업데이트"
```

### 모든 시나리오의 공통점: activity 기반 평가

| 평가 관점         | 어떻게 확인하는가                                         |
| ----------------- | --------------------------------------------------------- |
| 살아있는가?       | 카드 상태 + 마지막 활동 시각                              |
| 일을 하는가?      | Activity 기록 수 + 빈도                                   |
| 불필요한 작업?    | output "0 pages" / "nothing relevant" 패턴 반복           |
| 퀄리티?           | test_run 점수 + Conductor 평가 코멘트                     |
| 어디서 멈췄나?    | task_error의 error_message + duration_ms                  |
| 에이전트 간 연결? | mama_save → mama_search 체인 (activity input/output 추적) |

---

## Claude Managed Agents → MAMA OS 매핑

| Claude MA                                                                          | MAMA OS 대응                                                       | 현재 상태                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Agent** (model + system + tools)                                                 | config.yaml `multi_agent.agents.{id}` + `~/.mama/personas/{id}.md` | 구조 있음. agent_create가 config.yaml에 안 씀                                                 |
| **Environment** (컨테이너)                                                         | 불필요 (로컬 실행)                                                 | N/A                                                                                           |
| **Session** (실행 인스턴스, idle/running/terminated)                               | delegation 1회 = session. `agent_activity` 테이블로 추적           | 테이블 있음. 데이터 0건 (미검증)                                                              |
| **Events** (SSE: user.message, agent.message, agent.tool_use, session.status_idle) | `agent_activity` 행 (task_start, task_complete, task_error)        | auto-log 코드 있음. 미검증                                                                    |
| **Agent 생성** (POST /v1/agents → id, version)                                     | `agent_create` gateway tool → config.yaml 추가 + 핫리로드          | 구현됨. `packages/standalone/src/agent/gateway-tool-executor.ts`에서 runtime/config sync 수행 |
| **Agent 버전관리** (agent.version, 업데이트 시 자동 증가)                          | `agent_versions` 테이블 (snapshot + persona_text)                  | 구현됨                                                                                        |
| **Tool config** (agent_toolset + configs[].enabled)                                | `tool_permissions.allowed/blocked`                                 | 구현됨                                                                                        |
| **Session 시작** (POST /v1/sessions → session_id)                                  | `delegate(agentId, task)` → executeDelegate                        | 구현됨                                                                                        |
| **Events 스트리밍** (GET /v1/sessions/{id}/stream SSE)                             | Activity 탭 (페이지 로드 시 API 호출)                              | UI 있음. 데이터 없음                                                                          |

## 현재 config.yaml agents (정리 필요)

```yaml
conductor       — 유지 (오케스트레이터)
dashboard-agent — 유지 (시스템 에이전트)
wiki-agent      — 유지 (시스템 에이전트)
developer       — ❌ 제거 (Agent Swarm 잔재, enabled:false)
reviewer        — ❌ 제거
architect       — ❌ 제거
pm              — ❌ 제거
```

## 기존 인프라 (재사용)

### Conductor Audit (매시간 cron)

```
~/.mama/skills/audit-checklist.md
  Step 4: Agent Health — agent_notices로 에이전트 상태 확인
  → agent_activity 기반 체크로 확장 가능
```

### PUT /api/multi-agent/agents/:id (config.yaml 수정 + 핫리로드)

```
graph-api.ts:handleMultiAgentUpdateAgentRequest
  → loadMAMAConfig() → 필드 업데이트 → saveMAMAConfig() → applyMultiAgentConfig()
```

### executeDelegate (gateway tool delegate)

```
gateway-tool-executor.ts:executeDelegate
  → AgentProcessManager.getProcess(agentId)
  → process.sendMessage(prompt)
  → auto-log: logActivity(task_start/task_complete/task_error)  ← 코드 있음, 미검증
```

---

## 리뷰 반영사항 (CEO + Eng + DX + Design)

| #   | Finding                             | Severity | Resolution                                 |
| --- | ----------------------------------- | -------- | ------------------------------------------ |
| 1   | Task 순서: activity 검증이 최우선   | High     | Task 1로 재배치                            |
| 2   | standalone 핫리로드 미설정          | High     | start.ts에 applyMultiAgentConfig 콜백 추가 |
| 3   | output_summary raw text 500자       | High     | 에이전트 output 계약 정의                  |
| 4   | pulse 애니메이션 CSS 필요           | High     | @keyframes 블록 주입                       |
| 5   | alert 배너 클릭 → 에이전트 이동     | High     | showDetail(agentId) + activeTab='activity' |
| 6   | "첫 5분" 빈 상태 시나리오 없음      | Medium   | 시나리오 0 추가                            |
| 7   | 에러 복구 UX 없음                   | Medium   | activity error에 suggested_action 필드     |
| 8   | task_start/complete 중복 표시       | Medium   | 완료된 task_start 숨김                     |
| 9   | delegatesInFlight Set → Map<number> | Medium   | 동시 delegation 카운팅                     |
| 10  | loadMAMAConfig 추출 불필요          | Medium   | inline yaml read/write (옵션 B)            |
| 11  | cross-agent correlation_id          | Medium   | v0.20 defer                                |
| 12  | activity 30일 보존 정책             | Low      | audit cron에서 prune                       |
| 13  | alert 배너 3개 초과 "and N more"    | Low      | 표시 로직 추가                             |

---

## 구현 Task (리뷰 반영 순서)

### Task 1: activity 기록이 실제 동작하는지 검증 (데이터 먼저!)

> CEO: "데이터 없으면 전부 빈 화면. 이게 Task 1이어야."

auto-log 코드는 executeDelegate에 이미 있음 (Eng 확인: sync 줄 2444-2506, bg 줄 2375-2428).

**검증 순서:**

1. `pnpm build` + MAMA 재시작
2. 뷰어 채팅에서 delegation 유발: "dashboard 브리핑 갱신해줘"
3. 확인:

```bash
sqlite3 ~/.mama/mama-sessions.db "SELECT * FROM agent_activity LIMIT 5;"
# 행이 있으면 → 동작함!
# 행이 없으면 → 디버그:
```

**디버그 (0건일 경우):**

```bash
grep -i "delegate\|logActivity" ~/.mama/logs/daemon.log | tail -20
```

- `sessionsDb` null → start.ts에서 `setSessionsDb(db)` 호출 시점 확인
- `logActivity` import 실패 → try-catch에서 삼켜짐
- delegation 자체가 안 일어남 → Conductor가 delegate 안 쓰고 직접 처리

**수정 후 재검증:**

```bash
curl -s "http://localhost:3847/api/agents/dashboard-agent/activity?limit=5"
# 빈 배열이 아니어야 함
```

→ Agents 탭 → Activity 탭 → 로그 표시 확인

### Task 2: standalone 핫리로드 + 불필요 에이전트 제거

> Eng: "standalone 모드에서 applyMultiAgentConfig이 설정 안 됨"

**2a: standalone 핫리로드 콜백 추가** (`start.ts` 줄 444-452 근처)

```typescript
// start.ts — DelegationManager 생성 후:
const dm = new DelegationManager(agentConfigs);
// ... 기존 wiring ...

// standalone 핫리로드 콜백 (Eng #2)
graphHandlerOptions.applyMultiAgentConfig = async (rawConfig: Record<string, unknown>) => {
  const nextConfig = rawConfig as MultiAgentConfig;
  pm.updateConfig(nextConfig); // persona cache 클리어 + process pool 갱신
};
graphHandlerOptions.restartMultiAgentAgent = async (agentId: string) => {
  pm.reloadPersona(agentId); // 단일 에이전트 리로드
};
```

**2b: 불필요 에이전트 제거**

- `~/.mama/config.yaml` — developer/reviewer/architect/pm 삭제
- `config-manager.ts` 줄 568-602 — 기본값에서 제거

**검증:**

```bash
mama stop && mama start
curl -s http://localhost:3847/api/agents  # 3개만
# Config 편집 → Save → config.yaml 반영 + 재시작 불필요 확인
```

### Task 3: agent_create → config.yaml + persona + 핫리로드

> Eng: "inline yaml read/write가 더 단순 (옵션 B). reloadPersona(agentId)로 단일 에이전트 리로드."

**수정** (`gateway-tool-executor.ts:587-606`):

```typescript
case 'agent_create': {
  if (!this.sessionsDb) return { success: false, error: 'Sessions DB not available' };
  const createArgs = input as { id: string; name: string; model: string; tier: number; system?: string };

  // 1. config.yaml에 추가 (inline yaml — Eng #10)
  const configPath = join(homedir(), '.mama', 'config.yaml');
  const config = yamlLoad(readFileSync(configPath, 'utf-8')) as Record<string, any>;
  if (!config.multi_agent?.agents) config.multi_agent = { ...config.multi_agent, agents: {} };
  if (config.multi_agent.agents[createArgs.id]) {
    return { success: false, error: `Agent '${createArgs.id}' already exists in config` };
  }
  config.multi_agent.agents[createArgs.id] = {
    name: createArgs.name,
    display_name: createArgs.name,
    model: createArgs.model,
    tier: createArgs.tier,
    persona_file: `~/.mama/personas/${createArgs.id}.md`,
    enabled: true,
    can_delegate: false,
  };
  writeFileSync(configPath, yamlDump(config, { indent: 2, lineWidth: 120, noRefs: true }));

  // 2. persona 파일 생성
  const personaDir = join(homedir(), '.mama', 'personas');
  if (!existsSync(personaDir)) mkdirSync(personaDir, { recursive: true });
  writeFileSync(
    join(personaDir, `${createArgs.id}.md`),
    createArgs.system || `# ${createArgs.name}\n\nYou are ${createArgs.name}.`,
    'utf-8'
  );

  // 3. 핫리로드 — reloadPersona (Eng #1: 전체 updateConfig 대신 단일 리로드)
  if (this.agentProcessManager) {
    this.agentProcessManager.reloadPersona(createArgs.id);
  }

  // 4. agent_versions 감사 기록
  const createdV = createAgentVersion(this.sessionsDb, {
    agent_id: createArgs.id,
    snapshot: { model: createArgs.model, tier: createArgs.tier, name: createArgs.name },
    persona_text: createArgs.system ?? null,
    change_note: 'Created via agent_create tool',
  });

  return { success: true, id: createArgs.id, version: createdV.version };
}
```

**검증:**

```bash
# Agents 탭 + New Agent → 생성
grep "new-agent-id" ~/.mama/config.yaml     # 존재
cat ~/.mama/personas/new-agent-id.md         # 존재
curl -s http://localhost:3847/api/agents     # 목록에 포함
# 채팅에서 delegate(new-agent-id, "hello") → 응답 반환
```

### Task 4: delegation 실시간 가시성

Task 1에서 activity 동작 확인 후에만 의미 있음.

**4a: viewer_notify toast** (`executeDelegate` 내부)

```typescript
// 시작:
if (this.uiCommandQueue) {
  this.uiCommandQueue.push({
    type: 'notify',
    payload: { type: 'info', message: `${agentId} working...` },
  });
}
// 완료/에러: 동일 패턴
```

**4b: is_running — Map<string, number> 카운터** (Eng #5: 동시 delegation 대응)

```typescript
private delegatesRunning = new Map<string, number>();
// 시작: this.delegatesRunning.set(id, (this.delegatesRunning.get(id) ?? 0) + 1);
// finally: { const c = (this.delegatesRunning.get(id) ?? 1) - 1; c > 0 ? this.delegatesRunning.set(id, c) : this.delegatesRunning.delete(id); }
getDelegatesInFlight(): string[] { return [...this.delegatesRunning.keys()]; }
```

GET /api/agents에 `is_running` 필드 추가.

**4c: CSS @keyframes pulse** (Design #1)

```typescript
// agents.ts init()에 한 번만 주입:
if (!document.getElementById('agent-pulse-style')) {
  const style = document.createElement('style');
  style.id = 'agent-pulse-style';
  style.textContent = '@keyframes agent-pulse { 0%,100% { opacity:1 } 50% { opacity:0.5 } }';
  document.head.appendChild(style);
}
// Running 카드: style="animation: agent-pulse 1.5s infinite"
```

**4d: alert 배너 클릭 → Activity 탭** (Design #5)

```typescript
// alert 배너의 에이전트 이름을 클릭 가능하게:
`<span class="cursor-pointer underline" data-alert-agent="${agentId}">${agentId}</span>`;
// 클릭 시: this.activeTab = 'activity'; this.showDetail(agentId);
```

**4e: task_start 표시 조건** (Design #3)

- task_complete가 있는 task_start → 숨김
- task_complete가 없는 task_start (= 진행 중) → 표시

**검증:** delegate 유발 → toast 표시 + 카드 Running + Activity 로그

### Task 5: output_summary 구조화 + 첫 5분 UX

> DX: "에이전트가 구조화된 SUMMARY 라인을 반환하는 계약 필요"
> CEO: "첫 5분 시나리오 없음"

**5a: output_summary 계약**

에이전트 페르소나에 계약 추가 (dashboard, wiki 등):

```markdown
## Output Contract

Always end your response with a one-line summary:
SUMMARY: [brief result description]
```

logActivity에서 SUMMARY 라인 추출:

```typescript
const summaryMatch = response.match(/SUMMARY:\s*(.+)/);
const outputSummary = summaryMatch ? summaryMatch[1].trim() : response.slice(0, 200);
```

**5b: 첫 5분 UX — 빈 상태**

Activity 빈 상태 메시지 개선:

```
"No activity yet. This agent will show logs here when Conductor delegates tasks to it.
 Try: ask Conductor to run a task for this agent."
```

Agents 탭 첫 진입 시 3개 시스템 에이전트 + 설명:

```
"These are your system agents. Conductor orchestrates, Dashboard generates briefings,
 Wiki compiles knowledge. Create your own agents with [+ New Agent]."
```

**검증:** 빈 상태 메시지 표시 확인 + delegate 후 메시지 사라지고 로그 표시

### Task 6: agent_test + audit 확장

**6a: agent_test 동작 검증**

1. 채팅: "dashboard-agent 테스트해줘"
2. daemon.log에서 agent_test 호출 확인
3. Activity에 test_run 결과 + expandable card

**6b: audit-checklist Step 4 확장**

`~/.mama/skills/audit-checklist.md`:

```
### Step 4: Check Agent Health
Run via Bash tool (DX #1 — Conductor has Tier 1 Bash access):
curl -s "http://localhost:3847/api/agents/activity-summary?since=$(node -e \"const d=new Date(Date.now()-86400000); console.log(d.toISOString().slice(0,10))\")"
- error_rate > 30%? → MAJOR
- consecutive_errors >= 3? → MAJOR
- enabled agent with no activity in 24h? → check
```

**6c: activity 30일 prune** (CEO #6)

audit cron에서 실행:

```sql
DELETE FROM agent_activity WHERE created_at < datetime('now', '-30 days');
```

### Task 7: 전체 E2E

1. 채팅: "QA 에이전트 만들고 테스트까지 해줘"
2. Conductor → agent_create → Agents 탭에 카드 (Running pulse)
3. Conductor → agent_test → Activity에 test_run (expandable)
4. Conductor 평가 보고 + "활성화할까요?"
5. "좋아" → agent_update → Active

**검증:** 3개 화면 전부 동작 + toast 알림 + 카드 상태 정확

---

## 코드 위치 참조

| 기능                                             | 파일                                | 줄                             |
| ------------------------------------------------ | ----------------------------------- | ------------------------------ |
| agent_create case                                | gateway-tool-executor.ts            | 587-606                        |
| executeDelegate + auto-log                       | gateway-tool-executor.ts            | sync: 2444-2506, bg: 2375-2428 |
| executeAgentTest                                 | gateway-tool-executor.ts            | 2183-2328                      |
| PUT multi-agent (config.yaml 수정)               | graph-api.ts                        | 2954-3175                      |
| loadMAMAConfig / saveMAMAConfig                  | graph-api.ts                        | 1968 / 2670                    |
| config-manager 기본 에이전트                     | config-manager.ts                   | 455-602                        |
| AgentProcessManager.updateConfig                 | agent-process-manager.ts            | 134                            |
| AgentProcessManager.reloadPersona                | agent-process-manager.ts            | 890                            |
| standalone wiring (applyMultiAgentConfig 미설정) | start.ts                            | 444-452                        |
| gateway wiring (applyMultiAgentConfig 설정)      | gateway-wiring.ts                   | 264                            |
| Conductor 페르소나                               | ~/.mama/personas/conductor.md       | 전체                           |
| audit-checklist                                  | ~/.mama/skills/audit-checklist.md   | 전체                           |
| agent_activity 테이블                            | db/agent-store.ts                   | initAgentTables                |
| Activity 탭 UI                                   | public/viewer/src/modules/agents.ts | renderActivityTab              |
| 상태 뱃지/카드                                   | public/viewer/src/modules/agents.ts | renderList                     |

## 데드코드 (이 브랜치에서 삭제하지 않음, 별도 정리)

- multi-agent-base.ts (827줄)
- multi-agent-discord.ts (1,477줄)
- multi-agent-slack.ts (1,205줄)
- ultrawork.ts (1,190줄)
- ultrawork-state.ts (201줄)

## 원칙

1. **데이터 먼저** — activity 기록이 동작해야 나머지가 의미 있음
2. 매 Task 완료 시 실제 MAMA OS에서 검증 (curl, DB, 뷰어)
3. 빈 배열이면 미완료
4. 서브에이전트 사용 안 함
5. 데드코드 위에 코드 쌓지 않음
6. **activity 30일 보존** — audit cron에서 prune
