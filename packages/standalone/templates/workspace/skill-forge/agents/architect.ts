/**
 * Skill Forge - Architect Agent
 *
 * 역할: 스킬 구조 설계
 * 모델: Sonnet 4 (빠른 구조화)
 *
 * 입력: 사용자 요청 (스킬 이름, 설명, 트리거 등)
 * 출력: ArchitectOutput (구조, 워크플로우, 파일 구조)
 */

import { SkillRequest, ArchitectOutput } from '../types';

// ===== Architect System Prompt =====

const ARCHITECT_SYSTEM_PROMPT = `당신은 Skill Forge의 **Architect 에이전트**입니다.

## 역할
OpenClaw 스킬의 구조를 설계합니다. 코드를 작성하지 않고, **설계도**만 제공합니다.

## 출력 형식 (JSON)
{
  "skillName": "스킬 영문 이름 (kebab-case)",
  "purpose": "스킬의 목적 (1-2문장)",
  "triggers": ["트리거1", "트리거2"],
  "workflow": [
    {"step": 1, "action": "동사", "description": "설명"},
    ...
  ],
  "fileStructure": [
    {"path": "상대경로", "purpose": "용도"},
    ...
  ],
  "toolsRequired": ["Read", "Write", ...],
  "estimatedComplexity": "simple | medium | complex"
}

## 설계 원칙
1. **단순함 우선**: 최소한의 파일로 시작
2. **명확한 워크플로우**: 3-7단계 이내
3. **기존 도구 활용**: OpenClaw의 기존 도구 사용
4. **확장 가능성**: 나중에 확장할 수 있는 구조

## 복잡도 기준
- **simple**: 단일 파일, 1-3 워크플로우 단계
- **medium**: 2-3 파일, 4-5 워크플로우 단계
- **complex**: 4+ 파일, 6+ 워크플로우 단계, 외부 API 연동

## 예시 입력
스킬명: weather-check
설명: 날씨 정보를 조회합니다
트리거: /weather, 날씨 알려줘

## 예시 출력
{
  "skillName": "weather-check",
  "purpose": "OpenWeatherMap API를 통해 현재 날씨 정보를 조회하고 사용자에게 알려줍니다",
  "triggers": ["/weather", "날씨 알려줘", "오늘 날씨"],
  "workflow": [
    {"step": 1, "action": "parse", "description": "도시명 추출 (기본값: Seoul)"},
    {"step": 2, "action": "fetch", "description": "OpenWeatherMap API 호출"},
    {"step": 3, "action": "format", "description": "응답을 사용자 친화적으로 포맷"},
    {"step": 4, "action": "respond", "description": "Discord로 결과 전송"}
  ],
  "fileStructure": [
    {"path": "skills/weather-check/index.ts", "purpose": "메인 진입점"},
    {"path": "skills/weather-check/api.ts", "purpose": "API 호출 로직"},
    {"path": "skills/weather-check/README.md", "purpose": "사용법 문서"}
  ],
  "toolsRequired": ["WebFetch", "discord_send"],
  "estimatedComplexity": "medium"
}

JSON만 출력하세요. 설명이나 마크다운 블록 없이 순수 JSON만.`;

// ===== Architect Agent Class =====

export class ArchitectAgent {
  private systemPrompt: string;

  constructor() {
    this.systemPrompt = ARCHITECT_SYSTEM_PROMPT;
  }

  /**
   * 스킬 요청을 받아 구조를 설계합니다
   */
  async design(request: SkillRequest): Promise<ArchitectOutput> {
    const userPrompt = this.buildUserPrompt(request);

    // Claude API 호출 (Sonnet 4)
    // 현재는 mock 구현, 실제 API 연동은 Phase 2에서
    const response = await this.callClaude(userPrompt);

    return this.parseResponse(response);
  }

  private buildUserPrompt(request: SkillRequest): string {
    return `스킬명: ${request.name}
설명: ${request.description}
트리거: ${request.triggers.join(', ')}
기능: ${request.capabilities.join(', ')}

원본 입력: ${request.rawInput}`;
  }

  private async callClaude(userPrompt: string): Promise<string> {
    // TODO: 실제 Claude API 호출
    // Phase 2에서 구현

    // Mock 응답 - 프롬프트 기반으로 구조 생성
    const skillName = this.extractSkillName(userPrompt);

    return JSON.stringify({
      skillName,
      purpose: this.extractPurpose(userPrompt),
      triggers: this.extractTriggers(userPrompt),
      workflow: this.generateWorkflow(userPrompt),
      fileStructure: this.generateFileStructure(skillName),
      toolsRequired: this.inferTools(userPrompt),
      estimatedComplexity: this.estimateComplexity(userPrompt),
    });
  }

