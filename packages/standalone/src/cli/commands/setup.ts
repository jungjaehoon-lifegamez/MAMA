/**
 * mama setup command
 *
 * Interactive setup wizard with Claude assistance
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { expandPath } from '../config/config-manager.js';
import { OAuthManager } from '../../auth/index.js';
import { startSetupServer } from '../../setup/setup-server.js';

/**
 * Options for setup command
 */
export interface SetupOptions {
  /** Port for setup server (default: 3848) */
  port?: number;
  /** Skip browser auto-open */
  noBrowser?: boolean;
}

/**
 * Execute setup command
 */
export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  console.log('\n🚀 MAMA Standalone Setup Wizard\n');

  // 1. Check Claude Code authentication
  console.log('Step 1: Claude Code 인증 확인');
  process.stdout.write('  OAuth 토큰 확인 중... ');

  const credentialsPath = expandPath('~/.claude/.credentials.json');
  if (!existsSync(credentialsPath)) {
    console.log('❌\n');
    console.error('⚠️  Claude Code 인증 파일을 찾을 수 없습니다.');
    console.error(`   예상 경로: ${credentialsPath}`);
    console.error('\n   Claude Code를 먼저 설치하고 로그인하세요:');
    console.error('   https://claude.ai/code\n');
    process.exit(1);
  }

  try {
    const oauthManager = new OAuthManager();
    const status = await oauthManager.getStatus();

    if (!status.valid) {
      console.log('❌\n');
      console.error('⚠️  OAuth 토큰이 만료되었습니다.');
      console.error('   Claude Code에 다시 로그인하세요.\n');
      process.exit(1);
    }

    console.log('✓');
    console.log(`  구독 타입: ${status.subscriptionType || 'unknown'}`);

    if (status.subscriptionType && status.subscriptionType !== 'max') {
      console.log('\n⚠️  경고: Claude Pro (Max) 구독이 권장됩니다.');
      console.log(`   현재 구독: ${status.subscriptionType}\n`);
    }
  } catch (error) {
    console.log('❌\n');
    console.error(`   OAuth 오류: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // 2. Start setup server
  console.log('\nStep 2: Setup 서버 시작');
  const port = options.port || 3848;

  let server;
  try {
    process.stdout.write(`  포트 ${port}에서 서버 시작 중... `);
    server = await startSetupServer(port);
    console.log('✓');
  } catch (error) {
    console.log('❌\n');
    console.error(`   서버 시작 실패: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // 3. Open browser
  const setupUrl = `http://localhost:${port}/setup`;

  if (!options.noBrowser) {
    console.log('\nStep 3: 브라우저 열기');
    process.stdout.write(`  ${setupUrl} 접속 중... `);

    try {
      await openBrowser(setupUrl);
      console.log('✓');
    } catch (error) {
      console.log('⚠️');
      console.log(`   자동으로 열리지 않았습니다. 수동으로 열어주세요:`);
      console.log(`   ${setupUrl}`);
    }
  }

  // 4. Instructions
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✨ Setup Wizard가 시작되었습니다!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`브라우저에서 Claude와 대화하며 설정을 완료하세요:`);
  console.log(`👉 ${setupUrl}\n`);
  console.log(`설정이 완료되면 이 터미널로 돌아와서 Ctrl+C로 종료하세요.\n`);

  // 5. Wait for Ctrl+C
  await waitForExit(server);
}

/**
 * Open browser
 */
async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  let command: string;

  if (platform === 'darwin') {
    command = 'open';
  } else if (platform === 'win32') {
    command = 'start';
  } else {
    // Linux
    command = 'xdg-open';
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, [url], {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', reject);
    child.unref();

    // Give it a moment to launch
    setTimeout(resolve, 500);
  });
}

/**
 * Wait for user to press Ctrl+C
 */
async function waitForExit(server: any): Promise<void> {
  return new Promise(() => {
    const cleanup = () => {
      console.log('\n\n🛑 Setup 서버를 종료합니다...');
      server.close(() => {
        console.log('✓ 종료 완료\n');
        process.exit(0);
      });
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}
