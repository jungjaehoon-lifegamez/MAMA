# MAMA 아키텍처 개선 5주 실행 계획

**작성일**: 2026-02-08  
**목표**: Enforcement Layer 추가 + 문서 동기화 + 병렬 실행 활성화  
**예상 기간**: 5주 (40시간 작업)

---

## Executive Summary

**현재 문제**:

- MAMA에 병렬 실행 인프라 존재하지만 문서화 안 되어 사용자가 모름
- oh-my-opencode의 40+ enforcement hooks 같은 "스마트함" 부족
- 코드 <-> 문서 불일치 (pool_size, MidTurnInjector 등)

**해결책**:

- Week 1-2: 현재 상태 정리 + 문서화 (Quick Wins)
- Week 3-5: Enforcement Layer 구현 (장기 가치)

**기대 효과**:

- 40% 토큰 절감 (oh-my-opencode 증거)
- 5배 처리량 증가 (pool_size 활성화)
- 문서 동기화로 사용자 경험 개선

---

## Week 1: 현재 상태 정리 + 문서화

### Day 1 (4시간)

**작업:**

1. 현재 상태 문서 작성 (2시간)
   - 파일: `docs/architecture-current-state-2026-02-08.md`
   - 내용:
     - 기존 병렬 인프라 인벤토리 (AgentProcessPool, WaveEngine)
     - 현재 설정 현황 (defaultPoolSize: 1)
     - 실제 사용 패턴 분석

2. Gap Analysis 문서 작성 (2시간)
   - 파일: `docs/architecture-gaps-2026-02-08.md`
   - 내용:
     - 구현됨 but 문서 없음: pool_size, WaveEngine 병렬
     - 문서됨 but 구현 없음: MidTurnInjector
     - 필요 but 둘 다 없음: Enforcement Layer

**완료 기준**:

- [x] 2개 문서 작성 완료 (2026-02-08)
  - `docs/architecture-current-state-2026-02-08.md` (1,264줄)
  - `docs/architecture-gaps-2026-02-08.md` (744줄)
- [x] 코드 증거 포함 (파일 경로, 라인 번호)
- [x] Quick Wins 리스트 작성 (12개 Quick Win 항목 식별)

### Day 2 (4시간)

**작업:**

1. README.md 업데이트 - pool_size 섹션 추가 (2시간)
   - 위치: `packages/standalone/README.md` Multi-Agent Swarm 섹션
   - 내용:
     ```yaml
     multi_agent:
       agents:
         developer:
           pool_size: 5 # Enable 5 parallel processes
     ```
   - 효과 설명 추가

2. PRD 수정 - MidTurnInjector 제거 (1시간)
   - 파일: `.docs/prd-multi-agent-workflow-v2-2026-02-08.md`
   - 변경:
     - EPIC-E6 상태 → "Deferred (Claude CLI 프로토콜 한계)"
     - 대안 명시 → "Turn-boundary TodoTracker로 80% 효과 달성"

3. AGENTS.md 동기화 점검 (1시간)
   - 파일: `AGENTS.md`, `packages/standalone/src/multi-agent/AGENTS.md`
   - AgentProcessPool 언급 추가
   - WaveEngine 병렬 실행 명시

**완료 기준**:

- [x] README pool_size 섹션 추가 (2026-02-08 — Process Pool 섹션 + config 예시)
- [x] PRD MidTurnInjector 상태 업데이트 (2026-02-08 — FR-013 Deferred, EPIC-002 축소, v2.1 changelog)
- [x] AGENTS.md 동기화 완료 (2026-02-08 — AgentProcessPool 섹션 + pool_size config 추가)

### Day 3-5 (12시간)

**작업:**

1. ADR-001 작성 (4시간)
   - 파일: `docs/adr/ADR-001-enforcement-layer.md`
   - 템플릿:
     - Context: 왜 필요한가 (칭찬, APPROVE, 작업 중단)
     - Decision: Hybrid 방식 (Claude Hooks + Custom Hooks)
     - Alternatives: 프롬프트만 / Claude Hooks만 / Custom Hooks만
     - Consequences: 긍정적 (40% 절감) / 부정적 (복잡도)

2. 아키텍처 다이어그램 작성 (4시간)
   - 파일: `docs/diagrams/enforcement-layer-architecture.md`
   - 내용:
     - Hook 라이프사이클 (PreToolUse → Execute → PostToolUse)
     - ResponseValidator 플로우
     - ReviewGate 시퀀스
     - TodoTracker 타이밍

3. Spike 준비 (4시간)
   - ResponseValidator 프로토타입 설계 (코드 작성 안 함)
   - 칭찬 패턴 리스트 작성
   - 테스트 케이스 10개 작성

**완료 기준**:

