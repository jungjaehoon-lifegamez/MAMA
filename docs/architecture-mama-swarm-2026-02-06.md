# MAMA Multi-Agent Swarm Architecture

**Date:** 2026-02-06
**Status:** Draft
**Author:** System Architect (BMAD Workflow)
**Scope:** Oh My OpenCode 패턴을 MAMA Discord 멀티에이전트 시스템에 적용

---

## 1. Executive Summary

MAMA의 기존 멀티에이전트 Discord 시스템에 Oh My OpenCode(OMO)의 검증된 패턴을 적용하여,
에이전트 계층화, 자율 실행(UltraWork), 도구 권한 격리, 카테고리 라우팅, 작업 지속성을 구현한다.

**핵심 원칙:**

- 에이전트는 작업 완료까지 멈추지 않는다 (Sisyphus 패턴)
- 계층적 위임으로 복잡한 작업을 분해한다
- 도구 권한으로 안전성을 보장한다
- Discord에서 모든 과정이 실시간 관찰 가능하다

---

## 2. Architectural Drivers

| ID   | Driver                | Impact                                   | OMO Reference                         |
| ---- | --------------------- | ---------------------------------------- | ------------------------------------- |
| AD-1 | 에이전트 자율성       | UltraWork/Ralph Loop: 완료까지 자동 실행 | Sisyphus + todo-continuation-enforcer |
| AD-2 | 루프 방지 안전성      | 무한 루프 없이 장시간 자율 실행          | Chain limit + TTL expiration          |
| AD-3 | 계층적 위임           | Tier 1→2→3 계층 분리                     | 3-tier agent hierarchy                |
| AD-4 | 도구 권한 격리        | 에이전트별 허용 도구 제한                | Tool deny/allow per agent             |
| AD-5 | Discord 실시간 가시성 | 모든 활동 Discord 관찰                   | MAMA 고유 (OMO는 tmux)                |
| AD-6 | 기존 아키텍처 호환    | PersistentProcessPool 재사용             | Session reuse pattern                 |
| AD-7 | 확장성                | config.yaml만으로 에이전트 추가          | Agent factory pattern                 |

---

## 3. High-Level Architecture

### 3.1 Architecture Pattern

**Hierarchical Multi-Agent Orchestration with Discord Gateway**

