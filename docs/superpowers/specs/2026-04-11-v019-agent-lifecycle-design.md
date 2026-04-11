# v0.19 Agent Lifecycle — Create, Verify, Track

> 에이전트를 대화로 만들고, 자동으로 검증하고, 운영을 추적하는 시스템.
>
> **Scope:** 이 문서는 전체 비전. v0.19에서는 Phase 1A (Config 편집 + Tools 저장 + enable/disable) + Phase 2A (agent_activity + Activity 탭)만 구현. Phase 1B-4는 후속 버전.
>
> **Review:** Codex + Claude 서브에이전트 리뷰 반영 (2026-04-11). Critical 6건 수정.

## Problem

현재 MAMA Agents 탭은 틀만 있다. Config 수정 불가, Tools 저장 안 됨, 검증 시스템 없음, 운영 추적 없음. 사용자가 에이전트를 실제로 "관리"할 수 없다.

Claude Managed Agents는 Agent → Session → Events 라이프사이클로 이 문제를 풀지만, 클라우드 전용이고 MCP 서버를 직접 연결해야 한다. MAMA는 커넥터 데이터가 이미 로컬에 있고, AI 판단 기반 자동화가 가능하다.

## Key Architecture Decision (Review 반영)

**Settings 탭에 이미 에이전트 편집 UI가 존재한다** (`settings.ts:1145-1245`, `PUT /api/multi-agent/agents/:id`). 새로운 API를 만들지 않고 이 경로를 재사용한다.

- **런타임 소스**: `config.yaml` → `PUT /api/multi-agent/agents/:id`로 수정 + 핫리로드
- **감사 소스**: `agent_versions` 테이블 → 변경 이력 기록 (best-effort, 런타임에 영향 없음)
- **Settings → Agents 통합**: Settings의 에이전트 섹션을 Agents 탭으로 이동. Settings에서는 제거.

## Core Principles

1. **사용자는 Conductor에게만 말한다** — 개별 에이전트와 직접 대화하지 않음
2. **Conductor가 오케스트레이션한다** — 에이전트 생성, 위임, 평가, 보고 전부 Conductor 역할
3. **뷰어는 실시간으로 반응한다** — 에이전트 생성/테스트/활성화가 뷰어에 즉시 반영
4. **핫리로드** — MAMA OS 재시작 없이 에이전트 추가/변경
5. **전 채널 보고** — 채팅 + Dashboard + Wiki + 외부 채널

## Architecture

```
사용자 ←→ Conductor (OS 에이전트, 유일한 인터페이스)
              │
              ├── agent_create()     → 에이전트 생성 + 핫리로드
              ├── agent_update()     → 설정 변경 + 버전 생성
              ├── agent_test()       → 테스트 세션 실행 (NEW)
              ├── agent_evaluate()   → 결과 평가 + 점수 (NEW)
              ├── delegate()         → 작업 위임
              ├── viewer_navigate()  → 뷰어 실시간 이동
              ├── viewer_notify()    → Toast/알림
              ├── report_publish()   → Dashboard 슬롯
              └── wiki_publish()     → Wiki 문서 생성
```

## Phase 1: Create (에이전트 생성)

### 1.1 대화 기반 생성

```
사용자: "납품 추적하는 에이전트 만들어줘"
Conductor:
  1. 커넥터 확인 → drive ✓ sheets ✓ kagemusha ✓
  2. 에이전트 설정 자동 설계:
     - name, model, system prompt, tools, connector bindings
  3. agent_create() 호출
  4. viewer_navigate('agents') → 새 카드 실시간 표시
  5. 채팅: "납품 감시 에이전트 v1을 만들었습니다. 테스트할까요?"
```

### 1.2 에이전트 설정 구조

Claude MA의 Agent 구조를 따르되 MAMA 고유 필드 추가:

```yaml
# Agent Config (agent_versions 테이블에 snapshot으로 저장)
name: '납품 감시'
display_name: '📦 납품 감시'
model: claude-sonnet-4-6
system: |
  Drive에 새 파일이 추가되면 납품으로 판단하고:
  1. 프로젝트명을 시트에서 매칭
  2. 납품 채널에 알림
  3. 시트에 납품 기록 추가
tools:
  agent_toolset:
    enabled: [Bash, Read, Write, Glob, Grep]
  connectors: [drive, kagemusha, sheets]
tier: 2
can_delegate: false
trigger_prefix: '!delivery'
cooldown_ms: 5000
enabled: true
```

### 1.3 Config 탭 편집

