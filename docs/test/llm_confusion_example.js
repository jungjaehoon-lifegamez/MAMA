/**
 * LLM Confusion Scenario: 자동링크로 인한 실제 피해 사례
 */

// ============================================================================
// Scenario: 재훈이 6개월 후 SpineLift 최적화 질문
// ============================================================================

console.log('═══════════════════════════════════════════════════════════════');
console.log('SCENARIO: 6개월 후, 재훈이 SpineLift 성능 최적화 질문');
console.log('═══════════════════════════════════════════════════════════════\n');

const conversation = `
재훈: "SpineLift의 mesh generation이 느린데, 우리가 WebAssembly로 갈지 
      Node.js로 갈지 결정한 적 있었나?"

Claude (with MAMA v1.1 automatic links):
"Let me search your decision history...

[Finds memory_42: "Use WebAssembly for mesh generation"]
[Loads linked context: 35 links]

I found a decision about mesh generation. Let me check the related context...

Based on the connected decisions, I see several considerations:

1. **Authentication Strategy**: You chose JWT for stateless architecture 
   [⚠️ IRRELEVANT - 하지만 semantic similarity 0.82로 링크됨]

2. **Frontend Framework**: React was selected for component reusability
   [⚠️ IRRELEVANT - temporal link (같은 날 결정)]

3. **Database Choice**: PostgreSQL for JSONB support
   [⚠️ IRRELEVANT - semantic link (둘 다 '기술 선택'이라는 구조)]

4. **WebAssembly Decision**: For performance-critical mesh generation
   [✅ RELEVANT]

Looking at these connected contexts, the WebAssembly decision seems related 
to your authentication and database choices... 
[❌ 완전히 틀린 연관성]

However, I also see decisions about Railway deployment that might affect 
performance...
[⚠️ TANGENT - 관련 있긴 한데 질문과 직접 무관]

Let me also check... [계속 무관한 context 탐색]
"

재훈: "...뭔 소리야? 그냥 WebAssembly 결정만 보여줘."
`;

console.log(conversation);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('PROBLEM ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('1. NOISE CONTAMINATION');
console.log('   - 1개의 relevant decision을 찾았지만');
console.log('   - 35개의 linked context가 자동으로 로드됨');
console.log('   - 그 중 27개(77%)가 실제로는 무관한 내용\n');

console.log('2. LLM BEHAVIOR DEGRADATION');
console.log('   - 명확한 답변 대신 "Let me check..." 반복');
console.log('   - 무관한 context를 "연관성 있다"고 착각');
console.log('   - 답변 길이 3배 증가 (noise 때문에 불확실)\n');

console.log('3. USER FRUSTRATION');
console.log('   - "그냥 결정만 보여줘" ← 짜증');
console.log('   - MAMA에 대한 신뢰 하락');
console.log('   - 결국 수동으로 파일 찾아서 읽음\n');

console.log('═══════════════════════════════════════════════════════════════');
console.log('ROOT CAUSE: Automatic Links');
console.log('═══════════════════════════════════════════════════════════════\n');

const rootCauses = [
  {
    link: 'WebAssembly decision ↔ JWT decision',
    rule: 'semantic_similarity',
    confidence: 0.82,
    reason: '둘 다 "기술 선택 decision"이라는 구조적 유사성',
    relevance: '❌ ZERO - 완전히 다른 영역',
  },
  {
    link: 'WebAssembly decision ↔ React decision',
    rule: 'temporal_proximity',
    confidence: 0.45,
    reason: '같은 날 작성됨 (3시간 차이)',
    relevance: '❌ ZERO - 시간상 가깝지만 무관',
  },
  {
    link: 'WebAssembly decision ↔ PostgreSQL decision',
    rule: 'semantic_similarity',
    confidence: 0.78,
    reason: '"성능"이라는 단어가 둘 다 있음',
    relevance: '🟡 WEAK - 단어만 공유, 실제 관련 없음',
  },
  {
    link: 'WebAssembly decision ↔ Railway deployment',
    rule: 'same_topic (deployment)',
    confidence: 0.6,
    reason: '둘 다 "배포" 카테고리',
    relevance: '🟡 MEDIUM - 관련 있지만 질문과 무관',
  },
];

rootCauses.forEach((cause, i) => {
  console.log(`${i + 1}. ${cause.link}`);
  console.log(`   Rule: ${cause.rule}`);
  console.log(`   Confidence: ${cause.confidence}`);
  console.log(`   Why linked: ${cause.reason}`);
  console.log(`   Actual relevance: ${cause.relevance}\n`);
});

console.log('═══════════════════════════════════════════════════════════════');
console.log('COMPARISON: Without Automatic Links');
console.log('═══════════════════════════════════════════════════════════════\n');

const betterConversation = `
재훈: "SpineLift의 mesh generation이 느린데, 우리가 WebAssembly로 갈지 
      Node.js로 갈지 결정한 적 있었나?"

Claude (with MAMA v1.0 - no automatic links):
"Yes, I found a decision about mesh generation:

**Decision (2025-05-15)**: Use WebAssembly for mesh generation
- **Reasoning**: Performance-critical operation, need near-native speed
- **Outcome**: SUCCESS - 5x faster than pure JS
- **Implementation**: src/core/mesh-generator.wasm

You implemented this in May and it's been working well. Are you seeing 
performance issues now? What's the specific bottleneck?"
`;

console.log(betterConversation);

console.log('\n✅ CLEAN RESPONSE:');
console.log('   - Direct answer from the exact relevant decision');
console.log('   - No noise from unrelated topics');
console.log('   - LLM maintains confidence in answer');
console.log('   - User gets answer immediately\n');

console.log('═══════════════════════════════════════════════════════════════');
console.log('KEY INSIGHT');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('자동링크가 제공하는 "추가 context"는:');
console.log('  ❌ LLM을 더 똑똑하게 만들지 않음');
console.log('  ❌ 오히려 혼란을 가중시킴');
console.log('  ❌ 답변 품질을 저하시킴\n');

console.log('LLM이 신뢰하는 건:');
console.log('  ✅ 명확한 reasoning (왜 결정했는가)');
console.log('  ✅ Explicit relationships (supersedes, implements)');
console.log('  ✅ Outcome data (무엇이 작동했고 무엇이 실패했는가)\n');

console.log('자동링크는 "더 많은 정보"를 주지만,');
console.log('"더 나은 정보"를 주지는 못함.\n');

console.log('═══════════════════════════════════════════════════════════════\n');