```
┌─────────────────────────────────────────────────────────────────┐
│                    MAMA Swarm Architecture                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Discord Channel (실시간 관찰 + 사람 개입)                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  👤 Human  ←→  🤖 Agent Bots (lifegamezBot, pm_alex, ...)  │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                              │                                    │
│  ┌───────────────────────────▼──────────────────────────────────┐│
│  │              Discord Gateway (DiscordGateway)                ││
│  │  - Message routing & bot detection                           ││
│  │  - Multi-agent handler integration                           ││
│  └──────────────────────────┬───────────────────────────────────┘│
│                              │                                    │
│  ┌───────────────────────────▼──────────────────────────────────┐│
│  │           Swarm Orchestration Layer (NEW)                    ││
│  │                                                               ││
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐      ││
│  │  │  Category    │  │  Task        │  │  Tool          │      ││
│  │  │  Router      │  │  Continuation│  │  Permission    │      ││
│  │  │  (NEW)       │  │  Enforcer    │  │  Manager       │      ││
│  │  │              │  │  (NEW)       │  │  (NEW)         │      ││
│  │  └─────────────┘  └──────────────┘  └────────────────┘      ││
│  │                                                               ││
│  │  ┌─────────────────────────────────────────────────────┐     ││
│  │  │  Multi-Agent Orchestrator (ENHANCED)                │     ││
│  │  │  - Agent selection (free_chat, trigger, keyword)    │     ││
│  │  │  - Chain tracking & loop prevention                 │     ││
│  │  │  - Agent tier enforcement                           │     ││
│  │  └─────────────────────────────────────────────────────┘     ││
│  └──────────────────────────────────────────────────────────────┘│
│                              │                                    │
│  ┌───────────────────────────▼──────────────────────────────────┐│
│  │              Agent Execution Layer                            ││
│  │                                                               ││
│  │  ┌─────────────────────────────────────────────────────┐     ││
│  │  │  Agent Process Manager (ENHANCED)                   │     ││
│  │  │  - Per-agent PersistentClaudeProcess                │     ││
│  │  │  - Persona loading with tier metadata               │     ││
│  │  │  - Tool restriction injection into system prompt    │     ││
│  │  └─────────────────────────────────────────────────────┘     ││
│  │                                                               ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    ││
│  │  │ Sisyphus │  │ Oracle   │  │ Junior   │  │ Explore  │    ││
│  │  │ (Tier 1) │  │ (Tier 2) │  │ (Tier 3) │  │ (Tier 3) │    ││
│  │  │ 🎯 오케  │  │ 📊 자문  │  │ 🔧 실행  │  │ 🔍 탐색  │    ││
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    ││
│  └──────────────────────────────────────────────────────────────┘│
│                              │                                    │
│  ┌───────────────────────────▼──────────────────────────────────┐│
│  │              Shared Infrastructure                            ││
│  │  ┌────────────┐  ┌──────────────┐  ┌────────────────┐       ││
│  │  │ Shared     │  │ Multi-Bot    │  │ MAMA Memory    │       ││
│  │  │ Context    │  │ Manager      │  │ (SQLite+vec)   │       ││
│  │  │ Manager    │  │ (Discord)    │  │                │       ││
│  │  └────────────┘  └──────────────┘  └────────────────┘       ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Pattern Rationale

| 선택                           | 이유                          | OMO와의 차이           |
| ------------------------------ | ----------------------------- | ---------------------- |
| Discord 기반 통신              | 실시간 가시성, 사람 개입 가능 | OMO는 CLI/tmux 기반    |
| PersistentProcessPool          | 세션 재사용, 빠른 응답        | OMO는 OpenCode session |
| 단일 Gateway + MultiBotManager | 기존 구조 유지, 점진적 확장   | OMO는 단일 프로세스    |
| Config-driven 에이전트         | YAML 설정만으로 에이전트 추가 | OMO는 코드 기반 팩토리 |

---

## 4. Agent Tier System

### 4.1 Three-Tier Hierarchy

```
Tier 1: Orchestrators (위임 권한 있음)
├── Sisyphus (🎯) - 메인 오케스트레이터, 작업 분배, 완료까지 추적
└── Atlas (📋) - 계획 실행자, todo 기반 체크리스트 실행

Tier 2: Advisors (읽기 전용, 자문역)
├── Oracle (📊) - 아키텍처 분석, 디버깅 자문
├── Reviewer (📝) - 코드 리뷰, 품질 검토
└── Prometheus (💡) - 전략 기획, 인터뷰 모드

