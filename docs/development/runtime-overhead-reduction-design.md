# MAMA Runtime Overhead Reduction — 검증을 보존하고 모델 낭비를 제거하는 설계

> **상태:** Eng review CLEAR, PR-A CODE GREEN, PR-B 구현 대기
>
> **작성일:** 2026-08-26
>
> **선택안:** A — 위험과 검증 방법이 다른 세 슬라이스를 독립 출하한다. 첫 구현은
> `Slice A: Model-work control`이다. 감사 저장 수명주기와 daemon 로그 회전은 각각 별도 설계·승인 후
> 진행한다.
>
> **패리티 계약:** 이 설계는 `TG-03`, `TG-04`, `TG-05`, `TG-06`을 따른다. 특히 모델이 안전한
> 도구를 자유롭게 조합하는 능력은 유지하고, 호스트는 권한·중복 방지·durable receipt·복구만
> 소유한다.

## 1. 문제 정의

MAMA의 운영 오버헤드는 “검증 함수가 너무 많아서” 발생하지 않았다. 실측상 sender, role,
envelope, destination, path, receipt, input validation 같은 로컬 검증은 대부분 마이크로초에서 수
밀리초 수준이었다. 실제 비용의 중심은 다음 두 경로였다.

1. connector owner-event가 Board 작업을 요청할 때마다 `force: true` 전체 수리를 새로 실행한다.
2. Temporal worker가 동일한 결정적 도구 계약 오류를 형태만 바꿔 반복하고, 실패한 generation을
   다시 모델에 맡긴다.

이 둘은 안전 검증의 비용이 아니라 모델 호출 횟수와 컨텍스트 크기의 비용이다. 따라서 검증을
삭제하면 보안과 복구 성질만 잃고 비용 원인은 남는다.

## 2. 관측 기준선

아래 수치는 2026-08-25의 현재 릴리스 이후 약 9.7시간 운영 창에서 로컬 DB, Codex rollout 파일,
daemon 로그와 소스 코드를 읽어 측정한 기준선이다. rollout 파일을 전체 토큰의 권위 있는 출처로
사용하고, DB 수치는 lane별 상대 분해에 사용했다.

| 항목                             |           관측값 | 해석                                       |
| -------------------------------- | ---------------: | ------------------------------------------ |
| Codex 세션                       |               80 | 같은 운영 창의 전체 세션                   |
| 전체 토큰                        |       22,825,582 | 입력+출력 합계                             |
| Board                            | 23회 / 8,487,359 | 세션당 평균 369,016                        |
| owner-event Board 강제 전체 수리 | 20회 / 7,204,986 | owner-event Board 요청 전부 `full + force` |
| Temporal                         |  3회 / 5,179,840 | 한 generation이 3회 재시도 후 소진         |
| 두 낭비 경로 합계                |       12,384,826 | 전체 토큰의 54.3%                          |
| Temporal 실패 trace              |   486 / 전체 565 | `context_compile` scope 계약 오류가 다수   |
| Board 실제 실행 시간             |  평균 약 250.5초 | owner-event 요청은 평균 약 86.6초          |
| Temporal 실제 실행 시간          |  평균 약 411.7초 | 같은 결정적 실패를 장시간 반복             |

로컬 검증 기준선은 다음과 같다.

| 검증                           |              관측 비용 |
| ------------------------------ | ---------------------: |
| envelope 구조 검사             |  호출당 약 0.16–0.36µs |
| live boundary config 읽기+파싱 |         호출당 약 47µs |
| 시간별 결정적 code audit       |         약 5–21ms/시간 |
| 빠른 gateway 도구 + 감사 기록  |        대체로 약 1–4ms |
| idle daemon                    | CPU 0.0%, RSS 약 135MB |

## 3. 목표

1. owner-event burst가 Board 전체 강제 수리를 이벤트 수만큼 생성하지 않게 한다.
2. 같은 결정적 Temporal 도구 계약 실패가 한 generation에서 무한 변형되거나 새 모델 run으로
   재시도되지 않게 한다.
3. owner-event 입력 배치가 durable acceptance, 외부 effect, 또는 정확한 no-update receipt 중 하나와
   계속 연결되게 한다.
4. 현재의 sender/role/envelope/scope/destination/path/idempotency/receipt 검증을 유지한다.
5. 모델 비용, 실행 시간, 중복 작업 감소를 릴리스 후 24시간 운영 지표로 입증한다.

## 4. 비목표와 불변식

### 비목표

- 일반적인 검증 함수 삭제나 단일 “fast mode” 추가
- `xhigh`를 전역으로 낮춰 원인을 숨기는 변경
- 모델이 수행할 도구 순서를 호스트 코드에 하드코딩
- Board, Wiki, memory-curation을 하나의 거대 오케스트레이터로 합치기
- 기존 Telegram 앱/UI를 이용한 검증
- Slice A에서 기존 감사 데이터를 삭제하거나 daemon 로그를 회전하기

### 반드시 유지할 안전 불변식

- ingress principal 분류와 owner/external 경계
- role 및 tool 권한, host-issued envelope, scope와 destination 검증
- 외부 effect의 pending-before-send, receipt-first recovery와 멱등성
- mutation의 committed/unknown 결과에 대한 비재시도 정책
- input validation, secret filtering, 경로 containment, 결과 sanitization
- 시간별 deterministic code audit
- `TG-03/TG-04`: coherent primitive와 agent freedom
- `TG-05`: bounded context restoration과 같은 정책 세션의 최소 continuation
- `TG-06`: prose가 아닌 durable receipt가 완료 권위

