# Memory Agent Redesign — Multi-Agent Persistent Architecture

> Supermemory 대비 우위: 로컬 퍼스트, 에이전트 격리, persistent session 문맥 유지, graph evolution 추적, 비용 $0

## Problem

현재 메모리 레이어가 raw API call (HaikuClient → Anthropic SDK 직접)로 구현되어 있음. MAMA OS에는 이미 persistent agent loop + 격리된 multi-agent 인프라가 있는데 활용하지 않음.

### 현재 문제점

1. `HaikuClient` — 별도 SDK client, session persistence 없음, 매 호출 stateless
2. `autoExtractFacts()` — raw API call, 기존 agent loop 미사용
3. Context injection — NEW 세션에서만 동작, CONTINUE 세션에서 새 facts 안 보임
4. 파일명/클래스명이 "Haiku"인데 실제 모델은 Sonnet 4.6

## Architecture

### 1. Memory Agent as Multi-Agent Role

```
┌─────────────────────────────────────────────────┐
│ MAMA OS                                          │
│                                                   │
│  ┌──────────────┐    ┌──────────────────────┐    │
│  │ Main Agent    │    │ Memory Agent          │    │
│  │ (developer)   │    │ (memory)              │    │
│  │               │    │                       │    │
│  │ PersistentCLI │    │ PersistentCLI         │    │
│  │ Process       │    │ Process               │    │
│  │ (per channel) │    │ (shared singleton)    │    │
│  └──────┬───────┘    └──────────┬────────────┘    │
│         │                       │                  │
│         │    ┌──────────────┐   │                  │
│         └───►│ Message      │◄──┘                  │
│              │ Router       │                      │
│              └──────┬───────┘                      │
│                     │                              │
│              ┌──────▼───────┐                      │
│              │ SQLite DB     │                      │
│              │ (decisions,   │                      │
│              │  embeddings,  │                      │
│              │  edges, FTS5) │                      │
│              └──────────────┘                      │
└─────────────────────────────────────────────────┘
```

### 2. Memory Agent Lifecycle

- **프로세스**: `AgentProcessManager`가 관리하는 persistent Claude CLI process
- **세션**: singleton — `AgentProcessManager`에 `getSharedProcess(agentId)` 메서드 추가. 고정 channelKey `"__system__:memory"` 사용. 채널 무관하게 하나의 프로세스 공유.
- **모델**: `config.yaml`의 `agents.memory.model` (기본값: `claude-sonnet-4-6`)
- **Persona**: `~/.mama/personas/memory.md`
- **격리**: CLAUDE.md Agent Isolation 규칙 준수 (cwd, plugin-dir, setting-sources)
- **도구 제한**: `--tools ""` — 메모리 에이전트는 JSON 반환만 하며 파일/명령 실행 불필요
- **Busy 처리**: `sendMessage()` 호출 시 process가 busy면 큐에 저장, idle이 되면 순차 처리. fire-and-forget이므로 호출자는 결과를 기다리지 않음.

### 3. Persona 설계 (`~/.mama/personas/memory.md`)

```markdown
You are MAMA's memory agent — an always-on observer that watches conversations
and extracts knowledge worth remembering.

## Your Role

- Observe every conversation turn between users and the main agent
- Extract decisions, preferences, lessons, and constraints
- Return structured JSON for storage — never respond to users directly

## Output Format

Return ONLY a JSON object:
{
"facts": [
{
"topic": "snake_case_topic",
"decision": "clear one-sentence decision",
"reasoning": "brief why",
"is_static": true/false,
"confidence": 0.0-1.0,
"relationship": null | {"type": "supersedes|builds_on|synthesizes", "target_topic": "..."}
}
]
}

## Topic Rules

- MUST reuse existing topic if same subject (provided in context)
- snake_case, specific but not overly granular
- Same topic = evolution chain (supersedes)
- Related topic = extends or derives

## Relationship Types (기존 DB schema와 일치)

- supersedes: replaces a previous decision on same topic
- builds_on: adds information to existing topic without replacing
- synthesizes: merges multiple decisions or infers connections from patterns

## What to Extract

- Architecture decisions, technical choices, tooling preferences
- User preferences and working style (is_static: true)
- Constraints, requirements, lessons learned
- Decision changes (mark relationship: supersedes)

## What to SKIP (return {"facts": []})

- Greetings, casual chat, thanks
- Questions without answers
- Temporary debugging steps
- Code snippets
```

### 4. Trigger Flow

```
message-router.ts process():
  1. User message arrives
  2. ContextInjector searches DB → related memories
  3. Prefix memories to user message (매 턴, NEW/CONTINUE 무관)
  4. Main agent responds
  5. Fire-and-forget:
     a. agentProcessManager.getSharedProcess('memory') → singleton process
     b. process가 busy면 내부 큐에 추가, idle이면 즉시 실행
     c. sendMessage({conversation, existing_topics})
     d. message-router는 결과를 기다리지 않음 (fire-and-forget)
  6. Memory Agent extracts facts (persistent process, 세션 문맥 유지)
  7. JSON 파싱 → mama.save() per fact
  8. Next turn → Step 2에서 새 facts 포함
```

**Cooldown**: 채널별 30초. cooldown 중 도착한 메시지는 drop (defer 안 함).
빠른 대화에서 모든 턴을 추출할 필요 없음 — 중요한 결정은 반복 언급되므로 놓치지 않음.

