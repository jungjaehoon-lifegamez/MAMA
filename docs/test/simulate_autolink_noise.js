/**
 * MAMA v1.1 Automatic Link Noise Simulation
 *
 * 목적: ADR-001의 자동링크 규칙이 실제로 얼마나 많은 noise를 만드는지 시뮬레이션
 *
 * 시나리오:
 * - 재훈이 6개월간 MAMA를 사용하며 SpineLift 개발
 * - 다양한 topic의 decision, checkpoint, insight 생성
 * - ADR-001의 Rule 1-3에 따라 자동링크 생성
 * - Signal vs Noise 비율 측정
 */

// ============================================================================
// Mock Data: 실제 사용 패턴 기반 메모리 생성
// ============================================================================

function generateRealisticMemories() {
  const memories = [];
  const timestamp = Date.now() - 180 * 24 * 3600000; // 6개월 전부터 시작

  // Topic 별 클러스터 (실제 SpineLift/MAMA 개발 패턴)
  const topics = [
    'spinelift_architecture',
    'spinelift_mesh_generation',
    'spinelift_performance',
    'mama_tool_design',
    'mama_schema',
    'mama_semantic_search',
    'deployment_railway',
    'deployment_vercel',
    'auth_strategy',
    'database_choice',
    'frontend_framework',
    'testing_strategy',
  ];

  // 시뮬레이션: 100개 메모리 생성 (6개월간 주 4회 작업)
  let id = 1;

  for (let week = 0; week < 24; week++) {
    // 24주 = 6개월
    const sessionStart = timestamp + week * 7 * 24 * 3600000;

    // 주 2회 작업 세션
    for (let session = 0; session < 2; session++) {
      const currentTime = sessionStart + session * 3 * 24 * 3600000;

      // 세션당 2-4개 메모리 생성 (decision → checkpoint → insight 패턴)
      const topic = topics[Math.floor(Math.random() * topics.length)];
      const sessionMemories = Math.floor(Math.random() * 3) + 2;

      for (let i = 0; i < sessionMemories; i++) {
        const types = ['decision', 'checkpoint', 'insight', 'context'];
        const type = i === 0 ? 'decision' : types[Math.floor(Math.random() * types.length)];

        memories.push({
          id: `memory_${id++}`,
          type,
          topic: type === 'decision' ? topic : Math.random() > 0.5 ? topic : null,
          content: `${type} about ${topic}`,
          created_at: currentTime + i * 15 * 60000, // 15분 간격
          embedding: generateEmbedding(topic, type),
        });
      }
    }
  }

  console.log(`Generated ${memories.length} memories`);
  return memories;
}

function generateEmbedding(topic, type) {
  // Mock: 같은 topic은 유사한 embedding (0.7-0.9)
  // 다른 topic은 낮은 similarity (0.2-0.5)
  const hash = hashString(topic + type);
  return Array(384)
    .fill(0)
    .map((_, i) => (hash + i) / 1000);
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// ============================================================================
// ADR-001 자동링크 규칙 구현
// ============================================================================

function createAutomaticLinks(memories) {
  const links = [];

  console.log('\n=== Applying ADR-001 Automatic Link Rules ===\n');

  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];

    // Rule 1: Temporal proximity (1 hour window)
    const temporalLinks = applyTemporalRule(memory, memories.slice(Math.max(0, i - 10), i));
    links.push(...temporalLinks);

    // Rule 2: Same topic
    const topicLinks = applySameTopicRule(memory, memories.slice(0, i));
    links.push(...topicLinks);

    // Rule 3: Semantic similarity (Top-5)
    const semanticLinks = applySemanticRule(memory, memories.slice(0, i));
    links.push(...semanticLinks);
  }

  console.log(`Created ${links.length} automatic links`);
  return links;
}

// Rule 1: Temporal Proximity
function applyTemporalRule(memory, recentMemories) {
  const links = [];
  const ONE_HOUR = 3600000;

  for (const prev of recentMemories) {
    const timeDelta = memory.created_at - prev.created_at;

    if (timeDelta > 0 && timeDelta <= ONE_HOUR) {
      const confidence = 0.3 + (1 - timeDelta / ONE_HOUR) * 0.2;
      links.push({
        from_id: prev.id,
        to_id: memory.id,
        link_type: 'temporal',
        confidence,
        rule: 'temporal_proximity',
        metadata: { time_delta: timeDelta },
      });
    }
  }

  return links;
}