Tier 3: Executors (실행만, 위임 불가)
├── Developer (🔧) - 코드 구현, 버그 수정
├── Explore (🔍) - 코드베이스 탐색 (읽기 전용)
└── Librarian (📚) - 문서 검색, 참조 자료
```

### 4.2 Tier Capabilities Matrix

| Capability               | Tier 1 | Tier 2 | Tier 3              |
| ------------------------ | ------ | ------ | ------------------- |
| Read files               | ✅     | ✅     | ✅                  |
| Write/Edit files         | ✅     | ❌     | ✅ (Developer only) |
| Bash execution           | ✅     | ❌     | ✅ (Developer only) |
| Delegate to other agents | ✅     | ❌     | ❌                  |
| Create sub-tasks         | ✅     | ❌     | ❌                  |
| Trigger re-evaluation    | ✅     | ✅     | ❌                  |
| Discord 메시지 전송      | ✅     | ✅     | ✅                  |

### 4.3 Configuration Schema

```yaml
# ~/.mama/config.yaml
multi_agent:
  enabled: true
  free_chat: true

  # Agent tier definitions
  agents:
    sisyphus:
      name: 'Sisyphus'
      display_name: '🎯 Sisyphus'
      tier: 1 # NEW: tier level
      trigger_prefix: '!sis'
      persona_file: '~/.mama/personas/sisyphus.md'
      bot_token: '...'
      model: 'claude-opus-4-5-20251101'
      can_delegate: true # NEW: delegation permission
      auto_continue: true # NEW: UltraWork auto-continue
      tool_permissions: # NEW: tool restrictions
        read: 'allow'
        write: 'allow'
        edit: 'allow'
        bash: 'allow'
        delegate_task: 'allow'
      auto_respond_keywords: []
      cooldown_ms: 3000

    reviewer:
      name: 'Reviewer'
      display_name: '📝 Reviewer'
      tier: 2
      trigger_prefix: '!review'
      persona_file: '~/.mama/personas/reviewer.md'
      bot_token: '...'
      model: 'claude-sonnet-4-5-20250929'
      can_delegate: false
      tool_permissions:
        read: 'allow'
        write: 'deny' # Read-only
        edit: 'deny'
        bash: 'deny'
        delegate_task: 'deny'
      auto_respond_keywords: ['review', 'check', '리뷰', '검토']
      cooldown_ms: 5000

    developer:
      name: 'DevBot'
      display_name: '🔧 DevBot'
      tier: 3
      trigger_prefix: '!dev'
      persona_file: '~/.mama/personas/developer.md'
      bot_token: '...'
      model: 'claude-sonnet-4-5-20250929'
      can_delegate: false
      tool_permissions:
        read: 'allow'
        write: 'allow'
        edit: 'allow'
        bash: 'allow'
        delegate_task: 'deny' # Cannot delegate
      auto_respond_keywords: ['bug', 'error', 'code', '구현', '버그']
      cooldown_ms: 5000

    explore:
      name: 'Explorer'
      display_name: '🔍 Explorer'
      tier: 3
      trigger_prefix: '!explore'
      persona_file: '~/.mama/personas/explore.md'
      model: 'claude-haiku-4-5-20251001'
      can_delegate: false
      tool_permissions:
        read: 'allow'
        write: 'deny'
        edit: 'deny'
        bash: 'deny'
        delegate_task: 'deny'
      auto_respond_keywords: ['찾아', 'search', '어디']
      cooldown_ms: 2000

  # Category-based routing (NEW)
  categories:
    code:
      description: '코드 구현 및 수정'
      default_agent: 'developer'
      keywords: ['implement', 'fix', '구현', '수정', '작성']
    review:
      description: '코드 리뷰 및 품질 검토'
      default_agent: 'reviewer'
      keywords: ['review', 'check', '리뷰', '검토']
    explore:
      description: '코드베이스 탐색 및 검색'
      default_agent: 'explore'
      keywords: ['find', 'search', '찾아', '어디']
    plan:
      description: '아키텍처 및 설계'
      default_agent: 'sisyphus'
      keywords: ['plan', 'design', '설계', '계획']

  # UltraWork configuration (NEW)
  ultrawork:
    enabled: true
    trigger_keywords: ['ultrawork', 'ulw', '울트라워크']
    max_duration_ms: 3600000 # 1시간 최대
    continuation_check_interval_ms: 30000 # 30초마다 완료 체크
    completion_markers: ['DONE', '완료', '✅ 작업 완료']
    auto_resume_on_idle: true

  # Task continuation (NEW)
  task_continuation:
    enabled: true
    idle_timeout_ms: 60000 # 1분 비활성 시 재개 프롬프트
    max_retries: 3 # 최대 재개 시도
    resume_prompt: '이전 작업이 완료되지 않았습니다. 계속 진행해주세요.'

  # Loop prevention (ENHANCED)
  loop_prevention:
    max_chain_length: 10
    global_cooldown_ms: 2000
    chain_window_ms: 60000
    ultrawork_chain_length: 50 # UltraWork 모드 시 확장
