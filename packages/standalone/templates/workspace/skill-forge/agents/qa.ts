/**
 * Skill Forge - QA Agent
 *
 * 역할: 생성된 스킬 검증
 * 모델: Haiku (빠른 체크리스트 검증)
 *
 * 입력: DeveloperOutput + ArchitectOutput
 * 출력: QAOutput (체크리스트, 이슈, 권고)
 */

import { ArchitectOutput, DeveloperOutput, QAOutput, ChecklistItem, QAIssue } from '../types';

// ===== QA System Prompt =====

const QA_SYSTEM_PROMPT = `당신은 Skill Forge의 **QA 에이전트**입니다.

## 역할
Developer가 생성한 코드를 검증하고 품질을 보장합니다.

## 체크리스트

### 1. 구조 검증
- [ ] 모든 필수 파일이 생성되었는가
- [ ] 파일 구조가 설계와 일치하는가
- [ ] export가 올바르게 되어있는가

### 2. 코드 품질
- [ ] TypeScript 타입이 명시되어있는가
- [ ] 에러 핸들링이 있는가 (try-catch)
- [ ] 적절한 주석이 있는가

### 3. 기능 검증
- [ ] 트리거가 올바르게 정의되었는가
- [ ] 워크플로우 단계가 구현되었는가
- [ ] 필요한 도구를 사용하는가

### 4. 보안/안전
- [ ] 하드코딩된 비밀이 없는가
- [ ] 입력 검증이 있는가
- [ ] 에러 메시지가 안전한가

## 출력 형식 (JSON)
{
  "passed": true/false,
  "checklist": [
    {"item": "검사 항목", "passed": true/false, "note": "선택적 설명"}
  ],
  "issues": [
    {"severity": "critical|warning|suggestion", "description": "설명", "location": "파일:라인"}
  ],
  "recommendation": "approve|revise|reject"
}

JSON만 출력하세요.`;

// ===== QA Agent Class =====

export class QAAgent {
  private systemPrompt: string;

  constructor() {
    this.systemPrompt = QA_SYSTEM_PROMPT;
  }

  /**
   * Developer 출력을 검증합니다
   */
  async verify(
    developerOutput: DeveloperOutput,
    architectOutput: ArchitectOutput
  ): Promise<QAOutput> {
    const userPrompt = this.buildUserPrompt(developerOutput, architectOutput);
    const response = await this.callClaude(userPrompt);
    return this.parseResponse(response);
  }

  private buildUserPrompt(dev: DeveloperOutput, arch: ArchitectOutput): string {
    return `## Architect 설계

\`\`\`json
${JSON.stringify(arch, null, 2)}
\`\`\`

## Developer 출력

### 생성된 파일들
${dev.files
  .map(
    (f) => `#### ${f.path}
\`\`\`${f.language}
${f.content}
\`\`\``
  )
  .join('\n\n')}

### 설치 지침
${dev.installInstructions.join('\n') || '없음'}

### 테스트 명령
${dev.testCommands.join('\n') || '없음'}

---

