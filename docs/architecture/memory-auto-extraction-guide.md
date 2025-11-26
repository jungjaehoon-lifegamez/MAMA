# 메모리 시스템 자동 추출 구현 가이드

## 핵심 통찰

메모리 시스템에서 **자동 추출**이 제일 어렵고 중요한 부분입니다.

```
임베딩 모델: 텍스트 → 벡터 (검색용)
추출 모델: 긴 대화 → 핵심 정보 (이해용)
```

- **임베딩 모델이 좋아야** → 검색이 정확
- **추출 모델이 좋아야** → 저장할 게 의미 있음

---

## Anthropic의 방식 (추측)

Claude의 메모리 시스템이 작동하는 방식:

```
[대화 종료]
     ↓
[백그라운드 LLM 호출]
     ↓
Prompt: "이 대화에서 사용자에 대해 기억할 만한 것들을 추출해줘:
- 직업/프로젝트
- 관심사/취향
- 진행 중인 작업
- 중요한 결정
- Context가 필요한 정보"
     ↓
[구조화된 데이터로 반환]
     ↓
[기존 메모리와 병합/업데이트]
```

**핵심:** LLM이 직접 추출합니다.
별도 특화 모델이 아니라 **Claude 자신이 자신의 대화를 분석**

### 속도 분해

```
1. 메모리 검색: 10-50ms (Vector DB)
2. LLM 추론: 500-2000ms (모델 처리)
3. 응답 생성: streaming으로 즉시 출력

총 시간: 대부분 LLM 추론
메모리 검색은 무시할 수준
```

**Anthropic의 이점:**

- Embedding 서버가 메모리에 상주
- 최적화된 vector DB (아마 맞춤 제작)
- 인프라 규모로 해결

---

## 개인이 구현 가능한 4가지 방법

### 방법 1: LLM 기반 완전 자동 추출

**가장 간단하지만 비용 발생**

```typescript
// MAMA에 추가 가능
async function autoExtractFromChat(chatHistory: Message[]) {
  const prompt = `
다음 대화에서 향후 협업에 도움될 정보를 추출해줘.

대화:
${chatHistory.map((m) => `${m.role}: ${m.content}`).join('\n')}

다음 형식으로 JSON 반환:
{
  "decisions": [
    {
      "topic": "...",
      "decision": "...",
      "reasoning": "...",
      "confidence": 0.8
    }
  ],
  "context": {
    "project_updates": "...",
    "open_questions": "...",
    "next_steps": "..."
  }
}
`;

  const result = await callClaude(prompt);
  return JSON.parse(result);
}

// 세션 종료 시 자동 호출
await autoExtractFromChat(currentSession);
// → MAMA에 자동 저장
```

**장점:**

- 구현 간단
- Claude API로 가능
- 품질 높음

**단점:**

- API 비용 (대화당 ~$0.01-0.05)
- 속도 (2-5초)

---

### 방법 2: Semi-automatic (가장 현실적)

**사용자가 중요한 순간에 표시 - ChatGPT "memory" 방식**

```typescript
// 자연어 저장 명령
User: "기억해줘: SpineLift MCP는 MAMA 엔진을 bone mapping에 적용"

Claude:
"저장할까요?
- Topic: spinelift_mcp
- Decision: MAMA 엔진을 bone mapping 도메인에 적용
- Reasoning: CoT few-shot + semantic search 패턴 재사용

[확인/수정]"
```

**구현 예시:**

```typescript
// mama-nlp-save.ts
async function naturalLanguageSave(userMessage: string) {
  // "기억해줘:", "저장해줘:", "remember:" 감지
  const savePattern = /(기억해줘|저장해줘|remember)[:：]\s*(.+)/i;
  const match = userMessage.match(savePattern);

  if (!match) return null;

  const content = match[2];

  // LLM으로 구조화
  const structured = await callLLM(`
다음 내용을 decision 형식으로 구조화해줘:
"${content}"

JSON 반환:
{
  "topic": "...",
  "decision": "...",
  "reasoning": "...",
  "confidence": 0.0-1.0
}
`);

  // 사용자 확인
  return {
    ...structured,
    needsConfirmation: true,
  };
}
```

**장점:**

- 사용자가 중요도 판단
- 품질 보장
- 비용 낮음 (선택적 호출)

**단점:**

- 수동 개입 필요
- 놓칠 수 있음

