# MAMA Command Center — Cross-Source Intelligence + Notion Integration

**Date:** 2026-04-08
**Branch:** feat/v018-output-layer
**Status:** Design approved, pending plan review

## Problem

MAMA OS의 대시보드(dashboard.ts)가 decision을 단순 나열하고 있어 집계/그룹핑/액션 제안이 없다. 커넥터(Slack, Notion, Discord, Gmail, Calendar, Claude Code 등)가 흡수한 크로스소스 데이터를 지능적으로 정리하는 레이어가 없다.

## Core Insight: MAMA의 정체성

MAMA는 "또 다른 Notion"이 아니다. MAMA는 **기억하는 신경계**다.

- **Notion** = 팀의 작업 공간 (Kanban, Timeline, Calendar — 이미 세계 최고 수준)
- **Obsidian** = 개인 지식 그래프 (그래프뷰, wikilinks, 로컬)
- **Slack/Discord/Telegram** = 대화 채널
- **MAMA** = 이 모든 것을 연결하고, 기억하고, 컴파일하고, 큐레이션하는 유일한 존재

Notion이 할 수 있는 기능은 Notion에게 맡긴다. MAMA는 **크로스소스 컴파일**에 집중한다.

## Architecture

```
[Connectors — 입력]              [MAMA Brain]                [출력 표면]

Slack ────────┐                                            ┌── MAMA Web (사령탑)
Notion ───────┤                  ┌──────────────┐          │   Summary + Notify
Discord ──────┤── poll/ingest ──→│ Memory DB    │          │   Pipeline (단계별)
Gmail ────────┤                  │ (decisions,  │──→ Wiki  │   Notion Cards
Calendar ─────┤                  │  scopes,     │   Agent  │   System 상태
Claude Code ──┤                  │  embeddings) │          │
Meeting 녹음 ─┘                  └──────┬───────┘          ├── Notion (팀 뷰)
                                        │                  │   Projects DB (Kanban)
                              Intelligence API              │   Decisions DB (Table)
                              /summary /pipeline            │   Wiki Pages
                                        │                  │
                                   Agent curates           ├── Obsidian (개인)
                                   → notices + alerts      │   그래프뷰, wikilinks
                                                           └── Bot (Slack/Discord/TG)
```

## Design

### 1. MAMA Web 사령탑 (dashboard.ts 재설계)

현재 307줄 4섹션(Briefing/Alerts/Activity/Pipeline)을 **경량 사령탑 4영역**으로 교체:

```
┌─────────────────────────────────────────────────────────┐
│  📋 Summary + Notify                                    │
│  "ProjectAlpha 피드백 3건 미반영, ProjectC 제출 완료"            │
│  ┌─ Agent Notices ────────────────────────────────────┐ │
│  │ 2m ago  Wiki Agent edited projects/ProjectAlpha.md        │ │
│  │ 15m ago Wiki Agent created lessons/auth-pattern.md │ │
│  │ 1h ago  Dashboard Agent updated summary            │ │
│  └────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│  🔄 Pipeline                          (변경순 ↑)        │
│  ProjectAlpha      대기2 진행1 피드백3 제출대기0 제출0    🔴 NEW │
│  ProjectC   대기0 진행0 피드백0 제출대기1 제출4    🟢     │
│  MAMA v0.18 대기5 진행2 피드백0 제출대기0 제출0    🟡     │
├─────────────────────────────────────────────────────────┤
│  📡 Connector Activity                                   │
│  📅 Calendar    오늘: 14:00 ProjectAlpha 미팅, 17:00 납기       │
│  💬 Slack       #proj-project-alpha 새 메시지 3건 (12분 전)      │
│  🥷 Kagemusha   ProjectAlpha 견적서 업데이트 (1h ago)            │
│  📋 Trello      ProjectAlpha: 피드백→제출대기 이동 (30m ago)     │
│  🤖 Claude Code  MAMA 세션 2개 활성 (47 messages)        │
│  📧 Gmail       미읽음 없음                              │
│  Notion ⚠️ 미연결 | Telegram ✓ idle                      │
├─────────────────────────────────────────────────────────┤
│  ⚙️ System                                              │
│  Agents: 3 ✓ | Wiki: 12p | Memory: 284 decisions        │
└─────────────────────────────────────────────────────────┘
```

커넥터가 연결된 이유가 보여야 한다. "5/5 ✓"가 아니라 **각 커넥터의 최신 1건 또는 오늘의 핵심**을 한 줄로 표시.
활동 없는 커넥터는 "idle", 미연결은 "⚠️ 미연결"로 축약.

**데이터 소스:**

- Summary: `GET /api/intelligence/summary` (에이전트 생성 텍스트 + 긴급 알림)
- Agent Notices: `GET /api/intelligence/notices` (AgentEventBus ring buffer)
- Pipeline: `GET /api/intelligence/pipeline` (Trello 커넥터 데이터 소비, 미연결 시 프로젝트+decision 수만 표시)
- Connector Activity: `GET /api/connectors/activity` (각 커넥터의 latest 1건 추출)
- System: `GET /api/metrics/health` + `GET /api/intelligence/projects`

