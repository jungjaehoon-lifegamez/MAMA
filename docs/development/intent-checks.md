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

## 2026-09-08 — 보드 갱신 봉인 해제 (Stage 0, feat/intent-v4-owner-flow 80e52da9)

- 작업 / 인텐트 버전 / 연결 시나리오: INTENT v4. I-02, I-03, I-01(내용 조건), I-07 실측.
- 기대한 사용자 행동 변화: 전체보고를 요청하면 답장 내용이 "작업판 갱신 실패·미해결"이라는
  MAMA 자체 오류 대신 현재 보드를 반영한다. 정기 보드 갱신이 실제로 돈다.
- 실제 결과와 증거 수준·위치:
  - 원인(코드+운영DB 검증): `hasUnsafeReplayEffects`가 확정된 `task_create`를 재실행 위험으로
    판정 → 고정 occurrence `workorder:board:full:repair`가 영구 봉인 → 비강제 full 보드가 claim
    즉시 failed(board#4688) → `report-slots.json` 3칸이 09-07 16:44 stale. 수정: 확정
    `task_create`를 `native_run`과 함께 허용(`ledger.atomic`로 재실행 시 영수증 반환). 확정 Bash /
    native_tool / 미확정 효과는 계속 차단(기존 pin 테스트 :95/:160 무변경 green).
  - 단위: `tests/operator/board-repair-replay-gate.test.ts` 4건(RED 재현→GREEN + 음성 3건),
    관련 5 스위트 119 통과, typecheck. 실원장 복사본: board 3→0 해제, self-check Bash 1→1 유지.
  - 운영(정상 데몬, 후보 설치 10:48): board#4694 `completed`(같은 고정키), 강제 갱신 0건,
    `report-slots.json` briefing/action_required/decisions **10:52:29 current**(before 09-07 16:44 stale).
  - 오너 텔레그램: `전체보고해줘` 10:54:54 → 답장 11:07:40, 본문에 갱신 실패 문구 0건, 10:52 슬롯 인용.
- 남은 실패·미확인 조건 / 기준 축소 여부: **I-07 미충족** — 766초(큐 대기 70s + 턴 700s; 툴 실행 11s,
  나머지 모델 스텝 간 사고·작성, code_act 16회). n=1, p95 미측정. I-05 서식 plain. 기준 축소 없음.
- 의도 판정: **I-02 충족, I-03 부분 확인→충족(슬롯 current; 보드-화면 직접 대조는 이 사례만),
  I-01 부분 부합(내용 조건 충족, 서식·시간 미충족), I-07 미충족.**
- 하위 작업 상태 / 최상위 목표 상태 / 다음 작업의 연결 이유: Stage 0 완료. **최상위 목표 미완료.**
  다음: Stage 1 — 스텝 수 축소로 보고 지연(모델 사고 시간) 해결, 새 기구 없이. Stage 2 — 서식.

## 2026-09-08 — 전체보고 지연: 보고 계약 축소 (Stage 1, 설정 변경만)

- 작업 / 인텐트 버전 / 연결 시나리오: INTENT v4 I-07(전체보고 응답 시간). 소스 변경 없음.
- 기대한 사용자 행동 변화: `전체보고해줘`에 카게무샤 수준(~3분 이내)으로 답장이 온다.
- 실제 결과와 증거 수준·위치:
  - 계량(run mr_47474c33, 766초): 큐 대기 71s(공유 오너 레인, 백그라운드 턴 뒤) / 툴 실행 합계
    11s(tool_traces 58행) / 모델 스텝 간 사고 ~450s(code_act 27스텝, 66·63·157s 공백 3회) /
    최종 작성 169s. 시간의 81%가 모델 왕복·작성.
  - 원인: 오너 페르소나 `~/.mama/CLAUDE.md`(7/28, 제품 기본값 아님)의 전체보고 문단이 "모든 활성
    라인을 매번 task_list·trello_kanban·kagemusha로 새로 수집"을 요구 → task_list 7회, trello_search
    9건×2회(활성 라인별 Trello 대조), 40개 열린 태스크 전수 서술. `~/.mama/operator/prompts.json`
    (`statusReportBody`/`osFullReportBody`)과 `locale.json.statusRequestPattern`은 소스 어디서도
    로드되지 않는 죽은 설정(grep 0건) — 이전 기록의 "보고 계약" 지목은 오류.
  - 삭제: CLAUDE.md 문단을 카게무샤 기준선으로 교체(task_list 1회가 진실, 재조회는 판단이 바뀔
    때만, 라인별 Trello 대조 금지, 변화 없는 라인은 요약 한 줄, 재독 없이 한 번에 작성).
    prompts.json 삭제, statusRequestPattern 제거. 백업 `~/.mama/backups/pre-stage1-20260908-111548`.
    데몬 재시작(페르소나는 첫 턴 주입) PID 8610.
  - 재측정(run mr_ec4513f4, 오너 텔레그램): 도착 11:17:50 → 답장 11:20:21 = **151초**
    (큐 대기 55s + 턴 95s; code_act 1스텝, board_read+task_list 각 1회, trello 0회). 답장 5절
    (핵심상황/대응 필요/결정 필요/파이프라인/다음 액션), 활성 40건 총계·D-day·담당 포함,
    갱신 실패 문구 0건. 카게무샤 ~172초 대비 동급.
- 남은 실패·미확인 조건 / 기준 축소 여부: n=1(전후 각 1회). 큐 대기 55–71s는 공유 레인 설계
  그대로(스케줄러 추가 금지 — 삭제로 풀리지 않음). 재시작 중 SIGKILL로 owner-event batch 692가
  `dead`(native_run 효과 unknown) — 그 내용(수정본 수신)은 태스크 원장에 이미 반영돼 답장에 포함;
  배치 자체는 재실행 안 됨(재시작 부수 피해, 제품 결함 아님). 이 변경은 오너 로컬 페르소나라
  PR/릴리즈 대상 밖; 제품 기본 페르소나(init.ts)에는 해당 문구가 없음. 기준 축소 없음.
- 의도 판정: **I-07 부분 확인(n=1, p95 미측정)**. I-01 시간 조건은 이 단일 사례만 확인, 서식(I-05) 미충족.
- 하위 작업 상태 / 최상위 목표 상태 / 다음 작업의 연결 이유: Stage 1 완료. **최상위 목표 미완료.**
  다음: Stage 2 — 텔레그램 서식(유일한 소스 변경) → 설치 → 오너 개밥먹기 → PR/릴리즈.

## 2026-09-08 — Stage 2 서식 후보 3차 리뷰 수정

- INTENT v4 / I-05, I-06, TG-01/TG-05/TG-06. 제목·링크·코드·인용과 긴 답변을 실제 Telegram 서식으로 전달하는 후보다.
- Opus는 세션 사용량 한도로 실행되지 않았다. 사용자 지시로 Codex 독립 리뷰 1명으로 대체했다.
  최초 중요 발견 3건과 부모의 스트리밍 재현을 수정하고, 동일 리뷰어의 한정 재검토에서 P1/P2 0건을 확인했다.
- 긴 HTML 원문을 자르기 전에 entities로 변환하여 열린/닫힌 태그가 노출되는 결함을 수정했다.
  회귀 테스트에서 `567890</b>` 노출을 확인한 뒤 서식 있는 10자 출력으로 통과했다.
- 지침은 공통 owner 정책과 fingerprint에 한 번 포함한다. 채팅 전용 지침과 정기보고별 중복 주입은 제거했다.
  background-first 및 inbound-first 실제 라우터→AgentLoop→Codex 프로토콜 fixture에서 thread/start 1회,
  초기 지침 1회, turn/start 재주입 0회를 확인했다. 외부 모델·Telegram 전송은 대역이다.
- 기존 pending의 chunk index를 새 분할 경계로 해석해 마지막 3글자가 누락되는 inbound/outbound 실패를 재현했다.
  기존 원장의 선택적 chunkFormat 필드로 새 형식을 기록하고, 필드 없는 기존 전송은 원래 경계로 복구한다.
  새 테이블·큐는 추가하지 않았다. 관련 7파일 300테스트 및 이후 ingress 2사례 통과, 빌드·타입 검사 통과.
- I-07은 151초 단일 사례이며 p95 목표 전체 충족은 아니다. 이전 기록의 충족 판정을 부분 확인으로 정정했다.
- I-04의 원문 대조·판단 품질과 I-06의 실제 재시작 후 미완료 업무 전체 재개는 이번 서식 증거로 판정하지 않는다.
- 의도 판정: 부분 부합. 후보 코드 검증이며 실제 설치·Telegram 표시 확인은 남아 있다. 최상위 목적 미완료.

- 최종 후보 검증: root `MAMA_FORCE_TIER_3=true pnpm test` 종료 0, 7/7 작업 성공,
  standalone 421파일·5,720 통과·7 기존 제외. root build 2/2, typecheck 3/3, 변경 파일 ESLint/Prettier와 diff 검사 통과.
  독립 재리뷰 PASS. npm pack 타르볼 1,475파일에 viewer/operator JS·CSS와 새 formatter 포함 확인.

- 후보 설치: 전체 빌드 후 npm pack한 타르볼 1,475파일을 기존 의존성을 유지하며 설치했고 전 파일 SHA-256 일치를 확인했다.
  bin 실행 권한을 적용했다. 설치 버전 번호는 0.51.0 로컬 후보이며 공개 릴리즈가 아니다.
  운영 작업 완료·active workorder/claimed event/자식 프로세스 0 확인 후 SIGTERM을 보냈다.
  API 종료 뒤 잔류한 부모 프로세스는 SIGKILL로 정리했다. 새 데몬 PID 45095, Telegram 연결,
  CLI status Running, viewer/operator JS·CSS HTTP 200 확인. 본문 작성 지침도 설치 후 일치시켰다.
- 실제 사용자가 보낸 전체보고의 시각적 서식·내용·응답 시간은 아직 확인 대기다. I-05 전체 충족이나 릴리즈 완료로 판정하지 않는다.

- 인증된 runtime status API: HTTP 200, version 0.51.0, health 60/degraded. calendar의 20페이지 수집 한도 오류가
  이전/이후 로그에 모두 존재한다. 서식 후보에서 새로 발생한 문제는 아니며 수집 완전성 미확인 상태를 유지한다.
  재기동 뒤 실제 전체보고 요청 미수신. 사용자 전송·화면 확인을 기다리며 PR/공개 릴리즈는 진행하지 않았다.

## 2026-09-08 — 실제 Telegram 평문 보고 후 운영 지침 충돌 수정

- INTENT v4 / I-05, I-07, TG-01/TG-06. 사용자는 공개 웹보드 연결 문제 해소를 확인했다.
  로컬 브라우저의 실제 Board 렌더링도 확인했다. 공개 주소의 최초 로딩 오류 원인은 확정하지 않는다.
- 후보 첫 전체보고(id 1330)는 본문 서식 태그 0개, Bold 0개였다. 전송 코드의 존재만으로 I-05를 충족했다고
  판단할 수 없다. 실제 Codex 초기 정책에는 새 guide가 있었지만, 앞선 자동 작업 프롬프트에는 운영 브리프의
  평문 전용·볼드 금지·entities 미노출 시 평문 사용 규칙이 그대로 포함돼 있었다.
- 운영 브리프의 낡은 서식 규칙 3개를 백업 후 제거하고, 본문 HTML을 전송기가 entities로 바꾼다는 현재 계약으로
  대체했다. 기타 업무 규칙은 유지했다. 이번 수정은 사용자 로컬 설정이며 PR 소스 변경이 아니다.
- 같은 운영 모델 gpt-5.6-sol의 격리된 짧은 fixture는 제목 3개를 Bold로 변환했다. low effort·합성 내용이므로
  운영 전체보고 품질/시간 증거와 구분한다. 실제 채널에는 이 fixture를 전송하지 않았다.
- 사용자의 직접 서식 정정과 재요청 이후 작업완료 답변(id 1332)은 Bold 1개, 최신 전체보고(id 1334)는
  Bold 5개로 변환되는 본문을 생성했다. 전체보고는 한 메시지로 delivered(12:39:14.865 KST),
  라우터 수신 12:36:28.732부터 약 166.1초였다. 이 관측은 로컬 설정 변경만의 통제된 효과 비교가 아니다.
- 의도 판정: I-05 부분 확인(실제 HTML 본문·전송 완료; 사용자의 시각적 Bold 확인 대기),
  I-07 부분 확인(이전 235초대 평문 보고와 이번 166초 보고, p95 미측정). 최상위 목적/공개 릴리즈 미완료.

- 사용자 최종 확인: 최신 전체보고의 제목이 Telegram 화면에서 실제 굵게 보인다고 응답했다.
  이 사례의 본문 생성→entities 변환→전송→시각적 Bold까지 확인했다. 인용·코드·링크·모든 스트리밍 상태의
  실제 화면을 일괄 확인한 것은 아니므로 I-05 전체 판정은 부분 확인을 유지한다.

## 2026-09-08 — PR 274 자동 리뷰 반영

- TG-01/TG-06: plain-v1 presenter가 스트리밍에서도 HTML을 해석하지 않도록 수정했다.
  레거시 스트리밍 회귀가 수정 전 실패함을 확인했다. 빈 전송 테스트는 미완료 목록 대신 정확한 원장 키 부재를 확인한다.
- 새 formatter 테스트를 Story/AC 기준으로 묶었다. 추가 독립 모델 리뷰는 실행하지 않았다.
- task_create 게이트의 다른 creation_key 중복 위험은 실재하며, Stage 0에서 수용한 경계다. 같은 occurrence 안에서
  여러 정상 업무를 만드는 자유를 유지한다. 동일 키·동일 의도는 원자적 영수증으로 재사용하고 충돌 의도는 거부한다.
  다른 키를 같은 업무에 재사용하는 모델 오류까지 의미적으로 제거하지는 않는다. 이를 막으려고 확정 task_create를
  일괄 재차단하면 고정 board repair occurrence가 영구 봉인되는 원래 오류로 돌아간다. shell/native/미확정 효과 차단은 유지한다.

- 검증: 첫 전체 실행은 테스트 5,721개 통과 뒤 기존 Codex protocol 종료 fixture의 비동기 EPIPE로 명령 종료 1.
  해당 파일 포함 4파일 259개가 재실행에서 통과했고, 이후 전체 재실행은 7/7 작업·standalone 5,721개 통과,
  기존 7개 제외·명령 종료 0이었다. 빌드·lint 통과. CodeRabbit은 creation_key 경계 설명을 수용하고 해당 지적을 철회했다.

## 2026-09-08 — 보드 판단 슬롯 완료 검증 버그 수정

- TG-01/TG-06: 작업을 실제 수행했는데 모델에게 요구하지 않은 pipeline 슬롯 때문에 재점검되던 불일치를 수정했다.
- REQUIRED_BOARD_JUDGMENT_SLOTS와 화면 전체 최신성용 REQUIRED_FULL_BOARD_SLOTS를 분리했다.
  모델은 판단3슬롯의 실제 저장 성공을 검증하고 pipeline은 기존 호스트 projection/freshness 경로가 담당한다.
- 회귀 테스트의 실패(expected false to be true)를 먼저 확인했다. real publisher/DB/repair gate 경로에서
  성공→captured generation 해제, 후속 새입력 유지, 부분/실패/다른attempt/과거trace 거부를 검증했다.
  호스트 pipeline 연결 성공과 projection 실패 시 성공 trace 미인정도 확인했다.
- 검증: 관련4파일112테스트, standalone build, tsc --noEmit, 변경파일eslint 모두 종료코드0.
  운영 sessions DB 읽기 전용으로 실제4704/276781 기록을 빌드된 검증기에 적용: 기존0건/수정1건.
- 판정: 좁은 완료 검증 버그 수정으로 부합. 실제 실행 확인은 유지했다. 코드 수정/검증 완료이며
  설치·재시작·새 Telegram 검증·실제 지연 개선과 v1 전체 완료는 아니다.

## 2026-09-08 — 교정·절차·트리거 공통 실행 후보

- 인텐트: v6의 오너 교정·반복 작업 결과 → 조건 있는 재사용 절차 → 다음 실제 업무.
  I-01/I-02/I-05/I-06, TG-01/TG-03/TG-04/TG-05/TG-06에 연결한다.
- 변경: 기존 operator DB의 scope별 불변 절차 revision과 조회·교정·폐기·관측 도구,
  운영 브리프 부분 대체 및 충돌 보존, legacy trigger 연결, 대기 후 admission 재확인,
  공통 owner 역할의 요청형 report_publish 노출. 사용 조건과 비적용 조건은 에이전트가
  판단하며 저장·선택·결과 관측을 실제 학습 성공과 구분한다.
- 코드 근거: 전체 `pnpm test` 작업 7개 성공, standalone 5,792 통과/7 제외.
  마지막 최초 브리프 읽기 결함은 runtime 회귀 테스트 RED 확인 후 관련 38개 GREEN.
  변경 TypeScript 39개 ESLint 및 Prettier 통과. 독립 리뷰의 범위·대기 admission·projection
  복구·legacy 연결 지적을 수정하고 마지막 두 한정 재검토 CLEAR.
- 실제 모델 근거: 격리된 AgentLoop/GatewayToolExecutor/ProcedureStore와 고정 합성 입력.
  보고용 규칙의 오해를 재현한 뒤 오너 교정으로 r1→r2 변경, 원지시·scope 유지,
  새 대화의 보고 적용과 일반 대화 비적용 확인. 운영 메신저나 실자료 전달 증거는 아니다.
- 파일 업무의 첫 관측: A는 원문 항목을 의미상 보존하여 충족, B는 완료 항목의 근거
  2개를 누락하여 실패. 단일 실패 관측 후 절차를 유지한 결과는 음성 사례이며 자율 개선
  성공이 아니다. 추가 C 파일은 전체 항목과 근거를 보존하여 충족했다. 반복 실패가
  확보되지 않아 추가 관측·학습 후 heldout 및 다른 모델 전이는 실행하지 않았다.
- 증거 위치: 로컬 `.superpowers/validation/correction-activation/live/validation-summary.json`,
  `usage-timing-summary.json`, `report-revision-history.json` 및 원본/실제 산출물.
  총 9회 실제 모델 실행 합계 537.651초, 보고된 입력 592,701/출력 9,549 tokens.
  입력 사용량에는 반복 컨텍스트가 포함될 수 있다. 전달 단계·운영 p95 측정값은 아니다.
- 현재 판정: 기반 코드와 오너 교정 사례 부분 확인. 자율 개선·교체 모델의 비보고 산출물,
  `pnpm build` 2개 작업도 성공했다. 패키지 설치·실운영 반영은 미확인. 아직 릴리즈하지 않았으며 v1 전체 완료가 아니다.

## 2026-09-08 — 교정 후보의 로컬 운영 설치 (공개 릴리즈 전 개밥먹기)

- 오너가 로컬 후보 설치를 명시 승인했다. 공개 릴리즈와 로컬 실사용 평가를 분리한다.
- 기존 `0.51.2-local.1` 복구 패키지, SQLite 11개와 설정·운영 브리프를 백업한 뒤
  `0.52.0-local.1`을 설치했다. 로컬 패키지의 workspace 의존성을 실제 mama-core 2.4.0으로
  해석하여 설치했고, 설치 파일 1,495개의 해시가 후보 아카이브와 일치했다.
- `mama status` exit 0: CLI/runtime 모두 `0.52.0-local.1`, PID 18800, Running,
  Health 98/100. Telegram 연결, procedure 테이블 5개 생성, Operator JS HTTP 200 및
  설치 파일 일치 확인. 기존 운영 브리프 원문은 백업과 바이트 단위 동일하다.
- 재시작 로그에서 위키 작업 #4728의 effect reconciliation 전 replay 보류를 관측했다.
  중복 효과를 강제 재실행하지 않았다. Calendar page cap 20 경고는 이전 운영 로그에도 있다.
- 증거: 로컬 `.superpowers/validation/correction-activation/local-install.json`.
  복구 백업은 `~/.mama/backups/pre-correction-local-20260908-214526/`에 보관한다.
- 판정: 로컬 설치·연결 확인 완료. 이후 실제 Telegram 요청·교정·후속 보고/파일 업무에서
  적용 범위와 지속성을 검증할 수 있다. 합성 운영 메시지는 전송하지 않았으며 실사용에서의
  자율 학습·재시작 후 행동 개선은 아직 미입증이다. PR/머지/공개 릴리즈는 미실행이다.

## 2026-09-08 — 원마마의 자율 수행 경로 재조사

- INTENT v6, I-01/I-02/I-06/I-07 및 TG-03/TG-04/TG-05/TG-06 기준으로 설치 후보를 조사했다.
- 오너가 재확인한 완료 기준은 관련 상황의 작은 힌트 → 자료의 점진 조사 → 판단·수행 →
  실제 결과 관측 → 근거 있는 교정 → 다음 상황의 개선된 힌트·행동이라는 순환이다.
  호스트가 정한 행동 순서를 잘 실행하는 것을 자율 에이전트의 성공으로 간주하지 않는다.
- 예약 실행의 교훈 저장 억제 지시, 병행 policy/lesson 작성자, 독립적인 프롬프트 조립,
  결과 관측의 분리, 무관한 알림 혼입과 장시간 배경 작업의 직접 요청 차단을 확인했다.
- 실제 4회 실행에서 Code-Act 59회 중 탐색/설명 포함 36회, 도구 실행 합계 4.633초.
  최소 힌트 조건의 동일 데이터 비교는 아직 미수행이며 원마마 완료로 선언하지 않는다.
- 상세 근거와 폐기·통합 방향: [자율 수행 조사](2026-09-08-one-mama-autonomy-audit.md).
  조사 중 운영 지침 수정·프로세스 재시작·추가 모델 실험은 하지 않았다.

## 2026-09-08 — 경험 순환 앵커로 수정안 재평가·재계획

- INTENT v6의 목적은 충분하며 추가 기능 목록으로 확장하지 않았다. [학습 앵커](one-mama-learning-anchor.md)를
  문서화하고 실제 운영에서 확인한 실패를 완료 판정의 기준으로 삼았다.
- 기존 교정 계획은 scope/revision/CAS/projection 기반으로 재분류했다. 배경 학습 억제,
  키워드 정책 작성자, 병행 프롬프트 조립은 폐기/통합 대상으로 명시했다.
- 후속 계획: 로컬 .superpowers/plans/2026-09-08-one-mama-experience-loop-plan.md.
  Code-Act 오류 경험의 재사용을 첫 수직 사례로 삼고, 보고 교정·비보고 파일 작업·비적용·
  담당 교체 및 최소 힌트 비교를 별도 실제 결과로 검증한다.
- 이번 작업은 재평가와 계획 작성이다. 운영 코드 변경·재시작·새 모델 행동 실험·공개 릴리즈는 하지 않았다.

## 2026-09-09 — 공통 힌트·실행 근거 연결 구현 후보

- INTENT v6 및 원마마 학습 앵커, I-01/I-02/I-06/I-07, TG-03/TG-04/TG-05/TG-06.
- 기존 tool_traces에 scope·상세 근거·진단·catalog revision을 additive migration 068로 연결했다.
  별도 경험 DB나 자동 액션표를 만들지 않았다. 목록/상세/페이지 조회는 권한 범위 안에서 동작한다.
- AgentLoop admission에서 최근 실행 근거 refs와 설치 스킬 설명/원문 위치를 제공한다.
  키워드 일치로 스킬 본문 전체를 지시처럼 주입하던 대화·이벤트 경로를 제거했다.
- 예약 실행의 교훈 저장 억제와 short legacy intro의 추가 전용 문구 잔존을 수정했다.
  운영 원본 파일을 대신 편집하거나 보고 정답을 하드코딩하지 않았다.
- 실제 DB/GWE 기본 API 통합에서 오류 input/result 보존, 성공 호출, 재개 후 힌트,
  authority 인자 위조 거절, evidence 읽기의 재귀 복제 방지, DB 조회 실패시 독립 실행 유지,
  skill catalog/execution 목록의 공개 도구 호출을 확인했다. 관련 137개 테스트 통과.
- 한정 리뷰 지적(문자열 credential·요약 노출, 선택적 조회의 실행 차단, 과거 근거 재복제,
  kind 인자 계약 누락)을 수정하고 재검토했다. 전체 테스트와 설치 검증은 다음 기록으로 확정한다.
- 경계: 현재 힌트는 최근 실행 후보와 스킬 카탈로그이며 의미 기반 관련성 검색·기존 policy/lesson
  작성자 통합·긴 보드 행동 대본 정리는 남아 있다. 실제 학습 전이/반복 개정 감소/속도 개선은
  아직 입증하지 않았다. 저장·통합 테스트를 에이전트 자율 개선 완료로 세지 않는다.

## 2026-09-09 — 실행 근거/스킬 힌트 후보 로컬 설치 및 운영 스키마 복구

- 설치 후보: mama-os 0.52.0-local.3 + mama-core 2.4.1-local.2. 공개 릴리즈가 아니다.
- 전체 사전 검증: pnpm test 7개 작업 성공, standalone 5,809 통과/7 제외, pnpm build 2개 작업 성공.
- 첫 설치에서 migration068이 운영 MetricsStore의 기존 project_id/channel_id와 충돌했다.
  기존 runner가 전체 transaction을 rollback한 뒤 version68을 표시해 새 필드가 없는 상태였다.
  상태조회는 정상이어도 실제 DB 필드 검증이 실패했으므로 서비스를 중지하고 복구했다.
- core migration68 전용 idempotent reconciliation으로 누락 컬럼/인덱스를 같은 transaction에서
  보충·검증한다. 이미68인 부분 적용 DB도 복구하고 기존 데이터를 유지한다. 운영 DB 복사본에서
  실제 복구 및 trace row count 보존 확인. runner12+기타 migration/trace31 테스트 통과,
  한정 독립 리뷰 차단 사항 없음. 후속 전체 검증 결과는 별도 로그로 보관한다.
- 최종 설치 파일 검증: standalone 1,499개/core286개 해시 일치. PID13044, Running,
  CLI/runtime0.52.0-local.3, Health98/100, Telegram연결. 실제 DB6필드/2인덱스와 OperatorJS
  HTTP200/설치파일 일치 확인. 기존 운영 브리프는 백업과 바이트 동일.
- 백업: ~/.mama/backups/pre-experience-local-20260909-011704/ (복구패키지·DB11개·설정·브리프·스킬).
  증거: .superpowers/validation/experience-loop/local-install.json,
  /private/tmp/mama-schema068-repair-proof.json, /private/tmp/mama-experience-repaired-runtime.log.
- 현재 실제 학습 전이, 보드 반복 감소, latency 개선은 아직 미입증이다. 새로 발생한 실행의
  근거를 수집하며, legacy unscoped trace를 임의로 owner에게 귀속시키지는 않는다.

- 후속 운영 관측: 새 버전의 실제 첫 실행에는 skill hints, 다음 실행에는 skill hints와
  이전 execution refs가 함께 주입됐다. scoped 상세 근거 10건을 읽기 전용으로 확인했다.
  전달 경로가 실운영에서 이어진 근거이며, 에이전트의 경험 수정·행동 개선까지 증명한 것은 아니다.
- 복구 후 모노레포 전체 재검증도 pnpm test 7개 작업 모두 성공했다.

## 2026-09-09 — 세션 인지 procedure 힌트 (카게무샤 같은세션 힌트 재사용, 미설치)

- INTENT v6, 원마마 학습 앵커, I-01/I-06/I-07, TG-03/TG-04/TG-05. 체크포인트 다음 단계 3(카게 재사용).
- 카게무샤 agent-loop.ts buildBrainContext/memory-hint-policy.ts를 코드로 대조했다. 재사용한 것: 현재 메시지
  기반 상위 3건, 같은 세션 ≤600자·재개/무상태 ≤1200자, 같은 힌트의 같은 세션 반복 억제, 기억 100개 상한.
  복사하지 않은 것: 자동화 채널 힌트 배제, 트리거 문구 정규식, 강제 업무 대본.
- 변경: 공통 admission의 매 턴 주입(procedure 카탈로그 20건 JSON, 설치 스킬 8건, 최근 trace 12건)을 제거하고
  turn 1 프롬프트 직전(백엔드 세션 probe 이후, `fresh = !shouldResume`)에 스레드별 `<procedure_hints>`만 붙인다.
  procedure 카탈로그를 세션 정책 fingerprint에서 제외해 procedure 교정이 다음 턴 스레드를 리셋하지 않는다.
  스킬 목록은 시스템 프롬프트 1회(오너는 source 경로 포함), 실행 근거는 도구 결과의 experience_ref와
  experience_read로만 접근한다. 세션 리셋 재시도 경로는 새 thread id로 fresh 힌트를 재계산한다.
  파일: experience-hints.ts(신규), procedure-runtime.ts, gateway-tool-executor.ts, agent-loop.ts,
  experience-evidence.ts(renderExecutionHints 삭제), docs/guides/procedure-corrections.md.
- 근거: 새 단위 4개·런타임/근거/전이 통합 테스트 갱신 통과, standalone 전체 429파일/5,814 통과·7 제외,
  tsc/eslint/prettier 통과, pnpm build 2/2 성공(core는 캐시 = core 변경 없음).
- 판정: 부분 부합. 매 턴 무관한 근거 주입과 학습 직후 스레드 리셋이라는 구조 결함은 제거했으나 설치·실운영
  관측(`[experience] thread= fresh= hints= chars=` 라인, 프롬프트 크기, 오너 요청 지연)은 아직 없다.
- 남은 병행 주입: chat learningPrefix(policy 전건+lesson 3건 매 턴), workorder brief의 learning block,
  NEW 세션 recallMemory prefix — Task 2/3에서 같은 조립기로 통합할 대상. 관련성은 토큰 겹침이며 의미 검색이
  아니다(procedure 수가 작아 카탈로그 전체는 procedure_list로 도달). 힌트 전달을 학습 성공으로 세지 않는다.

## 2026-09-09 — local.4 로컬 설치 (오너 승인, 세션 인지 힌트 실운영 관측 시작)

- 오너가 "로컬 설치해서 내가 확인" 지시. 공개 릴리즈가 아니다.
- 이전 데몬(PID 13044)은 launchd 없이 수동 기동된 상태(로그 /private/tmp)였다. `mama stop`(우아한 종료
  시간 초과→강제 종료; wiki#4746은 효과 대조 전 재생 보류, owner-event batch 866 pending) 후 백업
  (`~/.mama/backups/pre-experience-local4-20260909-103648`, 1.1G, DB 18개, rollback local.3 tgz 포함),
  `npm install -g` local.4(nested core 2.4.1-local.2 유지), 스테이징 1,503파일 SHA-256 전부 일치,
  `launchctl bootstrap`으로 launchd 관리 복귀.
- 결과: PID 87655, health HTTP 200, `mama status` Running 98/100, Telegram 연결, CLI 0.52.0-local.4,
  daemon.log 신규 오류 없음(기존 calendar page cap 경고만). 증거: .superpowers/validation/experience-loop/local-install-local4.json.
- 판정: 설치·연결 확인. `[experience]` 라인·스레드 유지·오너 지연은 오너의 실제 사용에서 관측한다.
  설치됐다는 이유로 I-01/I-06/I-07을 충족으로 바꾸지 않는다.

## 2026-09-09 — 전면 삭제(subtraction) 후보 local.5 설치

- 목표(계획 최상단): 오너 교정이 에이전트 스스로 procedure로 저장·발견·적용되고, 방해하는 고정 텍스트를 제거한다.
- 실측 실패(기준 사례): 10:56 교정 턴 도구 0회 "보고 형식 반영 완료"; 10:57 전체보고 903자 5섹션 대화체 반복,
  412초/19스텝; 시스템 프롬프트 31,964자(브리프 10.6K+복구 저널 9.5K+페르소나 6.9K) 상한 초과 절단.
- 제거: SOUL/IDENTITY/USER 주입, 페르소나 대본(~/.mama/CLAUDE.md 5,022→303자), 라우터 "Be concise/Greet" 고정 문구,
  매 턴 재진술되던 OWNER_CONSOLE_OPERATING_DISCIPLINE 10줄과 "artifacts→live→memory" 조사 순서, 채팅/워크오더/
  오너이벤트의 policy/lesson 블록과 turn-observer(오늘 0건 기록)·learning-* 모듈 4개, console_brief_update append
  (날짜 줄 누적 경로), 브리프 r1의 40개 날짜 줄(r2 501자로 교체, r1은 저장소 이력에 보존).
- 추가(데이터·도구·스킬로 얻을 수 없는 것만): OWNER_RUNTIME_RULES 3줄(힌트 블록 의미, 교정은 procedure_update,
  영속 쓰기 없는 완료 선언 금지), `[evidence] completion claim without a durable write` 관측 로그(차단 없음),
  복구 저널 렌더 4턴·응답 400자 상한.
- 검증: standalone 426파일/5,789 통과, tsc/eslint/prettier, build 2/2, 1,487파일 해시 일치, PID 16253 health 98,
  Telegram 연결. 증거: .superpowers/validation/experience-loop/local-install-local5.json.
- 판정: 부분 부합(구조 제거 완료). 오너 실사용에서 교정 1회→procedure_update trace→다음 보고 변화를 아직 관측하지
  않았다. 워크오더 turn-kind 대본(board/wiki/temporal)은 이번 범위 밖으로 남아 있다.

## 2026-09-09 11:41 — 첫 실사용 전이 확인 (local.5, 오너 판정)

- 11:32:27 오너 교정 "보고는 가독성 좋게 이모지와 텔레그램 서식, 대화체 금지, 간결하게" → 그 턴(40초, 5스텝)에서
  `procedure_update` → `owner-report-telegram-readability@1` 저장(when_to_use: 모든 보고성 응답, body 6줄).
- 다음 run부터 `[experience] hints=1(owner-report-telegram-readability@1)` 주입, 스레드는 CONTINUE 유지(리셋 없음).
- 11:35:34 "전체 보고하자" → 11:40:53 보고(898자): 상태 이모지, 한 줄 한 상태, 담당/의존관계/마감/근거, 문장 종결 없음.
  오너가 텔레그램에서 "행동이 교정된 건 확인"으로 판정. 이전 10:56(도구 0회 "반영 완료")과 대비되는 첫 성공.
- 남은 실패: 같은 보고 턴이 319초·14스텝, task_list 9회·trello_search 5회·kagemusha_messages 5회 재조회.
  재시작 시 부팅 워크오더(board:full:repair, wiki boot)가 오너 레인을 먼저 점유해 첫 메시지가 130초 대기.
  NEW thread에서 `[experience] fresh=false`로 찍힘(durable 런타임 판정식 오류, 후보 미반영).
- 판정: I-01 부분 부합→교정 전이 1건 실증. I-07(지연)·반복 조회는 미충족. 이 1건으로 학습 완료를 선언하지 않는다.

## 2026-09-09 16:26 — local.6 설치(하위에이전트 위임 구조) 및 사건·초기 관측

- 내용: A/B/D/E(코덱스 하위 스레드 등록·도구 라우팅·하위 자기 run/envelope/브리지·완료→오너 자극·무인 역할 투영·TTL·리셋 정리), C/F(부팅 강제 실행 삭제, board/wiki 대본→결과 계약, delegated 상태 attempt 바인딩, 리터럴 no-update scope). Opus 리뷰 3회, 전체 5,843 통과, 1,495파일 해시 일치. 백업 pre-delegation-local6-20260909-162551. 기록 local-install-local6.json.
- 사건: 14:40 "Standalone takeover"로 launchd 인스턴스 정상 종료 후 정체불명 인스턴스 기동, ~14:42 이후 무처리(모델 run 14:39~16:26 없음), 16:25 설치 시 프로세스·서비스 부재. 워커 트랜스크립트에 데몬 기동 명령 없음, 오너 인바운드 없음(피해 없음), node 크래시 5건은 parent=claude 실험 프로세스. 원인 확정: 오너가 직접 정지시킨 것(16:40 오너 확인). 장애 아님.
- 초기 관측: `[experience] fresh=true`(수정 확인). 부팅 시 board#4760(board:full:repair) 여전히 등록(사유 미로그). 그 run이 도구 0회·평문 23자로 끝났는데 `[stage2] full_unverified` 후 `completed` 처리 — 거짓 완료 경로 발견. 무인 owner-event 턴이 gateway `Bash`(workspace find) 실행 — 무인 Bash/Write 차단 불일치 실증. 두 건과 사유 로그를 워커 G에 배정.
- 판정: 구조 설치 완료, 실사용 판정(위임·완료 자극·통합) 미관측. 거짓 완료·무인 Bash는 미충족 항목으로 유지.

### 2026-09-09 local.7 — delegation not taken up (fail)
- Installed 0.52.0-local.7 (backup pre-local7-20260909-164501, hash match, health 21s). Boot enqueued only board#4763 (board:full:repair); no boot-forced runs.
- Observed 3 turns: owner-event 68s, board:full 158s (verdict full_verified), owner-event 33s. Every turn ran inline on the owner thread; the owner lane waited 157s behind board:full.
- The Codex thread has the collaboration tools (spawn_agent etc.) and the owner policy text says to delegate, but the board contract asks for the result directly and the owner-event header says not to "describe what another agent should do". The agent never spawned. Delegation state, subagent wake, no-durable-result and unattended Bash/Write block were therefore not exercised.
- Top goal not met: the owner is still blocked behind scheduled work. Next: make the scheduled contracts state the delegation shape and drop the anti-delegation clause (worker H), reinstall as local.8, observe spawn_agent → [subagent] wake → delegated→done.

### 2026-09-09 local.8 — delegation fires; three blockers found (fail)
- board#4764: owner spawned a native subagent and ended its turn in 38s; host woke the owner on child completion ([subagent] wake), owner verified and recorded contract_no_update. The owner lane was free while the child ran. This is the intended shape.
- Blocker 1: the child had NO gateway tools. Protocol experiments (scratch appserver-dyn-tool-nofork / appserver-resume-dyn): a child spawned with fork_turns "none" loses the parent's dynamicTools; a child spawned with the default fork inherits them, on both fresh and resumed parent threads. The owner policy text recommended fork_turns "none"; text corrected to say it removes host tools.
- Blocker 2: the consumer never observed the spawn. codex-cli 0.153.4 surfaces a spawn on the parent thread only as subAgentActivity items (no collabAgentToolCall); the process consumes those before the native-item callback. board#4764 was failed as no-durable-result instead of entering delegated. Fix: dedicated onSubagentStart callback (worker J), no ledger row.
- Blocker 3: the report leg died after the restart. The interrupted owner-report occurrence left a native_run|unknown row, and hasUnsafeReplayEffects blocks every replay of that occurrence (startup recovery and every trigger-loop tick). Twelve older native_run|unknown rows exist from earlier restarts; six owner-event batches are dead for the same reason. Fix: the native_run admission marker alone never blocks replay (worker I).
- Also seen: 45 owner-event batches dead from 2026-08-21..24 with Codex "usage limit" errors (historical, plan quota).

### 2026-09-09 local.9 — delegation verified end to end; owner wait root cause found
- board#4765: `[workorder] subagent observed` → `delegated kind=board attempt=4765` (owner turn 17s, lane released) → child ran with gateway tools (kagemusha_*, board_read, task_list) → `[subagent] wake owner` → `[workorder] delegated→done`. Report leg recovered at boot (`recovered digest report SENT`, the previously poisoned occurrence confirmed).
- Owner chat at 17:17:05 still showed "Waiting for the earlier task to finish": it waited 155s behind an owner-event delta turn (226s total). Of that turn, 2m20s (8 model steps) was spent debugging `var r = tools.code_act(...)` returning `{}`: the Codex exec host call returns a Promise and must be awaited, while the code_act contract said "do not use await" (meant for the inner script). Today's rollouts show 51 un-awaited code_act calls across 10 turns, each a 1-2.5 min stall. This is the "unnecessary repetition" the owner reported. Fix: contract text now states the exec-side await rule (local.10).
- Remaining: owner-event delta turns still run inline on the owner thread, and chat has priority but no preemption. `model_reasoning_effort = "xhigh"` in ~/.mama/.codex/config.toml is the other latency lever (not changed).

### 2026-09-09 local.10 — await stall gone (pass for this defect)
- Installed 17:22 (backup pre-local10-20260909-172130). First two turns after boot: every code_act call awaited on the first attempt (1/1 and 14/14), turn durations 43s and 48s versus 226s for the same kind of delta turn on local.9. No replay-guard errors at boot.
- Still open: delta turns run inline on the owner thread (no chat preemption), reasoning effort xhigh, wiki/temporal delegation and delegated-timeout unobserved.

### 2026-09-09 local.11 — consumer wedge fixed; report-turn cost measured
- local.10 exposed a wedge: the ledger-managed `delegated_at` key was re-validated with the enqueue validator on stored rows, so the delegated-and-done board#4765 sat in unresolvedBoardCandidateEffects and the serial consumer drained nothing (tick returned early, boot recovery broke out). Fix: publisherPayloadOfStoredWorkOrder strips ledger keys at the three stored-row sites and two requeue sites; enqueue still rejects them. Installed 17:31 (backup pre-local11-20260909-173110); boot recovered #4765 as stale-claim and enqueued #4766.
- Owner-requested full report (chat, 17:24:01) took 268s: tools 1.3s total (36 calls), 19 model steps, 7 of them discovery (tool_search/tool_describe/skill Read), context_compile twice, final answer generation 113s for 7.3K output tokens. Prompt cache held (≈23K cached, ≈400 new tokens per step). Cost is step count and long-form generation, not host overhead.
- Owner set model_reasoning_effort to low (config backup config.toml.pre-low-*); daemon restarted; confirmation of the new effort awaits the next turn's turn_context.
- Native subagents are on the same thread for every turn kind; only the scheduled contracts tell the agent to delegate. A chat-requested full report can be delegated the same way if the owner wants the chat turn to return immediately.

### 2026-09-09 local.12 — board delta anchor verified (pass); heartbeat-report skill retired
- Boot logged `board delta enqueued: delta (anchor 2026-09-09T08:57:45Z, basis Cm6ZAUdF…)` instead of a full rebuild. board#4768 was delegated (owner turn 19s); the child ran 37s and read only board_read, changes_read, task_list (no kagemusha_* reads), recorded contract_no_update for the delta scope; host woke the owner; `delta_verified` and `delegated→done`. The owner's post-wake turn also read board_read/changes_read/task_list only.
- The 18:00 scheduled full report went out in a 66s turn (`recovered full report SENT`).
- Builtin skill heartbeat-report removed from templates/skills and from the live ~/.mama/skills (backup pre-local12-20260909-180131/skills). No retire mechanism exists in syncBuiltinSkills; the live file was removed by hand once.
- Full standalone suite 428 files / 5,874 tests passed on the combined tree (workers H, I, J, K, L, M + the two inline text edits).
- Left as full on purpose: no-baseline, unpublished, signal-unavailable, owner force; and boardPublishedAt is a min over four slots including the host pipeline, so a judgment-only republish can still read as unpublished (noted, not changed).

### 2026-09-09 local.13 — fixed blocks once, turns carry deltas (pass)
- Installed 18:56 (backup pre-local13-20260909-185555; suite 429 files / 5,888 passed). Restart reminder gone: first turn after restart `reminder=omitted`, re-anchored through thread/resume baseInstructions (owner-event and scheduled lanes previously never supplied resumeInstructions; only chat did).
- `[prompt]` lines on the live thread: scheduled:board 4,136 chars brief=sent (first on thread) → later scheduled 1,007 brief=omitted; owner-event 13,573 brief=sent → 14,310 / 3,976 brief=omitted (the large ones are the connector delta itself, not host text). Board#4770 ran as delta, delegated, child published (briefing, action_required, pipeline changed) → delta_verified → delegated→done.
- Owner thread context ≈104K tokens (same thread since 17:22); growth per turn now bounded by the delta content and tool outputs the owner reads directly.
- Remaining: chat-requested full report still runs on the owner thread; thread rotation threshold not defined; boardPublishedAt min-over-slots wrinkle; wiki/temporal delegation unobserved.

### 2026-09-09 local.14 — board card vocabulary moved into the report_publish tool contract
- Finding: slots were HTML but generic (`<section><h3><ul>`), so the viewer (which styles only the report-summary/report-card class vocabulary) showed plain text. The vocabulary lived in board-slot-instructions.ts and was consumed only by the retired dashboard persona; the owner agent never saw it.
- Fix: `buildReportPublishToolContract()` is the single source for the report_publish description (registry + gateway-tools.md parity test), reached progressively via tool_describe at publish time. No per-turn text added. Legacy dashboard-agent persona path is dead under the owner runtime (left for later removal).
- Installed 19:27 (backup pre-local14-20260909-192659 incl. report-slots.json). Suite 429 files / 5,889 passed. Verification pending: next report_publish must contain report-card/report-summary classes.

### 2026-09-09 local.15 — vocabulary warning closes the loop (pass); card shape left to owner correction
- 19:59 chat turn published three generic slots → three `[board] slot … without the board vocabulary` warnings in the log and in the tool result → the same turn read the board again and republished at 20:00:43 using the vocabulary (`report-table`, `badge badge-*`); no further warnings. The agent chose tables with status badges rather than report-summary/report-card blocks, which the contract describes as the slot shape. Whether the owner wants cards specifically is a correction for the owner to give (procedure), not a host rule.
- Test note: one envelope fixture updated to carry a vocabulary class; `agent-situation-api` singleflight failed once under full parallel load and passed twice in isolation (flake, file untouched today).
- Open: boardPublishedAt min-over-slots made the boot gate read "unpublished" after a judgment-only republish (harmless skip this time).

### 2026-09-09 local.16 — the contract finally reaches the agent; registry split found
- Root cause of "contract ignored": code-act tool_search/tool_describe read the HostBridge TOOL_REGISTRY (host-bridge.ts), not the gateway registry where local.14 put the vocabulary. The 19:28 child's tool_describe output had no vocabulary. 61 of 62 shared tools have divergent descriptions between the two registries (frozen in tests/agent/tool-registry-parity.test.ts with a todo); report_publish is now single-sourced in both.
- tool_search matched the whole query as one substring: today 59 multi-word queries, 27 empty (46%). Now token-AND with exact-name-first ranking.
- Vocabulary warning now requires a structural class (report-summary / report-card / report-section-title / report-table); badges alone no longer pass (the 20:06 invented `card-grid`/`card` shape is a fixture). The warning result carries the full contract once.
- Owner correction "대시보드는 항상 카드형식으로" (20:05) was stored as procedure owner-full-report-board-html (cards + status badges, no tables/plain text); content is sound.
- Installed 20:23 (backup pre-local16-20260909-202233). Suite 431 files / 5,903 passed, 1 todo. Verification pending: next report_publish must carry report-card/report-summary.

### 2026-09-09 v0.52.0 released (pass)
- PR #278 (part 1, 40 files) and #277 (part 2, 100 files) squash-merged with the admin account after local CodeRabbit CLI review (14 findings: 13 fixed, 1 deliberately skipped as an insurance guard; follow-up finding on the owner-event brief fixed; final pass "No findings") and remote CodeRabbit on #278 (7/7 addressed). Remote CodeRabbit did not review #277 (rate limit); noted for billing.
- Release workflow run 34357112416: tags, npm `@jungjaehoon/mama-os@0.52.0` (depends on `^2.4.1`) and `@jungjaehoon/mama-core@2.4.1`, GitHub release v0.52.0, Pages deployed.
- Live daemon replaced local.16 with npm 0.52.0 at 22:32 (backup pre-npm-0.52.0-20260909-223155); health up in 9s, Telegram connected, boot board decision logged with its reason.
- Not yet verified on the npm build: a full owner-flow day (scheduled reports at 08/13/18, board delta runs, a chat correction). The local.7-16 evidence covers the same code.

### 2026-09-10 Claude Sonnet 5 backend trial (local.17-19)
- Switched `agent.backend` to claude / `claude-sonnet-5` / effort low at 09:36 (config backup pre-claude-sonnet5). Found and fixed on the live daemon: (1) scheduled contracts and owner rules asked for a native subagent the Claude runner cannot expose to the host — `IModelRunner.supportsNativeSubagents` (codex true, claude/cline false) now gates that text and the delegated state; (2) the owner saw the model's English tool-call narration in the live-edited Telegram message for 83s — the presenter drops text that precedes a tool call; (3) `--effort` never reached Sonnet 5: the model check matched only claude-*-4-6 and the adapter did not forward effort to its pool. Verified on the live process (`--effort low` present, no delegation text in contracts or system prompt).
- Fact correction: on the Claude backend the persona runs with `--tools Agent` (agent-loop-init), not `--tools ""`. Children it may spawn are unobservable to the host, so delegation stays unpromised there.
- Measured: turns after the fixes 18-26s (chat/event) versus 41-83s in the first minutes; the 83s chat turn had 16 tool calls with 3 failures (guessed report_publish shape twice). Equivalence to Codex: tool loop, permissions, memory, procedures identical; no observable subagents, no in-turn token budget stop.

### 2026-09-10 incident — test run rewrote the live MCP config (Claude backend lost all tools)
- 10:09 a full `pnpm vitest run` in the worktree reached api-routes-init's code-act MCP merge with the real HOME and wrote `~/.mama/mama-mcp-config.json` pointing at a worktree `src/.../code-act-server.js` that does not exist. The next Claude process (10:3x) had no `mcp__code-act__code_act`; the persona fell back to the native Agent tool, whose child had no gateway tools either; board#… failed "retries exhausted" and a high-severity notice reached the owner at 10:37.
- Recovery 10:39: daemon restart regenerated the config from the installed package. Fix in progress: vitest global setup that isolates HOME for every test (project rule: tests must isolate $HOME).
- Codex was never affected because its gateway tools are host-bridged, not MCP. This is a Claude-backend-specific single point of failure worth a loud boot check (MCP server path exists).