## 5. 검토한 접근

### A. 독립 슬라이스로 비용 원인을 제거 — 선택

1. 모델 작업 제어
2. 감사 저장 수명주기
3. daemon 로그 회전

장점은 각 변경이 별도 실패 도메인과 되돌리기 단위를 갖는다는 점이다. 첫 슬라이스는 삭제 없는
additive migration과 호스트 상태 기계만 사용한다. 운영 효과를 먼저 측정한 뒤 저장 정책을 결정할
수 있다.

### B. 한 PR에서 모델·DB·로그를 모두 정리 — 기각

토큰 절감과 디스크 회수를 한 번에 얻지만, 성능 회귀·receipt 회귀·데이터 삭제 문제를 분리해
판단할 수 없다. 실패 시 어떤 변경을 되돌려야 하는지도 불명확하다.

### C. 검증과 감사 기록을 광범위하게 비활성화 — 기각

실측 비용이 작은 경로를 제거하면서 principal, scope, destination, mutation recovery 불변식을
깨뜨린다. 모델 호출의 54.3% 낭비 원인도 해결하지 못한다.

## 6. 프로그램 구조

```text
Slice A — Model-work control
  PR-A. owner-event Board coalescing + durable acceptance
  PR-B. Temporal host-bound context contract
        + deterministic failure circuit breaker + retry classification
  A4. 24-hour canary and cost comparison

Slice B — Audit storage lifecycle
  별도 보존 정책 승인 → additive archive/compaction → 온라인 정리

Slice C — launchd-safe daemon log rotation
  별도 회전 정책 승인 → reopen 가능한 writer → size/time rotation
```

Slice A가 정상 출하되어도 B와 C는 자동 승인되지 않는다. B는 데이터 보존이라는 파괴적 결정을,
C는 launchd와 열린 file descriptor의 수명주기 결정을 각각 요구한다.

Slice A 자체도 한 거대 PR로 만들지 않는다. Board와 Temporal은 실패 도메인과 회귀 테스트가 다르므로
`PR-A → PR-B → 릴리즈 1회`로 진행한다. PR-A가 main에 머지된 뒤 PR-B를 최신 main에서 시작하고, 두
PR이 모두 clear된 뒤 한 릴리즈로 운영에 반영한다.

## 7. Slice A 상세 설계

### A1. Owner-event Board refresh coordinator

#### 현재 결함

`buildOwnerWorkOrderRequestHandler()`는 owner chat과 owner-event가 공유한다. `kind === 'board'`이고
`causeEventIds`가 있으면 이를 `mode: 'full', force: true`와 고유 `boardBatchKey()`로 변환한다.
따라서 connector event batch마다 새로운 전체 수리가 만들어진다. 한편 `OwnerEventLoop`의 terminal
receipt는 같은 exact batch key의 workorder를 찾아야만 배치를 ACK한다. 단순히 enqueue를 생략하거나
공용 key로 바꾸면 receipt 계약이 끊어진다.

#### 새 경계

`workorder_request`의 호출 출처를 데이터 유무로 추측하지 않는다. 호스트 실행 컨텍스트가 다음
origin을 명시한다.

```ts
type WorkOrderRequestOrigin =
  | { kind: 'owner_manual' }
  | { kind: 'owner_event'; batchId: number; eventIds: readonly string[] };
```

- `owner_manual`: 기존 `full + force: true` 의미와 고유 manual key를 유지한다.
- `owner_event`: `causeEventIds`를 모델 입력에서 받지 않고 host-bound batch에서 파생한다.
  모델은 batch ID, event ID, force 여부 또는 idempotency key를 선택하거나 넓힐 수 없다.

#### Durable intent

`OwnerEventBoardRefreshLedger` 하나가 기존 `operatorDb`, `TaskLedger`, `BoardRefreshGate`를 조합한다.
Board 수리 자체는 기존 `boardRepairKey()`와 TaskLedger의 open-row dedupe를 그대로 사용한다. 새
테이블은 여러 owner-event batch가 workorder 하나를 공유할 때 필요한 many-to-one receipt 관계만
보관한다.

`BoardRefreshGate`는 full-repair coordination을 위해 항상 생성한다. 기존
`MAMA_BOARD_RECONCILE=1`은 connector delta reconcile scheduler만 제어하고, owner-event coalescing이나
scheduled full repair의 안전성을 끄지 않는다.

operator DB에 additive 테이블 `owner_event_board_refresh_intents`를 추가한다.

| 열                         | 의미                                                 |
| -------------------------- | ---------------------------------------------------- |
| `batch_id` PK/FK           | owner-event batch와 1:1                              |
| `batch_key` UNIQUE         | 기존 event ID 정렬 해시로 만든 retry-stable identity |
| `repair_generation`        | 해당 요청이 더럽힌 Board generation                  |
| `workorder_id` FK          | 실제 수리에 연결된 workorder                         |
| `applied_at` nullable      | verified repair가 해당 generation을 처리한 시각      |
| `created_at`, `updated_at` | 복구와 retention 기준                                |

`applied_at IS NULL` 행만 `(repair_generation, batch_id)`로 찾는 partial index를 둔다. owner-event
inbox가 삭제될 때 intent도 `ON DELETE CASCADE`로 삭제한다. `TaskLedger`가 같은 DB connection에서 이미
`foreign_keys = ON`을 설정하므로 별도 cleanup timer나 두 번째 retention 정책은 만들지 않는다.

트랜잭션 순서:

1. DB transaction 전에 Board gate를 dirty로 만든다. 이후 DB가 실패해도 안전한 extra repair만 남고
   work loss는 생기지 않는다.
2. 같은 operator DB transaction 안에서 `batch_id` intent를 조회한다. 이미 있으면 같은 durable
   acceptance를 반환한다.
3. 새 batch라면 기존의 열린 non-force Board repair를 찾고, 없으면 공용 `boardRepairKey()`로
   `mode: 'full', force: false` 작업 하나를 enqueue한다.
4. 선택된 workorder ID와 generation을 가진 intent를 삽입한다.
5. intent와 workorder가 함께 commit된 뒤에만 `workorder_request` 성공을 반환한다.

동일 batch retry는 같은 intent를 읽는다. 새 batch가 활성 수리 중 도착하면 그 수리에 연결하되 새
generation은 남긴다. 여기서 workorder 연결은 “요청이 수리 coordinator에 접수됐다”는 뜻이지 현재
attempt가 그 generation까지 처리했다는 뜻이 아니다. 활성 수리가 자기 captured generation까지만
지우므로, 이후 generation이 남으면 완료 hook이 기존 terminal row가 공용 key를 놓은 뒤 후속 수리를
하나 enqueue하고 아직 적용되지 않은 intent를 새 workorder에 다시 연결한다. 결과적으로 burst는
`1 open repair + 1 durable follow-up obligation`으로 수렴한다. 별도 `status` state machine은 만들지
않는다. `applied_at IS NULL`이 유일한 미적용 상태다.

#### 완료와 ACK

- owner-event terminal receipt는 더 이상 Board task의 exact occurrence key만 찾지 않는다.
- 해당 `batch_id` intent와 연결된 workorder가 존재하면 `delegated` receipt를 반환한다. 이는 기존
  `accepted workorder` 의미를 유지한다. Board 수리 완료를 기다려 owner-event inbox를 붙잡는 계약으로
  바꾸지 않는다.
- verified workorder hook만 captured generation 이하 intent에 `applied_at`을 기록한다.
- verified hook 뒤에 더 높은 미적용 generation이 남으면 현재 workorder ID를 run-local follow-up set에
  넣는다. WorkOrderConsumer가 그 row를 terminal로 commit한 뒤 내보내는 기존 `onEvent(complete)`가 set을
  consume해 non-force repair를 즉시 요청한다. 이 요청은 accepted intent가 있으므로 delta-skip을
  우회하지만 `force: true`가 아니며, exact no-update receipt로 안전하게 끝날 수 있다.
- unverified completion과 failed/exhausted event는 즉시 follow-up을 만들지 않는다. dirt와 intent를
  유지하고 기존 scheduled self-heal과 경보를 사용해 hot loop를 막는다.
- 수리 실패는 intent를 삭제하지 않는다. gate dirt와 intent를 남기고 기존 Board 경보/자기회복
  경로가 후속 수리를 맡는다.
- boot recovery는 미적용 intent의 최대 generation보다 큰 값으로 Board gate를 초기화하고 boot-dirty
  full repair 하나에 미적용 intent를 다시 연결한다. verified hook 이후 process death가 나도 다음 boot가
  같은 의무를 복구한다. 메모리 gate만 보고 수리 완료를 추정하지 않는다.
- `owner_event_inbox` 삭제 시 intent도 FK/trigger로 정리한다. ACK된 inbox의 기존 retention과 같은
  수명을 따르며, durable receipt가 필요한 동안 먼저 삭제하지 않는다.

#### 패리티 영향

- **TG-03/TG-04:** 모델은 여전히 Board/Wiki/memory 도구를 자유롭게 선택한다. 호스트는 Board 요청을
  하나의 안전한 primitive로 접수할 뿐, Board 내부 행동 순서를 지시하지 않는다.
- **TG-05:** 이벤트별 fresh owner-event 판단은 유지하지만, 판단 이후 같은 Board 전체 컨텍스트를
  반복 실행하는 비용을 합친다.
- **TG-06:** exact batch는 durable intent와 연결되고, prose만으로 ACK되지 않는다. crash 후에도 같은
  batch가 새 강제 전체 수리를 만들지 않는다.

### A2. Temporal context contract를 host-bound로 만든다

#### 현재 결함

Temporal brief는 `context_compile`을 요구하지만, 도구 설명은 `mama_search`와 `mama_recall`에 있는
“scope를 생략하면 호스트가 기본값을 적용한다”는 계약을 충분히 노출하지 않는다. 모델이 scope와
connector를 직접 만들면 executor가 `memory_scope_out_of_scope`, `connector_out_of_scope`,
`context_compile_input_invalid`로 거부한다. 거부는 맞지만 같은 선택을 모델이 반복한다.

#### 변경

1. 작은 shared contract constant에서 canonical tool registry와 HostBridge가 동일한
   `context_compile` 설명을 읽는다. 문구를 두 파일에 복사하지 않는다.
2. Temporal managed brief는 다음 계약을 명시한다.
   - `scopes`, `connectors`를 모델이 공급하지 않는다.
   - host-bound execution context가 현재 generation의 project, connector, memory grant를 적용한다.
   - 모델은 `task`, `range`, `as_of`, strictness와 bounded compile budget만 선택한다. active temporal
     task의 raw seed는 호스트가 추가한다.
3. executor의 기존 경계를 유지한다. 필드 누락 시 trusted envelope snapshot을 적용하고, 명시
   필드는 기존 subset/authorization 검증을 통과해야 한다. widening은 계속 거부한다.
4. prompt와 registry의 문구가 달라지지 않도록 coherence test를 추가한다.