Settings 탭의 에이전트 카드 (`settings.ts:1145-1245`)를 Agents 탭으로 이동. 저장은 기존 `PUT /api/multi-agent/agents/:id` 사용 (핫리로드 포함). agent_versions에 감사 기록 추가 (best-effort).

| 필드                | 편집 방식                        | 저장 시 동작                                                |
| ------------------- | -------------------------------- | ----------------------------------------------------------- |
| name / display_name | 텍스트 입력                      | PUT multi-agent → 핫리로드 + agent_versions 감사 기록       |
| backend             | 드롭다운 (claude/codex-mcp)      | PUT multi-agent → 핫리로드 + agent_versions 감사 기록       |
| model               | 드롭다운 (backend별 옵션)        | PUT multi-agent → 핫리로드 + agent_versions 감사 기록       |
| system prompt       | Persona 탭 텍스트에어리어 (기존) | PUT multi-agent → 핫리로드 + agent_versions 감사 기록       |
| tools               | 체크박스 토글 + Save 버튼        | PUT multi-agent → 핫리로드 + agent_versions 감사 기록       |
| tier                | 드롭다운 (T1/T2/T3)              | PUT multi-agent → 핫리로드 + agent_versions 감사 기록       |
| enabled             | 토글 스위치                      | PUT multi-agent → 즉시 핫리로드 (Settings toggleAgent 동일) |
| can_delegate        | 체크박스                         | PUT multi-agent → 핫리로드                                  |

### 1.4 템플릿 시스템

범용 템플릿이 아닌 **커넥터 데이터 기반 동적 추천**.

#### 템플릿 구조

```yaml
# ~/.mama/agent-templates/delivery-monitor.yaml
template:
  id: delivery-monitor
  name: '📦 납품 감시'
  description: 'Drive에 파일이 추가되면 프로젝트 매칭 → 시트 기록 → 채널 알림'
  required_connectors: [drive, sheets, kagemusha]
  optional_connectors: [gmail] # 있으면 담당자에게 메일 알림 추가
  category: monitoring # monitoring | analysis | processing | reporting

agent:
  model: claude-sonnet-4-6
  tier: 2
  system: |
    Drive에 새 파일이 추가되면 납품으로 판단하고:
    1. 파일명/경로에서 프로젝트명 추출
    2. Sheets에서 프로젝트명 매칭
    3. 납품 채널에 알림 (파일명, 프로젝트명, 시간)
    4. Sheets 납품 기록 행 추가
  tools:
    agent_toolset:
      enabled: [Read, Glob, Grep, Bash]
    connectors: [drive, sheets, kagemusha]

test:
  description: '최근 Drive 변경 파일 3건으로 납품 감지 테스트'
  count: 3
  success_criteria: '3건 중 2건 이상 프로젝트 매칭 성공'
```

#### 커넥터 조합별 템플릿 카탈로그

| 패턴                | 필요 커넥터                  | 템플릿                                    |
| ------------------- | ---------------------------- | ----------------------------------------- |
| **모니터링 → 알림** | sheets + calendar            | 마감 경보기, SLA 모니터                   |
| **모니터링 → 기록** | drive + sheets + kagemusha   | 납품 감시, 산출물 추적                    |
| **수집 → 분석**     | kagemusha + sheets           | 프로젝트 진행 요약, 클라이언트 인텔리전스 |
| **변환 → 기록**     | gmail + sheets               | 메일→태스크 변환, 청구서 추적             |
| **종합 → 보고**     | kagemusha + drive + calendar | 미팅 브리핑, 팀원 맥락 브리퍼             |
| **분석 → 문서**     | sheets + kagemusha           | 주간 리포트, 스프린트 회고                |

#### 동적 추천 플로우

```
사용자: "에이전트 만들어줘" (또는 Agents 탭에서 + New Agent)
           ↓
Conductor:
  1. 활성 커넥터 목록 조회 (connector list API)
  2. 각 커넥터의 최근 데이터 샘플링 (어떤 데이터가 있는지 파악)
  3. 템플릿 카탈로그에서 required_connectors 매칭
  4. 매칭된 템플릿 + 사용자 데이터 기반 커스터마이즈 제안:

채팅: "현재 연결된 커넥터: Drive ✓ Sheets ✓ Kagemusha ✓ Gmail ✓ Calendar ✓

만들 수 있는 에이전트:

📦 납품 감시 (Drive+Sheets+Kagemusha)
   → ProjectA 폴더에서 최근 파일 3건 감지됨. 바로 테스트 가능.

📧 메일→태스크 변환 (Gmail+Sheets)
   → 최근 미답변 메일 5건 있음. 자동 태스크 생성 가능.

📊 프로젝트 현황 요약 (Sheets+Kagemusha)
   → PROJECT_DB 시트에 프로젝트 42건. 주간 요약 자동화 가능.

⏰ 마감 경보기 (Sheets+Calendar)
   → 3일 내 마감 태스크 2건 감지. 알림 에이전트 추천.

어떤 에이전트를 만들까요? 또는 원하는 역할을 설명해주세요."
```

