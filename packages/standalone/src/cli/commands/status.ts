/**
 * mama status command
 *
 * Show MAMA agent status
 */

import { isDaemonRunning, getUptime } from '../utils/pid-manager.js';
import { loadConfig, configExists, expandPath } from '../config/config-manager.js';
import { OAuthManager } from '../../auth/index.js';

/**
 * Execute status command
 */
export async function statusCommand(): Promise<void> {
  console.log('\n📊 MAMA Standalone 상태\n');

  // Check if running
  const runningInfo = await isDaemonRunning();

  if (runningInfo) {
    console.log(`상태: 실행 중 ✓`);
    console.log(`PID: ${runningInfo.pid}`);
    console.log(`가동 시간: ${getUptime(runningInfo.startedAt)}`);
  } else {
    console.log('상태: 정지됨 ✗');
    console.log('시작하려면: mama start');
  }

  console.log('');

  // OAuth token status
  process.stdout.write('OAuth 토큰: ');
  try {
    const oauthManager = new OAuthManager();
    const tokenStatus = await oauthManager.getStatus();

    if (tokenStatus.valid) {
      const expiresIn = tokenStatus.expiresIn;
      if (expiresIn !== null) {
        const hours = Math.floor(expiresIn / 3600);
        const minutes = Math.floor((expiresIn % 3600) / 60);
        if (hours > 0) {
          console.log(`유효 (${hours}시간 ${minutes}분 남음)`);
        } else {
          console.log(`유효 (${minutes}분 남음)`);
        }
      } else {
        console.log('유효');
      }

      if (tokenStatus.needsRefresh) {
        console.log('  ⚠️  곧 갱신이 필요합니다');
      }

      if (tokenStatus.subscriptionType) {
        console.log(`구독 유형: ${tokenStatus.subscriptionType}`);
      }
    } else {
      console.log('무효 ❌');
      if (tokenStatus.error) {
        console.log(`  오류: ${tokenStatus.error}`);
      }
      console.log('  Claude Code에 다시 로그인하세요.');
    }
  } catch (error) {
    console.log('확인 실패 ❌');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }

  // Config status
  if (configExists()) {
    try {
      const config = await loadConfig();
      console.log(`데이터베이스: ${expandPath(config.database.path)}`);
      console.log(`모델: ${config.agent.model}`);
      console.log(`로그 레벨: ${config.logging.level}`);
    } catch (error) {
      console.log(`설정 로드 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log('\n⚠️  설정 파일이 없습니다. mama init을 실행하세요.');
  }

  console.log('');
}