---

### 방법 3: 점진적 자동화 (⭐ 추천)

**패턴 감지 + 선택적 LLM 추출**

```typescript
// 1단계: 패턴 감지 (규칙 기반 - 무료)
function detectDecisionPatterns(messages: Message[]) {
  const patterns = {
    decision: /decided to|결정했다|하기로 했다|선택했다/i,
    change: /changed from.*to|바꿨다|변경했다/i,
    failure: /failed because|실패했다.*왜냐하면|망했다/i,
    insight: /learned that|배웠다|알게 됐다|깨달았다/i,
    comparison: /better than|worse than|더 좋다|안 좋다/i,
  };

  const candidates = [];

  for (const msg of messages) {
    for (const [type, pattern] of Object.entries(patterns)) {
      if (pattern.test(msg.content)) {
        candidates.push({
          message: msg,
          type: type,
          excerpt: extractContext(msg.content, pattern),
        });
      }
    }
  }

  return candidates;
}

// 2단계: LLM 추출 (감지된 것만 - 비용 효율적)
const candidates = detectDecisionPatterns(chatHistory);

for (const candidate of candidates) {
  const extraction = await extractDecision(candidate);

  if (extraction.confidence > 0.8) {
    // 자동 저장
    await mama.save(extraction);
  } else {
    // 사용자 확인 요청
    suggestForReview(extraction);
  }
}
```

**전체 구현:**

```typescript
// mama-auto-extract.ts

export class AutoExtractor {
  private patterns = {
    decision: /decided|결정|선택했다/i,
    failure: /failed|실패|망했다/i,
    insight: /learned|배웠다|깨달았다/i,
    change: /changed|바꿨다|변경했다/i,
  };

  async analyzeSession(messages: Message[]) {
    // 1. 패턴 기반 후보 찾기
    const candidates = this.findCandidates(messages);

    // 2. LLM으로 구조화
    const extractions = await Promise.all(candidates.map((c) => this.extractStructured(c)));

    // 3. 중복 제거
    const deduplicated = await this.removeDuplicates(extractions);

    // 4. confidence로 분류
    return {
      auto: deduplicated.filter((e) => e.confidence > 0.8),
      review: deduplicated.filter((e) => e.confidence <= 0.8),
    };
  }

  private findCandidates(messages: Message[]) {
    return messages.filter((m) => Object.values(this.patterns).some((p) => p.test(m.content)));
  }

  private async extractStructured(message: Message) {
    const prompt = `
이 메시지에서 decision/insight 추출:
"${message.content}"

JSON 반환:
{
  "type": "decision|insight|change|failure",
  "topic": "...",
  "summary": "...",
  "reasoning": "...",
  "confidence": 0.0-1.0
}

confidence 기준:
- 0.9+: 명확한 결정/통찰
- 0.7-0.9: 중요하지만 확인 필요
- 0.7 미만: 애매함
`;

    return await callLLM(prompt);
  }

  private async removeDuplicates(extractions: Extraction[]) {
    const unique = [];

    for (const ext of extractions) {
      // 기존 메모리와 유사도 체크
      const similar = await mama.suggest_decision(ext.summary);

      if (similar.length === 0 || similar[0].score < 0.9) {
        unique.push(ext);
      } else {
        // 업데이트 제안
        ext.suggestedAction = 'update_existing';
        ext.existingId = similar[0].id;
        unique.push(ext);
      }
    }

    return unique;
  }
}
```

**사용 예시:**

```typescript
// 세션 종료 시
const extractor = new AutoExtractor();
const results = await extractor.analyzeSession(chatHistory);

// 높은 confidence → 자동 저장
console.log(`자동 저장: ${results.auto.length}개`);
for (const item of results.auto) {
  await mama.save(item);
}

// 낮은 confidence → 사용자 확인
console.log(`확인 필요: ${results.review.length}개`);
for (const item of results.review) {
  await requestUserConfirmation(item);
}
```

**장점:**

- 비용 효율적 (전체 대화가 아닌 일부만 LLM 처리)
- 중요한 것 놓치지 않음
- 품질 유지
- 점진적으로 패턴 개선 가능

**단점:**

- 패턴 유지보수 필요
- 초기 설정 시간 필요

---

### 방법 4: 중복 감지 시스템

**새 저장 전에 유사한 게 있는지 체크**