**딥링크:**

- Obsidian: `obsidian://open?vault=MAMA&file=wiki/projects/{slug}`
- MAMA Wiki Tab: `/viewer#wiki?path=projects/{slug}.md`
- Notion: `https://notion.so/{pageId}` (Phase 2)

**대화(Q&A)는 대시보드에 없음** — 텔레그램/Slack/웹챗 탭에서 처리.

### 1b. Projects 탭 → Connector Feed 탭

기존 Projects 탭(projects.ts)은 decision 나열뿐이라 실질적 가치가 없다.
**커넥터별 raw 데이터 수집 뷰어**로 교체하여, 각 커넥터에 직접 가지 않고도 어떤 데이터가 수집되고 있는지 확인 가능하게 한다.

```
┌─ Connector Feed ──────────────────────────────────────┐
│                                                        │
│  [Calendar] [Slack] [Trello] [Kagemusha] [Claude Code] │
│                                                        │
│  ── Slack 선택 시 ──────────────────────────────────── │
│                                                        │
│  #proj-project-alpha                                           │
│    12:30 김대리: 피드백 반영해서 다시 보내드립니다       │
│    12:15 박과장: 3번 항목 수정 부탁드립니다              │
│                                                        │
│  #general                                              │
│    11:00 이사님: 내일 회의 15시로 변경                   │
│                                                        │
│  ── 마지막 폴링: 2분 전 | 수집: 47건/오늘 ────────── │
└────────────────────────────────────────────────────────┘
```

**데이터 소스:** `GET /api/connectors/:name/feed?limit=20`

- 각 커넥터의 raw store (SQLite: `~/.mama/connectors/<name>/raw.db`)에서 채널별 최신 데이터 조회
- 커넥터 미연결 시 해당 탭 비활성화

**뷰어 변경:**

- `projects.ts` → `connector-feed.ts` 로 교체
- 사이드바 탭: "Projects" → "Feed"
- 좌측: 커넥터 목록 (아이콘 + 이름 + 최신 폴링 시간)
- 우측: 선택된 커넥터의 채널별 raw 데이터

### 2. Notion은 읽기 전용 커넥터

Notion은 다른 커넥터(Slack, Trello, Gmail 등)와 동일하게 **읽기 전용** 소스로만 사용.

- 기존 `NotionConnector`(packages/standalone/src/connectors/notion/)가 Notion API를 폴링하여 NormalizedItem으로 변환
- NotionWriter는 만들지 않음 — MAMA의 역할은 데이터 흡수+컴파일이지 발행이 아님
- Obsidian만 Karpathy식 knowledge compilation 대상 (Wiki Agent → compile → Obsidian vault)
- Notion 데이터는 Connector Feed 탭에서 다른 커넥터와 동일하게 열람 가능

### 3. Intelligence API 확장

기존 4개 엔드포인트에 3개 추가:

| 엔드포인트                    | 상태 | 용도                       |
| ----------------------------- | ---- | -------------------------- |
| `GET /alerts`                 | 기존 | stale/low_confidence       |
| `GET /activity`               | 기존 | 최신 decisions             |
| `GET /projects`               | 기존 | 프로젝트별 집계            |
| `GET /projects/:id/decisions` | 기존 | 프로젝트 decisions         |
| **`GET /summary`**            | 신규 | 에이전트 생성 1줄 요약     |
| **`GET /pipeline`**           | 신규 | 프로젝트별 파이프라인 단계 |
| **`GET /notices`**            | 신규 | 에이전트 활동 로그         |

**`/pipeline` 데이터 소스:**

- Trello 커넥터 연결됨 → Trello 보드의 리스트별 카드 수를 그대로 사용 (대기/진행/피드백/제출대기/제출)
- Trello 미연결 → 프로젝트 + active decision 수만 표시 (단계 없음)
- 키워드 기반 단계 추론은 하지 않음 — 실제 데이터가 없으면 추측하지 않는다

Pure functions (테스트 가능):

- `buildPipelineFromTrello(trelloData, projects)` — Trello 리스트→단계 매핑 + 집계
- `buildPipelineFallback(projects)` — Trello 미연결 시 프로젝트 목록만 반환

### 4. AgentEventBus 확장

기존 이벤트에 추가:

```typescript
| { type: 'agent:action'; agent: string; action: string; target: string }
```

Notices ring buffer (최근 50개) + `getRecentNotices(limit)` 메서드 추가.

### 5. Wiki Agent 디버깅

Persona에 concrete tool_call JSON 예시 추가:

```
Step 1: {"name": "mama_search", "input": {"query": "ProjectAlpha project decisions", "limit": 10}}
Step 2: {"name": "wiki_publish", "input": {"pages": [{"path": "projects/ProjectAlpha.md", ...}]}}
```