```

---

## 5. New Components

### 5.1 Category Router (`src/multi-agent/category-router.ts`)

**Purpose:** 메시지 내용을 분석하여 적절한 카테고리로 라우팅

**Responsibilities:**

- 키워드 기반 카테고리 매칭
- 카테고리별 기본 에이전트 선택
- 명시적 트리거 우선 (기존 로직 유지)
- 카테고리 미매칭 시 free_chat 모드 fallback

**Interface:**

```typescript
interface CategoryRouter {
  // 메시지를 카테고리로 분류
  categorize(content: string): CategoryMatch | null;
  // 카테고리에 적합한 에이전트 선택
  selectAgentForCategory(category: string): string;
}

interface CategoryMatch {
  category: string;
  confidence: number; // 0-1
  matchedKeywords: string[];
  defaultAgent: string;
}
```

**Integration point:** `MultiAgentOrchestrator.selectRespondingAgents()` 에서
키워드 매칭 단계를 카테고리 라우팅으로 대체/보강

### 5.2 Tool Permission Manager (`src/multi-agent/tool-permission-manager.ts`)

**Purpose:** 에이전트별 도구 사용 권한 관리 및 시스템 프롬프트 주입

**Responsibilities:**

- 에이전트 설정에서 tool_permissions 로딩
- 시스템 프롬프트에 도구 제한 규칙 주입
- Tier 기반 기본 권한 적용

**Interface:**

```typescript
interface ToolPermissionManager {
  // 에이전트의 도구 권한 조회
  getPermissions(agentId: string): ToolPermissions;
  // 시스템 프롬프트에 도구 제한 주입
  injectPermissionPrompt(agentId: string, systemPrompt: string): string;
  // 특정 도구 사용 가능 여부
  canUseTool(agentId: string, toolName: string): boolean;
}

interface ToolPermissions {
  read: 'allow' | 'ask' | 'deny';
  write: 'allow' | 'ask' | 'deny';
  edit: 'allow' | 'ask' | 'deny';
  bash: 'allow' | 'ask' | 'deny';
  delegate_task: 'allow' | 'ask' | 'deny';
  [key: string]: 'allow' | 'ask' | 'deny';
}
```

**구현 방식:**

- Claude CLI의 `--dangerouslySkipPermissions` 사용 시 시스템 프롬프트로 제한
- 시스템 프롬프트에 "절대 write/edit 도구를 사용하지 마세요" 등 명시적 지시 주입
- 향후 Claude CLI의 `--allowed-tools` 옵션 지원 시 네이티브 전환

### 5.3 Task Continuation Enforcer (`src/multi-agent/task-continuation.ts`)

**Purpose:** 에이전트가 작업 도중 멈추면 자동으로 재개 프롬프트 전송

**Responsibilities:**

- 에이전트 응답 후 완료 마커 확인
- 미완료 시 재개 프롬프트 자동 전송
- 최대 재시도 횟수 제한
- UltraWork 모드 시 장시간 자율 실행 관리

**Interface:**

```typescript
interface TaskContinuationEnforcer {
  // 에이전트 응답 후 완료 여부 확인
  checkCompletion(agentId: string, response: string): boolean;
  // 미완료 시 재개 프롬프트 전송
  scheduleResumption(agentId: string, channelId: string): void;
  // UltraWork 모드 시작
  startUltraWork(channelId: string, task: string): void;
  // UltraWork 모드 중단
  stopUltraWork(channelId: string): void;
}

interface UltraWorkSession {
  channelId: string;
  startTime: number;
  task: string;
  iterations: number;
  maxDuration: number;
  active: boolean;
}
```

**UltraWork Flow:**

```
User: "이 프로젝트를 리팩토링해줘 ultrawork"
  │
  ▼
[Detect "ultrawork" keyword]
  │
  ▼
[Start UltraWork Session]
  │
  ▼
