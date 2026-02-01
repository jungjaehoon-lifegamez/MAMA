/**
 * Skill Forge - Developer Agent
 *
 * 역할: 실제 스킬 코드 생성
 * 모델: Opus 4.5 (복잡한 코드 생성)
 *
 * 입력: ArchitectOutput (구조 설계)
 * 출력: DeveloperOutput (생성된 파일들)
 */

import { ArchitectOutput, DeveloperOutput, GeneratedFile, SkillRequest } from '../types';

// ===== Developer System Prompt =====

const DEVELOPER_SYSTEM_PROMPT = `당신은 Skill Forge의 **Developer 에이전트**입니다.

## 역할
Architect가 설계한 구조를 바탕으로 **실제 동작하는 코드**를 생성합니다.

## 입력
1. Architect의 설계 (구조, 워크플로우, 파일 구조)
2. 원본 사용자 요청

## 출력 형식 (JSON)
{
  "files": [
    {
      "path": "skills/skill-name/index.ts",
      "content": "... 전체 코드 ...",
      "language": "typescript"
    },
    ...
  ],
  "installInstructions": [
    "npm install 필요한-패키지",
    ...
  ],
  "testCommands": [
    "npx tsx skills/skill-name/index.ts",
    ...
  ]
}

## 코드 작성 원칙

### 1. OpenClaw 스킬 구조 준수
\`\`\`typescript
// skills/my-skill/index.ts
export const skill = {
  name: 'my-skill',
  description: '스킬 설명',
  triggers: ['/my-skill', '트리거'],

  async execute(context: SkillContext) {
    // 구현
  }
};
\`\`\`

### 2. 에러 핸들링 필수
- try-catch 사용
- 사용자 친화적 에러 메시지
- 디버깅용 console.error

### 3. 타입 안전성
- TypeScript strict mode
- 명시적 타입 선언
- 인터페이스 정의

### 4. 모듈화
- 단일 책임 원칙
- 재사용 가능한 헬퍼 함수
- 명확한 export

JSON만 출력하세요.`;

// ===== Developer Agent Class =====

export class DeveloperAgent {
  private systemPrompt: string;

  constructor() {
    this.systemPrompt = DEVELOPER_SYSTEM_PROMPT;
  }

  /**
   * Architect 출력을 받아 실제 코드를 생성합니다
   */
  async develop(
    architectOutput: ArchitectOutput,
    originalRequest: SkillRequest
  ): Promise<DeveloperOutput> {
    const userPrompt = this.buildUserPrompt(architectOutput, originalRequest);
    const response = await this.callClaude(userPrompt);
    return this.parseResponse(response);
  }

  private buildUserPrompt(arch: ArchitectOutput, req: SkillRequest): string {
    return `## Architect 설계

\`\`\`json
${JSON.stringify(arch, null, 2)}
\`\`\`

## 원본 요청
- 스킬명: ${req.name}
- 설명: ${req.description}
- 트리거: ${req.triggers.join(', ')}
- 기능: ${req.capabilities.join(', ')}

## 지시사항
위 설계를 바탕으로 실제 동작하는 코드를 생성하세요.`;
  }

  private async callClaude(userPrompt: string): Promise<string> {
    // TODO: 실제 Claude API 호출 (Phase 3)
    const output = this.generateCode(userPrompt);
    return JSON.stringify(output);
  }

  private parseResponse(response: string): DeveloperOutput {
    try {
      let jsonStr = response;
      const jsonMatch = response.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      const parsed = JSON.parse(jsonStr.trim());
      return {
        files: parsed.files || [],
        installInstructions: parsed.installInstructions || [],
        testCommands: parsed.testCommands || [],
      };
    } catch (error) {
      console.error('[DeveloperAgent] JSON parse error:', error);
      throw new Error(`Developer 응답 파싱 실패: ${error}`);
    }
  }

  // ===== Code Generation (Template-based) =====

