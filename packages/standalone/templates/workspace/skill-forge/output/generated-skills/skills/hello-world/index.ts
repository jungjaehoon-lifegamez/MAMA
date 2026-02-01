/**
 * hello-world - 간단한 인사 스킬
 *
 * @triggers /hello, 안녕
 * @complexity simple
 */

import { SkillContext, SkillResult } from './types';

// ===== Skill Definition =====

export const skill = {
  name: 'hello-world',
  description: '간단한 인사 스킬',
  triggers: ['/hello', '안녕'],

  async execute(context: SkillContext): Promise<SkillResult> {
    try {
      console.log('[hello-world] 시작:', context.input);

      // Workflow Steps
      // Step 1: parse - 사용자 입력 파싱
      const step1 = await parse(context.input);
      // Step 2: validate - 입력 검증
      const step2 = await validate(step1);
      // Step 3: execute - 핵심 로직 실행
      const step3 = await execute(step2);
      // Step 4: format - 결과 포맷팅
      const step4 = await format(step3);
      // Step 5: respond - 응답 반환
      const step5 = await respond(step4);

      return {
        success: true,
        message: String(step5),
      };
    } catch (error) {
      console.error('[hello-world] 에러:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 에러',
      };
    }
  },
};

// ===== Helper Functions =====

async function parse(input: unknown): Promise<unknown> {
  // 사용자 입력 파싱
  console.log('[parse]', input);
  return input;
}

async function validate(input: unknown): Promise<unknown> {
  // 입력 검증
  console.log('[validate]', input);
  return input;
}

async function execute(input: unknown): Promise<unknown> {
  // 핵심 로직 실행
  console.log('[execute]', input);
  return input;
}

async function format(input: unknown): Promise<unknown> {
  // 결과 포맷팅
  console.log('[format]', input);
  return input;
}

async function respond(input: unknown): Promise<unknown> {
  // 응답 반환
  console.log('[respond]', input);
  return input;
}

export default skill;