이 변경은 검증 완화가 아니다. 모델 선택 영역에서 권한 필드를 제거하고, 기존 fail-closed executor를
그대로 유지한다.

### A3. Deterministic failure circuit breaker

#### 현재 결함

AgentLoop의 반복 방지는 outer Code-Act code 문자열을 키로 사용한다. 모델이 코드를 조금씩 바꾸면
같은 host failure도 다른 호출로 보이며 50-call emergency cap까지 진행할 수 있다. Temporal
WorkOrderConsumer는 generation을 최대 3회 모델 run으로 재시도해 같은 계약 실패를 확대한다.

#### 구조화 fingerprint

HostBridge가 이미 생산하는 trusted `hostToolExecutions`만 사용해 fingerprint를 만든다. 모델 prose,
sandbox console, 코드 문자열은 분류 권위가 아니다.

```text
fingerprint = sha256(
  ordered(failedNestedTool + normalizedFailureCode)
)
```

fingerprint는 기존 trusted `hostToolExecutions`의 실패한 `{name, code}`만 사용한다. principal, scope,
destination ID 또는 오류 메시지 전체를 새 audit surface에 추가하지 않는다. 동일 run 안에서만 비교하므로
권한 identity를 fingerprint에 중복 포함할 필요가 없다.

결정적 오류 집합은 명시적 allowlist로 시작한다.

- `memory_scope_out_of_scope`
- `connector_out_of_scope`
- `context_compile_input_invalid`
- `invalid_memory_scope`
- `role_denied`, `tool_denied`, `destination_out_of_scope`
- schema/argument contract 위반

provider 429/5xx, capacity, transport disconnect는 이 집합에 넣지 않는다. mutation outcome unknown,
committed-after-abort, missing result는 기존 구조적 비재시도 정책을 그대로 우선한다.

#### 차단 규칙

- `RunScope`에 Temporal run 전용 `codeActCalls`, `lastDeterministicFingerprint`,
  `consecutiveDeterministicFailures`만 추가한다. AgentLoop instance state나 session state에 저장하지
  않는다.
- 같은 Temporal run에서 같은 결정적 fingerprint가 연속 3회 나오면 즉시
  `TOOL_CONTRACT_REPEAT`로 종료한다. 성공하거나 다른 fingerprint가 나오면 연속 카운터를 reset한다.
- 추가 안전망으로 Temporal run의 outer Code-Act 호출은 실행 전 최대 8회다. 일반 owner turn과 다른
  lane은 기존 50-call ceiling을 유지한다.
- 종료 결과는 `retryable: false`, `failureClass: 'deterministic_contract'`, fingerprint의 짧은
  비민감 prefix를 갖는다.
- `TOOL_CONTRACT_REPEAT`를 `HostToolTerminalCode`와 `AgentErrorCode`의 닫힌 vocabulary에 추가한다.
  WorkOrderConsumer는 그 exact `AgentError.code`만 보고 `allowRetry: false`로 generation을 실패 처리한다.
  응답 prose나 일반적인 `retryable: false`를 넓게 해석하지 않는다.
- mutation terminal code가 있으면 circuit breaker보다 먼저 반환한다.
- provider/transient failure는 현재 retry 정책을 유지한다.

#### 패리티 영향

- **TG-03/TG-04:** 정상적으로 서로 다른 Code-Act 프로그램을 조합하는 자유는 유지된다. 단지 같은
  trusted host denial을 반복하는 경우만 차단한다.
- **TG-06:** mutation의 불확실 결과와 완료 영수증이 circuit breaker보다 우선한다. 이미 시작된
  side effect를 안전하다고 추측해 재시도하지 않는다.

## 8. 데이터 흐름

### Owner-event Board

```text
connector batch persisted
  → owner AgentLoop chooses workorder_request(board)
  → host derives owner_event origin
  → durable refresh intent INSERT/lookup
  → attach to one open repair OR enqueue one non-force repair
  → durable acceptance returned
  → OwnerEventLoop ACKs exact batch
  → Board completion clears captured generation only
  → newer dirt schedules at most one follow-up
```

### Temporal failure

```text
temporal generation claimed
  → host-bound context_compile defaults
  → Code-Act nested executions recorded
  → deterministic fingerprints accumulated
  → 3 equal failures OR 8 outer calls
  → structured non-retryable TOOL_CONTRACT_REPEAT
  → generation exhausted once, no replacement model run
  → operator evidence + bounded alarm
```

## 9. 오류 처리와 복구

| 실패 지점                         | 처리                                                   |
| --------------------------------- | ------------------------------------------------------ |
| intent INSERT 실패                | workorder 요청 실패, owner-event retry; ACK 금지       |
| intent/workorder transaction 실패 | 전체 rollback, dirty gate가 다음 repair를 보장         |
| enqueue 후 ACK 전 crash           | 동일 batch intent/workorder를 찾아 ACK; 새 작업 금지   |
| Board 실행 중 새 event            | 새 generation 유지, 현재 완료 후 follow-up 최대 하나   |
| Board publish 검증 실패           | dirt와 intent 유지, 즉시 loop 없이 scheduled self-heal |
| context_compile 권한 위반         | fail-closed + fingerprint 카운트                       |
| 결정적 실패 3회                   | 비재시도 generation 실패                               |
| provider 429/5xx                  | 기존 transient retry                                   |
| mutation outcome unknown          | 기존 no-retry receipt-first recovery 우선              |
| daemon shutdown                   | 기존 active workorder drain/boot recovery 계약 유지    |

