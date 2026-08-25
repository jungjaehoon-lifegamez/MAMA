# MAMA Runtime Overhead Reduction — 검증을 보존하고 모델 낭비를 제거하는 설계

> **상태:** 오너 검토 대기
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
  A1. owner-event Board coalescing + durable acceptance
  A2. Temporal host-bound context contract
  A3. deterministic failure circuit breaker + retry classification
  A4. 24-hour canary and cost comparison

Slice B — Audit storage lifecycle
  별도 보존 정책 승인 → additive archive/compaction → 온라인 정리

Slice C — launchd-safe daemon log rotation
  별도 회전 정책 승인 → reopen 가능한 writer → size/time rotation
```

Slice A가 정상 출하되어도 B와 C는 자동 승인되지 않는다. B는 데이터 보존이라는 파괴적 결정을,
C는 launchd와 열린 file descriptor의 수명주기 결정을 각각 요구한다.

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

operator DB에 additive 테이블 `owner_event_board_refresh_intents`를 추가한다.

| 열                         | 의미                                                 |
| -------------------------- | ---------------------------------------------------- |
| `batch_id` PK/FK           | owner-event batch와 1:1                              |
| `batch_key` UNIQUE         | 기존 event ID 정렬 해시로 만든 retry-stable identity |
| `repair_generation`        | 해당 요청이 더럽힌 Board generation                  |
| `status`                   | `accepted`, `attached`, `applied`, `failed`          |
| `workorder_id` nullable    | 실제 수리에 연결된 workorder                         |
| `last_error` nullable      | bounded operator 진단 문자열                         |
| `created_at`, `updated_at` | 복구와 retention 기준                                |

트랜잭션 순서:

1. `batch_id`로 intent를 `INSERT OR IGNORE`한다.
2. Board gate를 dirty로 만들고 generation을 intent에 고정한다.
3. 기존의 열린 non-force Board repair가 있으면 intent를 그 workorder에 `attached`한다.
4. 없으면 공용 `boardRepairKey()`로 `mode: 'full', force: false` 작업 하나를 enqueue하고 연결한다.
5. durable intent가 최소 `accepted` 상태가 된 뒤에만 `workorder_request` 성공을 반환한다.

동일 batch retry는 같은 intent를 읽는다. 새 batch가 활성 수리 중 도착하면 그 수리에 연결하되 새
generation은 남긴다. 여기서 `attached`는 “요청이 수리 coordinator에 접수됐다”는 뜻이지 현재
attempt가 그 generation까지 처리했다는 뜻이 아니다. 활성 수리가 자기 captured generation까지만
지우므로, 이후 generation이 남으면 완료 hook이 기존 terminal row가 공용 key를 놓은 뒤 후속 수리를
하나 enqueue하고 아직 적용되지 않은 intent를 새 workorder에 다시 연결한다. 결과적으로 burst는
`1 open repair + 1 durable follow-up obligation`으로 수렴한다.

#### 완료와 ACK

- owner-event terminal receipt는 더 이상 Board task의 exact occurrence key만 찾지 않는다.
- 해당 `batch_id`의 intent가 `accepted` 이상이고 연결된 workorder가 존재하면 `delegated` receipt를
  반환한다. 이는 기존 `accepted workorder` 의미를 유지한다. Board 수리 완료를 기다려 owner-event
  inbox를 붙잡는 계약으로 바꾸지 않는다.
- workorder 완료 hook은 captured generation 이하 intent를 `applied`로 전환한다.
- 수리 실패는 intent를 삭제하지 않는다. gate dirt와 intent를 남기고 기존 Board 경보/자기회복
  경로가 후속 수리를 맡는다.
- boot recovery는 `accepted/attached` intent의 최대 generation보다 큰 값으로 Board gate를
  초기화하고 boot-dirty full repair 하나에 미적용 intent를 다시 연결한다. 메모리 gate만 보고 수리
  완료를 추정하지 않는다.
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

1. canonical tool registry와 HostBridge가 동일한 `context_compile` 설명을 생성한다.
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
  outerTool + nestedTool + normalizedFailureCode + authorityBoundary
)
```

