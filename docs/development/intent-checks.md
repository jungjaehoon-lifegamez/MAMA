# MAMA 작업 후 의도 점검 기록

기준: [루트 INTENT.md](../../INTENT.md). 기술 계획을 대신하지 않는 짧은 판정 기록이다.
점검을 생략한 작업은 최상위 목적 완료의 근거로 사용할 수 없다.

## 기록 형식

- 작업 / 인텐트 버전 / 연결 시나리오:
- 기대한 사용자 행동 변화:
- 실제 결과와 증거 수준·위치:
- 남은 실패·미확인 조건 / 기준 축소 여부:
- 의도 판정: 부합 / 부분 부합 / 불일치
- 하위 작업 상태 / 최상위 목표 상태 / 다음 작업의 연결 이유:

## 2026-09-07 — 인텐트 고정과 작업 후 점검 연결

- 기준: INTENT v1, I-01~I-07. 기존 owner-action-authority 계획을 하위 실행 계획으로 유지한다.
- 기대 변화: 세션·작업·리뷰가 바뀌어도 같은 목적과 사용자 시나리오를 완료 기준으로 사용한다.
- 결과: 루트 INTENT.md를 만들고 AGENTS.md·CLAUDE.md의 첫 읽기 지점, 릴리즈 절차와
  진행 중인 실행 계획에 연결했다. 현재 기본 체크아웃과 실행 작업트리에 같은 인텐트를 반영했다.
- 검증: 링크·문서 위치·I-01~I-07 일곱 기준·두 체크아웃의 인텐트 일치와 diff 확인 완료. 문서 작업이므로
  런타임 테스트·재시작·Telegram 전송은 수행하지 않는다.
- 남음: I-02 자동 요약 실패, I-05 출력 서식 미적용, I-07 지연 목표 미달, I-03 보드 불일치
  직접 확인. I-01/I-04/I-06의 부분 증거도 전체 흐름 완료로 승격하지 않았다.
- 범위 축소: 없음. 발생 시점이나 파일 소속을 이유로 위 실패를 제외하지 않는다.
- 의도 판정: **부합 — 작업 기준을 고정하는 문서 작업으로서 부합. 제품 동작 개선을 뜻하지 않는다.**
- 상태: 문서 연결 작업 완료(링크·일치 검사 및 두 체크아웃 git diff --check 종료 코드 0). **최상위 목표는 미완료.**
- 다음 작업: 기존 계획의 작업을 I-01~I-07에 연결해, 요청/자동 입력 → 조회·판단 → 행동·보드
  반영 → Telegram 전달의 끊어진 부분을 실제 흐름에서 개선하고 다시 판정한다.

## 2026-09-07 — 제품 목적과 전체 실행 구조 재설계

- INTENT v2: 사용자 업무 부담 감소와 지속적인 판단·실행을 제품 목적으로 정리했다.
- 개발 점검과 I-01~I-07 기준은 intent-workflow.md로 이동했다. 런타임 선행 심사가 아니다.
- 기존 owner runtime 설계에 입력 통합, 발생/시도/효과 수명, 행동별 복구, 화면·전송 분리,
  기존 코드 제거 지도와 데이터 전환을 반영했다. TG-01/03/04/05/06.
- 결과: 설계 반영. 런타임 전환·설치·사용자 행동 개선은 아직 미구현이다.
- 의도 판정: 설계 수준에서 부합. 최상위 목적 미완료; 기존 실행 계획 S1부터 구현한다.

## 2026-09-07 — 정기보고 목적 복원

- 사용자 정정: 질문 응답이 아니라 폴링 데이터 가공과 정기보고가 목적이다.
- 이전 v2 설계는 실행기 통합을 앞세워 목적에서 벗어났다. 판정: 불일치.
- INTENT v3와 기존 설계·계획을 폴링→업무 맥락→변화 판단→정기보고로 수정했다.
- 런타임 변경은 아직 없다. 다음 작업은 보고 입력까지의 실제 가공 경로와 손실 추적이다.

## 2026-09-07 — 전체 제품 흐름 명시

- INTENT v4: 전체 수집 데이터 축적→쉬운 점진 접근→현시점 이해·보고→질문·작업 요청
  →가능한 실행→결과 반영을 하나의 목적으로 명시했다.
