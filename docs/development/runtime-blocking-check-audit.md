# 업무 실행을 막는 검사 조사

2026-09-07 · 설치된 mama-os 0.50.0 로컬 수정 빌드와 운영 기록을 대조했다.
목적은 사용자의 업무를 진행하는 MAMA다. 이 문서는 개발자의 진단 기록이며 에이전트가
추가로 수행해야 할 심사 절차나 새 실행 계획이 아니다. 이번 조사는 코드·운영 상태를 변경하지 않았다.

## 1. 성공한 작업 때문에 이후 보드 갱신을 막음 — 실제 장애 확인

`OwnerActionEffectLedger.hasUnsafeReplayEffects`는 `native_run` 이외의 효과가 존재하면
상태가 confirmed여도 true를 반환한다. 시작 코드가 이 값을 WorkOrderConsumer의 모델
실행 전 차단 조건으로 사용한다. 작업별 영수증으로 정확한 중복만 막을 수 있는데, 더 넓은
검사가 다음 업무 전체를 막는다.

- [판정식](../../packages/standalone/src/operator/owner-action-effects.ts#L414)
- [실행 전 차단](../../packages/standalone/src/operator/workorder-consumer.ts#L363)
- [호스트 연결](../../packages/standalone/src/cli/commands/start.ts#L1928)

운영 DB에서 동일 `board:full:repair` 키의 후속 작업 6건이 모두
`owner effect requires reconciliation before replay`로 실패했다. 이 키의 기존 효과는
confirmed native_run 1건과 confirmed task_create 3건이며 미확정 효과가 없었다.
서로 다른 보드 실행도 같은 재실행 방지 키를 공유한다.

설치된 실제 ledger를 메모리 SQLite로 실행한 결과도
`unsettled=false / wholeRunBlocked=true / sameActionReplayState=confirmed`였다.
즉 개별 작업 재요청은 이미 저장된 영수증을 반환할 수 있지만 상위 검사가 전체 실행을 거부한다.

수정 방향: 반복 작업의 새 발생 건과 같은 발생 건의 재시도를 구별하고, confirmed 효과가
존재한다는 이유로 전체 모델 실행을 차단하지 않는다. 불확실한 실제 변경의 재전송만 제한하며,
상태 읽기·판단·허용된 복구는 가능해야 한다. 기존 영수증을 삭제하거나 무시해서 푸는 방식은 아니다.

## 2. 호스트 식별자 누락이 요약 모델 진입을 차단 — 실제 장애 확인

전체 보고는 sourceMessageRef를 전달하지만 digest는 문자열 호출 경로로 들어가 식별자를
잃는다. `createNativeEffectObserver`가 실제 업무나 도구 호출 전에 식별자를 요구하면서
`Native effect observation needs an owner occurrence`로 종료한다. 조회 시점의 최근 24시간에
이 오류가 17회 기록됐다.

- [digest/full 경로 차이](../../packages/standalone/src/operator/operator-trigger-loop.ts#L411)
- [문자열 호출에서 식별자 누락](../../packages/standalone/src/operator/report-run.ts#L66)
- [모델 진입 전 차단](../../packages/standalone/src/agent/gateway-tool-executor.ts#L880)

수정 방향: 하나의 보고 진입 경로에서 호스트가 발생 건의 안정적인 식별자를 제공한다.
호스트 내부 메타데이터를 에이전트가 알아내거나 사용자에게 받아오게 하지 않는다.
새 임의 ID를 재시도마다 만들어 중복 방지를 무력화하지 않도록 기존 발생 건을 보존한다.

## 3. 실패가 없어도 9번째 도구 프로그램을 중단 — 실제 차단 규칙 확인

Temporal 실행은 성공·실패나 새 근거 획득 여부와 무관하게 CodeAct 호출이 8회를 넘으면
`TOOL_CONTRACT_REPEAT`, `retryable=false`, `abort=true`로 중단된다. 별도로 존재하는 동일
오류 반복 차단과는 다른 조건이다. 설치된 함수의 최소 재현은
`calls=9 / consecutiveFailures=0 / blocked=true`였다. 운영 기록에도 outer call limit으로
실패한 모델 실행 1건이 있었으나, 그 실행의 모든 선행 호출이 성공했다는 뜻은 아니다.

- [고정 호출 제한](../../packages/standalone/src/agent/temporal-code-act-breaker.ts#L3)
- [중단·재시도 금지 결과](../../packages/standalone/src/agent/agent-loop.ts#L183)

수정 방향: 정상적으로 진행되는 조사까지 호출 횟수만으로 종료시키는 규칙을 제거·대체한다.
실제 반복 오류, 진행 정체, 사용자가 정한 자원 한도와 미완료 목적 보존을 구분한다.
이 제한은 Temporal 경로에만 해당하며 모든 Telegram 요청에 적용되는 것은 아니다.

## 4. 체크포인트 대체 경로도 거부 — 실제 불통 경로 확인

직접 체크포인트 읽기는 scoped search를 사용하라는 오류를 반환한다. 그러나 search에
checkpoint 타입과 scopes를 주면 다시 scoped checkpoint가 미지원이라는 오류를 반환한다.
최근 운영 기록에도 해당 코드의 mama_search 실패 2건이 있다.

- [대체 경로 안내](../../packages/standalone/src/envelope/enforcer.ts#L162)
- [안내된 경로의 거부](../../packages/standalone/src/agent/mama-tool-handlers.ts#L150)

수정 방향: 사용자가 허용한 범위 안의 실제 읽기 기능을 제공하고 계약을 일치시킨다.
권한 범위를 없애는 문제가 아니라, 구현하지 않은 정상 기능을 상시 차단과 모순된 안내로
대신한 문제다.

## 5. 화면 렌더 실패가 업무 실행까지 차단 — 코드상 차단, 운영 발생 미확인

Board 작업은 모델 진입 전에 pipeline 렌더링을 한다. 이때 예외가 나면 업무 자체를
실패로 종료한다. 원장을 읽고 상황을 파악하거나 다른 허용된 일을 할 기회도 주지 않는다.
화면 사실을 모델이 임의로 재작성하지 못하게 하는 목적과, 모델의 모든 업무를 중단하는
결과는 구별해야 한다. 앞의 실제 보드 실패 6건은 이 조건이 아니라 1번 조건이었다.

- [렌더링 예외 후 실행 종료](../../packages/standalone/src/operator/workorder-consumer.ts#L367)

수정 방향: 표시 갱신 실패는 명시적으로 남기되 원장 조회와 독립적인 업무 진행은 유지한다.
원장과 화면이 어긋났는데 화면까지 최신이라고 주장하는 일은 막는다.

## 보호해야 하는 것과 과도하게 막는 것을 구분

보호 대상은 사용자의 데이터, 현재 권한·지시, 의도한 변경 대상, 중복되면 안 되는 실제
외부 효과다. 인증·허용 리소스와 목적지·동시 변경 충돌·불확실한 동일 변경의 재실행 방지는
그 대상에 직접 연결된다. 이미 확인된 성공, 호스트 식별자, 화면 렌더 상태, 고정 호출 횟수를
이유로 읽기·판단·새 정상 업무 전체를 거부하는 것은 목적에 맞지 않는다.

판정: 1~3번은 우선 제거하거나 범위를 좁혀야 할 실행 차단이다. 4번은 정상 기능을 제공하지
않은 계약 결함이고 5번은 화면과 업무를 지나치게 결합한 차단이다. 권한 검사를 통째로 끄는
방식으로 해결하지 않는다. 직접 요청의 330초가 전부 이 검사 비용이라는 증거는 없으며,
이번에 확인한 것은 자동 요약·보드·Temporal·체크포인트의 실행 차단이다.