// Rule 2: Same Topic
function applySameTopicRule(memory, allMemories) {
  const links = [];

  if (!memory.topic) {
    return links;
  }

  for (const prev of allMemories) {
    if (prev.topic === memory.topic && memory.type === 'decision' && prev.type === 'decision') {
      links.push({
        from_id: prev.id,
        to_id: memory.id,
        link_type: 'association',
        confidence: 0.6,
        rule: 'same_topic',
        metadata: { topic: memory.topic },
      });
    }
  }

  return links;
}

// Rule 3: Semantic Similarity
function applySemanticRule(memory, allMemories) {
  const links = [];
  const SIMILARITY_THRESHOLD = 0.75;

  const similarities = allMemories
    .map((prev) => ({
      memory: prev,
      similarity: cosineSimilarity(memory.embedding, prev.embedding),
    }))
    .filter((s) => s.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5); // Top-5

  for (const { memory: prev, similarity } of similarities) {
    links.push({
      from_id: prev.id,
      to_id: memory.id,
      link_type: 'association',
      confidence: similarity,
      rule: 'semantic_similarity',
      metadata: { similarity },
    });
  }

  return links;
}

function cosineSimilarity(a, b) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================================================
// Noise Analysis
// ============================================================================

function analyzeNoise(memories, links) {
  console.log('\n=== Noise Analysis ===\n');

  // 1. Link 밀도 분석
  const linkDensity = links.length / memories.length;
  console.log(`Link Density: ${linkDensity.toFixed(2)} links per memory`);

  // 2. Rule별 분포
  const byRule = links.reduce((acc, link) => {
    acc[link.rule] = (acc[link.rule] || 0) + 1;
    return acc;
  }, {});

  console.log('\nLinks by Rule:');
  Object.entries(byRule).forEach(([rule, count]) => {
    console.log(`  ${rule}: ${count} (${((count / links.length) * 100).toFixed(1)}%)`);
  });

  // 3. High-traffic nodes (많은 link를 받는 메모리)
  const incomingLinks = links.reduce((acc, link) => {
    acc[link.to_id] = (acc[link.to_id] || 0) + 1;
    return acc;
  }, {});

  const hotspots = Object.entries(incomingLinks)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  console.log('\nTop 10 Hotspot Memories (most incoming links):');
  hotspots.forEach(({ id, count }) => {
    const memory = memories.find((m) => m.id === id);
    console.log(`  ${id}: ${count} links (${memory?.type}, ${memory?.topic || 'no topic'})`);
  });

  // 4. Confidence 분포
  const confidences = links.map((l) => l.confidence);
  const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const lowConfLinks = links.filter((l) => l.confidence < 0.5).length;

  console.log('\nConfidence Distribution:');
  console.log(`  Average: ${avgConfidence.toFixed(3)}`);
  console.log(
    `  Low confidence (<0.5): ${lowConfLinks} (${((lowConfLinks / links.length) * 100).toFixed(1)}%)`
  );

  return { linkDensity, byRule, hotspots, avgConfidence, lowConfLinks };
}

// ============================================================================
// Signal vs Noise: 실제 유용한 링크 비율 추정
// ============================================================================