### 1.5 전체 생성 플로우 (상세)

```
[Step 1] 사용자 요청
  ├── A) 채팅: "납품 추적하는 에이전트 만들어줘"
  ├── B) 채팅: "에이전트 뭐 만들 수 있어?" → 템플릿 추천
  └── C) Agents 탭: "+ New Agent" → Conductor에게 자동 질문

[Step 2] Conductor가 설계
  ├── 커넥터 데이터 확인
  ├── 템플릿 매칭 또는 자연어에서 설정 생성
  ├── 에이전트 설정 YAML 구성
  └── 채팅: "이런 에이전트를 만들겠습니다: [설정 요약]. 진행할까요?"

[Step 3] 사용자 승인
  └── "좋아" / "모델을 opus로 바꿔" / "도구에 WebFetch도 추가해"

[Step 4] 에이전트 생성 + 뷰어 반영
  ├── agent_create() → config.yaml 핫리로드
  ├── viewer_navigate('agents') → Agents 탭으로 이동
  ├── 새 에이전트 카드 실시간 표시
  └── 채팅: "✅ 납품 감시 에이전트 v1 생성 완료. 테스트할까요?"

[Step 5] 자동 검증 (→ Phase 2로)
```

## Phase 2: Verify (검증)

### 2.1 전체 검증 플로우 (상세)

```
[Step 1] 테스트 데이터 수집
  Conductor:
  ├── 커넥터 API로 최근 실제 데이터 N건 수집
  │   예: Drive 최근 파일 3건, Gmail 최근 메일 5건
  ├── 템플릿에 test.count 정의되어 있으면 그 수만큼
  └── 채팅: "최근 데이터 3건으로 테스트합니다..."

[Step 2] 시뮬레이션 실행
  Conductor:
  ├── delegate(대상에이전트, '이 데이터를 처리해: [테스트 데이터]')
  ├── 각 건별 처리 결과 수집
  │   예: {input: "파일명.mov", output: "프로젝트 A에 매칭, 시트 기록 완료"}
  ├── viewer_navigate('agents', {id: agentId, tab: 'activity'})
  └── 뷰어: Activity 탭에 테스트 실행 로그 실시간 표시

[Step 3] 결과 평가 (Conductor가 직접 수행)
  Conductor:
  ├── 각 건의 input/output을 검토
  ├── 평가 기준 적용:
  │   ├── 정확도: N건 중 올바르게 처리한 비율
  │   ├── 도구 사용: 적절한 도구를 호출했는가
  │   ├── 결과 품질: 출력이 의도에 부합하는가
  │   └── 에러 여부: 예외 없이 완료했는가
  ├── 종합 점수 산출 (0-100)
  └── 개선 제안 생성

[Step 4] 결과 보고
  ├── 채팅: "테스트 완료 — 85점 (3건 중 2건 정확)
  │          ❌ 1건 실패: 파일명에서 프로젝트명 추출 못함
  │          💡 제안: system prompt에 프로젝트 목록 참조 추가"
  ├── Agents 탭 Activity: 테스트 결과 카드 표시
  ├── agent_activity_log(type='test_run', score=85, ...)
  └── Wiki: 테스트 기록 자동 저장

[Step 5] 개선 루프 (필요 시)
  사용자: "제안대로 수정해줘"
  Conductor:
  ├── agent_update() → system prompt 수정 → v2 생성
  ├── 동일 테스트 데이터로 재실행
  ├── Before/After 비교:
  │   "v1: 70점 (2/3) → v2: 95점 (3/3)"
  └── 채팅: "v2가 더 좋습니다. 활성화할까요?"

[Step 6] 활성화
  사용자: "좋아 운영해"
  Conductor:
  ├── agent_enable(agentId, true) → 핫리로드
  ├── viewer_notify('납품 감시 에이전트가 활성화되었습니다')
  ├── Agents 탭: 카드 상태 → Active (녹색)
  └── 채팅: "✅ 활성화 완료. 운영 중 이상이 있으면 알려드리겠습니다."
```

### 2.2 평가 데이터 구조