[Sisyphus: 작업 분석 & 계획]
  │
  ├──▶ [Developer: 구현] ──▶ [Reviewer: 리뷰]
  │         │                       │
  │         ◀── 피드백 반영 ◀───────┘
  │
  ├──▶ [완료 마커 감지?]
  │         │
  │    No   ▼   Yes
  │    [재개 프롬프트] ──▶ [UltraWork 종료]
  │         │
  │         ▼
  │    [계속 실행...]
  │
  ▼
[Max duration or 완료] ──▶ [결과 보고]
```

### 5.4 Delegation Manager (`src/multi-agent/delegation-manager.ts`)

**Purpose:** Tier 1 에이전트가 다른 에이전트에게 작업을 위임하는 메커니즘

**Responsibilities:**

- Tier 기반 위임 권한 검증
- 위임 메시지 포맷 생성
- 위임 결과 수집 및 오케스트레이터에게 보고
- 순환 위임 방지

**Interface:**

```typescript
interface DelegationManager {
  // 작업 위임 (Tier 1 → Tier 2/3)
  delegate(
    fromAgentId: string,
    toAgentId: string,
    task: string,
    options?: DelegationOptions
  ): Promise<DelegationResult>;

  // 카테고리 기반 위임
  delegateByCategory(
    fromAgentId: string,
    category: string,
    task: string
  ): Promise<DelegationResult>;

  // 위임 가능 여부 확인
  canDelegate(fromAgentId: string, toAgentId: string): boolean;
}

interface DelegationOptions {
  background?: boolean; // 백그라운드 실행
  timeout?: number; // 타임아웃
  priority?: 'low' | 'normal' | 'high';
}

interface DelegationResult {
  success: boolean;
  agentId: string;
  response: string;
  duration: number;
}
```

**Discord 통합:**

- 위임 시 Discord에 "🎯 Sisyphus → 🔧 DevBot: [작업 설명]" 메시지 전송
- 실행 결과도 Discord에 표시
- 사용자가 중간에 개입 가능

---

## 6. Enhanced Existing Components

### 6.1 MultiAgentOrchestrator (ENHANCED)

**변경 사항:**

- `selectRespondingAgents()` 에 카테고리 라우팅 통합
- Tier 기반 에이전트 필터링 추가
- UltraWork 모드 감지 로직 추가

```typescript
// 선택 우선순위 (기존 + 신규)
// 0. UltraWork 모드 (NEW): ultrawork 키워드 감지 → Sisyphus 선택
// 1. Free chat 모드: 모든 에이전트 응답
// 2. 명시적 트리거: !dev, !review 등
// 3. 카테고리 라우팅 (NEW): 키워드로 카테고리 매칭 → 카테고리 기본 에이전트
// 4. 키워드 매칭: auto_respond_keywords
// 5. 기본 에이전트: default_agent
```

### 6.2 AgentProcessManager (ENHANCED)

**변경 사항:**

- `buildSystemPrompt()` 에 도구 권한 제한 주입
- Tier 메타데이터를 시스템 프롬프트에 포함
- 위임 가능 에이전트 목록 주입 (Tier 1 전용)

```typescript
// Tier 1 에이전트 시스템 프롬프트 추가 예시
`
## Delegation Capabilities
당신은 Tier 1 오케스트레이터입니다. 다음 에이전트에게 작업을 위임할 수 있습니다:
- 🔧 DevBot (developer): 코드 구현, 버그 수정
- 📝 Reviewer (reviewer): 코드 리뷰, 품질 검토
- 🔍 Explorer (explore): 코드베이스 탐색

작업 위임 시 "DELEGATE::{agentId}::{task}" 형식으로 메시지를 보내세요.
`
// Tier 2 에이전트 시스템 프롬프트 추가 예시
`
## Tool Restrictions
당신은 Tier 2 자문역입니다. 다음 도구는 사용할 수 없습니다:
- ❌ Write, Edit (파일 수정 불가)
- ❌ Bash (명령 실행 불가)
분석과 조언만 제공하세요.
`;
```

### 6.3 SharedContextManager (ENHANCED)

**변경 사항:**

- 위임 메시지 기록 추가
- UltraWork 세션 컨텍스트 유지
- 메시지 truncation 800자 (이미 적용됨)

---

## 7. Data Architecture

### 7.1 Core Data Entities

```
UltraWorkSession
├── channelId: string
├── task: string
├── startTime: number
├── status: 'active' | 'paused' | 'completed' | 'timeout'
├── iterations: number
├── delegations: DelegationRecord[]
└── completionMarkers: string[]

