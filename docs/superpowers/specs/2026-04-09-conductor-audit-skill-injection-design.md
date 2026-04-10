# Conductor 감사 루프 + 스킬 주입 시스템 설계

## Goal

Conductor를 감독자로 확장: 매시간 자동 감사 + 문제 시 경중 분기(자동 수정 vs 인간 보고) + 스킬 파일로 하부 에이전트에 세부지침 주입.

## 원칙

- 인간은 Conductor와만 소통. 하부 에이전트와 직접 소통 없음.
- Conductor는 실행자가 아니라 감독자. 직접 수정하지 않고 delegate로 지시.
- 스킬은 파일 기반. 새 세션에서도 하부 에이전트가 자동 로드.

## 구조

```
매시간 cron → Conductor audit prompt 실행
  │
  ├── mama_search("dashboard_briefing") → 브리핑 상태
  ├── mama_search("wiki_compilation")   → 위키 상태
  ├── kagemusha_tasks({filter:"overdue"}) → 프로젝트 태스크
  ├── agent_notices({limit: 20})        → 에이전트 활동
  │
  ├── 경미: delegate(agent, "수정해") 자동 처리
  ├── 중대: 채널 알림 + 브리핑에 포함
  │
  └── mama_save(topic: "conductor_audit") → 감사 기록
```

## 스킬 파일 시스템

```
~/.mama/skills/
  ├── dashboard-rules.md     ← Dashboard Agent용
  ├── wiki-rules.md          ← Wiki Agent용
  ├── developer-rules.md     ← Developer Agent용
  └── audit-checklist.md     ← Conductor 자신용
```

- Conductor가 Write 도구로 생성/수정
- AgentProcessManager.loadPersona()에서 자동 append
- 인간: "브리핑 규칙 바꿔" → Conductor가 스킬 파일 수정

## 스킬 로드 흐름

```
AgentProcessManager.loadPersona(agentId)
  1. persona_file 로드 (~/.mama/personas/{agent}.md)
  2. ~/.mama/skills/{agentId}-rules.md 존재하면 append
  3. 결합된 시스템 프롬프트 반환
```

## 감사 경중 분기

### 자동 처리 (경미)

- 브리핑에 필수 섹션 누락
- 위키 페이지 형식 미준수
- 오래된 데이터 (7일+)

### 인간 보고 (중대)

- 프로젝트 마감 3일 이내 지연
- 리소스 충돌
- 에이전트 crash 3회 이상

## 감사 보고

- 중대: 채널 알림 (discord_send/slack_send/telegram_send) + 브리핑 주의사항 섹션
- 경미: 자동 수정 후 감사 기록만 (memory)

## 구현 범위

1. AgentProcessManager.loadPersona()에 스킬 파일 로드 추가
2. 기본 스킬 파일 생성 (dashboard-rules.md, wiki-rules.md)
3. Conductor audit prompt 작성
4. 감사 cron job 등록 (매시간)
5. Conductor persona에 경중 판단 기준 + 스킬 관리 안내 추가