```yaml
# agent_activity에 저장되는 테스트 결과
type: test_run
agent_id: delivery-monitor
agent_version: 2
input_summary: 'Drive 파일 3건 테스트'
output_summary: '3건 중 3건 정확 (v1 대비 +1건 개선)'
score: 95
details:
  total: 3
  passed: 3
  failed: 0
  items:
    - input: 'c130302-Animation_4_Loop.mov'
      expected: 'ProjectA 프로젝트 매칭'
      actual: 'ProjectA 프로젝트 매칭 → 시트 기록 완료'
      result: pass
    - input: 'SD_typhoon_addition_draft.psd'
      expected: 'ProjectB 프로젝트 매칭'
      actual: 'ProjectB 프로젝트 매칭 → 납품 채널 알림'
      result: pass
    - input: 'meeting_notes_0411.pdf'
      expected: '납품 아님 → skip'
      actual: '납품 아님으로 판단 → skip'
      result: pass
suggestion: null # 전부 통과 시 없음
```

### 2.3 검증 기록

모든 테스트 결과는 영구 보존:

- `agent_activity` 테이블에 type='test_run'으로 기록
- Wiki에 자동 문서화: "에이전트명 테스트 기록 YYYY-MM-DD"

## Phase 3: Track (추적)

### 3.0 전체 추적 플로우 (상세)

```
[운영 중] 에이전트 활성화 상태
           ↓
[Step 1] 실행 이벤트 자동 기록
  에이전트가 작업할 때마다:
  ├── task_start → agent_activity 기록
  ├── 도구 호출 로그 (tools_called)
  ├── task_complete 또는 task_error → 결과 기록
  └── 토큰 사용량 집계 (tokens_used)

[Step 2] 실시간 뷰어 반영
  ├── Agents 탭 카드: 상태 뱃지 갱신 (active → idle → error)
  ├── Activity 피드: 새 로그 추가
  └── Dashboard: 에이전트 활동 카운터 갱신

[Step 3] Conductor 주기 점검 (cron 또는 heartbeat)
  매일 아침 / 매 시간:
  ├── agent_activity 집계 쿼리
  ├── 이상 감지 로직:
  │   ├── 에러율 > 30% → 경고
  │   ├── 에러 3회 연속 → 긴급 알림
  │   ├── 토큰 급증 (전일 대비 3배) → 비용 경고
  │   └── 24시간 무활동 → "에이전트 작동 중인가?" 확인
  └── 보고 생성

[Step 4] 보고 (채널별 분기)
  정상 운영:
  ├── Dashboard briefing: "어제 에이전트 활동 요약"
  └── Wiki: 주간 성과 문서 자동 업데이트

  이상 감지 시:
  ├── 채팅: "⚠️ 납품 감시 에이전트 에러 연속 — 확인 필요"
  ├── Toast: 뷰어 알림
  ├── 외부 채널: Slack/Discord/Telegram
  └── Wiki: 인시던트 기록

[Step 5] 자동 대응 (선택적)
  Conductor:
  ├── 에러 원인 분석 (최근 에러 로그 검토)
  ├── 자동 수정 시도 (system prompt 조정 → 새 버전)
  ├── 재검증 (Phase 2 루프)
  └── 채팅: "에러 원인: API 응답 형식 변경. v3으로 수정했습니다. 테스트 결과 95점."
```

### 3.1 실행 이벤트 기록

```sql
CREATE TABLE IF NOT EXISTS agent_activity (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  agent_version   INTEGER NOT NULL,
  type            TEXT NOT NULL,  -- task_start, task_complete, task_error, test_run, config_change
  input_summary   TEXT,
  output_summary  TEXT,
  tokens_used     INTEGER DEFAULT 0,
  tools_called    TEXT,           -- JSON array
  duration_ms     INTEGER DEFAULT 0,
  score           REAL,           -- 검증 시 평가 점수
  details         TEXT,           -- JSON (테스트 결과 items, suggestion 등)
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_agent ON agent_activity(agent_id, created_at);
```

**자동 로깅:** delegation handler (`gateway-tool-executor.ts`)에서 delegate 시작/완료/에러 시 자동으로 `logActivity()` 호출. Conductor가 수동으로 `agent_activity_log`를 호출할 필요 없음.

### 3.2 실시간 모니터링

| 채널                    | 내용                                             | 갱신 주기          |
| ----------------------- | ------------------------------------------------ | ------------------ |
| Agents 탭 카드          | 상태 뱃지 (active/idle/error) + 마지막 실행 시각 | 실시간 (WebSocket) |
| Agents 탭 Activity 피드 | 시간순 실행 로그 (Metrics 탭 대체)               | 페이지 로드 시     |
| Dashboard 에이전트 카드 | 에이전트별 오늘 실행 횟수 + 에러 수              | 브리핑 갱신 시     |