  private generateCode(userPrompt: string): DeveloperOutput {
    const archMatch = userPrompt.match(/\`\`\`json\n([\s\S]*?)\`\`\`/);
    if (!archMatch) {
      throw new Error('Architect 출력을 찾을 수 없습니다');
    }

    const arch: ArchitectOutput = JSON.parse(archMatch[1]);
    const files: GeneratedFile[] = [];

    // 1. 메인 index.ts
    files.push(this.generateMainFile(arch));

    // 2. types.ts
    files.push(this.generateTypesFile(arch));

    // 3. README.md
    files.push(this.generateReadmeFile(arch));

    // 4. API 파일 (필요시)
    if (arch.toolsRequired.includes('WebFetch')) {
      files.push(this.generateApiFile(arch));
    }

    return {
      files,
      installInstructions: this.generateInstallInstructions(arch),
      testCommands: this.generateTestCommands(arch),
    };
  }

  private generateMainFile(arch: ArchitectOutput): GeneratedFile {
    const skillName = arch.skillName;

    const content = `/**
 * ${arch.skillName} - ${arch.purpose}
 *
 * @triggers ${arch.triggers.join(', ')}
 * @complexity ${arch.estimatedComplexity}
 */

import { SkillContext, SkillResult } from './types';

// ===== Skill Definition =====

export const skill = {
  name: '${skillName}',
  description: '${arch.purpose}',
  triggers: ${JSON.stringify(arch.triggers)},

  async execute(context: SkillContext): Promise<SkillResult> {
    try {
      console.log('[${skillName}] 시작:', context.input);

      // Workflow Steps
${arch.workflow
  .map(
    (w) => `      // Step ${w.step}: ${w.action} - ${w.description}
      const step${w.step} = await ${w.action}(${w.step === 1 ? 'context.input' : `step${w.step - 1}`});`
  )
  .join('\n')}

      return {
        success: true,
        message: String(step${arch.workflow.length}),
      };
    } catch (error) {
      console.error('[${skillName}] 에러:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 에러',
      };
    }
  },
};

// ===== Helper Functions =====

${arch.workflow
  .map(
    (w) => `async function ${w.action}(input: unknown): Promise<unknown> {
  // ${w.description}
  console.log('[${w.action}]', input);
  return input;
}`
  )
  .join('\n\n')}

export default skill;
`;

    return { path: `skills/${skillName}/index.ts`, content, language: 'typescript' };
  }

  private generateTypesFile(arch: ArchitectOutput): GeneratedFile {
    const content = `/**
 * ${arch.skillName} - Type Definitions
 */

export interface SkillContext {
  input: string;
  channelId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}
`;
    return { path: `skills/${arch.skillName}/types.ts`, content, language: 'typescript' };
  }

  private generateReadmeFile(arch: ArchitectOutput): GeneratedFile {
    const content = `# ${arch.skillName}

> ${arch.purpose}

## 트리거

${arch.triggers.map((t) => `- \`${t}\``).join('\n')}

## 워크플로우

${arch.workflow.map((w) => `${w.step}. **${w.action}**: ${w.description}`).join('\n')}

## 필요한 도구

${arch.toolsRequired.map((t) => `- ${t}`).join('\n')}

---
Generated by Skill Forge 🔥
`;
    return { path: `skills/${arch.skillName}/README.md`, content, language: 'markdown' };
  }

  private generateApiFile(arch: ArchitectOutput): GeneratedFile {
    const content = `/**
 * ${arch.skillName} - API Module
 */

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export async function fetchData<T>(url: string): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: \`HTTP \${response.status}\` };
    }
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
`;
    return { path: `skills/${arch.skillName}/api.ts`, content, language: 'typescript' };
  }

  private generateInstallInstructions(arch: ArchitectOutput): string[] {
    const instructions: string[] = [];
    if (arch.toolsRequired.includes('WebFetch')) {
      instructions.push('npm install node-fetch');
    }
    return instructions;
  }

  private generateTestCommands(arch: ArchitectOutput): string[] {
    return [`npx tsx skills/${arch.skillName}/index.ts`];
  }
}

// ===== Factory =====

export function createDeveloperAgent(): DeveloperAgent {
  return new DeveloperAgent();
}

// ===== Test =====

async function runTest() {
  console.log('💻 Developer Agent Test\n');

  const agent = createDeveloperAgent();

  const archOutput: ArchitectOutput = {
    skillName: 'code-review',
    purpose: '코드 리뷰를 수행하고 피드백을 제공',
    triggers: ['/review', '코드 리뷰해줘'],
    workflow: [
      { step: 1, action: 'parse', description: '파일 경로 추출' },
      { step: 2, action: 'read', description: '파일 읽기' },
      { step: 3, action: 'analyze', description: '분석' },
      { step: 4, action: 'respond', description: '응답' },
    ],
    fileStructure: [{ path: 'skills/code-review/index.ts', purpose: '메인' }],
    toolsRequired: ['Read', 'discord_send'],
    estimatedComplexity: 'medium',
  };

  const request = {
    name: 'code-review',
    description: '코드 리뷰',
    triggers: ['/review'],
    capabilities: ['분석'],
    rawInput: '/forge code-review',
  };

  const output = await agent.develop(archOutput, request);
  console.log(`✅ Generated ${output.files.length} files`);
  output.files.forEach((f) => console.log(`  - ${f.path}`));
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runTest();
}
