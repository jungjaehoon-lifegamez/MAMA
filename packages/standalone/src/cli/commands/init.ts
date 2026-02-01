/**
 * mama init command
 *
 * Initialize MAMA configuration
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import {
  createDefaultConfig,
  configExists,
  getConfigPath,
  expandPath,
} from '../config/config-manager.js';
import { BOOTSTRAP_TEMPLATE } from '../../onboarding/bootstrap-template.js';

/**
 * CLAUDE.md template for workspace documentation
 */
const CLAUDE_MD_TEMPLATE = `# MAMA

저는 MAMA, 지속적 메모리를 가진 AI 비서입니다.

## 워크스페이스 (중요!)

**모든 파일 작업은 아래 경로에서만 수행하세요:**

| 용도 | 경로 |
|------|------|
| 작업 디렉토리 | \`~/.mama/workspace/\` |
| 스킬 저장 | \`~/.mama/skills/\` |
| 스크립트 | \`~/.mama/workspace/scripts/\` |
| 데이터 | \`~/.mama/workspace/data/\` |
| 로그 | \`~/.mama/logs/\` |

**절대 사용 금지:**
- \`~/.openclaw/\` - 다른 프로젝트
- \`~/project/\` - 사용자 프로젝트 (명시적 요청 없이 수정 금지)

## 메모리 시스템

MAMA는 결정의 진화를 추적합니다:

\`\`\`
결정 v1 (실패) → v2 (부분 성공) → v3 (성공)
\`\`\`

과거 결정을 검색하면 전체 맥락을 볼 수 있습니다.

## 사용 가능한 명령어

- \`mama start\` - 에이전트 시작
- \`mama stop\` - 에이전트 중지
- \`mama status\` - 상태 확인
- \`mama run <command>\` - 일회성 명령 실행
`;

/**
 * Options for init command
 */
export interface InitOptions {
  /** Force overwrite existing config */
  force?: boolean;
  /** Skip Claude Code authentication check (for testing) */
  skipAuthCheck?: boolean;
}

/**
 * Execute init command
 */
export async function initCommand(options: InitOptions = {}): Promise<void> {
  console.log('\n🔧 MAMA Standalone 초기화\n');

  if (!options.skipAuthCheck) {
    const credentialsPath = expandPath('~/.claude/.credentials.json');
    process.stdout.write('Claude Code 인증 확인... ');

    if (!existsSync(credentialsPath)) {
      console.log('❌');
      console.error('\n⚠️  Claude Code 인증 파일을 찾을 수 없습니다.');
      console.error(`   예상 경로: ${credentialsPath}`);
      console.error('\n   Claude Code를 먼저 설치하고 로그인하세요:');
      console.error('   https://claude.ai/code\n');
      process.exit(1);
    }
    console.log('✓');
  }

  // Check if config already exists
  if (configExists() && !options.force) {
    console.log(`\n⚠️  설정 파일이 이미 존재합니다: ${getConfigPath()}`);
    console.log('   덮어쓰려면 --force 옵션을 사용하세요.\n');
    process.exit(1);
  }

  // Create config
  process.stdout.write('설정 파일 생성 중... ');
  try {
    const configPath = await createDefaultConfig(options.force);
    console.log('✓');
    console.log(`\n${configPath} 생성 완료\n`);
  } catch (error) {
    console.log('❌');
    console.error(
      `\n설정 파일 생성 실패: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  // Create directory structure
  const directories = [
    { path: '~/.mama/skills', label: '스킬 디렉토리' },
    { path: '~/.mama/workspace', label: '워크스페이스' },
    { path: '~/.mama/workspace/scripts', label: '스크립트 디렉토리' },
    { path: '~/.mama/workspace/data', label: '데이터 디렉토리' },
    { path: '~/.mama/logs', label: '로그 디렉토리' },
  ];

  for (const dir of directories) {
    const expandedPath = expandPath(dir.path);
    process.stdout.write(`${dir.label} 생성 중... `);
    try {
      if (!existsSync(expandedPath)) {
        await mkdir(expandedPath, { recursive: true });
        console.log('✓');
      } else {
        console.log('(이미 존재)');
      }
    } catch (error) {
      console.log('❌');
      console.error(
        `\n${dir.label} 생성 실패: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  }

  // Create CLAUDE.md
  const claudeMdPath = expandPath('~/.mama/CLAUDE.md');
  process.stdout.write('CLAUDE.md 생성 중... ');
  try {
    if (existsSync(claudeMdPath) && !options.force) {
      console.log('(이미 존재)');
    } else {
      await writeFile(claudeMdPath, CLAUDE_MD_TEMPLATE, 'utf-8');
      console.log('✓');
    }
  } catch (error) {
    console.log('❌');
    console.error(
      `\nCLAUDE.md 생성 실패: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  const bootstrapPath = expandPath('~/.mama/BOOTSTRAP.md');
  process.stdout.write('BOOTSTRAP.md 생성 중... ');
  try {
    if (existsSync(bootstrapPath) && !options.force) {
      console.log('(이미 존재)');
    } else {
      await writeFile(bootstrapPath, BOOTSTRAP_TEMPLATE, 'utf-8');
      console.log('✓');
    }
  } catch (error) {
    console.log('❌');
    console.error(
      `\nBOOTSTRAP.md 생성 실패: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  // Show next steps
  console.log('\n다음 단계:');
  console.log('  mama setup    대화형 설정 마법사 (처음 실행)');
  console.log('  mama start    에이전트 시작');
  console.log('  mama status   상태 확인');
  console.log('');
}