## 10. Migration과 호환성

- `owner_event_board_refresh_intents`는 operator DB에 additive `CREATE TABLE IF NOT EXISTS` migration으로
  추가한다.
- 기존 `owner_event_inbox`, `operator_tasks`, `owner_event_effects` 행은 수정하지 않는다.
- 기존 `MAMA_BOARD_RECONCILE` 설정은 delta reconcile scheduler만 제어한다. full repair gate와
  owner-event intent 접수는 항상 활성이다.
- 구버전은 새 테이블을 읽지 않으므로 rollback-safe다. 단, 새 버전이 만든 non-force repair는 기존
  Board payload schema와 호환되어야 한다.
- migration 실패 시 daemon은 owner-event 처리를 시작하지 않고 fail loudly 한다. 메모리-only
  fallback은 금지한다.
- 기존 `boardBatchKey()`는 historical lookup과 batch identity 생성에 유지할 수 있지만, 더 이상
  owner-event마다 독립 full-force workorder occurrence를 만드는 데 사용하지 않는다.

## 11. 테스트 전략 — TDD

구현은 아래 RED 테스트부터 시작한다.

### A1 Board/receipt

1. `TG-06`: 동일 owner-event batch retry가 intent와 workorder 하나만 만든다.
2. `TG-06`: 서로 다른 20개 batch burst가 open repair 하나에 연결되고 durable follow-up obligation은
   최대 하나다.
3. `TG-06`: enqueue 후 ACK 전 crash가 새 workorder 없이 durable acceptance를 복구한다.
4. `TG-06`: 새 generation은 오래된 repair 완료로 지워지지 않는다.
5. `TG-06`: prose-only 또는 intent 없는 성공은 ACK되지 않는다.
6. `TG-03/TG-04`: owner manual Board 요청은 여전히 `force: true`; owner-event는 `force: false`다.
7. verified completion만 terminal 이후 immediate follow-up을 만들고, unverified/failed completion은 hot
   loop를 만들지 않는다.
8. `MAMA_BOARD_RECONCILE`이 꺼져도 owner-event coalescing과 scheduled full gate는 유지된다.
9. migration I/O 실패는 fail-closed하고 기존 DB bytes를 보존한다.

### A2 Temporal context

1. `TG-03/TG-04`: Temporal `context_compile`은 host scope를 기본 적용한다.
2. 명시적으로 scope를 넓히면 기존과 같이 거부한다.
3. registry, HostBridge, managed brief의 계약 문구가 일치한다.
4. trusted grant snapshot은 한 호출 안에서 변하지 않고 다음 호출에서 revoke를 반영한다.

### A3 Circuit breaker/retry

1. 코드 문자열이 다른 3개 Code-Act가 같은 nested failure를 내면 한 run에서 차단된다.
2. 서로 다른 정상 프로그램은 차단되지 않는다.
3. provider 429/5xx는 deterministic fingerprint로 분류되지 않는다.
4. mutation outcome unknown은 기존 no-retry 결과를 유지한다.
5. Temporal 8-call ceiling이 그 lane에만 적용된다.
6. `retryable: false` generation은 WorkOrderConsumer가 새 model run을 만들지 않는다.
7. 구조화 결과 없이 같은 문구만 출력한 model prose는 retry 분류 권위가 아니다.

### 회귀 게이트

- 관련 standalone focused suites
- standalone typecheck와 build
- 전체 standalone test
- root typecheck, build, test
- 변경 파일 Prettier와 `git diff --check`
- `docs/development/kagemusha-telegram-parity.md`의 TG-03/TG-04/TG-05/TG-06 evidence/status 갱신

## 12. 출시와 운영 검증

### 단계 1 — 릴리즈 내 계측

별도 shadow 릴리스를 만들지 않는다. 이미 확보한 운영 기준선을 before 값으로 고정한다. 새 append-only
telemetry table도 만들지 않고 durable intent, 기존 `operator_tasks`, `agent_activity`, `model_runs`, Codex
rollout에서 아래 값을 계산한다. 코드에 새로 필요한 것은 기존 metric sink의 breaker termination counter
하나다.

- owner-event Board intents accepted/applied/pending
- Board repair open/follow-up/coalesced batch 수
- Temporal deterministic fingerprint count와 breaker termination
- workorder별 model runs, tokens, duration, retry class

민감한 event ID, connector payload, chat ID, scope ID는 로그에 기록하지 않는다.

### 단계 2 — PR-A/PR-B 머지 후 Slice A 활성화

- old path를 fallback으로 호출하지 않는다. 새 durable path가 실패하면 fail loudly 한다.
- rollback은 이전 패키지로 재설치하고 launchd를 재시작한다. schema는 additive이고 구버전이 새 테이블을
  읽지 않으므로 별도 장기 기능 플래그를 유지하지 않는다.
- build/install/restart는 별도 단계로 구분하고 launchd 단일 인스턴스를 확인한다.

### 단계 3 — 단일 릴리즈와 24시간 canary

UI나 synthetic connector event를 사용하지 않는다. 실제 운영 이벤트와 로컬 DB/rollout/receipt/log만
읽는다.

완료 조건:

1. owner-event가 만든 `full + force` Board workorder가 0건이다.
2. owner-event Board 토큰이 기준선 대비 최소 60% 감소한다. 이벤트 수가 너무 적으면 비율 판정을
   보류하고 최소 10개 실제 batch가 쌓일 때까지 기다린다.
