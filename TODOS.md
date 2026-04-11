# TODOS

## Deferred from v0.19 Validation Session v1

### Fixed benchmark test sets for agent_test

- **What:** agent_test에서 고정된 benchmark prompt 세트를 사용하여 run 간 비교 가능성 확보
- **Why:** 현재 agent_test는 connector에서 최근 데이터를 가져오므로 매 실행마다 입력이 다름. delta 비교의 의미가 약해짐.
- **Pros:** 동일 입력 → 동일 조건 비교 → metric delta가 진짜 성능 변화를 반영
- **Cons:** benchmark 세트 관리 UI/저장소 필요, 에이전트별 커스텀 세트 관리 복잡
- **Context:** v1에서는 사용된 입력을 before_snapshot_json에 기록하여 "무엇으로 테스트했는지"는 추적. v2에서 고정 세트로 확장.
- **Depends on:** validation_session v1 완료

### Hard approval enforcement + rollback

- **What:** regressed 에이전트의 실행을 하드 블로킹하고 approved version으로 롤백하는 메커니즘
- **Why:** v1은 Conductor가 soft하게 판단하지만, 자동화된 시행이 없으면 regressed 에이전트가 계속 실행될 수 있음
- **Pros:** regressed 에이전트가 자동으로 차단됨, 안전한 rollback 경로
- **Cons:** rollback 시맨틱이 복잡 (persona? config? connector binding?), false positive regression이 정상 에이전트를 차단할 위험
- **Context:** v1의 requires_approval 필드와 POST /approve 엔드포인트가 기반. v2에서 DelegationManager에 validation state 체크 게이트 추가.
- **Depends on:** validation_session v1 완료, false positive rate 측정

### gateway-tool-executor.ts refactoring

- **What:** executeDelegate() + \_runAgentTest()를 delegation-executor.ts로 추출
- **Why:** 현재 2650줄. 모든 기능 추가가 여기서 병목. Codex도 위험한 시퀀싱이라고 지적.
- **Pros:** 모듈 분리, 테스트 용이성, 병렬 개발 가능
- **Cons:** 의존성이 많아서 추출이 복잡 (agent context, retry, skills, raw store, sessions DB, process manager, history injection)
- **Context:** v0.19 validation 구현 시 리팩토링 없이 sessionService.recordRun() 호출만 추가하기로 결정. 별도 브랜치에서 진행.
- **Depends on:** validation_session v1 완료
