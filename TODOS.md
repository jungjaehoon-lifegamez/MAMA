# TODOS

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

### Codex per-call model/resumeSession + codex report-thread reset

- **What:** Decide deliberately whether codex should honor per-call `model`/`resumeSession` (Task 3 forwards ONLY systemPrompt on purpose — activating the others changes thread lifecycle, codex-mcp-process.ts thread wipe on `resumeSession === false`). Also implement a codex report-thread reset so Task 6's stateless guarantee holds there (freshSession is pool-level only on codex; the internal threadId persists — a loud log marks this today).
- **Why:** Without it, a codex-backend deployment keeps the immortal report thread Task 6 killed on claude.
- **Context:** Default deployments run claude; gap is latent, logged loudly.

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