3. burst가 `1 open repair + 1 follow-up` 상한을 넘지 않는다.
4. 결정적 Temporal 오류 하나가 3회를 넘는 Code-Act 또는 1회를 넘는 model run을 만들지 않는다.
5. 정상 Temporal generation 하나가 완료 receipt까지 성공한다.
6. owner-event batch가 durable effect, accepted intent/workorder, exact no-update 중 하나 없이 ACK된
   사례가 0건이다.
7. TG-03/TG-04 권한, TG-05 session continuity, TG-06 delivery/receipt 회귀가 0건이다.
8. provider 오류, Telegram 409, 중복 전송, 본문 잘림, 내부 메타 노출이 0건이다.

실제 이벤트가 없으면 성공으로 추정하지 않고 canary를 계속 기다린다.

## 13. Slice B — Audit storage lifecycle 후속 설계 경계

현재 DB에는 보존 정책이 없는 대형 append-only 표면이 있다.

| 표면                  |       관측 크기/행수 | 현재 판단                             |
| --------------------- | -------------------: | ------------------------------------- |
| `context_packets`     |    약 261MB / 10,642 | payload가 크고 retention 없음         |
| `envelopes`           |  약 159.8MB / 54,959 | 관측 시점에 모두 expired              |
| `agent_activity`      | 약 144.5MB / 255,855 | workorder verifier가 현재 권위로 사용 |
| `model_runs`          |   약 57.3MB / 72,958 | 운영/비용 분석에 필요                 |
| `tool_traces`         |  약 45.9MB / 174,060 | 상세 nested execution 근거            |
| `validation_sessions` |   약 13.5MB / 12,462 | 현재 boot 이후 신규 없음              |

Slice B는 다음 결정을 별도 문서에서 승인받은 뒤에만 시작한다.

- durable business receipt, task, decision, provenance를 영구 보존 대상으로 분류
- `tool_traces`를 canonical detail로 할지 `agent_activity`를 canonical projection으로 할지 결정
- workorder verifier가 compact projection으로 전환된 뒤에만 원본 retention 적용
- age + terminal status + receipt reachability를 함께 사용하는 삭제 조건
- dry-run count/bytes, `VACUUM INTO` backup, batch delete, WAL checkpoint, rollback 검증

단순 행수 기준 삭제나 `agent_activity` 즉시 제거는 금지한다.

## 14. Slice C — launchd-safe daemon log rotation 후속 설계 경계

`daemon.log`는 관측 시 약 141MB였고 audit warning 기준은 50MB였다. 현재 daemon과 watchdog은 append
file descriptor를 오래 유지하므로 외부 rename만 하면 실행 중인 프로세스가 이전 inode에 계속 쓸 수
있다.

Slice C는 다음을 별도 설계한다.

- writer가 회전 후 file descriptor를 명시적으로 reopen하는 계약
- size/time trigger와 한 번에 하나의 rotation lock
- bounded generation 수와 비동기 gzip
- launchd 재시작 없이 회전되는 integration test
- crash 중 temp 파일/부분 gzip 복구
- secret redaction을 rotation 전후 동일하게 유지

## 15. 성공 정의

이 프로그램의 성공은 “검증 코드 줄 수 감소”가 아니다.

- 안전 검증과 receipt 불변식은 그대로다.
- 실제 모델 호출과 토큰이 줄어든다.
- 동일한 실패는 더 빨리, 구조적으로, 비재시도 상태로 끝난다.
- connector burst가 하나의 수리 의도로 수렴한다.
- 저장과 로그는 승인된 수명주기 안에서만 줄어든다.
- 각 슬라이스는 독립적으로 검증·출하·롤백할 수 있다.

## 16. 승인 후 다음 단계

이 문서 승인 후에만 `Slice A` 구현 계획을 작성한다. 구현 계획은 파일·테스트·migration 순서를
구체화하고, RED→GREEN 단위로 나눈다. Slice B와 Slice C는 Slice A의 24시간 canary 결과와 무관하게
각각 별도 설계 승인 게이트를 거친다.

## 17. What already exists

| 문제                            | 기존 권위/코드                                       | 재사용 결정                       |
| ------------------------------- | ---------------------------------------------------- | --------------------------------- |
| full Board dirt와 generation    | `BoardRefreshGate`                                   | 항상 생성하고 그대로 사용         |
| 열린 full repair dedupe         | `boardRepairKey()` + TaskLedger partial unique index | 새 queue를 만들지 않음            |
| workorder durable acceptance    | `operator_tasks`                                     | 실제 repair row 권위 유지         |
| owner-event batch 수명주기      | `OwnerEventInbox`                                    | intent FK/retention의 부모로 사용 |
| owner-event terminal recovery   | `getTerminalReceipt()`                               | exact batch intent lookup을 추가  |
| Board effect verification       | `applyBoardRefreshVerdict()`                         | verified generation만 적용 처리   |
| Temporal envelope defaults      | `ContextCompileService.coerceCompileInput()`         | 실행 의미 변경 없이 설명만 정합화 |
| trusted nested tool audit       | `hostToolExecutions`                                 | fingerprint의 유일한 입력         |
| run-local concurrency isolation | `RunScope`                                           | breaker counter를 여기에만 저장   |
| Temporal retry suppression      | `failTemporalWorkOrder(..., allowRetry)`             | exact terminal code만 연결        |
| backend terminal propagation    | `HostToolTerminalCode` → `AgentErrorCode`            | 닫힌 vocabulary 확장              |

새 queue, 새 worker, 새 model session, 새 외부 서비스는 필요 없다. 새 stateful class는
`OwnerEventBoardRefreshLedger` 하나다. Temporal breaker는 `RunScope`와 pure helper로 구현한다.

