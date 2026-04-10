# v0.19 Epic 1: Interactive Agent Management

## Overview

MAMA OS 뷰어에 **대화형 에이전트 관리** 기능을 추가한다. Claude Managed Agents의 검증된 패턴(Agent CRUD, 버전 관리, per-tool 권한, optimistic concurrency)을 채택하고, SmartStore의 양방향 Agent↔UI 통신 패턴을 적용하여 **에이전트와 대화하면서 에이전트를 진화시키는** 인터랙티브 루프를 구현한다.

### 핵심 가치

수동 폼 UI가 아니라, 에이전트가 뷰어 상태를 인지하고 대화를 통해 설정을 변경하는 방식. 이 패턴은 경쟁 제품(Managed Agents Console, Mem0, CrewAI)에 없는 MAMA 고유 차별점이다.

### 범위

- Epic 1 (Agent Management) 완수가 목표
- Epic 2~6은 v0.19 백로그에 유지하되 이번 계획 범위 밖

---

## 1. 데이터 모델

### 1.1 agent_versions 테이블

에이전트 설정 변경 시마다 스냅샷을 보존한다. Managed Agents의 optimistic concurrency 패턴 적용.

```sql
CREATE TABLE agent_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  snapshot     TEXT NOT NULL,       -- JSON: {model, backend, tier, tools, effort, ...}
  persona_text TEXT,                -- persona .md 전문 (스냅샷 시점)
  change_note  TEXT,                -- 사람이 읽을 수 있는 변경 사유
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, version)
);
```

### 1.2 agent_metrics 테이블

버전별 성과를 일 단위로 집계하여 Before/After 비교를 지원한다.

```sql
CREATE TABLE agent_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  agent_version   INTEGER NOT NULL,
  period_start    TEXT NOT NULL,     -- ISO 8601 (일별)
  period_end      TEXT NOT NULL,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  tool_calls      INTEGER DEFAULT 0,
  delegations     INTEGER DEFAULT 0,
  errors          INTEGER DEFAULT 0,
  avg_response_ms REAL DEFAULT 0,
  UNIQUE(agent_id, agent_version, period_start)
);
```

### 1.3 동작 방식

- config.yaml 저장 시 → `agent_versions`에 새 row (현재 설정 snapshot + persona 전문)
- token-handler 기록 시 → `agent_metrics`에 현재 버전 번호와 함께 집계
- Before/After 비교 → 같은 agent_id의 version N vs M 메트릭 쿼리

---

## 2. API 레이어

Managed Agents REST 구조를 1:1 매핑. 기존 `/api/multi-agent/agents/*`에서 `/api/agents/*`로 단순화 (기존 경로 redirect 유지).

### 2.1 에이전트 CRUD

| Method | Endpoint                   | Managed Agents 대응            | 설명                    |
| ------ | -------------------------- | ------------------------------ | ----------------------- |
| POST   | `/api/agents`              | `POST /v1/agents`              | 생성 + version 1 자동   |
| GET    | `/api/agents`              | `GET /v1/agents`               | 전체 목록 (상태 포함)   |
| GET    | `/api/agents/:id`          | `GET /v1/agents/{id}`          | 단일 상세               |
| POST   | `/api/agents/:id`          | `POST /v1/agents/{id}`         | 업데이트 (version 필수) |
| POST   | `/api/agents/:id/archive`  | `POST /v1/agents/{id}/archive` | 아카이브                |
| GET    | `/api/agents/:id/versions` | `GET /v1/agents/{id}/versions` | 버전 히스토리           |

### 2.2 메트릭 / 모니터링

| Method | Endpoint                                   | 설명                      |
| ------ | ------------------------------------------ | ------------------------- |
| GET    | `/api/agents/:id/metrics?from=&to=`        | 기간별 메트릭 조회        |
| GET    | `/api/agents/:id/logs?limit=`              | 에이전트 실행 로그        |
| GET    | `/api/agents/:id/versions/:v1/compare/:v2` | 버전 간 Before/After 비교 |