기존 인프라(WikiCompiler, ObsidianWriter, wiki-handler, AgentEventBus 체인)는 변경 없음.

### 6. EventBus 체인

```
memory:saved ──(debounce 30s)──→ Wiki Agent
                                      │
                                 wiki:compiled
                                      │
                                ┌─────┴─────┐
                                ▼           ▼
                          Obsidian     Notion (옵셔널)
                                      │
                                 agent:action (notice)
                                      │
            ──(debounce 60s)──→ dashboard:refresh
                                      │
                                 Dashboard Agent
                                      │
                                 report_publish(summary)
                                      │
                                 agent:action (notice)
```

## File Changes

### Phase 1 (이번 브랜치) — New Files

| File                                                | Purpose                                   | Lines |
| --------------------------------------------------- | ----------------------------------------- | ----- |
| `src/api/connector-feed-handler.ts`                 | GET /api/connectors/activity, /:name/feed | ~80   |
| `public/viewer/src/modules/connector-feed.ts`       | Connector Feed 탭 (Projects 탭 교체)      | ~200  |
| `tests/api/intelligence-pipeline.test.ts`           | /summary, /pipeline, /notices tests       | ~60   |
| `tests/api/connector-feed-handler.test.ts`          | /connectors/activity, /feed tests         | ~50   |
| `tests/multi-agent/agent-event-bus-notices.test.ts` | Notices ring buffer tests                 | ~40   |

### Phase 1 — Modified Files

| File                                     | Change                                                                                | Delta |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ----- |
| `src/api/intelligence-handler.ts`        | +/summary, /pipeline, /notices + pure functions                                       | +100  |
| `src/multi-agent/agent-event-bus.ts`     | +agent:action event, notices buffer                                                   | +30   |
| `src/multi-agent/wiki-agent-persona.ts`  | +concrete tool_call examples                                                          | +15   |
| `src/cli/commands/start.ts`              | notices 연결 + connector feed 라우터 마운트                                           | +20   |
| `public/viewer/src/utils/api.ts`         | +types, +4 API methods (summary, pipeline, notices, connectorActivity, connectorFeed) | +45   |
| `public/viewer/src/modules/dashboard.ts` | Command center rewrite — 4섹션: Summary+Pipeline+ConnectorActivity+System             | ±200  |
| `public/viewer/viewer.html`              | Dashboard HTML + Feed 탭 (Projects 탭 교체)                                           | ±40   |

### Phase 1 — Deleted/Replaced Files

| File                                    | Reason                                        |
| --------------------------------------- | --------------------------------------------- |
| `public/viewer/src/modules/projects.ts` | Connector Feed 탭으로 교체 (projects.ts 삭제) |

### Phase 2 — 삭제됨

Notion은 읽기 전용 커넥터로 결정. NotionWriter/Notion Cards/dual writer 모두 불필요.
(decision: v018_notion_read_only)

### Unchanged (preserved from v0.18 branch)

WikiCompiler, ObsidianWriter, wiki types, wiki-handler, tool-registry, gateway-tools.md, NotionConnector — all untouched.

## Implementation Order

### Phase 1: 이번 브랜치 (feat/v018-output-layer)

```
Step 1 (병렬): 백엔드
  1a. intelligence-handler.ts: /pipeline + /notices + /summary
  1b. agent-event-bus.ts: agent:action + notices buffer
  1c. connector-feed-handler.ts: /connectors/activity + /:name/feed
  1d. wiki-agent-persona.ts: tool_call 예시

Step 2 (Step 1 후): 프론트엔드
  2a. api.ts: 타입 + 메서드 (intelligence + connector feed)
  2b. viewer.html: Dashboard HTML + Feed 탭 (Projects 탭 교체)
  2c. dashboard.ts: 사령탑 재설계 (Summary+Pipeline+ConnectorActivity+System)
  2d. connector-feed.ts: Connector Feed 탭 (projects.ts 교체)

Step 3: 테스트 + 검증
  3a. 신규 테스트
  3b. pnpm test (2453+ 통과)
  3c. pnpm build + 수동 검증
```

### Phase 2 — 삭제됨 (Notion = 읽기 전용 커넥터)

## Testing Strategy

1. **Pure function unit tests** — buildPipelineFromTrello, buildPipelineFallback, notices buffer, buildConnectorActivity
2. **API integration tests** — /summary, /pipeline, /notices, /connectors/activity, /connectors/:name/feed
3. **Existing tests** — 2453+ all pass, zero breakage
4. **Manual verification** — mama start → viewer → 사령탑 대시보드 4섹션 (Summary+Pipeline+ConnectorActivity+System) + Connector Feed 탭

## Constraints

- Existing 2453 tests must not break
- Hook performance: UserPromptSubmit < 1200ms (unaffected)
- Local-first: Notion/Trello 없어도 기본 동작
- No SQLite schema changes
- Pipeline 데이터: Trello 커넥터에서 가져옴 (키워드 추론 안 함)