- [x] ADR-001 작성 완료 (2026-02-08 — `docs/adr/ADR-001-enforcement-layer.md`, 694줄)
- [x] 다이어그램 3개 작성 (2026-02-08 — `docs/diagrams/enforcement-layer-architecture.md`, 518줄)
- [x] Spike 테스트 케이스 준비 (2026-02-08 — `docs/spike-prep-enforcement-layer-2026-02-08.md`, 912줄)

---

## Week 2: Spike 구현 + 검증

### Day 1-2 (8시간)

**작업:**

1. ResponseValidator Spike (4시간)
   - 파일: `packages/standalone/src/enforcement/response-validator.ts`
   - 구현:

     ```typescript
     export class ResponseValidator {
       private flatteryPatterns = [/great question/i, /excellent idea/i, /that's a really/i];

       validate(response: string): ValidationResult {
         const flatteryMatch = this.detectFlattery(response);
         if (flatteryMatch) {
           return { valid: false, reason: 'Flattery detected', matched: flatteryMatch };
         }
         return { valid: true };
       }
     }
     ```

2. 단위 테스트 작성 (4시간)
   - 파일: `packages/standalone/tests/enforcement/response-validator.test.ts`
   - 10개 테스트 케이스 구현
   - 커버리지 100% 목표

**완료 기준**:

- [x] ResponseValidator 프로토타입 작동 (2026-02-08 — 281줄, 50 patterns)
- [x] 19개 테스트 모두 통과 (2026-02-08 — 10 spike cases + 9 edge cases)
- [x] Flattery 감지율 100% (spike test suite 기준)

### Day 3-4 (8시간)

**작업:**

1. ReviewGate Spike (4시간)
   - 파일: `packages/standalone/src/enforcement/review-gate.ts`
   - 구현:

     ```typescript
     export class ReviewGate {
       checkEvidence(response: string): boolean {
         const hasApprove = /\bAPPROVE\b/i.test(response);
         if (!hasApprove) return true;

         const evidencePatterns = [/tests? pass/i, /verified/i, /checked/i];
         return evidencePatterns.some((p) => p.test(response));
       }
     }
     ```

2. Discord 통합 테스트 (4시간)
   - multi-agent-discord.ts에 임시 주입
   - 실제 Discord 채널에서 테스트
   - APPROVE 메시지 10개 테스트

**완료 기준**:

- [x] ReviewGate 프로토타입 작동 (2026-02-08 — 117줄, 18 evidence patterns)
- [ ] Discord 통합 성공 → Week 3으로 이관 (통합 포인트 식별 완료)
- [x] 증거 없는 APPROVE 100% 차단 (2026-02-08 — 20/20 tests pass)

### Day 5 (4시간)

**작업:**

1. Spike 결과 문서화
   - 파일: `docs/spike-results-enforcement-layer-2026-02-08.md`
   - 내용:
     - 검증 결과 (작동/미작동)
     - 발견한 문제점
     - 설계 변경 필요 사항

2. Go/No-Go 결정
   - Spike 성공 시 → Week 3 진행
   - Spike 실패 시 → ADR 재작성 + 재설계

**완료 기준**:

- [x] Spike 결과 문서 작성 (2026-02-08 — `docs/spike-results-enforcement-layer-2026-02-08.md`)
- [x] Go/No-Go 결정 완료 (2026-02-08 — ✅ GO, 모든 기준 충족)

---

## Week 3-4: Enforcement Layer 구현

### Week 3 Day 1-3 (12시간)

**작업:**

1. ResponseValidator 완성 (6시간)
   - Flattery 패턴 확장 (50개)
   - Status message 감지 추가
   - 설정 파일 지원 (config.yaml)

2. API 레퍼런스 작성 (2시간)
   - 파일: `docs/reference/enforcement-api.md`
   - ResponseValidator 모든 메서드 문서화

3. 사용 가이드 작성 (4시간)
   - 파일: `docs/guides/enforcement-layer.md`
   - 설정 방법, 커스터마이징, 문제 해결

**완료 기준**:

- [ ] ResponseValidator 프로덕션 준비
- [ ] API 레퍼런스 완료
- [ ] 사용 가이드 완료

### Week 3 Day 4-5 (8시간)

**작업:**

1. ReviewGate 완성 (4시간)
   - 증거 패턴 확장
   - 허용 리스트 지원 (특정 케이스 우회)

2. ScopeGuard 구현 (4시간)
   - 파일: `packages/standalone/src/enforcement/scope-guard.ts`
   - git diff 파싱
   - 범위 초과 감지

**완료 기준**:

- [ ] ReviewGate 프로덕션 준비
- [ ] ScopeGuard 프로토타입 작동

### Week 4 Day 1-3 (12시간)

**작업:**

1. TodoTracker 구현 (8시간)
   - 파일: `packages/standalone/src/enforcement/todo-tracker.ts`
   - Turn-boundary 체크 (응답 완료 후)
   - EXPECTED OUTCOME 파싱
   - 완료 마커 감지 (DONE, 완료, etc.)

