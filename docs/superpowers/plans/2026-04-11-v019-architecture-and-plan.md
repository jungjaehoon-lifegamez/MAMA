# v0.19 Agent Lifecycle — Architecture & Implementation Plan

## 1. 목표

> "Agents 탭에서 에이전트를 만들고, 설정하고, 테스트하고, 추적할 수 있다."

Claude Managed Agents 패턴 (디시전 `v019_agent_management_redesign`):

- **Agent** = model + system prompt + tools + config
- **Session** = 작업 단위별 실행 인스턴스 (idle/running/terminated) ← **현재 MAMA에 없는 가장 가치있는 갭**
- **Events** = 실행 중 발생하는 이벤트 스트림

MAMA 로컬에서 이식할 부분:

- Agent Config 편집 + 버전 관리 → agent_versions
- Session = delegation 단위 (delegate 호출 1회 = session 1개) → agent_activity
- Events = task_start/task_complete/task_error → activity 자동 기록

## 2. 기존 시스템 (활용해야 하는 것)

### 2.1 Conductor Audit (이미 동작 중)

```
cron (매시간) → Conductor → audit-checklist.md 실행
  Step 1: Dashboard 브리핑 상태 확인
  Step 2: Wiki 상태 확인
  Step 3: 프로젝트 태스크 확인
  Step 4: Agent Health 확인  ← 여기에 agent_activity 기반 체크 추가 가능
  → MINOR: 자동 수정 (delegate)
  → MAJOR: 사용자에게 보고
```

### 2.2 메시지 처리 경로

```
뷰어 채팅 → MessageRouter → 단일 AgentLoop → Conductor
  → delegate(agentId, task) → GatewayToolExecutor.executeDelegate()
    → AgentProcessManager.getProcess() → Claude CLI 프로세스
    → sendMessage(prompt) → 응답 반환
Discord/Slack/Telegram → 단순 전달 (단일 에이전트, chat_bot 역할)
```

### 2.3 에이전트 설정 수정 (이미 동작 중)

```
PUT /api/multi-agent/agents/:id
  → loadMAMAConfig() → config.yaml 읽기
  → 필드 업데이트
  → saveMAMAConfig() → config.yaml 쓰기
  → applyMultiAgentConfig() → 핫리로드
```

### 2.4 현재 config.yaml agents

```yaml
conductor       — 오케스트레이터 (tier 1, can_delegate)
dashboard-agent — 브리핑 에이전트 (tier 2, 시스템)
wiki-agent      — 위키 컴파일러 (tier 2, 시스템)
developer       — ❌ Agent Swarm 잔재, enabled:false
reviewer        — ❌ Agent Swarm 잔재, enabled:false
architect       — ❌ Agent Swarm 잔재, enabled:false
pm              — ❌ Agent Swarm 잔재, enabled:false
```

### 2.5 데드코드 (~5,000줄)

multi-agent-base.ts, multi-agent-discord.ts, multi-agent-slack.ts, ultrawork.ts, ultrawork-state.ts
→ 멀티에이전트 핸들러/Agent Swarm — 사용 안 함

## 3. 문제점 (현재 → 목표 gap)

| #   | 문제                                      | 원인                                           | 영향                                          |
| --- | ----------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| P1  | agent_create가 에이전트를 실제 생성 안 함 | agent_versions DB에만 기록, config.yaml 미반영 | "에이전트 만들어줘" 불가                      |
| P2  | activity 0건                              | auto-log 코드는 있지만 실제 동작 미검증        | Activity 탭 항상 빈 화면, 상태 뱃지 항상 Idle |
| P3  | 불필요 에이전트 잔존                      | dev/reviewer/architect/pm enabled:false로 방치 | Agents 탭 오염                                |
| P4  | standalone 모드 핫리로드 불확실           | applyMultiAgentConfig이 Discord/Slack 경유     | Config 편집 후 재시작 필요할 수 있음          |
| P5  | Session 개념 없음                         | delegation = 단발성, 작업 단위 추적 없음       | Claude MA의 핵심 갭 미해결                    |

## 4. UX Flow — 사용자가 보는 것

### Flow 1: Agents 탭 진입

```
사용자가 Agents 탭 클릭
  → 카드: Conductor, Dashboard, Wiki (+ 사용자 생성 에이전트들)
  → 각 카드:
    ┌─────────────────────────────┐
    │ 🎯 Conductor          T1   │
    │ claude-sonnet-4-6    [ON]  │
    │ ● Active · 2m ago          │
    └─────────────────────────────┘
  → 상태: Active(녹)/Idle(노랑)/Error(빨강)/Disabled(회색)
  → enable/disable 토글
  → [+ New Agent] 버튼
```

### Flow 2: 에이전트 만들기

```
[+ New Agent] 클릭 또는 채팅에서 "에이전트 만들어줘"

채팅:
  Conductor: "현재 커넥터: Drive ✓ Sheets ✓ Kagemusha ✓
              이런 에이전트를 만들겠습니다:
              - 이름: QA Monitor
              - 모델: claude-sonnet-4-6
              - 역할: 데이터 품질 검증
              진행할까요?"

사용자: "좋아"

  → agent_create() → config.yaml 추가 + persona 파일 생성 + 핫리로드
  → viewer_navigate('agents') → Agents 탭에 새 카드
  → "✅ QA Monitor 생성 완료. 테스트할까요?"
```