- v3에서 대화·실행을 보조로 축소한 해석을 수정했다. 기존 설계와 실행 계획에도 반영했다.
- 문서 반영이며 런타임 구현 완료가 아니다.

## 2026-09-07 — 공통 보고 실행 계약 구현

- INTENT v4 / TG-05/TG-06: 같은 보고 발생을 재시작 후 이어가고 명시적인 최종 결과만 전달한다.
- full/digest의 compose 계약을 통합하고 두 종류 모두 생성 전 요청을 저장한다.
- 문자열 호출, authoring 대체 경로, 과거 assistant 텍스트 폴백을 삭제했다.
- focused 129개 통과. 전체 standalone 실행은 5,663개 통과·구 API 호출 테스트 2개 실패였다.
  해당 호출을 전환한 뒤 영향받는 5개 파일 253개가 통과했다. 빌드·타입·변경 파일 lint 통과.
  전체 suite를 재실행한 결과로 표기하지 않는다. 설치는 하지 않았다.
- 부분 부합: 보고 실행 기반의 변화다. 전체 데이터의 버전 계약·쉬운 접근·업무별 가공·
  현시점 보고·오너 후속 실행까지의 구조 전환은 미완료다.

## 2026-09-07 — raw 변경이력 충실도(재전달/재관측 구분)

- 작업 / 인텐트 버전 / 연결 시나리오: RawStore 버전 저장의 두 결함 수정. INTENT v4
  (§데이터와 접근·§현시점의 이해). I-04(누락·판단시점·조회누락 구분), I-02(누락을
  변화없음으로 오인 금지), I-03(원문 변경의 일관 반영·최신/과거 구분), I-06(재시작 후 이어감).
- 기대한 사용자 행동 변화: 축적되는 변경 이력이 진짜 변화만 담는다. 업스트림이 불변 버전을
  재나열하거나 내용은 그대로인데 관측시각(observedAt)만 바뀐 재폴링을 "변화"로 오인해
  가짜 버전을 쌓지 않는다. 진짜 A→B→A는 보존한다. 재관측 시 last-seen은 갱신되어 조회
  누락과 무변화를 구분할 수 있다. (수정할 파일명이 아니라 이력 신뢰성이 목표다.)
- 실제 결과와 증거 수준·위치:
  - 단위: raw-store-revisions.test.ts 6개 통과(불변버전 replay=`[A,B]`, observedAt-only=1버전,
    A→B→A=3관측, guard 경로 last-seen 갱신, 배치 원자성). connector 스위트 32파일 528개 무회귀.
  - 후보 경로(합성 입력): `.superpowers/sdd/2026-09-07-owner-action-authority/dogfood/raw-flow.cjs`
    를 리빌드된 dist로 실행(exit 0). raw-flow-result.json:
    replayImmutableVersions {polls:2, storedVersions:2}, observedAtOnlyRePoll {polls:3,
    storedVersions:1}. 실제 RawStore+PollingScheduler.pollAll+save+index sink 경유.
  - 리뷰: opus 리뷰어가 back-compat(업그레이드 시 옛 해시 row 중복/인덱스 churn 없음)를 실측
    확인, Critical 0. 회귀(guard 경로 last-seen 미갱신)를 지적받아 TDD로 수정.
- 남은 실패·미확인 조건 / 기준 축소 여부:
  - `getRevisions` 프로덕션 호출자 없음 → 변경이력 "읽기 노출"(점진 접근 도구)은 다음 슬라이스.
  - calendar sourceId 형태 변경(`evt`→`evt:ver`)으로 업그레이드 후 인덱스에 옛/신 1회성 중복 →
    since-window로 소멸하나 backfill/cleanup 노트 필요.
  - 저장 행의 metadata.observedAt는 첫 관측값으로 고정(마지막 관측은 source_cursor가 보유).
  - 실제 모델 판단·운영 Telegram·설치는 미검증(installed:false, telegramSent:false).
  - 기준 축소: 없음. 리뷰 Issue2는 수정, Issue1(전역 observedAt strip)은 예약키 컨벤션으로
    문서화하고 collector-declaration 기구는 2번째 키 필요 시로 명시 유보(투기적 일반화 회피),
    Issue3는 다음 슬라이스로 추적. 어떤 실패도 범위 밖으로 밀지 않음.