```typescript
async function checkDuplicate(newDecision: Decision) {
  const similar = await mama.suggest_decision(newDecision.decision);

  if (similar.length > 0 && similar[0].score > 0.9) {
    // 이미 비슷한 게 있음
    return {
      isDuplicate: true,
      existing: similar[0],
      suggestion: determineSuggestion(newDecision, similar[0]),
    };
  }

  return { isDuplicate: false };
}

function determineSuggestion(newDec: Decision, existing: Decision) {
  // 시간 비교
  const isNewer = newDec.timestamp > existing.timestamp;

  // 내용 비교
  const hasNewInfo = containsNewInformation(newDec, existing);

  if (isNewer && hasNewInfo) {
    return 'supersede'; // 새 결정이 이전 결정을 대체
  } else if (hasNewInfo) {
    return 'update'; // 기존 결정에 정보 추가
  } else {
    return 'skip'; // 중복이므로 저장 안 함
  }
}
```

**통합 워크플로우:**

```typescript
async function smartSave(decision: Decision) {
  // 1. 중복 체크
  const dupCheck = await checkDuplicate(decision);

  if (dupCheck.isDuplicate) {
    switch (dupCheck.suggestion) {
      case 'supersede':
        await mama.save({
          ...decision,
          supersedes: dupCheck.existing.id,
        });
        break;

      case 'update':
        await mama.update({
          id: dupCheck.existing.id,
          additionalInfo: decision.reasoning,
        });
        break;

      case 'skip':
        console.log('이미 저장된 내용입니다.');
        return;
    }
  } else {
    // 신규 저장
    await mama.save(decision);
  }
}
```

**장점:**

- 중복 저장 방지
- 메모리 효율
- 자동 supersede 관계 생성

---

## 임베딩 vs 추출의 차이

### 임베딩의 역할: 검색

```
저장:
"SpineLift MCP는 MAMA 엔진을 재사용한다"
     ↓
[임베딩 모델] → [0.123, -0.456, 0.789, ...]
     ↓
[Vector DB 저장]

검색:
"bone mapping 어떻게?"
     ↓
[임베딩 모델] → [0.145, -0.423, 0.801, ...]
     ↓
[유사도 계산] → SpineLift 관련 decision 반환
```

**좋은 임베딩 모델:**

- `text-embedding-3-large` (OpenAI) ⭐ MAMA 현재 사용
- `voyage-02` (Voyage AI)
- `bge-large` (오픈소스)

**MAMA 실적:** 84% 정확도 (이미 충분히 좋음)

### 추출의 역할: 의미 파악

```
긴 대화:
"처음엔 규칙 기반으로 했다가 케이스가 많아지면서 망했고,
그 다음엔 단순 임베딩으로 했다가 왜 매핑되는지 설명 못해서 망했어요.
결국 경험과 reasoning을 저장하는 방향으로 갔어요."
     ↓
[추출 LLM]
     ↓
{
  topic: "spinelift_architecture_evolution",
  decision: "Reasoning 기반 매핑 시스템 채택",
  reasoning: "규칙 기반은 확장성 문제, 단순 임베딩은 설명 불가.
              경험 + reasoning 저장이 해결책",
  failures: ["규칙 기반 확장성", "임베딩 설명 불가"],
  confidence: 0.95
}
```

**핵심 차이:**

- 임베딩: 이미 있는 텍스트를 벡터로
- 추출: 대화에서 의미있는 것 찾아서 구조화

---

## 비용 계산

### Full LLM 자동 추출

```
대화당 입력 토큰: ~5,000
추출 출력 토큰: ~1,000
비용 (Claude Haiku): $0.03/대화

월 사용량:
- 100 대화 → $3
- 1,000 대화 → $30
```

### 패턴 기반 + 선택적 LLM (추천)

```
패턴 감지: 무료 (규칙 기반)
LLM 호출: 30% 대화만 (패턴 감지된 경우)
비용: $0.01/대화

월 사용량:
- 100 대화 → $1
- 1,000 대화 → $10
```

**개인 사용은 충분히 감당 가능**

---

## MAMA 로드맵

### MAMA v1.1 (현재)

```typescript
// 수동 저장
await mama.save({
  type: 'decision',
  topic: '...',
  decision: '...',
  reasoning: '...',
});
```

**특징:**