`authorityBoundary`는 scope/destination/principal 계열을 구분하지만 실제 ID나 민감한 입력은 포함하지
않는다. 오류 메시지 전체를 hash하지 않아 숫자·정렬·표현 차이로 회피되지 않게 한다.

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

- 같은 Temporal run에서 같은 결정적 fingerprint가 연속 3회 나오면 즉시
  `TOOL_CONTRACT_REPEAT`로 종료한다.
- 추가 안전망으로 Temporal run의 outer Code-Act 호출은 최대 8회다. 일반 owner turn과 다른 lane은
  기존 50-call ceiling을 유지한다.
- 종료 결과는 `retryable: false`, `failureClass: 'deterministic_contract'`, fingerprint의 짧은
  비민감 prefix를 갖는다.
- WorkOrderConsumer는 trusted structured result만 보고 `allowRetry: false`로 generation을 실패
  처리한다. 응답 prose에서 “재시도하지 마라”를 파싱하지 않는다.
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

| 실패 지점                       | 처리                                                 |
| ------------------------------- | ---------------------------------------------------- |
| intent INSERT 실패              | workorder 요청 실패, owner-event retry; ACK 금지     |
| intent 저장 후 enqueue 전 crash | boot recovery가 intent로 repair를 재생성             |
| enqueue 후 ACK 전 crash         | 동일 batch intent/workorder를 찾아 ACK; 새 작업 금지 |
| Board 실행 중 새 event          | 새 generation 유지, 현재 완료 후 follow-up 최대 하나 |
| Board publish 검증 실패         | dirt와 intent 유지, existing alarm/self-heal 사용    |
| context_compile 권한 위반       | fail-closed + fingerprint 카운트                     |
| 결정적 실패 3회                 | 비재시도 generation 실패                             |
| provider 429/5xx                | 기존 transient retry                                 |
| mutation outcome unknown        | 기존 no-retry receipt-first recovery 우선            |
| daemon shutdown                 | 기존 active workorder drain/boot recovery 계약 유지  |

## 10. Migration과 호환성

- `owner_event_board_refresh_intents`는 operator DB에 additive `CREATE TABLE IF NOT EXISTS` migration으로
  추가한다.
- 기존 `owner_event_inbox`, `operator_tasks`, `owner_event_effects` 행은 수정하지 않는다.
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
2. `TG-06`: 서로 다른 20개 batch burst가 open repair 하나에 attach되고 follow-up은 최대 하나다.
3. `TG-06`: enqueue 후 ACK 전 crash가 새 workorder 없이 durable acceptance를 복구한다.
4. `TG-06`: 새 generation은 오래된 repair 완료로 지워지지 않는다.
5. `TG-06`: prose-only 또는 intent 없는 성공은 ACK되지 않는다.
6. `TG-03/TG-04`: owner manual Board 요청은 여전히 `force: true`; owner-event는 `force: false`다.
7. migration I/O 실패는 fail-closed하고 기존 DB bytes를 보존한다.

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

### 단계 1 — shadow 계측

한 릴리스 동안 기존 동작을 바꾸지 않고 다음 counter를 추가한다.

- owner-event Board intents accepted/attached/applied/failed
- Board repair open/follow-up/coalesced batch 수
- Temporal deterministic fingerprint count와 breaker termination
- workorder별 model runs, tokens, duration, retry class

민감한 event ID, connector payload, chat ID, scope ID는 로그에 기록하지 않는다.

### 단계 2 — Slice A 활성화

- 기능 플래그는 rollback용으로만 두며 기본값은 새 경로다.
- old path를 fallback으로 호출하지 않는다. 새 durable path가 실패하면 fail loudly 한다.
- build/install/restart는 별도 단계로 구분하고 launchd 단일 인스턴스를 확인한다.

### 단계 3 — 24시간 canary

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