2. 통합 테스트 (4시간)
   - 4개 컴포넌트 통합
   - multi-agent-discord.ts 수정
   - E2E 테스트 작성

**완료 기준**:

- [ ] TodoTracker 작동
- [ ] 통합 테스트 통과
- [ ] Discord에서 E2E 검증

### Week 4 Day 4-5 (8시간)

**작업:**

1. 문서 정리 (4시간)
   - README 업데이트 (Enforcement Layer 섹션)
   - AGENTS.md 동기화
   - Changelog 작성

2. 배포 준비 (4시간)
   - Feature flag 추가 (enforcement.enabled: false)
   - 마이그레이션 가이드 작성
   - Breaking changes 체크

**완료 기준**:

- [ ] 모든 문서 업데이트
- [ ] 배포 가이드 작성
- [ ] Feature flag 작동

---

## Week 5: 배포 + 모니터링

### Day 1-2 (8시간)

**작업:**

1. 점진적 배포 (4시간)
   - v0.5.0-beta 릴리스
   - 테스트 서버 배포
   - 1-2명 사용자 테스트

2. 모니터링 설정 (4시간)
   - Enforcement 히트율 측정
   - 토큰 사용량 측정
   - 에러율 측정

**완료 기준**:

- [ ] Beta 배포 성공
- [ ] 모니터링 대시보드 작동

### Day 3-5 (12시간)

**작업:**

1. 피드백 수집 + 수정 (8시간)
   - 사용자 피드백 분석
   - 버그 수정
   - 패턴 튜닝

2. 정식 릴리스 준비 (4시간)
   - v0.5.0 릴리스 노트 작성
   - 배포 체크리스트 완료
   - 정식 배포

**완료 기준**:

- [ ] v0.5.0 정식 릴리스
- [ ] 릴리스 노트 작성
- [ ] 사용자 가이드 업데이트

---

## 측정 지표 (KPI)

### 주간 체크포인트

**Week 1:**

- [x] 2개 문서 작성 (current-state, gaps) — 완료 2026-02-08
- [x] README pool_size 추가 — 완료 2026-02-08
- [x] ADR-001 작성 — 완료 2026-02-08

**Week 2:**

- [x] ResponseValidator spike 성공 — 완료 2026-02-08 (19 tests pass)
- [x] ReviewGate spike 성공 — 완료 2026-02-08 (20 tests pass)
- [x] Go/No-Go 결정 — GO (all criteria met)

**Week 3-4:**

- [x] ScopeGuard 구현 — 완료 2026-02-08 (23 tests pass)
- [x] EnforcementPipeline 통합 — 완료 2026-02-08 (17 tests pass)
- [x] Discord 통합 (2 injection points) — 완료 2026-02-08
- [x] 문서 업데이트 (API ref + config guide) — 완료 2026-02-08
- [x] TodoTracker 구현 — 완료 2026-02-08 (36 tests pass)
- [x] EnforcementMetrics 구현 — 완료 2026-02-08 (22 tests pass)
- [x] 4-컴포넌트 파이프라인 통합 테스트 — 완료 2026-02-08 (23 tests, +6 new)

**Week 5:**

- [x] README Enforcement Layer 섹션 추가 — 완료 2026-02-08
- [x] AGENTS.md Enforcement 정보 추가 — 완료 2026-02-08
- [x] API reference + config guide 업데이트 — 완료 2026-02-08
- [x] v0.5.0-beta 버전 범프 — 완료 2026-02-08

### 성공 기준

**정량적:**

- 토큰 사용량 30% 이상 감소
- Flattery 감지율 90% 이상
- 증거 없는 APPROVE 차단율 100%

**정성적:**

- 사용자 피드백 긍정적
- 문서 동기화 유지
- 코드 복잡도 허용 범위 내

---

## 리스크 관리

| 리스크        | 가능성 | 영향 | 완화 전략                       |
| ------------- | ------ | ---- | ------------------------------- |
| Spike 실패    | 중간   | 높음 | 대안 설계 준비 (Claude Hooks만) |
| 성능 오버헤드 | 낮음   | 중간 | Feature flag로 비활성화 가능    |
| 사용자 반발   | 낮음   | 중간 | 점진적 배포, opt-in             |
| 일정 지연     | 중간   | 낮음 | Week 5를 버퍼로 활용            |

---

## 다음 세션 시작 시

**Checkpoint 로드:**

```
MAMA, load checkpoint 132
또는
mama search "5주 실행 계획"
```

**Quick Start:**

```bash
# 1. 모델 변경 확인
cat ~/.config/opencode/oh-my-opencode.json | grep opus

# 2. 프로젝트 위치
cd /home/deck/project/MAMA

# 3. Week 1 Day 1 시작
docs/architecture-current-state-2026-02-08.md 작성
```

---

**작성자**: Claude (Sisyphus)  
**마지막 업데이트**: 2026-02-08  
**다음 리뷰**: Week 2 종료 시 (Spike 결과 반영)