### 2.3 Agent 객체 스키마

```typescript
interface MamaAgent {
  // Managed Agents 동일 필드
  id: string;
  name: string;
  model: string;
  system: string; // persona 전문
  description: string | null;
  tools: ToolConfig[];
  metadata: Record<string, string>;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;

  // MAMA 고유 필드
  backend: 'claude' | 'codex-mcp';
  tier: 1 | 2 | 3;
  effort: 'low' | 'medium' | 'high' | 'max';
  can_delegate: boolean;
  trigger_prefix: string;
  cooldown_ms: number;
  auto_continue: boolean;
  persona_file: string;
}
```

### 2.4 도구 설정 (Managed Agents per-tool override 패턴)

```typescript
interface ToolConfig {
  type: 'mama_toolset';
  default_config: {
    enabled: boolean;
    permission_policy: 'always_allow' | 'always_ask';
  };
  configs: Array<{
    name: string; // 'Bash', 'Edit', 'Write', 'Read', ...
    enabled?: boolean;
    permission_policy?: 'always_allow' | 'always_ask';
  }>;
}
```

Tier 프리셋을 기본으로 적용하되 개별 도구 오버라이드 허용:

- T1: 전체 enabled
- T2: Read/Grep/Glob/WebSearch/WebFetch enabled
- T3: Read/Grep/Glob enabled

### 2.5 Update 시맨틱 (Managed Agents 동일)

- version 필수 — 불일치 시 409 Conflict
- 미전송 필드 = 기존 값 보존
- 배열 필드(tools)는 전체 교체
- 변경 없으면 버전 증가 안 함 (no-op detection)

### 2.6 뷰어 UI 조작 API

SmartStore `NavigationContext` + Layout command polling 패턴 이식.

| Method | Endpoint               | 설명                                   |
| ------ | ---------------------- | -------------------------------------- |
| POST   | `/api/ui/page-context` | 뷰어 → 에이전트: 현재 페이지 상태 보고 |
| GET    | `/api/ui/commands`     | 에이전트 → 뷰어: UI 커맨드 폴링 (1초)  |
| POST   | `/api/ui/commands`     | 에이전트가 UI 커맨드 발행              |

---

## 3. Agent↔Viewer 양방향 통신

SmartStore의 검증된 패턴을 MAMA OS 뷰어에 이식한다.

### 3.1 뷰어 → 에이전트 (Page Context)

각 뷰어 모듈이 현재 표시 상태를 에이전트에게 보고한다.

```typescript
// SmartStore의 usePageReporter() → MAMA vanilla TS 변환
function reportPageContext(route: string, data: PageData): void {
  fetch('/api/ui/page-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentRoute: route, pageData: data }),
  });
}

// Agents 모듈에서 호출 예시
reportPageContext('agents', {
  pageType: 'agent-detail',
  tab: 'persona',
  selectedAgent: 'conductor',
  agentVersion: 4,
  summary: 'Conductor v4 페르소나 편집 중',
});
```

### 3.2 에이전트 → 뷰어 (UI Commands)

Layout에서 1초 간격 폴링. SmartStore Layout.tsx:70-103 패턴 그대로.

```typescript
// 에이전트가 발행하는 커맨드 타입
type UICommand =
  | { type: 'navigate'; payload: { route: string; params?: Record<string, string> } }
  | { type: 'notify'; payload: { message: string; severity: 'info' | 'warning' } }
  | {
      type: 'suggest_change';
      payload: {
        agentId: string;
        changes: Partial<MamaAgent>;
        reason: string;
      };
    }
  | { type: 'refresh'; payload: { target: string } };
```

### 3.3 에이전트 시스템 프롬프트 내 뷰어 상태 주입

에이전트가 응답할 때 현재 뷰어 상태를 컨텍스트로 받는다:

```
[Viewer Context]
현재 사용자가 보고 있는 화면: Agents > conductor > Metrics 탭
선택된 비교 구간: v3 vs v4
표시된 메트릭: tokens/day v3=38.2k → v4=12.3k
```

---

## 4. 에이전트 Gateway Tools

에이전트가 뷰어를 조작하고 자기 자신을 포함한 에이전트 설정을 변경할 수 있는 도구.

### 4.1 도구 목록

| Tool              | 설명                              | 대화 예시                               |
| ----------------- | --------------------------------- | --------------------------------------- |
| `viewer_navigate` | 뷰어 페이지/탭 이동               | "메트릭을 보여줄게요" → Metrics 탭 열기 |
| `viewer_notify`   | 토스트/알럿 표시                  | "v5 적용 완료" 알림                     |
| `agent_get`       | 에이전트 현재 설정 조회           | "conductor 설정을 확인해볼게요"         |
| `agent_update`    | 에이전트 설정 변경 (version 필수) | "페르소나를 수정합니다"                 |
| `agent_create`    | 새 에이전트 생성                  | "QA 전문 에이전트를 만들어줄게요"       |
| `agent_compare`   | 버전 간 메트릭 비교               | "v3과 v4의 토큰 사용량을 비교하면..."   |

### 4.2 도구 스키마

```typescript
// agent_get
{ agent_id: string }
// → MamaAgent 전체 객체

// agent_update
{
  agent_id: string,
  version: number,           // optimistic concurrency
  changes: Partial<MamaAgent>,
  change_note: string
}
// → { success: true, new_version: number }

// agent_create
{
  id: string,
  name: string,
  model: string,
  tier: 1 | 2 | 3,
  system: string,            // persona 텍스트
  backend?: string,
  tools?: ToolConfig[]
}
// → MamaAgent (version: 1)

// agent_compare
{
  agent_id: string,
  version_a: number,
  version_b: number
}
// → { config_diff: object, metrics: { version_a: Metrics, version_b: Metrics } }

// viewer_navigate
{
  route: string,
  params?: Record<string, string>  // { id, tab, compareV1, compareV2 }
}

// viewer_notify
{
  type: 'info' | 'warning' | 'suggest',
  message: string,
  action?: { label: string, navigate: object }
}
```

### 4.3 안전장치

- **agent_update 호출 전**: 에이전트는 변경 내용을 사용자에게 표시하고 동의를 받아야 함 (persona에 명시)
- **Optimistic concurrency**: version 불일치 시 409 반환, 에이전트가 재시도
- **시스템 에이전트 보호**: memory/dashboard/wiki 에이전트의 핵심 필드(persona의 version marker 섹션) 변경 제한
- **롤백**: `agent_versions`에서 이전 snapshot 복원 가능

---

## 5. 뷰어 UI

### 5.1 구조

독립 탭 `[Agents]`를 뷰어에 추가.

```
[Memory] [Dashboard] [Graph] [Agents] [Settings] ...
```

### 5.2 에이전트 목록 (메인)

카드 그리드: 이름, 모델, 티어, 현재 버전, 상태(Running/Idle/Dead), 일일 토큰.
사용자 에이전트 + 시스템 에이전트(memory, dashboard, wiki) 모두 표시.
`[+ New Agent]` 버튼.

### 5.3 에이전트 상세 (카드 클릭)

5개 서브 탭:

- **Config**: 이름, backend, model, tier, effort, delegate, trigger, cooldown. Save 시 version bump.
- **Persona**: 마크다운 에디터로 persona .md 직접 편집. Save 시 version bump.
- **Tools**: Tier 프리셋 기반 + 개별 도구 on/off 토글 + permission policy 드롭다운. Managed Agents `agent_toolset` 패턴.
- **Metrics**: 기간 선택 + 버전 간 Before/After 비교 (토큰, 도구 호출, 에러, 응답 시간). 일별 차트.
- **History**: 버전 히스토리 목록. 버전 선택 시 config diff 표시.