### Flow 3: 에이전트 테스트

```
사용자: "테스트해줘"

  → Conductor가 agent_test(qa-monitor) 호출
  → 커넥터에서 최근 데이터 수집 → 새 에이전트에게 delegate
  → 결과 수집 → Conductor가 직접 평가 (LLM 판단)
  → auto-score (pass/fail ratio) + Conductor commentary

채팅:
  "테스트 완료 — 100/100 (2건 중 2건 정상)
   정확도: 높음, 도구 사용: 적절, 출력 품질: 양호
   활성화할까요?"

Activity 탭:
  🧪 Testing with 2 items — 100/100
    v1 · 15230ms · 2026-04-11
    ▼ (펼치면)
    ✅ PASS  [file_change] c130302-Animation...
    ✅ PASS  [spreadsheet_row] ProjectA...
```

### Flow 4: 설정 편집

```
Agents 탭 → 에이전트 클릭 → Config/Persona/Tools/Activity/History 5탭

Config: model/tier/backend/enabled/can_delegate 편집 → Save → 즉시 반영
Tools: 체크박스 on/off → Save → 즉시 반영
Persona: system prompt 편집 → Save → 새 버전 생성
```

### Flow 5: 운영 추적

```
Conductor가 delegate할 때마다:
  → agent_activity에 task_start/task_complete/task_error 자동 기록
  → Activity 탭에 시간순 로그
  → 카드 상태 뱃지 자동 갱신

기존 Conductor Audit (매시간):
  → audit-checklist.md Step 4에서 agent_activity 기반 health 체크
  → 에러 3회 연속 → MAJOR 보고
  → 24h 무활동 → 확인 알림
```

## 5. 구현 Task

### Task 1: 불필요 에이전트 제거

- config.yaml에서 developer/reviewer/architect/pm 제거
- config-manager.ts 기본값에서 제거
- **검증:** Agents 탭 3개만

### Task 2: agent_create → config.yaml 추가 + 핫리로드

gateway-tool-executor.ts의 agent_create case 수정:

1. `loadMAMAConfig()` → config에 새 에이전트 추가
2. persona_file 생성 (`~/.mama/personas/{id}.md`)
3. `saveMAMAConfig()` → config.yaml 저장
4. 핫리로드 (standalone 모드 경로 확인 필요)
5. agent_versions DB 기록 (감사)

graph-api.ts의 `loadMAMAConfig`/`saveMAMAConfig`를 공유 모듈로 추출하거나, 동일 HTTP 경로 내부 호출.

standalone 핫리로드: AgentProcessManager의 `updateConfig()` 또는 내부 persona cache clear. applyMultiAgentConfig 콜백이 standalone에서 설정되는지 확인 → 안 되면 직접 AgentProcessManager 참조 사용.

**검증:**

- Agents 탭 + New Agent → 생성 → config.yaml에 존재
- 새 에이전트에게 delegate → 응답 반환

### Task 3: delegation activity 실제 동작 확인 + 디버그

auto-log 코드는 executeDelegate에 이미 있음.

1. MAMA 재시작
2. 채팅에서 "dashboard 브리핑 갱신해줘" → delegate 유발
3. `sqlite3 agent_activity` → 행 존재 확인
4. 안 되면: sessionsDb null 여부, logActivity 도달 여부 디버그
5. Activity 탭에 로그 표시 확인

**검증:** Activity 탭에 실제 로그

### Task 4: Config/Tools 편집 실제 동작 확인

뷰어에서 직접 편집 → config.yaml 반영 확인.
standalone 모드에서 핫리로드가 동작하는지 확인.
안 되면 applyMultiAgentConfig standalone 경로 수정.

**검증:** 편집 → Save → config.yaml 반영 → 재시작 없이 동작

### Task 5: audit-checklist에 agent_activity 기반 체크 추가

기존 audit-checklist.md Step 4를 확장:

- `/api/agents/activity-summary` 호출 (이미 API 있음)
- 에러율 > 30% → MAJOR
- 3회 연속 에러 → MAJOR
- 24h 무활동 → 확인

**검증:** Conductor audit 실행 시 agent health 체크 포함

### Task 6: 전체 Create → Test → Track E2E

채팅: "에이전트 만들고 테스트까지 해줘"

1. Conductor → agent_create → 새 에이전트 생성
2. Conductor → agent_test → 커넥터 데이터로 테스트
3. Activity 탭에 test_run 결과
4. 카드 상태 뱃지 갱신

**검증:** Agents 탭에 새 카드 + Activity에 test_run + 상태 Active

## 6. 하지 않는 것

- 데드코드 삭제 (별도 브랜치)
- Phase 4 템플릿 (v0.20)
- Session 상태머신 (idle/running/terminated) — agent_activity로 근사치 추적, 전용 Session 테이블은 후속
- SSE 이벤트 스트리밍 — 페이지 로드 시 API 호출로 대체