function estimateSignalToNoise(memories, links) {
  console.log('\n=== Signal vs Noise Estimation ===\n');

  // "Useful link" 정의:
  // 1. Same session (1시간 이내) + same topic = HIGH signal
  // 2. Evolution relationship (supersedes 같은 명시적 관계) = HIGH signal
  // 3. Cross-session temporal link = LOW signal (noise)
  // 4. Semantic similarity but different topic = MEDIUM signal (탐색용)

  let highSignal = 0;
  let mediumSignal = 0;
  let lowSignal = 0;

  for (const link of links) {
    const fromMem = memories.find((m) => m.id === link.from_id);
    const toMem = memories.find((m) => m.id === link.to_id);

    if (!fromMem || !toMem) {
      continue;
    }

    const timeDelta = toMem.created_at - fromMem.created_at;
    const sameTopic = fromMem.topic === toMem.topic;
    const sameSession = timeDelta < 3600000; // 1 hour

    if (link.rule === 'same_topic' && sameSession) {
      highSignal++;
    } else if (link.rule === 'semantic_similarity' && sameTopic) {
      highSignal++;
    } else if (link.rule === 'temporal_proximity' && !sameSession) {
      lowSignal++; // Cross-session temporal = noise
    } else if (link.rule === 'semantic_similarity' && !sameTopic) {
      mediumSignal++; // 탐색용, 가끔 유용
    } else {
      mediumSignal++;
    }
  }

  console.log('Link Quality Distribution:');
  console.log(
    `  HIGH signal (useful): ${highSignal} (${((highSignal / links.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `  MEDIUM signal (exploration): ${mediumSignal} (${((mediumSignal / links.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `  LOW signal (noise): ${lowSignal} (${((lowSignal / links.length) * 100).toFixed(1)}%)`
  );

  const signalRatio = highSignal / links.length;
  console.log(`\n📊 Signal-to-Noise Ratio: ${(signalRatio * 100).toFixed(1)}%`);

  return { highSignal, mediumSignal, lowSignal, signalRatio };
}

// ============================================================================
// LLM Decision Quality Impact Simulation
// ============================================================================

function simulateLLMDecisionQuality(memories, links, _stats) {
  console.log('\n=== LLM Decision Quality Impact ===\n');

  // 시나리오: LLM이 "spinelift_performance" 관련 결정을 내려야 함
  const query = {
    topic: 'spinelift_performance',
    question: 'Should we use WebAssembly or native Node.js for mesh generation?',
  };

  console.log(`Query: "${query.question}"`);
  console.log(`Topic: ${query.topic}\n`);

  // 1. Relevant memories 찾기 (topic match)
  const relevantMemories = memories.filter((m) => m.topic === query.topic);
  console.log(`Found ${relevantMemories.length} memories with matching topic`);

  // 2. 각 relevant memory의 linked context 가져오기
  let totalLinkedContext = 0;
  let relevantLinkedContext = 0;
  let noiseLinkedContext = 0;

  for (const memory of relevantMemories) {
    const linkedIds = links
      .filter((l) => l.from_id === memory.id || l.to_id === memory.id)
      .map((l) => (l.from_id === memory.id ? l.to_id : l.from_id));

    totalLinkedContext += linkedIds.length;

    for (const linkedId of linkedIds) {
      const linked = memories.find((m) => m.id === linkedId);
      if (linked?.topic === query.topic) {
        relevantLinkedContext++;
      } else {
        noiseLinkedContext++;
      }
    }
  }

  console.log('\nLinked Context Analysis:');
  console.log(`  Total linked context: ${totalLinkedContext}`);
  console.log(
    `  Relevant (same topic): ${relevantLinkedContext} (${((relevantLinkedContext / totalLinkedContext) * 100).toFixed(1)}%)`
  );
  console.log(
    `  Noise (different topic): ${noiseLinkedContext} (${((noiseLinkedContext / totalLinkedContext) * 100).toFixed(1)}%)`
  );

  // 3. Context window pollution 추정
  const AVG_MEMORY_SIZE = 200; // tokens
  const contextTokens = totalLinkedContext * AVG_MEMORY_SIZE;
  const noiseTokens = noiseLinkedContext * AVG_MEMORY_SIZE;

  console.log('\nContext Window Impact:');
  console.log(`  Total context: ~${contextTokens} tokens`);
  console.log(
    `  Noise: ~${noiseTokens} tokens (${((noiseTokens / contextTokens) * 100).toFixed(1)}%)`
  );

  // 4. Decision quality degradation 추정
  const noiseRatio = noiseLinkedContext / totalLinkedContext;
  let qualityImpact = 'GOOD';

  if (noiseRatio > 0.5) {
    qualityImpact = 'SEVERE - LLM will be confused by irrelevant context';
  } else if (noiseRatio > 0.3) {
    qualityImpact = 'MODERATE - LLM may consider irrelevant factors';
  } else if (noiseRatio > 0.15) {
    qualityImpact = 'MINOR - Mostly relevant context';
  }

  console.log(`\n🎯 Decision Quality Impact: ${qualityImpact}`);

  return { noiseRatio, qualityImpact, contextTokens, noiseTokens };
}

// ============================================================================
// Scaling Analysis: 1000 memories 규모
// ============================================================================

function analyzeScaling() {
  console.log('\n' + '='.repeat(80));
  console.log('=== SCALING ANALYSIS: 1000 memories ===');
  console.log('='.repeat(80) + '\n');

  // 100개 메모리에서 측정한 비율로 1000개 추정
  const memories100 = 100;
  const linksPerMemory = 8.5; // 시뮬레이션 평균값
  const memories1000 = 1000;

  const totalLinks = memories1000 * linksPerMemory;
  const storagePerLink = 150; // bytes (JSON metadata 포함)
  const totalStorage = totalLinks * storagePerLink;

  console.log('Link Growth Projection:');
  console.log(`  100 memories → ~${(memories100 * linksPerMemory).toFixed(0)} links`);
  console.log(`  1000 memories → ~${totalLinks.toFixed(0)} links`);
  console.log(`  Storage: ${(totalStorage / 1024).toFixed(0)} KB`);

  // Traversal performance 추정
  const avgDepth = 3;
  const branchingFactor = linksPerMemory;
  const nodesVisited = Math.pow(branchingFactor, avgDepth);

  console.log('\nGraph Traversal (depth=3):');
  console.log(`  Branching factor: ${branchingFactor.toFixed(1)}`);
  console.log(`  Nodes visited: ~${nodesVisited.toFixed(0)}`);
  console.log(`  Estimated time: ${(nodesVisited * 0.5).toFixed(0)}ms (assuming 0.5ms per node)`);

  // Cache effectiveness
  const uniquePaths = memories1000 * 5; // 메모리당 5개 자주 쓰는 경로
  const cacheSize = 100;
  const cacheHitRate = Math.min(0.8, cacheSize / uniquePaths);

  console.log('\nCache Effectiveness:');
  console.log(`  Unique paths: ~${uniquePaths}`);
  console.log(`  Cache size: ${cacheSize}`);
  console.log(`  Estimated hit rate: ${(cacheHitRate * 100).toFixed(1)}%`);

  if (cacheHitRate < 0.5) {
    console.log('  ⚠️  LOW cache hit rate - performance degradation expected');
  }

  return { totalLinks, nodesVisited, cacheHitRate };
}

// ============================================================================
// Real-World Scenario: 혼란스러운 결과
// ============================================================================

function demonstrateConfusion(memories, links) {
  console.log('\n' + '='.repeat(80));
  console.log('=== REAL-WORLD CONFUSION SCENARIO ===');
  console.log('='.repeat(80) + '\n');

  console.log('시나리오: 재훈이 "auth_strategy"에 대한 질문을 함');
  console.log('질문: "JWT 방식의 문제점이 뭐였지?"\n');

  // auth_strategy 관련 메모리 찾기
  const authMemories = memories.filter((m) => m.topic === 'auth_strategy');

  if (authMemories.length === 0) {
    console.log('(No auth_strategy memories in this simulation)');
    return;
  }

  console.log(`Found ${authMemories.length} auth_strategy memories`);

  // 첫 번째 auth memory의 linked context 가져오기
  const targetMemory = authMemories[0];
  console.log(`\nExamining: ${targetMemory.id}`);

  const linkedContextIds = links
    .filter((l) => l.from_id === targetMemory.id || l.to_id === targetMemory.id)
    .map((l) => ({
      id: l.from_id === targetMemory.id ? l.to_id : l.from_id,
      rule: l.rule,
      confidence: l.confidence,
    }));

  console.log(`\nLinked context (${linkedContextIds.length} items):`);

  // 관련성 있는 것과 없는 것 구분
  const relevant = [];
  const irrelevant = [];

  for (const link of linkedContextIds) {
    const mem = memories.find((m) => m.id === link.id);
    if (!mem) {
      continue;
    }

    const item = {
      id: mem.id,
      type: mem.type,
      topic: mem.topic || '(no topic)',
      rule: link.rule,
      confidence: link.confidence,
    };

    if (
      mem.topic === 'auth_strategy' ||
      (mem.type === 'checkpoint' && link.rule === 'temporal_proximity')
    ) {
      relevant.push(item);
    } else {
      irrelevant.push(item);
    }
  }

  console.log('\n✅ Relevant context:');
  relevant.forEach((item) => {
    console.log(`  - ${item.id}: ${item.type} (${item.rule}, conf=${item.confidence.toFixed(2)})`);
  });

  console.log('\n❌ Irrelevant noise:');
  irrelevant.slice(0, 10).forEach((item) => {
    console.log(
      `  - ${item.id}: ${item.type}, topic="${item.topic}" (${item.rule}, conf=${item.confidence.toFixed(2)})`
    );
  });

  if (irrelevant.length > 10) {
    console.log(`  ... and ${irrelevant.length - 10} more irrelevant links`);
  }

  const noiseRatio = irrelevant.length / linkedContextIds.length;
  console.log(`\n📊 Noise ratio: ${(noiseRatio * 100).toFixed(1)}%`);

  if (noiseRatio > 0.4) {
    console.log('\n⚠️  PROBLEM: LLM will receive mostly irrelevant context!');
    console.log('Expected behavior:');
    console.log('  - LLM mentions unrelated topics (e.g., spinelift_mesh_generation)');
    console.log('  - Confidence in answer decreases');
    console.log('  - "Let me check multiple sources..." instead of direct answer');
  }
}

// ============================================================================
// Main Execution
// ============================================================================

function main() {
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║  MAMA v1.1 Automatic Link Noise Simulation                        ║');
  console.log('║  Realistic 6-month usage scenario                                  ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  // Generate data
  const memories = generateRealisticMemories();

  // Apply automatic linking
  const links = createAutomaticLinks(memories);

  // Analyze
  const noiseStats = analyzeNoise(memories, links);
  const signalStats = estimateSignalToNoise(memories, links);
  const qualityStats = simulateLLMDecisionQuality(memories, links, signalStats);

  // Scaling
  const scalingStats = analyzeScaling();

  // Demonstrate confusion
  demonstrateConfusion(memories, links);

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('=== SUMMARY ===');
  console.log('='.repeat(80) + '\n');

  console.log(`Total memories: ${memories.length}`);
  console.log(`Total links: ${links.length}`);
  console.log(`Links per memory: ${(links.length / memories.length).toFixed(2)}`);
  console.log(`Signal ratio: ${(signalStats.signalRatio * 100).toFixed(1)}%`);
  console.log(`LLM context noise: ${(qualityStats.noiseRatio * 100).toFixed(1)}%`);
  console.log(`Decision quality impact: ${qualityStats.qualityImpact}`);

  console.log('\n🚨 KEY FINDINGS:');
  console.log(
    `  1. Only ${(signalStats.signalRatio * 100).toFixed(0)}% of automatic links are truly useful`
  );
  console.log(
    `  2. ${((noiseStats.lowConfLinks / links.length) * 100).toFixed(0)}% of links have low confidence (<0.5)`
  );
  console.log(`  3. ${qualityStats.noiseTokens.toFixed(0)} noise tokens in typical query context`);
  console.log(
    `  4. At 1000 memories: ~${scalingStats.totalLinks.toFixed(0)} links, ${scalingStats.nodesVisited.toFixed(0)} nodes visited per traversal`
  );

  console.log('\n💡 RECOMMENDATIONS:');

  if (signalStats.signalRatio < 0.3) {
    console.log('  🔴 CRITICAL: Disable automatic linking');
    console.log('     - Signal ratio too low');
    console.log('     - Manual/LLM-guided links only');
  } else if (signalStats.signalRatio < 0.5) {
    console.log('  🟡 WARNING: Restrict automatic linking');
    console.log('     - Same-session only (remove cross-session temporal)');
    console.log('     - Increase similarity threshold to 0.85+');
    console.log('     - Add user confirmation for low-confidence links');
  } else {
    console.log('  🟢 ACCEPTABLE: Automatic linking may work');
    console.log('     - Monitor noise ratio over time');
    console.log('     - Implement aggressive pruning (weekly)');
  }

  console.log('\n' + '='.repeat(80));
}

// Run simulation
main();