### 5.4 에이전트 생성

모달: ID(slug) + Name + Backend/Model + Tier → `POST /api/agents` → version 1 → 상세 화면 이동.

### 5.5 인터랙티브 요소

- **suggest_change 카드**: 에이전트가 보낸 변경 제안이 상세 뷰 상단에 카드로 표시. "적용" / "무시" 버튼.
- **실시간 상태**: command polling으로 에이전트가 탭 전환, 데이터 하이라이트 등 UI 조작 가능.
- **채팅 연동**: Chat 모듈에서 대화하면서 Agents 탭이 연동 (navigate 커맨드).

---

## 6. 기존 코드와의 관계

### 6.1 활용하는 기존 코드

| 파일                         | 활용                                                |
| ---------------------------- | --------------------------------------------------- |
| `agent-process-manager.ts`   | 에이전트 spawn/stop/restart, persona 로딩           |
| `tool-permission-manager.ts` | tier→도구 프리셋, 와일드카드 매칭                   |
| `agent-event-bus.ts`         | 이벤트 체인 (agent:action → UI refresh)             |
| `token-handler.ts`           | 토큰 집계 확장 (per-version)                        |
| `graph-api.ts`               | 기존 /api/multi-agent/\* 핸들러 (마이그레이션 기반) |
| `config-manager.ts`          | config.yaml 읽기/쓰기 + hot-reload                  |

### 6.2 마이그레이션

- `GET/PUT /api/multi-agent/agents/*` → `/api/agents/*` redirect
- `handleMultiAgentAgentsRequest` → 새 핸들러로 교체 (버전 관리 추가)
- Settings 모듈의 agent 카드 → Agents 모듈로 이동 (Settings에서 제거)

### 6.3 SmartStore에서 이식하는 패턴

| SmartStore 소스                                      | MAMA 대상                         | 변환                             |
| ---------------------------------------------------- | --------------------------------- | -------------------------------- |
| `NavigationContext.tsx` — `usePageReporter()`        | viewer 공통 `reportPageContext()` | React hook → vanilla TS 함수     |
| `Layout.tsx:70-103` — command polling                | viewer entry point                | React useEffect → setInterval    |
| `AIActionCard.tsx` — 에이전트 제안 카드              | Agents 모듈 suggest_change 카드   | React component → vanilla TS DOM |
| `client.ts` — `getUICommands()`, `pushPageContext()` | viewer API client                 | 직접 이식                        |

---

## 7. 인터랙티브 시나리오 (검증 기준)

### 시나리오 1: 대화로 에이전트 최적화

```
사용자: "conductor가 토큰을 너무 많이 쓰는데 줄일 수 있어?"
에이전트: [viewer_navigate → Agents/conductor/metrics]
         메트릭 분석 + 원인 설명 + A/B 제안
사용자: "persona를 수정해보자"
에이전트: [viewer_navigate → Agents/conductor/persona]
         [agent_get → 현재 persona 조회]
         변경 내용 제시 + 사용자 확인
사용자: "좋아"
에이전트: [agent_update → v5 생성]
         [viewer_notify → "v5 적용 완료"]
```

### 시나리오 2: 에러 기반 권한 자동 제안

```
에이전트가 Write 도구 호출 시 permission denied 3회 감지
→ AgentEventBus에서 이벤트 발생
→ suggest_change 커맨드로 UI에 제안 카드 표시
→ 사용자가 "적용" 클릭 또는 채팅으로 논의
```

### 시나리오 3: 새 에이전트 생성

```
사용자: "QA 전문 에이전트를 만들고 싶어"
에이전트: ID/이름/역할/티어 대화로 확인
         [agent_create → version 1]
         [viewer_navigate → Agents/qa-specialist/persona]
         "기본 페르소나를 생성했습니다. 수정할 부분이 있나요?"
```