위 코드를 체크리스트에 따라 검증하세요.`;
  }

  private async callClaude(userPrompt: string): Promise<string> {
    // TODO: 실제 Claude API 호출 (Phase 3)
    const output = this.runChecklist(userPrompt);
    return JSON.stringify(output);
  }

  private parseResponse(response: string): QAOutput {
    try {
      let jsonStr = response;
      const jsonMatch = response.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      const parsed = JSON.parse(jsonStr.trim());
      return {
        passed: parsed.passed ?? false,
        checklist: parsed.checklist || [],
        issues: parsed.issues || [],
        recommendation: parsed.recommendation || 'revise',
      };
    } catch (error) {
      console.error('[QAAgent] JSON parse error:', error);
      throw new Error(`QA 응답 파싱 실패: ${error}`);
    }
  }

  // ===== Checklist Runner (Local) =====

  private runChecklist(userPrompt: string): QAOutput {
    const checklist: ChecklistItem[] = [];
    const issues: QAIssue[] = [];

    // 파일 추출
    const fileMatches = userPrompt.matchAll(/#### ([\w\-\/\.]+)\n\`\`\`(\w+)\n([\s\S]*?)\`\`\`/g);
    const files: Array<{ path: string; lang: string; content: string }> = [];

    for (const match of fileMatches) {
      files.push({ path: match[1], lang: match[2], content: match[3] });
    }

    // 1. 구조 검증
    checklist.push({
      item: '필수 파일 생성됨',
      passed: files.length >= 2,
      note: `${files.length}개 파일`,
    });

    const hasIndex = files.some((f) => f.path.includes('index.ts'));
    checklist.push({
      item: 'index.ts 존재',
      passed: hasIndex,
    });

    const hasTypes = files.some((f) => f.path.includes('types.ts'));
    checklist.push({
      item: 'types.ts 존재',
      passed: hasTypes,
    });

    // 2. 코드 품질
    const indexFile = files.find((f) => f.path.includes('index.ts'));
    if (indexFile) {
      const hasExport = indexFile.content.includes('export');
      checklist.push({
        item: 'export 문 존재',
        passed: hasExport,
      });

      const hasTryCatch = indexFile.content.includes('try') && indexFile.content.includes('catch');
      checklist.push({
        item: '에러 핸들링 (try-catch)',
        passed: hasTryCatch,
      });

      const hasTypeAnnotation = indexFile.content.includes(': ') || indexFile.content.includes('<');
      checklist.push({
        item: '타입 어노테이션',
        passed: hasTypeAnnotation,
      });

      // 보안 체크
      const hasHardcodedSecrets = /api[_-]?key|password|secret/i.test(indexFile.content);
      if (hasHardcodedSecrets) {
        issues.push({
          severity: 'warning',
          description: '하드코딩된 비밀 키워드 발견',
          location: indexFile.path,
        });
      }
      checklist.push({
        item: '하드코딩 비밀 없음',
        passed: !hasHardcodedSecrets,
      });
    }

    // 3. 트리거 검증
    const hasTriggers = files.some((f) => f.content.includes('triggers'));
    checklist.push({
      item: '트리거 정의됨',
      passed: hasTriggers,
    });

    // 4. README 체크
    const hasReadme = files.some((f) => f.path.includes('README'));
    checklist.push({
      item: 'README 존재',
      passed: hasReadme,
    });

    // 결과 계산
    const passedCount = checklist.filter((c) => c.passed).length;
    const totalCount = checklist.length;
    const passRate = passedCount / totalCount;

    const criticalIssues = issues.filter((i) => i.severity === 'critical').length;

    let recommendation: 'approve' | 'revise' | 'reject';
    if (criticalIssues > 0) {
      recommendation = 'reject';
    } else if (passRate >= 0.8) {
      recommendation = 'approve';
    } else {
      recommendation = 'revise';
    }

    return {
      passed: passRate >= 0.8 && criticalIssues === 0,
      checklist,
      issues,
      recommendation,
    };
  }
}

// ===== Factory =====

export function createQAAgent(): QAAgent {
  return new QAAgent();
}

// ===== Test =====

async function runTest() {
  console.log('🔍 QA Agent Test\n');

  const agent = createQAAgent();

  const devOutput: DeveloperOutput = {
    files: [
      {
        path: 'skills/code-review/index.ts',
        language: 'typescript',
        content: `export const skill = {
  name: 'code-review',
  triggers: ['/review'],
  async execute(ctx: any) {
    try {
      return { success: true };
    } catch (e) {
      return { success: false };
    }
  }
};`,
      },
      {
        path: 'skills/code-review/types.ts',
        language: 'typescript',
        content: `export interface SkillContext { input: string; }`,
      },
      {
        path: 'skills/code-review/README.md',
        language: 'markdown',
        content: `# code-review\n\nCode review skill.`,
      },
    ],
    installInstructions: [],
    testCommands: ['npx tsx skills/code-review/index.ts'],
  };

  const archOutput: ArchitectOutput = {
    skillName: 'code-review',
    purpose: '코드 리뷰',
    triggers: ['/review'],
    workflow: [{ step: 1, action: 'analyze', description: '분석' }],
    fileStructure: [],
    toolsRequired: [],
    estimatedComplexity: 'simple',
  };

  const output = await agent.verify(devOutput, archOutput);
  console.log('✅ QA Result:\n');
  console.log(`Passed: ${output.passed}`);
  console.log(`Recommendation: ${output.recommendation}`);
  console.log(`\nChecklist:`);
  output.checklist.forEach((c) => {
    console.log(`  ${c.passed ? '✅' : '❌'} ${c.item}${c.note ? ` (${c.note})` : ''}`);
  });
  if (output.issues.length > 0) {
    console.log(`\nIssues:`);
    output.issues.forEach((i) => console.log(`  ⚠️ [${i.severity}] ${i.description}`));
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runTest();
}