## 18. Code path and user-flow coverage plan

```text
PR-A: OWNER-EVENT BOARD
=======================
workorder_request(board)
  ├─ owner_manual
  │   └─ [★★★ EXISTING+REGRESSION] force:true, unique manual key
  └─ owner_event
      ├─ [★★★ NEW] same batch already linked → same durable receipt
      ├─ [★★★ NEW] no open repair → dirty → atomic intent+repair insert
      ├─ [★★★ NEW] open repair → dirty → atomic intent attach
      └─ [★★★ NEW] transaction error → no ACK, dirty remains safe

verified Board completion
  ├─ [★★★ NEW] no newer generation → apply intents, no follow-up
  ├─ [★★★ NEW] newer generation → terminal commit → one immediate follow-up
  ├─ [★★★ NEW] process dies before follow-up → boot repair recovers pending intent
  └─ [★★★ NEW] unverified/failed → no immediate hot loop, scheduled self-heal

owner-event recovery
  ├─ [★★★ NEW] enqueue committed, ACK missing → intent receipt ACKs without model
  ├─ [★★★ NEW] prose only / missing intent → retry
  └─ [★★★ NEW] inbox retention deletes intent through FK cascade

configuration
  ├─ [★★★ NEW] MAMA_BOARD_RECONCILE=1 → delta reconcile + full gate
  └─ [★★★ NEW] MAMA_BOARD_RECONCILE off → no delta reconcile, full gate still active

PR-B: TEMPORAL
==============
context_compile projection
  ├─ [★★★ NEW] registry + HostBridge use one description constant
  ├─ [★★★ NEW] Temporal brief requires omitted scopes/connectors
  ├─ [★★★ EXISTING+REGRESSION] omitted fields use trusted envelope
  └─ [★★★ EXISTING+REGRESSION] explicit widening remains denied

outer Code-Act call
  ├─ non-Temporal → [★★★ REGRESSION] existing 50-call behavior unchanged
  └─ Temporal
      ├─ [★★★ NEW] call 1..8 counted before execution
      ├─ [★★★ NEW] successful/different result resets consecutive fingerprint
      ├─ [★★★ NEW] same deterministic {tool,code} x3 → TOOL_CONTRACT_REPEAT
      ├─ [★★★ NEW] call 9 attempted → TOOL_CONTRACT_REPEAT before host execution
      ├─ [★★★ NEW] provider/transport/no-code failure → not fingerprinted
      ├─ [★★★ NEW] mutation terminal result → existing terminal code wins
      └─ [★★★ NEW] concurrent/next run → independent zeroed RunScope

terminal propagation [→EVAL: real Temporal canary]
  ├─ [★★★ NEW] Claude parsed tool path preserves exact code
  ├─ [★★★ NEW] Codex native host bridge preserves exact code
  ├─ [★★★ NEW] Cline custom tool path preserves exact code
  └─ [★★★ NEW] WorkOrderConsumer suppresses only TOOL_CONTRACT_REPEAT retry
```

모든 새 branch는 RED 테스트를 먼저 작성한다. prompt 품질의 최종 eval은 synthetic connector traffic이
아니라 실제 Temporal generation이 `context_compile → task_temporal_reconcile receipt`를 완주하는
24시간 canary다.

## 19. Production failure modes

| 실패                                    | 방어                             | 테스트                            | 사용자/운영자 표면               |
| --------------------------------------- | -------------------------------- | --------------------------------- | -------------------------------- |
| intent insert와 task enqueue 사이 crash | 같은 SQLite transaction          | crash-boundary integration        | batch 재시도, silent ACK 없음    |
| gate dirty 후 DB rollback               | safe extra dirt                  | transaction failure unit          | 다음 scheduled repair, error log |
| 여러 batch 동시 접수                    | single writer + unique batch/key | duplicate/concurrency integration | workorder 한 개                  |
| verified hook 뒤 terminal 전 crash      | 미적용 intent boot scan          | boot recovery integration         | 다음 boot repair                 |
| verified terminal 뒤 nudge 전 crash     | boot-dirty + pending intent      | boot recovery integration         | 다음 boot repair                 |
| unverified Board가 즉시 반복            | verified-only follow-up signal   | unverified completion regression  | 기존 경보, scheduled retry       |
| flag off에서 coalescing 비활성          | gate unconditional               | config matrix                     | 동일 owner-event 계약            |
| model이 failure audit를 위조            | executor-returned audit만 사용   | forged prose/result regression    | 위조는 breaker 권위 없음         |
| mutation과 contract failure가 함께 존재 | mutation terminal 우선           | precedence regression             | receipt-first no-retry           |
| provider outage를 결정적 오류로 오분류  | closed code allowlist            | 429/5xx/transport matrix          | 기존 backoff/retry               |
| breaker state가 다른 run에 누출         | RunScope local state             | concurrent-run regression         | 정상 owner/chat 영향 없음        |
| backend가 terminal code를 잃음          | closed transport vocabulary      | Claude/Codex/Cline matrix         | workorder 1회 실패, 재실행 없음  |

테스트와 오류 처리가 모두 없는 silent failure는 설계상 0개다.

## 20. Performance review

- owner-event마다 작은 intent row 한 개가 추가되지만 기존 7일 inbox retention과 함께 삭제된다.
- 미적용 scan은 partial index만 읽는다. 전체 acked history scan은 없다.
- 첫/중복 접수는 같은 SQLite connection의 짧은 write transaction 하나다. 모델 실행 시간과 비교하면
  미미하며, 외부 I/O를 transaction 안에서 수행하지 않는다.
