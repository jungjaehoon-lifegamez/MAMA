# v0.19 Agent Lifecycle — Create, Verify, Track

> 에이전트를 대화로 만들고, 자동으로 검증하고, 운영을 추적하는 시스템.

## Problem

현재 MAMA Agents 탭은 틀만 있다. Config 수정 불가, Tools 저장 안 됨, 검증 시스템 없음, 운영 추적 없음. 사용자가 에이전트를 실제로 "관리"할 수 없다.

Claude Managed Agents는 Agent → Session → Events 라이프사이클로 이 문제를 풀지만, 클라우드 전용이고 MCP 서버를 직접 연결해야 한다. MAMA는 커넥터 데이터가 이미 로컬에 있고, AI 판단 기반 자동화가 가능하다.

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

현재 읽기 전용인 Config 탭을 편집 가능하게:

| 필드                | 편집 방식                        | 저장 시 동작             |
| ------------------- | -------------------------------- | ------------------------ |
| name / display_name | 텍스트 입력                      | agent_update → 버전 생성 |
| model               | 드롭다운 (sonnet/opus/haiku)     | agent_update → 버전 생성 |
| system prompt       | Persona 탭 텍스트에어리어 (기존) | agent_update → 버전 생성 |
| tools               | 체크박스 토글 + Save 버튼        | agent_update → 버전 생성 |
| tier                | 드롭다운 (T1/T2/T3)              | agent_update → 버전 생성 |
| enabled             | 토글 스위치                      | 즉시 적용 (핫리로드)     |
| connectors          | 체크박스 (활성 커넥터 목록)      | agent_update → 버전 생성 |

### 1.4 템플릿 시스템

범용 템플릿이 아닌 **커넥터 데이터 기반 동적 추천**:

```
Conductor: "현재 연결된 커넥터를 분석했습니다.
만들 수 있는 에이전트:
1. 📦 납품 감시 — Drive + Sheets + Kagemusha
2. 📧 메일 태스크 변환 — Gmail + Sheets
3. 📊 프로젝트 진행 요약 — Sheets + Kagemusha
4. ⏰ 마감 경보기 — Sheets + Calendar
어떤 에이전트를 만들까요?"
```

## Phase 2: Verify (검증)

### 2.1 테스트 세션

```
Conductor: "테스트 시작합니다"
  1. 최근 실제 데이터 N건 수집 (커넥터에서)
  2. 대상 에이전트에게 delegate() → 시뮬레이션 실행
  3. 결과 수집
```

### 2.2 자동 평가

Conductor가 직접 평가 (별도 채점자 에이전트 불필요):

```
평가 기준:
  - 정확도: N건 중 몇 건 올바르게 처리했나
  - 도구 사용: 적절한 도구를 사용했나
  - 응답 품질: 결과물이 의도대로인가
  - 에러 여부: 예외 없이 완료했나

결과:
  score: 85
  details: "5건 중 4건 정확. 1건 프로젝트명 매칭 실패"
  suggestion: "system prompt에 프로젝트명 목록 참조 추가 권장"
```

### 2.3 Before/After 비교

```
Conductor:
  1. 현재 버전 테스트 결과 저장 (v1: 70점)
  2. system prompt 수정 → v2 생성
  3. 동일 테스트 재실행 (v2: 95점)
  4. 비교 결과 보고:
     → 채팅: "v1: 70점 → v2: 95점. 활성화할까요?"
     → Agents 탭: History 탭에 버전별 점수 표시
```

### 2.4 검증 기록

모든 테스트 결과는 영구 보존:

- `agent_activity` 테이블에 type='test_run'으로 기록
- Wiki에 자동 문서화: "에이전트명 테스트 기록 YYYY-MM-DD"

## Phase 3: Track (추적)

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
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_agent ON agent_activity(agent_id, created_at);
```

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
