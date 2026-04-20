#!/usr/bin/env node

const { existsSync, mkdirSync, cpSync, readdirSync } = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Copy templates to ~/.mama/ directory
 */
async function copyTemplates() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const mamaDir = path.join(homeDir, '.mama');
  const skillsDir = path.join(mamaDir, 'skills');
  const workspaceDir = path.join(mamaDir, 'workspace');

  // Create directories if they don't exist
  if (!existsSync(mamaDir)) {
    mkdirSync(mamaDir, { recursive: true });
  }
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  // Find templates directory (in npm package or local)
  const packageRoot = path.resolve(__dirname, '..');
  const templatesDir = path.join(packageRoot, 'templates');

  if (existsSync(templatesDir)) {
    // Copy skills templates (only if not exist)
    const skillsTemplateDir = path.join(templatesDir, 'skills');
    if (existsSync(skillsTemplateDir)) {
      const skillFiles = readdirSync(skillsTemplateDir);
      for (const file of skillFiles) {
        const dest = path.join(skillsDir, file);
        if (!existsSync(dest)) {
          cpSync(path.join(skillsTemplateDir, file), dest);
          console.log(`  ✓ Skill 설치: ${file}`);
        }
      }
    }

    // Copy skill-forge (only if not exist)
    const forgeTemplateDir = path.join(templatesDir, 'workspace', 'skill-forge');
    const forgeDestDir = path.join(workspaceDir, 'skill-forge');
    if (existsSync(forgeTemplateDir) && !existsSync(forgeDestDir)) {
      cpSync(forgeTemplateDir, forgeDestDir, { recursive: true });
      console.log('  ✓ Skill Forge 설치 완료');
    }
  }
}

function getClaudeCodeAuthStatus() {
  const credentialsPath = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.claude',
    '.credentials.json'
  );

  try {
    const stdout = execFileSync('claude', ['auth', 'status'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout);
    if (parsed && parsed.loggedIn) {
      return {
        cliInstalled: true,
        loggedIn: true,
        source: 'cli_status',
        subscriptionType: parsed.subscriptionType || null,
      };
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        cliInstalled: false,
        loggedIn: existsSync(credentialsPath),
        source: existsSync(credentialsPath) ? 'legacy_credentials' : 'none',
        subscriptionType: null,
      };
    }
  }

  return {
    cliInstalled: true,
    loggedIn: existsSync(credentialsPath),
    source: existsSync(credentialsPath) ? 'legacy_credentials' : 'none',
    subscriptionType: null,
  };
}

async function main() {
  console.log('\n🚀 MAMA Standalone 설치 완료!\n');

  // Copy templates to ~/.mama/
  console.log('📦 기본 스킬 설치 중...');
  try {
    await copyTemplates();
  } catch (err) {
    console.warn('  ⚠️  템플릿 복사 실패:', err.message);
  }
  console.log('');

  const nodeVersion = parseInt(process.versions.node.split('.')[0]);
  if (nodeVersion < 18) {
    console.warn('⚠️  경고: Node.js 18+ 권장 (현재:', process.versions.node, ')\n');
  }

  console.log('📝 Embedding 스택 워밍업 중...');
  console.log('   source: @jungjaehoon/mama-core/embeddings\n');

  try {
    const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
    const vector = await generateEmbedding('MAMA standalone postinstall warmup');
    console.log('✓ Embedding 스택 준비 완료 (차원:', vector.length, ')\n');
  } catch (err) {
    console.warn('⚠️  Embedding 스택 워밍업 실패:', err.message);
    console.warn('   첫 사용 시 자동 초기화됩니다.\n');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✨ 설치 완료!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const authStatus = getClaudeCodeAuthStatus();
  if (authStatus.loggedIn) {
    console.log('✓ Claude Code 인증 발견\n');
    if (authStatus.source === 'cli_status') {
      const suffix = authStatus.subscriptionType ? ` (${authStatus.subscriptionType})` : '';
      console.log(`   source: claude auth status${suffix}\n`);
    } else {
      console.log('   source: legacy ~/.claude/.credentials.json fallback\n');
    }
    console.log('다음 단계:');
    console.log('  1. mama setup    # 대화형 설정 마법사');
    console.log('  2. mama start    # 서버 시작');
    console.log('  3. mama status   # 상태 확인\n');
  } else {
    console.log('⚠️  Claude Code 인증 없음\n');
    if (!authStatus.cliInstalled) {
      console.log('Claude Code를 먼저 설치하고 로그인하세요:');
      console.log('  https://claude.ai/code\n');
    } else {
      console.log('Claude Code는 설치되어 있지만 로그인되어 있지 않습니다.');
      console.log('다음 명령으로 로그인하세요:\n');
      console.log('  claude auth login\n');
    }
    console.log('로그인 후 다시 시도하세요:\n');
    console.log('  mama setup\n');
  }

  console.log('문서: https://github.com/jungjaehoon-lifegamez/MAMA\n');
}

main().catch((err) => {
  console.error('Postinstall 오류:', err.message);
  process.exit(0);
});
