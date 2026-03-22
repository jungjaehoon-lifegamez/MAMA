# Multi-Team Support for MAMA OS

**Date:** 2026-03-22
**Category:** Design Plan
**Status:** Draft (Codex 리뷰 반영 v2)

---

## Context

MAMA의 현재 multi-agent 시스템은 **팀 1개 × 에이전트 N개** 구조이다. 모든 에이전트가 `~/.mama/workspace`를 공유하며, 특정 프로젝트 폴더에서 개발 작업을 수행할 수 없다.

**문제:**

- 에이전트가 특정 프로젝트 폴더에서 개발 작업 불가 (cwd 고정)
- Telegram에서 멀티에이전트 미지원 (단일 에이전트만 라우팅)

**목표:** **팀 N개 × 에이전트 N개** 구조를 지원. 각 팀이 자체 프로젝트 폴더에서 운영.

```
Team "frontend"  (cwd: ~/projects/frontend)
├── conductor, developer, reviewer

Team "backend"   (cwd: ~/projects/backend)
├── conductor, developer, reviewer
```

**스코프 외 (후속 작업):** 팀별 메모리 DB 분리. 현재 `GatewayToolExecutor`가 싱글턴으로 공유되어 `MAMA_DB_PATH` env 주입으로는 격리 불가. team-aware memory adapter가 필요하며 별도 설계 필요.

---

## Config Schema

```yaml
multi_agent:
  enabled: true

  # NEW: 팀 정의
  teams:
    frontend:
      working_dir: ~/projects/frontend
      project_mode: true # 명시적 opt-in: 격리 모델을 프로젝트 모드로 전환
      agents: [conductor, developer, reviewer]
      bindings: # 통합 채널 매핑
        - { source: telegram, channel_id: '-1001234567890' }
      default_agent: conductor

    backend:
      working_dir: ~/projects/backend
      project_mode: true
      agents: [conductor, developer, reviewer]
      bindings:
        - { source: telegram, channel_id: '-1009876543210' }
      default_agent: conductor

  # 에이전트 정의는 flat (팀 간 공유)
  agents:
    conductor:
      persona_file: ~/.mama/personas/conductor.md
      tier: 1
      can_delegate: true
    developer:
      persona_file: ~/.mama/personas/developer.md
      tier: 1
    reviewer:
      persona_file: ~/.mama/personas/reviewer.md
      tier: 3
```

**하위 호환성:** `teams`가 없으면 기존과 동일 (단일 팀, cwd = `~/.mama/workspace`).

**Codex 피드백 반영:**

- `telegram_chats`/`discord_channels`/`slack_channels` → `bindings: [{ source, channel_id }]` 통합
- `project_mode: true` 명시 플래그 추가 — cwd 변경에 의한 격리 모델 전환을 암묵적이 아닌 명시적으로 선언

---

## 핵심 변경 사항

### 1. Config 타입 + 검증 (Phase 1)

**파일:** `packages/standalone/src/cli/config/types.ts`, `config-manager.ts`

```typescript
export interface ChannelBinding {
  source: 'telegram' | 'discord' | 'slack';
  channel_id: string;
}

export interface TeamConfig {
  /** 팀의 작업 디렉토리 (Claude CLI의 cwd) */
  working_dir: string;
  /** 명시적 opt-in: 격리 모델을 프로젝트 모드로 전환 */
  project_mode?: boolean;
  /** 이 팀에 속한 에이전트 ID 목록 */
  agents: string[];
  /** 통합 채널 매핑 */
  bindings?: ChannelBinding[];
  /** 이 팀의 기본 에이전트 */
  default_agent?: string;
}
```

`MultiAgentConfig`에 추가: `teams?: Record<string, TeamConfig>;`

**검증 (config-manager.ts)** — 타입 추가 직후 구현:

- 팀의 `agents`에 정의되지 않은 에이전트 ID → 에러
- 같은 `channel_id`가 여러 팀에 바인딩 → 에러
- `working_dir` 경로 존재 여부 → 경고 (에러는 아님, 나중에 생성 가능)
- `project_mode`가 false인데 `working_dir`이 `~/.mama/workspace`가 아닌 경우 → 경고

동일하게 `multi-agent/types.ts`에도 반영.

### 2. teamId end-to-end 전파 (Phase 2) — **최우선**

**Codex 지적:** `getProcess(source, channelId, agentId)` 호출이 background task, workflow, council, delegation 곳곳에 있어서 teamId 없이는 팀 간 프로세스 혼선.

**파일:** `multi-agent/agent-process-manager.ts`, `multi-agent/multi-agent-base.ts`, `multi-agent/types.ts`

변경:

- `getProcess()` 시그니처: `getProcess(source, channelId, agentId, overrides?)` → `overrides`에 `teamId` 필수 전달
- 채널 키 포맷: `{source}:{channelId}:{teamId}:{agentId}` (팀 있을 때) / `{source}:{channelId}:{agentId}` (기존)
- `parseChannelKey()`: 3-segment + 4-segment 모두 지원
- `MessageContext`에 `teamId?` 필드 추가
- **모든 `getProcess()` 호출부** (base handler L169, L627, L746, L827 등)에 teamId 전달
- `resolveTeamFromChannel(source, channelId)`: bindings 배열에서 매칭

### 3. persistent-cli-process에 cwd 옵션 추가 (Phase 3)

**파일:** `packages/standalone/src/agent/persistent-cli-process.ts`

`PersistentProcessOptions`에 추가:

```typescript
cwd?: string;         // 팀 working_dir
projectMode?: boolean; // true면 프로젝트 격리 모드
```

`doStart()` 변경 (L285~299):

- `projectMode === true && cwd`가 있으면 → 해당 디렉토리를 cwd로 사용, 가짜 `.git/HEAD` 생성 **안 함**
- 그 외 → 기존 `~/.mama/workspace` + git 경계 생성 (변경 없음)
- `--setting-sources project,local` + `--plugin-dir`(빈 디렉토리)는 **양쪽 모두 유지**

### 4. Prompt Enhancer 경로 팀 대응 (Phase 4)

**Codex 지적:** MAMA가 별도로 주입하는 `AGENTS.md`/`.claude/rules` 경로가 `MAMA_WORKSPACE` 기준이라, cwd만 바꾸면 불일치.

**파일:** `multi-agent/agent-process-manager.ts`, `agent/prompt-enhancer.ts`

변경:

- `loadBackendAgentsMd()` 호출 시 팀의 `working_dir` 전달
- `AGENTS.md` 검색 경로: 팀 working_dir → fallback `~/.mama/workspace`
- prompt enhancer의 rules 검색도 동일하게 팀 경로 우선

### 5. Orchestrator 팀 필터링 (Phase 5)

**파일:** `packages/standalone/src/multi-agent/orchestrator.ts`

- `selectRespondingAgents()`에서 `context.teamId`가 있으면 팀 에이전트만 후보
- delegation도 팀 내로 제한: `DelegationManager.isDelegationAllowed()`에서 크로스팀 차단

### 6. MultiAgentTelegramHandler (Phase 6) — **Codex 지적 반영**

**변경:** TelegramGateway 직접 라우팅 → `MultiAgentTelegramHandler` 신규 클래스

**Codex 지적:** 직접 라우팅은 orchestrator, 루프 방지, delegation, council 등 기존 기능을 우회. `MultiAgentHandlerBase`를 재사용해야 함.

**파일:** `multi-agent/multi-agent-telegram.ts` (신규), `gateways/telegram.ts`, `start.ts`

구현:

- `MultiAgentTelegramHandler extends MultiAgentHandlerBase` 생성
- 추상 메서드 구현: `getPlatformName()` → `'telegram'`, `sendChannelNotification()` → `bot.sendMessage()`
- `extractMentionedAgentIds()`: Telegram은 봇 멘션 없으므로 trigger prefix 파싱만
- `TelegramGateway`에 `multiAgentHandler` 옵션 추가
- `handleMessage()`에서 팀 바인딩 매칭 시 → multiAgentHandler로 위임
- 미매핑 채팅 → 기존 `messageRouter.process()` (단일 에이전트)

### 7. Codex backend 팀 대응 (Phase 7)

**파일:** `multi-agent/agent-process-manager.ts`

- Codex 런타임도 팀 `working_dir`을 `codexCwd`로 전달
- `CodexRuntimeProcess` 생성 시 `cwd: teamConfig.working_dir`

### 8. Viewer UI (Phase 8~10)

| Phase | 작업                                            | 파일                                                       |
| ----- | ----------------------------------------------- | ---------------------------------------------------------- |
| 8     | REST API: 팀 CRUD                               | `api/graph-api.ts` (기존 config API 계열)                  |
| 9     | "Teams" 별도 탭 추가                            | `viewer.html`, `public/viewer/src/modules/teams.ts` (신규) |
| 10    | Teams 탭: 팀 목록, 에이전트 배정, bindings 매핑 | `teams.ts`, `api.ts`                                       |

> 기존 Settings 탭의 Multi-Agent 섹션은 에이전트 정의(persona, model, tier)만 담당.
> 팀 구성(에이전트 배정, working_dir, 채널 바인딩)은 별도 Teams 탭.

---

## 구현 순서

