# TODOS

## Deferred until cognitive foundation repair is proven

### Fail the full-report request, not the tick, when the packet runtime is missing

**What:** In `operator-trigger-loop.ts`, `preparePendingRequest` throws when `reportAsk.full`,
`compileFullReportContext`, or `fullReportReadScope` is absent, and the persisted pending request
makes every later tick rethrow before the delta drain. Log the missing dependency, cancel the
persisted request with a receipt, and return `false` so drain, commit, author, review, and the
digest leg keep running.

**Why:** Reachable only when an assembly wires a report sink without the packet runtime, which
production wiring and the lane-wiring/E2E tests pin against. Changing tick failure semantics was
out of scope for the foundation repair PR; review finding on #247.

**Effort:** S
**Priority:** P2
**Depends on:** Cognitive foundation repair released

### Resume the real Phase 2b human-member canary

**What:** Resume the paused real two-human canary and prove registration, explicit grants,
member-private isolation, revoke, session-policy replacement, and delivery receipts.

**Why:** The member code is packaged, but adding more team behavior has little value while owner
reports and task judgment remain unreliable.

**Context:** This is an operating proof, not a request for synthetic traffic or more member
features. Reuse the existing schema-65 grant implementation and the active read-only canary rules.
Do not count pre-cutover rows or manufacture principals, grants, messages, or reports.

**Effort:** S
**Priority:** P1
**Depends on:** Cognitive foundation repair released and one real owner report passes its quality,
cost, and delivery gates

### Resume the Case and artifact roadmap

**What:** Return to the Case-scoped work unit and one concrete Drive artifact revision/approval/
delivery flow after the current foundation is trustworthy.

**Why:** Case and artifact lineage are the intended product direction, but implementing them on top
of stale reports would preserve the same poor judgment under more schema and UI.

**Context:** Start with one real owner Case and one artifact domain. Do not generalize an
`ArtifactAdapter` until a materially different second domain proves the shared fields.

**Effort:** L
**Priority:** P2
**Depends on:** Cognitive foundation repair real-report gate; stale task cleanup verified

### Benchmark provider-native continuity against MAMA continuity

**What:** Replay the same longitudinal work under fresh search, MAMA-owned context, and
provider-native stored state.

**Why:** MAMA should retain only local authority, correction, lineage, and receipt work that
produces measurable value beyond provider session memory.

**Context:** Compare repeated facts, evidence visibility, authorization, latency, tokens, cost, and
recovery. Run after the Case/artifact path exists or after a material provider capability change,
not on a calendar.

**Effort:** S
**Priority:** P2
**Depends on:** One real longitudinal Case and a stable cognitive foundation

### Generalize lifecycle authority beyond proven sources

**What:** Introduce a connector lifecycle-authority registry only when a third real source needs
the same task-binding and revision-receipt contract.

**Why:** Generalizing before Trello and Kagemusha behavior is proven would expand a safety-critical
interface without evidence that the abstraction is shared.

**Effort:** L
**Priority:** P3
**Depends on:** Stable Trello/Kagemusha lifecycle evidence and a concrete third connector

### Evaluate webhook-based Trello lifecycle ingestion

**What:** Design a signed, local-first webhook option only if polling misses the measured
submission-to-projection SLO.

**Why:** Webhooks can reduce latency but add a public callback, authentication, replay, tunnel, and
secret boundary to a local-first product.

**Effort:** L
**Priority:** P3
**Depends on:** Measured polling latency failure and separate callback/security approval

## Deferred from security-utility round (2026-07-17)

### Surface memory provenance at recall time

- **What:** Recall/search results should display source provenance (e.g. `connector-raw-evidence` + channel scope) so agents and owners can weight externally-derived memories differently from owner decisions.
- **Why:** Save-side provenance already exists (mama-core provenance.ts, connector ingest stamps source_type; gateway saves carry trusted-write evidence), but nothing surfaces it on recall - an injected "fact" from an external channel reads identically to an owner decision.
- **Context:** Cross-package change (mama-core recall payload + standalone recall-bundle-formatter). Untrusted-content wrapping at prompt seams (SEC-4) covers the input side this round.

### Untrusted wrapping for gateway gather-tool RESULTS

- **What:** Wrap connector-content tool results (kagemusha_messages, channel_history/recent/search) in untrusted-content markers when they are fed back into the agent conversation.
- **Why:** SEC-4 wrapped code-built prompts (situation report window, history-extractor passes); tool RESULTS during self-gather are the remaining unwrapped external-text seam.
- **Context:** Needs care with token budgets and code-act JSON result shapes; single formatting point per route in agent-loop/code-act bridge.