DelegationRecord
├── fromAgentId: string
├── toAgentId: string
├── task: string
├── startTime: number
├── endTime?: number
├── status: 'pending' | 'running' | 'completed' | 'failed'
└── result?: string

AgentConfig (Enhanced)
├── id: string
├── tier: 1 | 2 | 3
├── can_delegate: boolean
├── auto_continue: boolean
├── tool_permissions: ToolPermissions
└── ... (existing fields)
```

### 7.2 State Management

```
In-Memory State:
├── SharedContextManager → 채널별 메시지 히스토리 (20개, 10분)
├── ChainState → 채널별 응답 체인 상태
├── UltraWorkSessions → 채널별 UltraWork 세션 (NEW)
├── DelegationQueue → 위임 작업 큐 (NEW)
└── AgentCooldowns → 에이전트별 쿨다운

Persistent State (config.yaml):
├── Agent definitions (tier, permissions, personas)
├── Category definitions
├── UltraWork settings
└── Loop prevention settings
```

---

## 8. Communication Patterns

### 8.1 Pattern 1: Free Chat (기존)

```
Human → All agents respond → Agent-to-agent conversation → Chain limit
```

### 8.2 Pattern 2: Category Routing (NEW)

```
Human: "이 코드 리뷰해줘"
  → Category Router: "review" 카테고리 매칭
  → Reviewer 에이전트 선택
  → Reviewer 응답
```

### 8.3 Pattern 3: Hierarchical Delegation (NEW)

```
Human: "새 기능 구현하고 리뷰까지"
  → Sisyphus (Tier 1): 작업 분석
  → DELEGATE::developer::기능 구현
  → Developer (Tier 3): 구현
  → DELEGATE::reviewer::코드 리뷰
  → Reviewer (Tier 2): 리뷰 피드백
  → Developer: 피드백 반영
  → Sisyphus: 최종 보고
```

### 8.4 Pattern 4: UltraWork Autonomous (NEW)

```
Human: "전체 리팩토링 ultrawork"
  → UltraWork 세션 시작
  → Sisyphus: 분석 → 계획 → 위임
  → [자동 루프]
  │  Developer: 구현
  │  Reviewer: 리뷰
  │  Developer: 수정
  │  TaskContinuation: 미완료 → 재개
  └─ 완료 마커 감지 또는 max_duration 도달
  → 결과 보고
