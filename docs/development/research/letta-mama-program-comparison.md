# Letta와 MAMA의 프로그램 구조 재조사

2026-10-06 · MAMA `main` 81695ecbc / mama-core 6.0.0 · 구현 변경 없는 조사.

오너의 전제는 모델이 발전하며 에이전트의 문제와 프로그램의 문제를 구분한다는 것이다. 더 강한 모델이 정확히 판단하고 도구를 사용해도 남는 데이터·권한·조회·실행·복구의 제약을 비교한다. 답변 누락, 규칙 미조회, 잘못된 업무 해석은 프로그램 원인을 확인하지 않은 상태에서 결함으로 합산하지 않는다.

Letta는 현재 [letta-code](https://github.com/letta-ai/letta-code)가 활성 구현이다. 과거 V1 API 서버의 archival-memory 예제를 현재 MemFS/App Server의 보장으로 사용하지 않았다. 공식 문서의 제공 계약과 MAMA 코드·시험 결과를 비교했으며 Letta의 운영 장애나 누출을 재현한 조사는 아니다.

## 팀 멤버 전 프로그램 과제 (2026-10-06 재조사)

기준: 더 좋은 모델이 와도 남는 것만 넣는다. 모델이 지금 도구·데이터·쓰기 경로로 할 수 있는 일(규칙 목차를 열기, 인자를 맞추기, 메시지를 맞는 업무에 붙이기)은 관찰로만 둔다. Letta 근거 등급: DOC 공식 문서, SRC 소스 확인, NF 확인 못 함. Letta는 현재 구현인 Letta Code(harness·SDK·App Server)와 폐기 중인 V1 API를 구분했다.

| 과제                                         | MAMA 실측                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Letta                                                                                                                                                                                                                                           | 팀 전 필요                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 오너 대화가 MAMA 데이터에 원본으로 남지 않음 | mailbox가 처리된 오너 메시지를 7일 뒤 지운다(`mama-core/src/runtime/mailbox.ts:316`, `session-start-context.ts:35`). Telegram 대화는 소스로 저장되지 않는다(connector 이벤트 40,224건 중 telegram 0). 활성 오너 규칙 26개 중 6개는 출처 메시지가 이미 지워졌다(처리 시각 기준 정리). 오너의 문장은 Claude CLI 대화 기록(`~/.claude/projects/`)에만 남는데, MAMA가 소유하지 않고 어떤 action도 읽지 못한다. 7일 보관은 09-29 `owner.messages` 설계 때 알려진 제약으로 적혔을 뿐, 버리기로 한 오너 결정은 없다 | 압축 뒤에도 전체 메시지를 보관하고 대화 검색 제공(DOC, [conversations](https://docs.letta.com/concepts/conversations)). 보관 기간은 NF                                                                                                          | 필요. 오너가 권한의 출처인데 그 원문이 사라진다. 멤버 대화도 같은 길을 탄다                                                                                                                                                                |
| 기억이 쓴 사람의 scope 전부에 묶임           | scope를 지정하지 않은 쓰기는 `command.scopes ?? access.scopes`(`knowledge/judgments.ts:172`, `:593`). 오너 scope는 커넥터 이름별이라, 기록 4,801건(업무 수정 4,624건, 오너 규칙·교훈 포함)이 32개 scope 전부에 묶여 있다                                                                                                                                                                                                                                                                                     | 기억은 agent 소유이고, 공유는 조직 저장소를 명시적으로 붙인다(DOC, [shared memory](https://docs.letta.com/concepts/shared-memory))                                                                                                              | 기억 소유·격리 한 과제(아래 행과 함께). 지금은 드러나지 않지만, 멤버에게 이 scope 하나를 주면 오너의 업무·규칙 전부가 열린다. 묶임 계약은 개인/공유 모델과 함께 팀 흐름 분석에서 정하고, 첫 멤버에게 기억 권한을 주기 전에 구현·재결속한다 |
| scope 검색: 후보를 고른 뒤 거름              | 위 재현. 오너는 모든 scope를 읽어 드러나지 않음                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 폐기된 V1 서버의 SQL 경로도 LIMIT 뒤 tag 필터(권한이 아닌 검색 조건)를 걸어 k개보다 적게 반환했고, 벡터 DB 경로는 필터를 질의 안에 넣었다(SRC, archive `agent_manager.py`, `tpuf_client.py`). 현재 API의 순서는 NF                              | 기억 소유·격리 한 과제(위 행과 함께). 좁은 scope의 멤버에게 드러난다                                                                                                                                                                       |
| 상시 규칙(W37, 승인)                         | 정책 파일에 쓸 경로가 없다. 바꾸면 다음 턴이 새 세션                                                                                                                                                                                                                                                                                                                                                                                                                                                         | MemFS 루트 파일을 매 턴 프롬프트에 넣고, agent가 파일 도구로 고치며 commit이 이력(DOC). 로컬 백엔드는 세션을 바꾸지 않고 `<memory_update>` 블록을 대화에 넣는다(SRC). 파일 20,000자·루트 65,536자 상한(SRC). 공유 파일 갱신은 SHA 전제조건(DOC) | 필요(W37). 세션 재시작은 기존 동작대로 두고 하루 세션 수를 관측                                                                                                                                                                            |

팀 설계의 입력으로 두는 것(팀 전 수정 아님):

- 동시 실행: MAMA는 모든 턴을 한 오너 세션에서 차례로 돈다. 09-29 이후 오너 메시지의 대기는 평균 2초, 60초 넘은 것은 127건 중 1건이다. Letta는 {agent, conversation}마다 한 턴, agent끼리는 병렬이다(DOC, [sessions](https://docs.letta.com/agent-sdk/sessions)).
- 승인과 귀속: Letta도 승인자를 기록하는 계약은 NF다. 사용자 메시지에만 실제 사람을 붙인다(SRC, `acting-user.ts`). MAMA의 `record_actors`는 0행이다.
- 실행 격리: Letta는 테넌트마다 App Server를 따로 두고 권한은 앱이 집행하라고 한다(DOC, [integration patterns](https://docs.letta.com/self-hosting/app-server/integration-patterns)).
- 오너 신원: MAMA `principals` 0행. Letta Code에도 identity 개념은 없다(NF). 등록은 팀 작업의 첫 단계다.

약점이 아닌 것: 업무 수정은 revision CAS로 남는다(Letta 블록은 last-write-wins, DOC). 입력은 mailbox와 영수증으로 재시작을 넘어 남는다. Letta App Server는 클라이언트 연결이 끊기면 그 연결의 대기 입력을 버린다(DOC). 서로 다른 사건이라 우열 비교는 아니다.

## 결과와 근거

| 항목                         | MAMA의 프로그램 근거                                                                                                                              | Letta의 현재 제공 계약                                                                                                           | 판정                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 사람·에이전트·세션·실행 공간 | daemon의 `owner`/`owner-agent`, 단일 owner workspace, `owner:runtime`; native turn과 host tool이 ownerAccess를 넣음                               | Agent의 지속 상태와 conversation, 실행 computer를 구분. App Server가 여러 runtime을 병렬 관리                                    | MAMA 제품의 멤버 실행 연결이 미구현. core가 여러 세션·principal을 지원하지 못한다는 뜻은 아님          |
| 권한 집행                    | core dispatcher가 action/connector 권한을 검사하고 principal repository에 grant/revoke가 있음. 현재 Telegram ingress는 non-owner를 거부           | 조직 역할·Agent/대화 공개 범위, 컴퓨터별 도구 승인, 다른 Agent 기억 디렉터리 guard                                               | 현재 운영의 멤버 누출을 재현한 것이 아니라, 첫 멤버를 위해 실신원·현재 grants를 실행까지 연결할 과제   |
| 범위별 벡터 검색             | 전체 후보 상위 20개를 고른 뒤 scope 필터. 다른 scope의 높은 점수 기록이 후보를 차지할 수 있음                                                     | Agent별 MemFS와 별도 조직 저장소. 해당 검색 내부의 후보/권한 필터 순서는 이번 조사로 확인하지 않음                               | MAMA의 허용 범위 검색 누락을 격리 DB에서 재현. Letta 검색 정확도 우위는 판정하지 않음                  |
| 검색 모델 교체               | createKnowledge와 공개 recallMemory는 embedder를 받음. catalog memory.search → suggestInAdapter는 이를 전달할 포트가 없고 core 기본 임베더를 사용 | MemFS 기본 파일 검색, 선택적 검색 mod와 QMD 구성                                                                                 | MAMA 검색 API 사이의 주입 계약이 불완전. 임베딩 모델의 의미 이해 실패와 구분                           |
| 기억 증가                    | NodeSQLiteAdapter가 embeddings 전부를 Map에 적재하고 벡터 검색에서 순회                                                                           | MemFS 상세 파일은 필요할 때 읽고 검색 확장은 별도                                                                                | MAMA의 메모리·검색 비용 증가 위험. 규모별 실제 지연은 측정하지 않음                                    |
| 추론 모델 확장               | 기본 BackendType과 native receipt는 Claude/Codex 계약. 각 backend의 model 값은 교체 가능하고 createAgent factory도 있음                           | 여러 제공자·모델 선택과 모델군별 toolset 변경                                                                                    | MAMA가 모델 발전을 활용할 수 없다는 주장은 틀림. 기본 제공자 확대에는 adapter/receipt 계약 확장이 필요 |
| 이력·동시 수정               | 수정 이력을 append하고 transaction으로 revision을 정함. expectedRevision을 주면 stale write 거부; 생략한 두 동시 쓰기도 2/3번 revision으로 보존   | Git history/worktree와 commit/push/pull 공유                                                                                     | MAMA의 장치가 이미 존재. 팀 동시 수정 정책은 정해야 하지만 프로그램 결함으로 확정하지 않음             |
| 재시작·실행·전달 복구        | native ACK와 결과·전달을 구분; durable receipt/result, uncertain 상태에서 자동 재실행 금지                                                        | SDK reconnect/resume/reconciliation/approval recovery. App Server 문서는 durable product results와 retry 정책을 앱 책임으로 구분 | MAMA의 기존 기반을 약점으로 분류할 근거 없음. 두 제품의 복구 성능 우열은 미측정                        |

MAMA 코드 근거:

- 신원·조립: `packages/standalone/src/cli/commands/daemon.ts:65`, `:249`, `:464`; `runtime/stimulus-delivery.ts:659`; `runtime/native-session.ts:438`; `runtime/action-surface.ts:358`.
- 경계: `packages/standalone/src/gateways/telegram.ts:356`; `packages/mama-core/src/api/dispatch.ts:105`; `src/identity/principal-repository.ts:41`.
- 검색: `packages/mama-core/src/memory/api.ts:1118`, `:1152`, `:1165`, `:2630`; `src/api/catalog.ts:764`, `:1213`; `src/embedding/embedder.ts:148`, `:251`.
- 규모: `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts:444`, `:460`, `:632`.
- 모델·복구: `packages/mama-core/src/runtime/drivers/types.ts:43`; `src/runtime/native-input-journal.ts`; `src/runtime/runtime-process.ts`; `packages/standalone/src/runtime/native-session.ts:326`.
- 수정: `packages/standalone/src/api/work-actions.ts:1380`, `:1520`; `tests/api/work-actions.test.ts:429`, `:478`; `packages/mama-core/src/knowledge/commitments.ts:589`.

Letta 공식 근거: [Agent 상태](https://docs.letta.com/concepts/stateful-agents), [SDK](https://www.letta.com/agent-sdk/), [App Server](https://docs.letta.com/self-hosting/app-server), [Protocol lifecycle](https://docs.letta.com/self-hosting/app-server/protocol-lifecycle), [조직 권한](https://docs.letta.com/teams/permissions), [도구 권한](https://docs.letta.com/configuration/permissions), [MemFS](https://docs.letta.com/concepts/memfs), [공유 저장소](https://docs.letta.com/concepts/shared-memory), [모델 교체](https://docs.letta.com/configuration/models).

## 재현한 프로그램 결함: scope를 적용하기 전 후보 제한

모델을 호출하지 않고, 공개 core API와 시험 DB에서 결정적인 1024차원 벡터를 사용했다. 자연어 임베딩 품질을 평가하는 시험이 아니다. 질의는 기록의 텍스트와 단어가 겹치지 않게 해 벡터 경로를 분리했다.

1. 허용 scope에 질의와 유사도 0.98인 기억 한 개를 저장한다. 이 scope를 지정한 recall은 그 기억을 반환한다.
2. 다른 scope에 유사도 1.0인 기억 25개를 저장한다.
3. 같은 질의·같은 허용 scope로 다시 읽으면 결과가 0개다. 허용 기억은 DB에 그대로 남는다.
4. 결과 limit을 10에서 100으로 늘려도 0개다. 내부 벡터 후보 수는 일반 질의에서 20으로 고정된다.
5. 허용 기록의 topicPrefix를 추가해 vector 후보 선택 전에 범위를 좁히면 다시 찾힌다.

두 번 새 DB에서 같은 결과를 확인했다. 첫 실행과 재실행 모두 `beforeCount=1`, `afterCount=0`, `largerLimitCount=0`, `topicFilteredContainsAllowed=true`다. 현재 소스의 같은 처리 순서를 확인한 compiled public core 6.0.0 API로 실행했다.

원인은 `recallMemory`가 global vector top-K를 먼저 받고 scope 바인딩을 뒤에서 필터하는 순서다. scope를 요청한 검색의 후보가 무관한 scope의 데이터 양·점수에 영향을 받는다. 반환에서 외부 scope는 제거되므로 누출 재현이 아니라 허용 자료의 검색 누락이다. 기존 C2 답변 누락이나 네 자연어 질의 실패의 원인이라고 소급해 단정하지 않는다.

수정 후보는 admitted scope를 후보 선택 전에 적용하고, scoped 검색의 limit 계약을 확인하는 것이다. 모델에게 질의를 잘 바꾸라고 요구하거나 무관한 자료를 더 읽게 하는 것이 이 계약을 고치지는 않는다. 이번 요청은 조사이며 코드는 수정하지 않았다.

현재 채팅의 로컬 artifact로 `mama-program-scope-probe.mjs`와 `mama-program-research-evidence.json`을 저장했다. probe의 인수는 새 시험 DB 디렉터리와 mama-core 패키지 디렉터리이며 HOME도 임시 디렉터리로 지정해 실행한다. 운영·개발 메모리 DB를 쓰지 않는다.

## 기존 프로그램 계약 재확인

임시 HOME에서 기존 테스트 네 파일만 실행했다.

- core: `native-input-delivery`, `native-session-ownership`, `principal-scope-grants-repository` — 41개 통과.
- standalone: `api/work-actions` — 18개 통과. expectedRevision의 stale 거부와 transaction 안의 동시 revision 배정도 포함한다.
- 합계 59개 통과. 새 테스트를 저장소에 추가하거나 전체 테스트를 반복 실행하지 않았다.

이 결과는 프로그램 계약을 확인하는 supporting evidence다. 실제 오너 답변의 품질이나 새로운 팀 운영의 완료를 입증하지 않는다. native 압축 관측 부재도 다시 조회할 수 있는 규칙이 존재하는 한 교정 유실로 단정하지 않는다.

## 다음 재개를 위한 정리

이 보고서는 부분적인 프로그램 조사 메모이며, 그대로 실행할 팀 멤버 플랜의 근거로는 불충분하다. 오너는 전체 분석이 단편적이어서 팀 플랜을 진행하기 어렵다고 지적했다. 분석자는 전체 목적과 실행 흐름을 놓쳤고, 서로 다른 증거 수준으로 비교했으며, 국소 재현을 전체 평가·수정 우선순위로 확대하고 원인·API 계약·해결책을 혼합했다. 문서나 테스트 수는 통합 분석의 완료가 아니다.

다음 재개는 등록 → 신원 → 개인/공유 에이전트·세션·기억 → 현재 권한 → 도구/native 실행 → 공통 업무 원장 반영 → 전달 → 회수·재시작의 전체 흐름부터 분석한다. 단계마다 기존 코드로 가능한 것, 실제로 연결되지 않은 것, 관찰된 결함, 원인 미확인, 오너 정책 결정이 필요한 것을 같은 기준으로 표시한다.

scope 검색 사례는 국소 검색 구현의 근거로 유지한다. 20개 반환·후보 예산 자체가 결함이라는 결론이나 새로운 제한을 넣자는 제안은 철회한다. 기존 조회 권한과 검색 조건에서 반환 가능한 유효 결과를 조기에 놓치지 않는 것이 계약이다. 범위를 먼저 적용하는 방법과 후보 탐색을 이어가는 방법은 아직 채택·구현하지 않았고, 실제 제품 호출 경로와 영향도부터 확인해야 한다. 모델에게 탐색 횟수·절차를 고정하거나 이 사례를 자동으로 팀 플랜의 최우선 과제로 만들지 않는다.

기존 principal/grant·session·driver 기반의 연결은 전체 흐름에서 검토한다. 검색 embedder 주입과 vector cache 규모 위험도 같은 분석에 배치하되, 추론 모델 발전이나 에이전트의 도구 선택 실수와 합산하지 않는다. 첫 멤버 구현 spec과 실행 계획은 이 통합 분석·미결정 정책 정리 뒤에 작성한다.

Agent/conversation/computer 및 SDK의 구분은 Letta에서 참고할 프로그램 계약이다. MAMA의 SQLite 업무 원장을 Git 파일로 바꾸거나, 자동 회고·host 의미 규칙·새 fallback을 추가하자는 결론은 아니다. Letta에도 cloud-only 공유 저장소, Admin 전체 대화 접근, 파일 동기화의 시차라는 프로그램 정책·제약이 남는다.

한계: Letta를 설치해 실험하지 않았고, 두 제품의 대규모 latency/cost나 누출·동시성 우열을 측정하지 않았다. 운영 DB·config·daemon은 변경하지 않았다. C2/C5 오너 수용과 모니터링 중지도 유지한다. 다음 구현 spec·계획은 별도로 작성하고 검토해야 한다.