| Phase | 작업                                     | 파일                                                           |
| ----- | ---------------------------------------- | -------------------------------------------------------------- |
| 1     | TeamConfig 타입 + **config 검증**        | `config/types.ts`, `multi-agent/types.ts`, `config-manager.ts` |
| 2     | **teamId end-to-end 전파**               | `agent-process-manager.ts`, `multi-agent-base.ts`, `types.ts`  |
| 3     | cwd + projectMode 옵션                   | `persistent-cli-process.ts`                                    |
| 4     | Prompt Enhancer 팀 경로 대응             | `agent-process-manager.ts`, `prompt-enhancer.ts`               |
| 5     | Orchestrator 팀 필터링 + delegation 제한 | `orchestrator.ts`, `delegation-manager.ts`                     |
| 6     | MultiAgentTelegramHandler                | `multi-agent-telegram.ts` (신규), `telegram.ts`, `start.ts`    |
| 7     | Codex backend 팀 cwd                     | `agent-process-manager.ts`                                     |
| 8     | 검증 + 테스트                            | 테스트 파일                                                    |
| 9~11  | Viewer UI: Teams 탭 + REST API           | `graph-api.ts`, `viewer.html`, `teams.ts`                      |

> **Phase 1은 반드시 검증 포함.** invalid config로 런타임 변경하는 사고 방지.
> **Phase 2가 최우선.** teamId 전파 없이 cwd를 바꾸면 프로세스 혼선.

---

## 주의 사항

1. **같은 에이전트 ID, 다른 팀**: conductor가 frontend/backend 양쪽에 속할 수 있음. 채널 키에 teamId가 포함되므로 프로세스 격리됨. 같은 persona이지만 cwd가 다름.

2. **팀 간 위임**: 팀 내 위임만 허용. `DelegationManager.isDelegationAllowed()`에서 크로스팀 차단. 추후 `DELEGATE::{teamId}:{agentId}::task` 포맷으로 확장 가능.

3. **프로세스 수**: 팀 3개 × 에이전트 3개 = 최대 9개 Claude CLI 프로세스. lazy 생성이므로 실제로는 사용된 것만 spawn.

4. **CLAUDE.md 주입**: `project_mode: true` 시 팀 working_dir의 CLAUDE.md가 Claude CLI에 의해 자동 로드됨. 의도된 동작.

5. **격리 모델 변경**: `project_mode: true`는 `.mama/workspace` 경계 고정을 포기하고 프로젝트 컨텍스트를 허용하는 **명시적 opt-in**. `--setting-sources project,local` + `--plugin-dir`(빈)은 유지되므로 전역 user 설정/플러그인 재주입은 없음.

6. **Telegram 단일 봇**: 하나의 봇이 모든 팀 처리. 팀 구분은 채팅방(chatId) 바인딩. `MultiAgentTelegramHandler`가 orchestrator, delegation, council 등 기존 기능 모두 재사용.

7. **미매핑 채팅방**: teams가 활성화된 상태에서 바인딩되지 않은 chatId → 기존 단일 에이전트(messageRouter)로 폴백. 향후 미매핑 채팅 거부 옵션 추가 가능.

8. **working_dir 미존재 시**: config 검증에서 경고. 프로세스 생성 시 디렉토리 자동 생성하지 않음.

9. **채널 바인딩 중복 금지**: 같은 `{ source, channel_id }`가 여러 팀 → config 에러.

10. **Prompt Enhancer 경로**: `AGENTS.md`, `.claude/rules` 검색을 팀 working_dir 우선으로 변경. 없으면 `~/.mama/workspace` 폴백.

11. **프로세스 라이프사이클**: 팀 에이전트 프로세스도 PersistentProcessPool이 관리. `mama stop`/hot-reload 시 전체 풀 정리.

12. **메모리 (후속 작업)**: 현재는 전역 DB 공유. `GatewayToolExecutor` 싱글턴 구조로 인해 env 주입 방식으로는 격리 불가. team-aware memory adapter 설계 후 별도 구현 예정.

---

## 검증 방법

1. **빌드**: `pnpm build` 성공
2. **기존 테스트**: `pnpm test` 통과 (하위 호환성 — teams 미설정 시 기존 동작)
3. **단위 테스트**:
   - TeamConfig 파싱 + bindings 검증
   - 채널 키 4-segment 생성/파싱
   - cwd + projectMode 오버라이드
   - 채널→팀 바인딩 매칭 (매칭/미매칭/중복)
   - teamId end-to-end 전파 (delegation, council, background task에서 팀 유지)
4. **E2E**:
   - Telegram 팀 채팅방에서 `!dev 안녕` → 해당 팀 working_dir에서 프로세스 시작 확인
   - 같은 봇에서 비팀 채팅 → 기존 단일 에이전트 동작 확인
   - 팀 내 delegation 동작 확인
5. **로그 확인**:
   - `[AgentProcessManager]` 로그에서 cwd가 팀 working_dir인지
   - 채널 키에 teamId가 포함되어 있는지