```

---

## 9. NFR Coverage

### NFR-1: Safety (루프 방지)

- **Solution:** Chain limit (10, UltraWork 시 50) + TTL expiration
- **Validation:** 무한 루프 발생 시 자동 정지 확인 테스트

### NFR-2: Performance (응답 속도)

- **Solution:** PersistentProcessPool 세션 재사용, 병렬 처리
- **Validation:** 에이전트 응답 < 10초 (Haiku < 3초)

### NFR-3: Extensibility (에이전트 추가)

- **Solution:** config.yaml 기반 선언적 에이전트 정의
- **Validation:** 새 에이전트 추가 시 코드 변경 없이 config만 수정

### NFR-4: Observability (관찰 가능성)

- **Solution:** Discord에서 모든 위임/실행 과정 실시간 표시
- **Validation:** 위임 발생 시 "🎯→🔧" 형태의 알림 메시지

### NFR-5: Security (도구 권한)

- **Solution:** 시스템 프롬프트 기반 도구 제한 + Tier 기반 기본 권한
- **Validation:** Tier 2 에이전트가 파일 수정 시도 시 거부 확인

---

## 10. Implementation Phases

### Phase 1: Foundation (1-2일)

- [ ] `tool-permission-manager.ts` 구현
- [ ] `AgentPersonaConfig`에 `tier`, `tool_permissions` 필드 추가
- [ ] `AgentProcessManager.buildSystemPrompt()`에 도구 제한 주입
- [ ] 테스트: Reviewer가 파일 수정 불가 확인

### Phase 2: Category Routing (1일)

- [ ] `category-router.ts` 구현
- [ ] `MultiAgentOrchestrator.selectRespondingAgents()`에 카테고리 통합
- [ ] config.yaml에 categories 설정 추가
- [ ] 테스트: 카테고리별 에이전트 라우팅

### Phase 3: Task Continuation (1-2일)

- [ ] `task-continuation.ts` 구현
- [ ] 응답 완료 마커 감지 로직
- [ ] 미완료 시 자동 재개 프롬프트 전송
- [ ] 테스트: 중단된 작업 자동 재개

### Phase 4: Delegation (2-3일)

- [ ] `delegation-manager.ts` 구현
- [ ] Tier 기반 위임 권한 검증
- [ ] Discord에 위임 알림 메시지
- [ ] 위임 결과 수집 및 보고
- [ ] 테스트: Sisyphus → Developer → Reviewer 위임 체인

### Phase 5: UltraWork (2-3일)

- [ ] UltraWork 세션 관리
- [ ] 자동 루프 실행 (delegation + continuation)
- [ ] 시간 제한 및 안전 장치
- [ ] 테스트: 1시간 자율 실행 후 정상 종료

### Phase 6: Polish & Testing (1-2일)

- [ ] 통합 테스트 작성
- [ ] 에지 케이스 처리 (에이전트 크래시, 타임아웃)
- [ ] 문서화

**총 예상 기간: 8-13일**

---

## 11. Trade-offs

### Decision 1: 시스템 프롬프트 기반 도구 제한 vs Claude CLI 네이티브 제한

- **선택:** 시스템 프롬프트 기반
- ✅ 장점: 즉시 구현 가능, 설정 유연성
- ❌ 단점: LLM이 무시할 수 있음 (soft restriction)
- **Rationale:** Claude CLI에 `--allowed-tools` 옵션이 없으므로 현실적 선택. 추후 네이티브 지원 시 전환

### Decision 2: Discord 채널 기반 통신 vs 내부 메시지 큐

- **선택:** Discord 채널 기반
- ✅ 장점: 실시간 가시성, 사람 개입, 기존 구조 활용
- ❌ 단점: Discord API 속도 제한, 메시지 2000자 제한
- **Rationale:** 관찰 가능성이 핵심 차별점. 내부 통신은 SharedContext로 보완

### Decision 3: 단일 Gateway vs 다중 Gateway

- **선택:** 단일 Gateway + MultiBotManager (기존 유지)
- ✅ 장점: 중앙 집중 관리, 일관된 상태
- ❌ 단점: 일부 에이전트가 Gateway 토큰 공유
- **Rationale:** 이미 양방향 통신 구현 완료. 확장 시 검토

---

## 12. Validation Checklist

- [x] AD-1 (자율성): UltraWork + TaskContinuation으로 해결
- [x] AD-2 (안전성): Chain limit + TTL + max_duration으로 해결
- [x] AD-3 (계층화): 3-Tier 에이전트 시스템
- [x] AD-4 (도구 권한): ToolPermissionManager + 시스템 프롬프트 주입
- [x] AD-5 (가시성): Discord 실시간 메시지 + 위임 알림
- [x] AD-6 (호환성): 기존 PersistentProcessPool, SharedContext 재사용
- [x] AD-7 (확장성): config.yaml 선언적 정의

---

## Next Steps

1. **Sprint Planning** (`/sprint-planning`): Phase 1-6을 스프린트로 분해
2. **Persona 파일 작성**: Sisyphus, Oracle 등 신규 에이전트 페르소나
3. **구현 시작**: Phase 1 (도구 권한 관리) 부터