### 5. Per-Turn Context Injection (CONTINUE 세션 포함)

현재: NEW 세션에서만 system prompt에 injection
변경: **매 턴** user message에 관련 기억을 prefix

```typescript
// message-router.ts — 매 턴 injection
const relevantContext = await contextInjector.getRelevantContext(message.text);
if (relevantContext.hasContext) {
  const contextPrefix = `[MAMA Memory]\n${relevantContext.prompt}\n[/MAMA Memory]\n\n`;
  enhancedMessage = contextPrefix + message.text;
}
```

- Embedding search (cosine similarity) + FTS5 keyword search
- is_static boost (+0.2)
- Graph expansion (supersedes chain, extends, derives)
- SmartSearch rerank (candidates ≥ 3일 때)
- 최대 3개 관련 decision, 간결한 포맷

### 6. Config 통합

```yaml
# ~/.mama/config.yaml
agents:
  memory:
    enabled: true
    model: claude-sonnet-4-6 # config에서 변경 가능
    backend: claude
    tier: 1
    can_delegate: false
    cooldown_ms: 30000 # 추출 간격
    min_content_length: 100
    max_content_length: 10000
```

### 7. 플레이그라운드 모니터링

`playground_create`로 HTML 대시보드:

```
┌─────────────────────────────────────────┐
│ MAMA Memory Agent Dashboard              │
├─────────────────────────────────────────┤
│ Status: ● Active  Model: sonnet-4-6     │
│ Process: PID 12345  Uptime: 2h 15m      │
├─────────────────────────────────────────┤
│ Stats                                    │
│ Turns observed: 47                       │
│ Facts extracted: 23  Saved: 21           │
│ Duplicates skipped: 2                    │
│ Edges created: 8                         │
├─────────────────────────────────────────┤
│ Recent Extractions                       │
│ ✅ auth_strategy → "Use session-based"   │
│ ✅ database_choice → "SQLite local-first"│
│ ⏭️ greeting → skipped (casual)          │
├─────────────────────────────────────────┤
│ Edge Graph                               │
│ auth_strategy ──supersedes──► auth_str.. │
│ db_choice ──builds_on──► deployment_cfg   │
└─────────────────────────────────────────┘
```

API endpoint: `GET /api/memory-agent/stats` → JSON 실시간 데이터

## Migration Plan

### 제거 대상

- `packages/mama-core/src/haiku-client.ts` → 제거 (PersistentCLI로 대체)
- `packages/mama-core/src/fact-extractor.ts` → 제거 (memory agent persona로 대체)
- `message-router.ts` `autoExtractFacts()` → memory agent 트리거로 교체
- `gateway-tool-executor.ts` `handleMamaAdd()` → memory agent singleton에 메시지 전달. mama_add tool은 유지하되 내부적으로 `getSharedProcess('memory').sendMessage()`로 라우팅. busy 시 큐잉.

### 유지 대상

- `db-manager.ts` fts5Search — 그대로 유지
- `smart-search.ts` rerankResults — 그대로 유지
- `mama-api.ts` save/suggest — 그대로 유지
- `context-injector.ts` — 매 턴 injection으로 확장
- DB migrations (014, 015) — 그대로 유지
- `mama_profile` MCP tool — 그대로 유지

## Supermemory 대비 우위

| 영역               | Supermemory             | MAMA Memory Agent                                       |
| ------------------ | ----------------------- | ------------------------------------------------------- |
| 비용               | $299+/mo                | $0 (자체 OAuth)                                         |
| 프라이버시         | 클라우드 전송           | 100% 로컬 SQLite                                        |
| Agent 문맥 유지    | Stateless API           | Persistent CLI session                                  |
| Decision evolution | updates/extends/derives | supersedes/extends/derives + graph expansion            |
| 검색               | Hybrid vector+keyword   | Hybrid embedding+FTS5 + recency boost + graph traversal |
| Reranking          | Context-aware           | LLM rerank (SmartSearch)                                |
| 모니터링           | 외부 대시보드           | 내장 플레이그라운드                                     |
| 커스터마이징       | API 제한적              | Persona 직접 수정, 모델 변경 자유                       |

### 8. User Profile (기본 — is_static 활용)

이 스펙에서는 기존 `is_static` 컬럼과 `mama_profile` tool을 활용한 기본 profile 지원.
Memory agent persona가 `is_static: true/false`를 분류하여 자동 profile 구축.

**3-Tier Profile System (identity/preference/context 분리, profile_tier 컬럼, 30일 만료)은 별도 스펙으로 분리 — 이 redesign 완료 후 다음 이터레이션에서 구현.**

## Success Criteria

1. Memory agent가 `AgentProcessManager`의 persistent process로 실행
2. 매 대화 턴 후 fire-and-forget으로 facts 추출
3. 추출된 facts가 다음 턴에 context injection으로 메인 에이전트에 보임
4. 같은 topic 저장 시 supersedes edge 자동 생성
5. extends/derives relationship 지원
6. config.yaml에서 모델/cooldown 설정 가능
7. 플레이그라운드에서 실시간 모니터링
8. 텔레그램 round-trip e2e 통과
9. HaikuClient/FactExtractor 제거, raw API call 없음
10. Memory agent persona가 is_static 자동 분류