## Deferred from agent-boundary-repair round (2026-07-16)

### Persona migration to the code-act MCP route

- **What:** Move the main persona off text-parsed gateway tools onto the existing code-act MCP route (code-act-server → HostBridge → shared executor).
- **Why:** Tool contract enforced at the protocol layer kills the tool-hallucination class structurally (Task 2's `--tools ""` mitigates it at the surface level).
- **Context:** Exposure already exists — multi-agent pm processes use it today. Adoption for the conductor is its own round (prompt/persona rework).
- **Depends on:** agent-boundary-repair branch merged.

### Multi-agent pool getSharedProcess lane accumulation audit

- **What:** Measure dashboard-cron/reconcile shared-process session growth over a week; apply the Task-6 stateless pattern if durations grow.
- **Why:** Same unbounded-session disease the report lane had (146s→521s) may exist in the multi-agent pool lanes.
- **Context:** `[Lane]`/duration logs in daemon.log are sufficient instrumentation; owner principle "session = cache, not persistence".

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

### 문서 부채 (2026-07-18 릴리즈 감사에서 이연 - 3렌즈 감사 결과)

- **2026-07-21 재감사:** 추적 중인 Markdown 122개를 검사해 존재하지 않는 로컬 링크 참조
  67개를 확인했다. 이 중 35개는 `packages/claude-code-plugin/README.md`의 저장소 루트 기준
  상대경로이고, 나머지는 오래된 개발 문서의 삭제·이동된 설계 문서와 누락된 참조 문서다.
  v0.24 사용자 경로(README, 문서 인덱스, Codex 가이드, 배포 버전 표)에는 새 깨진 링크가 없다.
- **v0.24 처리:** Codex app-server/Code-Act/Trello 도구 경로, `gpt-5.4` 예시, 네 패키지가
  아니라 네 릴리스 대상이라는 표현, MAMA OS `0.24.0` 버전 표와 상태 문구를 동기화했다.
- **What:** v0.23 릴리즈 차단분은 수정 완료. 이연분: developer-playbook.md(2025-11 스냅숏 - mama-plugin 경로/384차원/구 툴명/데드 링크), deployment-architecture.md("4 packages", 워크플로 이름 불일치), docs/guides/deployment.md(e5-small 기본값), testing.md("134 tests"), code-standards.md(구 트리), hooks.md(384차원 예시 + SessionStart/PreCompact 미문서), code-act-sandbox.md + security.md Code-Act 섹션의 샌드박스 툴 표(host-bridge TOOL_REGISTRY와 불일치), reference/api.md에 operator task 라우트 3종 추가, configuration-options.md에 MAMA_TRIGGER_LOOP\* 패밀리/MAMA_BOARD_RECONCILE 행, AGENTS.md 전면 재생성(GitHub Packages/wave-swarm 중심 등 5+ 거짓), entity-substrate-runbook.md 포트 라벨.
- **At-cutover (Stage 2 on 전환 시 함께):** README/standalone README/mama-os.md/package-structure.md의 "상주 타이머 인격 런" 기술을 워크오더 파이프라인 기술로 전환.
- **Why:** 오늘 기준 거짓인 사용자 대면 사실층은 v0.23 준비 PR에서 수정했고, 나머지는 저빈도 개발 문서라 릴리즈 비차단 판정.

## Board-lane context_compile scope rejection: NOT closed by One MAMA Phase 1 (2026-09-04)

Phase 1 unified every scheduled turn under the `owner_console` principal. Review of that change
verified that `computeScopeAuditFields` (gateway-tool-executor.ts) keys on MEMORY SCOPES, never
on `roleName` or the envelope `agent_id`, and that a `context_compile` call with no `scopes`
argument is exempt. So the daily `[envelope] scope mismatch` on the board lane is a memory-scope
disagreement between the compile's requested scopes and the envelope's `channel:operator:worker:board`
scope, not a principal split. Confirmed from the compile service: an explicit `scopes` entry
outside the envelope's read allowance throws `worker_envelope_scope_denied` (403) and the
enclosing `code_act` fails. Fixed at both layers in 0.41.0: the board reconcile envelope carries
the judged channel's memory scope (`reconcileChannelKey`), and the board turn section says to
omit `scopes`. Remaining acceptance: one installed board reconcile run without the warn.