- fingerprint는 최대 8회, 작은 `{name, code}` 배열만 hash한다. payload나 connector text를 hash하지
  않는다.
- 새 append-only telemetry row를 만들지 않는다. canary는 durable intent와 기존 운영 기록을 집계한다.
- 기대 효과는 기준선 owner-event Board 7,204,986 tokens와 Temporal 5,179,840 tokens의 반복 부분을
  직접 줄이는 것이다. 로컬 검증 마이크로초 경로는 그대로다.

## 21. NOT in scope

- Slice B 감사 데이터 삭제/압축: retention 권위와 backup 정책을 별도 승인해야 한다.
- Slice C daemon 로그 회전: launchd open-file lifecycle을 별도 검증해야 한다.
- 전역 reasoning effort 변경: 원인 제어가 아니라 품질/비용 정책 변경이다.
- owner-event AgentLoop 호출 자체 제거: 이벤트의 의미 판단은 MAMA의 일이다.
- Board 내부 tool sequence 하드코딩: TG-03/TG-04 agent freedom을 위반한다.
- Telegram/브라우저 synthetic canary: 실제 이벤트가 없으면 완료를 보류한다.
- 기존 대형 파일 일반 리팩터링: 이번 변경에 필요한 seam만 추출한다.

Slice B와 C는 본 문서에 이미 이유·범위·승인 게이트가 있어 `TODOS.md`에 중복 항목을 추가하지 않는다.

## 22. Implementation and PR structure

| 단계                           | 모듈                              | 의존성                                 |
| ------------------------------ | --------------------------------- | -------------------------------------- |
| PR-A intent ledger             | `operator/`                       | 기존 inbox/task ledger/gate            |
| PR-A wiring and recovery       | `cli/`, `operator/`               | PR-A intent ledger                     |
| PR-A focused/full verification | `tests/operator/`, `tests/cli/`   | PR-A 구현                              |
| PR-B context contract          | `agent/`, `operator/`             | PR-A 머지 후 최신 main                 |
| PR-B circuit breaker           | `agent/`, `operator/`             | PR-B context contract와 병렬 작성 가능 |
| PR-B focused/full verification | `tests/agent/`, `tests/operator/` | PR-B 구현                              |
| release/canary                 | release + local runtime           | PR-A와 PR-B 머지                       |

기술적으로 PR-A와 PR-B 구현은 병렬 가능하지만, 본 작업은 순차 진행한다. 두 PR 모두 패리티 문서를
수정하고 최종 릴리즈가 하나이므로, PR-A의 실제 review 결과를 PR-B 계획에 반영하는 편이 merge conflict와
동일한 실수를 줄인다.

## 23. Eng review completion summary

- Step 0 Scope Challenge: 두 PR, 한 릴리즈로 scope 분리
- Architecture Review: 4 issues found, 4 resolved
- Code Quality Review: 3 issues found, 3 resolved
- Test Review: coverage diagram produced, 30개 path를 RED/regression test requirement로 반영
- Performance Review: 2 issues found, 2 resolved
- NOT in scope: 작성 완료
- What already exists: 작성 완료
- TODOS.md updates: 0, 기존 설계와 중복이라 추가하지 않음
- Failure modes: 12개 검토, critical silent gap 0
- Outside voice: skipped, 별도 agent 요청 없음
- Parallelization: 2개 구현 lane을 의도적으로 순차 실행
- Lake Score: 9/9 교정에서 complete option 선택

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status       | Findings                                  |
| ------------- | --------------------- | ------------------------------- | ---: | ------------ | ----------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                |    0 | —            | Backend cost-control change라 생략        |
| Codex Review  | `/codex review`       | Independent 2nd opinion         |    0 | —            | Nested Codex 금지, 별도 agent 요청 없음   |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) |    1 | CLEAR (PLAN) | 39 issues/paths reviewed, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps                      |    0 | —            | UI 변경 없음                              |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       |    0 | —            | 공개 API/SDK 변경 없음                    |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED, ready to write the implementation plan.

## 24. PR-A implementation evidence

2026-08-26 기준 PR-A는 코드와 테스트가 완료됐고, 아직 운영 릴리즈는 하지 않았다.

- exact owner-event batch마다 durable intent를 한 행 저장하고 열린 Board repair 하나로
  coalesce한다. 직접 owner 요청만 기존 `force: true` 계약을 유지한다.
- intent acceptance와 workorder enqueue는 같은 SQLite transaction이다. 재시작 시 미적용 최대
  generation보다 높은 gate를 만들고 pending intent를 새 non-force repair에 재연결한다.
- full Board의 action verifier와 receipt가 모두 성공한 경우만 captured generation까지 적용한다.
  실행 중 들어온 더 최신 generation은 현재 workorder terminal 뒤 한 번만 follow-up한다.
- owner-event terminal receipt는 external effect 다음으로 durable Board acceptance를 확인하고,
  Wiki/memory permanent key와 exact no-update 경로를 그대로 보존한다.
- `MAMA_BOARD_RECONCILE`은 delta reconcile scheduler와 route만 제어한다. full repair gate는 항상
  존재한다.

검증 결과:

- PR-A 집중 gate: 8 files, 198 tests passed.
- Standalone: 382 files, 5,166 tests passed; 4 files / 7 tests skipped.
- Root: typecheck exit 0, build exit 0, test 7/7 Turbo tasks passed.
- 릴리즈, 실제 owner-event canary, 24시간 비용 비교는 아직 수행하지 않았다.
