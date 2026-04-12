# v0.19 Agent Lifecycle — Completion Plan

## 이 브랜치가 전달해야 하는 것

> "Agents 탭에서 에이전트를 만들고, 설정하고, 테스트하고, 추적할 수 있다."

### 완료 기준 (PR merge 전 전부 동작해야 함)

1. **Agents 탭에 conductor, dashboard-agent, wiki-agent만 표시** (dev/reviewer/architect/pm 제거)
2. **Config 탭에서 model/tier/backend 변경 → Save → 즉시 반영** (뷰어에서 직접 확인)
3. **Tools 탭에서 체크박스 변경 → Save → 즉시 반영**
4. **채팅에서 "에이전트 만들어줘" → Conductor가 agent_create 호출 → config.yaml에 추가 → Agents 탭에 새 카드 표시**
5. **Conductor가 에이전트에게 delegate → Activity 탭에 task_start/task_complete 로그 자동 표시**
6. **"테스트해줘" → agent_test 호출 → 결과 Activity에 표시**

---

## 현재 상태 vs 완료 기준

| #   | 완료 기준                       | 현재 상태                                                          | 필요한 작업                                            |
| --- | ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | 3개 에이전트만 표시             | 7개 (dev/reviewer/architect/pm 포함)                               | config.yaml + config-manager.ts에서 제거               |
| 2   | Config 편집 동작                | UI는 있음. **실제 동작 미검증**                                    | MAMA 재시작 후 뷰어에서 직접 테스트                    |
| 3   | Tools 편집 동작                 | UI는 있음. **실제 동작 미검증**                                    | 뷰어에서 직접 테스트                                   |
| 4   | agent_create → config.yaml      | **agent_versions DB에만 기록. config.yaml 미반영. 핫리로드 안 됨** | agent_create가 config.yaml 수정 + 핫리로드 하도록 수정 |
| 5   | delegation → activity 자동 기록 | 코드는 executeDelegate에 있음. **실제 동작 미검증 (activity 0건)** | delegation 유발 후 activity 확인. 안 되면 디버그       |
| 6   | agent_test → 결과 표시          | 코드는 있음. **한 번도 호출 안 함**                                | 실제 호출 + 결과 확인                                  |

---

## Task 1: 불필요 에이전트 제거 + 검증

config.yaml에서 developer/reviewer/architect/pm 제거. config-manager.ts 기본값에서도 제거.

**검증:** MAMA 재시작 → `curl /api/agents` → 3개만. Agents 탭에서 3개만.

## Task 2: agent_create가 config.yaml에 에이전트 추가 + 핫리로드

현재 agent_create는 DB에만 기록. PUT /api/multi-agent/agents/:id가 config.yaml을 수정하는 경로를 추적하고, agent_create에서 동일 경로를 사용하도록 수정.

**검증:** Agents 탭 + New Agent → 생성 → `grep {id} ~/.mama/config.yaml` → 존재. `curl /api/agents` → 포함. 새 에이전트에게 delegate 가능.

## Task 3: delegation activity 로깅 실제 동작 검증

auto-log 코드는 executeDelegate에 이미 있음. 실제 delegation을 유발해서 activity가 기록되는지 확인.

**검증:** 채팅에서 "dashboard 브리핑 실행해줘" → delegate 발생 → `sqlite3 ~/.mama/mama-sessions.db "SELECT * FROM agent_activity;"` → 행 존재. Activity 탭에 로그 표시.

안 되면 → executeDelegate 내부 디버그 (sessionsDb가 null인지, logActivity 호출이 도달하는지) → 수정 → 재검증.

## Task 4: Config/Tools 편집 실제 동작 검증

뷰어에서 직접:

- Agents 탭 → conductor → Config → model 변경 → Save → toast 확인 → `grep model ~/.mama/config.yaml`
- Tools 탭 → 체크박스 변경 → Save → toast 확인

**검증:** config.yaml에 반영됐는지. 재시작 없이 동작하는지.

## Task 5: agent_test 실제 동작 검증

Task 2에서 만든 에이전트로:

- 채팅에서 "테스트해줘"
- agent_test가 호출되는지 (daemon.log 확인)
- Activity 탭에 test_run 결과 표시되는지

**검증:** Activity 탭에 test_run 항목 + 점수.

## Task 6: 전체 flow E2E

채팅에서 "에이전트 만들고 테스트까지 해줘" → Conductor가:

1. 에이전트 설계
2. agent_create 호출 → config.yaml 추가
3. agent_test 호출 → 테스트 실행
4. 결과 보고

**검증:** Agents 탭에 새 에이전트 + Activity에 test_run 결과.

---

## 하지 않는 것

- 리뷰 라운드 (동작하는 코드가 먼저)
- 서브에이전트 (전부 인라인)
- 데드코드 삭제 (이 브랜치 scope 아님 — 별도 정리 브랜치)
- Phase 3 보고 체계 (기본 flow가 먼저)
- Phase 4 템플릿 (v0.20)
