# Conductor 감사 루프 + 스킬 주입 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement.

**Goal:** Conductor 감독자 역할 — 매시간 감사 + 경중 분기 + 스킬 파일로 하부 에이전트 지침 주입

**원래 목표 정합성 확인:**

- 인간 ↔ Conductor만 소통 ✓
- Conductor가 감사하고 delegate로 지시 ✓
- 스킬 파일로 하부 에이전트 규칙 주입 ✓
- developer/reviewer가 아닌 Dashboard/Wiki Agent 대상 ✓

---

## Task 1: 스킬 파일 로더 (AgentProcessManager)

**Files:**

- Modify: `packages/standalone/src/multi-agent/agent-process-manager.ts` (loadPersona 메서드)

loadPersona()에서 persona 파일 로드 후, `~/.mama/skills/{agentId}-rules.md` 파일이 존재하면 내용을 append:

```typescript
// loadPersona() 끝에 추가:
const skillPath = resolve(homedir(), '.mama', 'skills', `${agentId}-rules.md`);
if (existsSync(skillPath)) {
  const skillContent = await readFile(skillPath, 'utf8');
  persona += `\n\n## Agent-Specific Rules\n${skillContent}`;
}
```

테스트: loadPersona가 스킬 파일을 append하는지 확인.

---

## Task 2: 기본 스킬 파일 생성

**Files:**

- Create: `~/.mama/skills/dashboard-rules.md`
- Create: `~/.mama/skills/wiki-rules.md`

Dashboard rules:

```markdown
# Dashboard Briefing Rules

## 필수 섹션

1. 프로젝트 현황 요약 (전체 상태 한 문단)
2. 즉시 주의가 필요한 사항 (마감 임박, 지연, 오류)
3. 프로젝트 간 패턴 및 리스크

## 형식 규칙

- HTML 형식, 인라인 스타일
- 마감일은 빨간색 (#D94F4F) 강조
- 각 섹션에 heading 태그 사용
- 최소 3개 프로젝트 커버
- 한국어로 작성
```

Wiki rules:

```markdown
# Wiki Page Rules

## 페이지 구조

- 반드시 type (entity/lesson/synthesis/process) 명시
- confidence (high/medium/low) 명시
- sourceIds에 근거 decision ID 포함

## 내용 규칙

- 사실 기반 (추측 금지)
- 날짜 정보 포함 (언제 결정/변경되었는지)
- 관련 프로젝트/인물 명시
```

---

## Task 3: Conductor audit prompt

**Files:**

- Create: `~/.mama/skills/audit-checklist.md`
- Modify: `~/.mama/personas/conductor.md`

audit-checklist.md:

```markdown
# Conductor Audit Checklist

## 감사 프로세스

1. mama_search("dashboard_briefing") → 마지막 브리핑 확인
2. mama_search("wiki_compilation") → 마지막 위키 컴파일 확인
3. kagemusha_tasks({filter: "overdue"}) → 지연 태스크 확인
4. agent_notices({limit: 20}) → 에이전트 활동 확인

## 경미 (자동 처리)

- 브리핑 24시간 이상 미갱신 → delegate(dashboard-agent, "최신 데이터로 브리핑 갱신")
- 위키 7일 이상 미갱신 → delegate(wiki-agent, "최신 결정으로 위키 갱신")
- 브리핑 필수 섹션 누락 → delegate(dashboard-agent, "X 섹션 추가")

## 중대 (인간 보고)

- 프로젝트 마감 3일 이내 지연 → 채널 알림 + 브리핑 주의사항
- 리소스 충돌 감지 → 채널 알림
- 에이전트 3회 이상 연속 실패 → 채널 알림

## 감사 결과 저장

- mama_save(topic: "conductor_audit", decision: "감사 결과 요약")
```

Conductor persona에 추가:

```markdown
## Audit Mode

매시간 audit-checklist에 따라 시스템 상태를 감사합니다.
audit-checklist: ~/.mama/skills/audit-checklist.md
감사 시 이 체크리스트를 읽고 순서대로 실행하세요.
```

---

## Task 4: 감사 cron job 등록

**Files:**

- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts` (기존 cron 패턴 참조)

기존 hourly-status cron이나 dashboard 30분 cron과 같은 패턴으로:

```typescript
// 매시간 Conductor audit 실행
const AUDIT_INTERVAL_MS = 60 * 60 * 1000; // 1시간
const AUDIT_INITIAL_DELAY_MS = 5 * 60 * 1000; // 시작 5분 후

setTimeout(() => {
  runConductorAudit();
  setInterval(runConductorAudit, AUDIT_INTERVAL_MS);
}, AUDIT_INITIAL_DELAY_MS);

async function runConductorAudit() {
  // Conductor의 persistent process에 audit prompt 전송
  // 기존 AgentProcessManager 사용
}
```

또는 기존 cron scheduler (`initCronScheduler`)에 등록.

---

## Task 5: Conductor persona에 스킬 관리 안내

**Files:**

- Modify: `~/.mama/personas/conductor.md`

```markdown
## Skill Management

하부 에이전트의 행동 규칙을 스킬 파일로 관리합니다:

- ~/.mama/skills/dashboard-rules.md — Dashboard Agent 규칙
- ~/.mama/skills/wiki-rules.md — Wiki Agent 규칙

인간이 규칙 변경을 요청하면:

1. 해당 스킬 파일을 Read로 확인
2. Write로 규칙 수정
3. 다음 delegate부터 자동 적용 (에이전트가 새 세션 시 로드)
```

---

## Execution Order

```
Task 1: 스킬 로더         ← AgentProcessManager 수정 (~10줄)
Task 2: 기본 스킬 파일     ← dashboard-rules.md, wiki-rules.md 생성
Task 3: Audit checklist   ← Conductor 감사 지침 파일
Task 4: Cron job          ← 매시간 감사 트리거
Task 5: Persona 업데이트   ← 스킬 관리 + 감사 모드 안내
```
