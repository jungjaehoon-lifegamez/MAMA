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