- 명시적 `mama:save` 호출
- 사용자가 직접 구조화
- 100% 정확도, 0 비용

---

### MAMA v1.2 (다음 단계)

```typescript
// 자연어 저장
User: "기억해줘: SpineLift MCP는 MAMA 엔진 재사용"

Claude: [자동 구조화]
"저장할까요?
- Topic: spinelift_mcp
- Decision: ...
[확인/수정]"

// 패턴 기반 제안
Claude: "이 대화에서 중요한 결정이 있었던 것 같은데, 저장할까요?"
User: "응, 저장해줘"
```

**추가 기능:**

- `mama:suggest-extraction` 도구
- 자연어 저장 명령 인식
- 대화 중 실시간 제안

**구현:**

```typescript
// mama-tools-v1.2.ts

{
  name: "mama:suggest_extraction",
  description: "현재 대화에서 저장 가능한 decision/insight 제안",
  inputSchema: {
    threshold: "confidence threshold (default: 0.7)"
  }
}
```

---

### MAMA v2.0 (미래)

```typescript
// 완전 자동 추출
세션 종료 시:
     ↓
자동 분석 (백그라운드)
     ↓
High confidence (0.8+) → 자동 저장
     ↓
Low confidence (0.5-0.8) → 다음 세션 시작 시 확인 요청
```

**워크플로우:**

```
[채팅 종료]
     ↓
[백그라운드 분석]
     ↓
패턴 감지 → 30% 메시지에서 후보 발견
     ↓
LLM 추출 → 구조화 + confidence 계산
     ↓
High confidence:
  - 자동 저장
  - 알림: "3개 decision 저장됨"

Low confidence:
  - 대기열에 추가
  - 다음 세션: "지난번 대화에서 2개 제안 있어요"
```

**추가 기능:**

- 백그라운드 처리
- 스마트 중복 제거
- Supersede 관계 자동 추론
- 주기적 메모리 정리

---

## 실전 구현 팁

### 1. 시작은 간단하게

```typescript
// Step 1: 자연어 저장만 추가
if (message.includes('기억해줘:')) {
  const content = extractAfterKeyword(message, '기억해줘:');
  await naturalLanguageSave(content);
}
```

### 2. 점진적으로 패턴 추가

```typescript
// 처음엔 명확한 패턴만
const patterns = [/결정했다/, /하기로 했다/];

// 점점 확장
patterns.push(/바꿨다/, /실패했다/, /배웠다/);
```

### 3. Confidence 조정

```typescript
// 초기엔 보수적으로
const AUTO_SAVE_THRESHOLD = 0.9; // 매우 확실할 때만

// 사용하면서 조정
const AUTO_SAVE_THRESHOLD = 0.8; // 정확도 확인 후
```

### 4. 비용 모니터링

```typescript
// 추출 비용 추적
let extractionCost = 0;

async function trackedExtraction(content: string) {
  const tokens = estimateTokens(content);
  const cost = calculateCost(tokens);
  extractionCost += cost;

  return await extract(content);
}

// 주기적 리포트
console.log(`이번 달 추출 비용: $${extractionCost}`);
```

---

## 결론

**개인이 충분히 구현 가능합니다!**

### 추천 순서:

1. **v1.2 자연어 저장** (1-2일)
   - "기억해줘:" 키워드 인식
   - LLM 구조화
   - 사용자 확인

2. **패턴 감지** (3-5일)
   - 기본 패턴 정의
   - 후보 추출
   - confidence 계산

3. **중복 방지** (2-3일)
   - 유사도 체크
   - 자동 supersede

4. **백그라운드 처리** (1주)
   - 세션 종료 시 분석
   - 다음 세션 제안

### 핵심 원칙:

- **완벽보다 실용성**
  - Anthropic의 100% 자동을 목표로 하지 말고
  - 90% 자동 + 10% 확인을 목표로

- **비용 효율성**
  - 전체 대화가 아닌 패턴 감지된 부분만 LLM 처리
  - Haiku 모델 사용 ($0.01/대화)

- **점진적 개선**
  - 처음엔 간단하게
  - 사용하면서 패턴 추가
  - 데이터로 개선

---

## 다음 단계

MAMA v1.2 프로토타입 만들어보시겠어요?

필요한 것:

1. 자연어 저장 파서
2. LLM 구조화 프롬프트
3. Confidence 기반 워크플로우

코드 예시 드릴까요?