- 의도 판정: **부분 부합** — 데이터 축적/관측시각 구분의 토대를 실제로 개선. 상위 흐름 완료 아님.
- 하위 작업 상태 / 최상위 목표 상태 / 다음 작업의 연결 이유: 하위 작업(변경이력 저장 충실도)
  완료. **최상위 목표 미완료.** 다음: 저장된 이력을 에이전트가 개요→검색→관련항목/이력→원문으로
  쉽게 쓰는 점진 접근 도구 연결(getRevisions 노출) — I-04/§데이터와 접근의 "읽기 절반".

## 2026-09-08 — 변경이력 읽기 노출 (P0 읽기 절반)

- 작업 / 인텐트 버전 / 연결 시나리오: raw 변경이력을 엔티티 단위로 조회 가능하게 노출. INTENT v4
  §데이터와 접근("개요→검색→관련 자료→원문"), I-04.
- 기대한 사용자 행동 변화: 소비자가 raw 항목 하나(raw_id)에서 그 엔티티의 전체 변경 이력을
  연대순·페이지로, **검색과 동일한 grant/scope 경계** 안에서 읽을 수 있다. 권한 밖 채널/스코프의
  revision은 절대 새지 않는다.
- 실제 결과와 증거 수준·위치:
  - core: connector_event_index에 source_entity_id 컬럼(마이그레이션 067) + upsert populate +
    `getRawHistory(entityId|rawId, connectors/scopes, limit, cursor)` (raw-query.ts). rawId 앵커는
    가시성 체크 후 엔티티 해석 → 앵커를 못 보면 아무것도 반환 안 함(인용이 읽기보다 더 읽지 않음).
    단위: raw-query.test.ts 9개(엔티티 이력/스코프 제외/커서/rawId 앵커/권한 밖 앵커) + 마이그레이션
    067 테스트 2개. mama-core 전체 668 통과.
  - standalone: agent-raw-handler에 `/:rawId/revisions` 라우트(search/detail/window와 동일 envelope
    가시성). e2e: agent-raw-api.test.ts 2개(엔티티 이력 반환·스코프 제외 / 앵커 비가시 시 빈 결과).
    standalone 전체 5674 통과. typecheck·lint 통과.
  - 후보 경로 dogfood(raw-flow.cjs, 리빌드 dist, exit0): entityRevisionsViaHttp {route:/:rawId/revisions,
    hits:2} — 실제 RawStore+pollAll+index+HTTP router+envelope로 grant-bounded 이력 읽기.
  - 회귀 수정: p2b-member-connectors-e2e가 마이그레이션을 65까지만 적용해 067 컬럼 누락 → 67로 상향.
- 남은 실패·미확인 조건 / 기준 축소 여부:
  - **에이전트 런타임 소비자 미연결**: 데몬 에이전트는 /api/agent/raw를 직접 호출하지 않음(그 HTTP는
    콘솔/외부/dogfood 소비). 에이전트가 이력을 실제 턴에서 쓰려면 provenance 경로 통합(channel-grant
    SQL) 또는 에이전트가 이 API를 호출하도록 배선 필요 → **다음 사이클**(플랜 R3'/R4' provenance 통합).
  - 같은 event-time revision들의 tiebreak는 event_index_id(임의) — 실 커넥터는 편집시각 distinct라
    문제없고 primary 정렬은 distinct-timestamp 유닛테스트로 검증. ingestion-order tiebreak는 후속.
  - 실제 모델/운영 Telegram/설치 미검증. 기준 축소: 없음(회귀·미연결을 숨기지 않고 명시).
- 의도 판정: **부분 부합** — P0 "읽기 절반"의 쿼리+API 표면 노출은 실증 완료. 에이전트 런타임 소비
  연결이 남아 P0 완전 종료는 아님.
- 하위 작업 상태 / 최상위 목표 상태 / 다음 작업의 연결 이유: raw 변경이력 저장+조회+API 노출 완료.
  **최상위 목표 미완료.** 다음: 에이전트 런타임 소비 연결(provenance 통합) → 그 뒤 P1(폴링→delta→보고).