### 3.3 주기 보고 (Conductor가 자동 수행)

```
매일 아침:
  Conductor → agent_activity 집계
  → Dashboard briefing: "어제 에이전트 활동: 납품감시 5건, 메일변환 12건, 에러 0건"
  → Wiki: 주간 에이전트 성과 문서 자동 업데이트

이상 감지 시:
  Conductor → 에러 3회 연속 감지
  → 채팅: "납품 감시 에이전트 에러 연속 — 확인 필요"
  → Toast: 뷰어 알림
  → 외부 채널: Slack/Discord/Telegram 알림
```

### 3.4 보고 채널 매핑

| 결과 유형   | 즉시 알림           | 시각적 현황      | 영구 기록             |
| ----------- | ------------------- | ---------------- | --------------------- |
| 작업 완료   | 채팅 인라인         | Agents Activity  | agent_activity        |
| 승인 필요   | 채팅 + 외부 채널    | Dashboard alerts | agent_activity        |
| 에러/이상   | Toast + 외부 채널   | Dashboard alerts | agent_activity + Wiki |
| 주기 보고   | Dashboard briefing  | Dashboard        | Wiki                  |
| 테스트 결과 | 채팅 (점수+피드백)  | Agents History   | Wiki + agent_activity |
| 버전 변경   | 채팅 (Before/After) | Agents History   | agent_versions        |

## New Gateway Tools

기존 도구에 추가:

| 도구                 | 파라미터                        | 설명                                           |
| -------------------- | ------------------------------- | ---------------------------------------------- |
| `agent_test`         | agent_id, test_data?, count?    | 최근 커넥터 데이터로 에이전트 테스트 세션 실행 |
| `agent_evaluate`     | agent_id, test_results          | 테스트 결과 평가 (정확도, 품질, 에러)          |
| `agent_enable`       | agent_id, enabled               | 에이전트 활성화/비활성화 토글                  |
| `agent_activity_log` | agent_id, type, summary, score? | 실행 이벤트 기록                               |

## Viewer Changes

### Agents 탭 리스트 뷰 개선

현재 카드에 추가:

- 상태 뱃지 (active/idle/error/disabled)
- 마지막 실행 시각
- 오늘 실행 횟수
- enable/disable 토글

### Agents 탭 상세 뷰 탭 재구성

| 탭       | 변경                     | 내용                                         |
| -------- | ------------------------ | -------------------------------------------- |
| Config   | 읽기전용 → **편집 가능** | model, tier, tools, connectors, enabled 토글 |
| Persona  | 유지                     | system prompt 편집 + 버전 생성               |
| Tools    | 표시만 → **저장 가능**   | 체크박스 + Save 버튼                         |
| Activity | **신규** (Metrics 대체)  | 시간순 실행 로그 + 테스트 결과               |
| History  | 유지 + **점수 표시**     | 버전별 테스트 점수 + diff                    |

### agents.ts 인라인 스타일 → Tailwind 전환

현재 100% 인라인 스타일을 Tailwind 클래스로 전환하여 디자인 시스템 일관성 확보.

## What This Is NOT

- **Claude MA 클론이 아니다** — Environment/Session/Vault는 도입하지 않음 (로컬 실행이므로 불필요)
- **n8n/Zapier 대체가 아니다** — 규칙 기반 자동화가 아닌 AI 판단 기반 자동화
- **UI 위저드가 아니다** — 1차는 대화 기반 생성. UI 위저드는 향후 고려

## n8n/Zapier vs MAMA 포지셔닝

```
n8n:  트리거 → 규칙 분기 → 액션  (노드 드래그 + JSON 매핑)
MAMA: 트리거 → AI 판단 → 액션  (자연어 대화로 설정)
```

MAMA가 차지하는 영역: "판단이 필요한 자동화"

- 메일을 읽고 견적인지 문의인지 **판단**해서 처리
- 납품물을 보고 프로젝트를 **매칭**해서 기록
- 채널 대화에서 액션 아이템을 **추출**해서 태스크 생성

## Implementation Priority

1. **Phase 1A**: Config 탭 편집 + Tools 저장 + enable/disable 토글
2. **Phase 1B**: agent_test + agent_evaluate gateway tools
3. **Phase 2A**: agent_activity 테이블 + Activity 탭
4. **Phase 2B**: Conductor 페르소나에 에이전트 팩토리 역할 추가
5. **Phase 3**: 보고 체계 (Dashboard + Wiki + 외부 채널 통합)
6. **Phase 4**: 커넥터 기반 템플릿 동적 추천