  private parseResponse(response: string): ArchitectOutput {
    try {
      // JSON 블록 추출 (```json ... ``` 형식 지원)
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const parsed = JSON.parse(jsonStr.trim());

      // 필수 필드 검증
      return {
        skillName: parsed.skillName || 'unnamed-skill',
        purpose: parsed.purpose || '목적 미정의',
        triggers: parsed.triggers || [],
        workflow: parsed.workflow || [],
        fileStructure: parsed.fileStructure || [],
        toolsRequired: parsed.toolsRequired || [],
        estimatedComplexity: parsed.estimatedComplexity || 'simple',
      };
    } catch (error) {
      console.error('[ArchitectAgent] JSON parse error:', error);
      throw new Error(`Architect 응답 파싱 실패: ${error}`);
    }
  }

  // ===== Mock Helpers (실제 API 연동 전까지 사용) =====

  private extractSkillName(prompt: string): string {
    const match = prompt.match(/스킬명:\s*([^\n]+)/);
    if (match) {
      return match[1].trim().toLowerCase().replace(/\s+/g, '-');
    }
    return 'unnamed-skill';
  }

  private extractPurpose(prompt: string): string {
    const match = prompt.match(/설명:\s*([^\n]+)/);
    return match ? match[1].trim() : '목적 미정의';
  }

  private extractTriggers(prompt: string): string[] {
    const match = prompt.match(/트리거:\s*([^\n]+)/);
    if (match) {
      return match[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
    return [];
  }

  private generateWorkflow(
    prompt: string
  ): Array<{ step: number; action: string; description: string }> {
    // 기본 워크플로우 템플릿
    return [
      { step: 1, action: 'parse', description: '사용자 입력 파싱' },
      { step: 2, action: 'validate', description: '입력 검증' },
      { step: 3, action: 'execute', description: '핵심 로직 실행' },
      { step: 4, action: 'format', description: '결과 포맷팅' },
      { step: 5, action: 'respond', description: '응답 반환' },
    ];
  }

  private generateFileStructure(skillName: string): Array<{ path: string; purpose: string }> {
    return [
      { path: `skills/${skillName}/index.ts`, purpose: '메인 진입점' },
      { path: `skills/${skillName}/types.ts`, purpose: '타입 정의' },
      { path: `skills/${skillName}/README.md`, purpose: '사용법 문서' },
    ];
  }

  private inferTools(prompt: string): string[] {
    const tools: string[] = ['discord_send']; // 기본

    const lowerPrompt = prompt.toLowerCase();

    if (
      lowerPrompt.includes('파일') ||
      lowerPrompt.includes('읽') ||
      lowerPrompt.includes('read')
    ) {
      tools.push('Read');
    }
    if (
      lowerPrompt.includes('작성') ||
      lowerPrompt.includes('쓰') ||
      lowerPrompt.includes('write')
    ) {
      tools.push('Write');
    }
    if (
      lowerPrompt.includes('api') ||
      lowerPrompt.includes('fetch') ||
      lowerPrompt.includes('http')
    ) {
      tools.push('WebFetch');
    }
    if (
      lowerPrompt.includes('검색') ||
      lowerPrompt.includes('search') ||
      lowerPrompt.includes('grep')
    ) {
      tools.push('Grep');
    }
    if (
      lowerPrompt.includes('명령') ||
      lowerPrompt.includes('bash') ||
      lowerPrompt.includes('실행')
    ) {
      tools.push('Bash');
    }

    return [...new Set(tools)]; // 중복 제거
  }

  private estimateComplexity(prompt: string): 'simple' | 'medium' | 'complex' {
    const lowerPrompt = prompt.toLowerCase();

    // 복잡도 키워드 체크
    const complexKeywords = ['api', 'database', 'auth', 'multi', '연동', '통합'];
    const mediumKeywords = ['검색', '파싱', 'parsing', 'format', '변환'];

    for (const kw of complexKeywords) {
      if (lowerPrompt.includes(kw)) return 'complex';
    }

    for (const kw of mediumKeywords) {
      if (lowerPrompt.includes(kw)) return 'medium';
    }

    return 'simple';
  }
}

// ===== Factory Function =====

export function createArchitectAgent(): ArchitectAgent {
  return new ArchitectAgent();
}

// ===== 테스트 =====

async function runTest() {
  console.log('🏗️ Architect Agent Test\n');

  const agent = createArchitectAgent();

  const request: SkillRequest = {
    name: 'code-review',
    description: '코드 리뷰를 수행하고 피드백을 제공합니다',
    triggers: ['/review', '코드 리뷰해줘'],
    capabilities: ['파일 읽기', '분석', '피드백 제공'],
    rawInput: '/forge code-review - 코드 리뷰를 수행하고 피드백을 제공합니다',
  };

  try {
    const output = await agent.design(request);
    console.log('✅ Architect Output:\n');
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// ESM entry point
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runTest();
}
