export interface BenchmarkScenario {
  name: string;
  userText: string;
  expectCandidate: boolean;
  expectSave: boolean;
  expectedKind?: string;
  expectedTopicHint?: string;
}

export const SAVE_SCENARIOS: BenchmarkScenario[] = [
  {
    name: 'explicit-decision-korean',
    userText: '앞으로 이 프로젝트 DB는 PostgreSQL로 사용하자. 기억해.',
    expectCandidate: true,
    expectSave: true,
    expectedKind: 'decision',
    expectedTopicHint: 'database_choice',
  },
  {
    name: 'preference',
    userText: '나는 Sony 호환 액세서리를 선호해.',
    expectCandidate: true,
    expectSave: true,
    expectedKind: 'preference',
  },
  {
    name: 'no-op-greeting',
    userText: '고마워',
    expectCandidate: false,
    expectSave: false,
  },
  {
    name: 'explicit-decision-english',
    userText: 'We decided to use JWT with refresh tokens for authentication.',
    expectCandidate: true,
    expectSave: true,
    expectedKind: 'decision',
  },
];

/**
 * Save-then-recall scenarios: save a decision, then query to verify recall.
 */
export interface RecallScenario {
  name: string;
  saveText: string;
  recallQuery: string;
  expectedInRecall: string; // substring that must appear in recalled content
  saveTopic: string;
  saveReasoning: string;
}

export const RECALL_SCENARIOS: RecallScenario[] = [
  {
    name: 'database-choice-korean',
    saveText: '이 프로젝트 DB는 PostgreSQL을 사용한다',
    recallQuery: '우리 프로젝트 DB 뭐 쓰기로 했지?',
    expectedInRecall: 'PostgreSQL',
    saveTopic: 'database_choice',
    saveReasoning: 'Team agreed to use PostgreSQL for the project database',
  },
  {
    name: 'auth-strategy-english',
    saveText: 'Use JWT with refresh tokens for authentication',
    recallQuery: 'What authentication method do we use?',
    expectedInRecall: 'JWT',
    saveTopic: 'auth_strategy',
    saveReasoning: 'JWT with refresh tokens chosen for stateless API auth',
  },
  {
    name: 'package-manager',
    saveText: 'We use pnpm as the package manager for this monorepo',
    recallQuery: 'Which package manager do we use?',
    expectedInRecall: 'pnpm',
    saveTopic: 'package_manager',
    saveReasoning: 'pnpm chosen for workspace support and disk efficiency',
  },
];

/**
 * Supersede scenario: save two decisions on same topic, verify latest is recalled.
 */
export interface SupersedeScenario {
  name: string;
  firstSave: { topic: string; decision: string; reasoning: string };
  secondSave: { topic: string; decision: string; reasoning: string };
  recallQuery: string;
  expectedInRecall: string; // from second save, not first
  notExpectedInRecall?: string; // from first save, should not be top result
}

export const SUPERSEDE_SCENARIOS: SupersedeScenario[] = [
  {
    name: 'database-change',
    firstSave: {
      topic: 'database_choice',
      decision: 'Use SQLite as the project database',
      reasoning: 'Lightweight, no server needed for initial development',
    },
    secondSave: {
      topic: 'database_choice',
      decision: 'Switch to PostgreSQL as the project database',
      reasoning: 'SQLite cannot handle concurrent writes needed for production',
    },
    recallQuery: 'What database do we use?',
    expectedInRecall: 'PostgreSQL',
  },
];
