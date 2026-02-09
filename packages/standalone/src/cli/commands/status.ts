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
  console.log('\n📊 MAMA Standalone Status\n');

  // Check if running
  const runningInfo = await isDaemonRunning();

  if (runningInfo) {
    console.log(`Status: Running ✓`);
    console.log(`PID: ${runningInfo.pid}`);
    console.log(`Uptime: ${getUptime(runningInfo.startedAt)}`);
  } else {
    console.log('Status: Stopped ✗');
    console.log('To start: mama start');
  }

  console.log('');

  // OAuth token status
  process.stdout.write('OAuth token: ');
  try {
    const oauthManager = new OAuthManager();
    const tokenStatus = await oauthManager.getStatus();

    if (tokenStatus.valid) {
      const expiresIn = tokenStatus.expiresIn;
      if (expiresIn !== null) {
        const hours = Math.floor(expiresIn / 3600);
        const minutes = Math.floor((expiresIn % 3600) / 60);
        if (hours > 0) {
          console.log(`Valid (${hours}h ${minutes}m remaining)`);
        } else {
          console.log(`Valid (${minutes}m remaining)`);
        }
      } else {
        console.log('Valid');
      }

      if (tokenStatus.needsRefresh) {
        console.log('  ⚠️  Refresh needed soon');
      }

      if (tokenStatus.subscriptionType) {
        console.log(`Subscription type: ${tokenStatus.subscriptionType}`);
      }
    } else {
      console.log('Invalid ❌');
      if (tokenStatus.error) {
        console.log(`  Error: ${tokenStatus.error}`);
      }
      console.log('  Please log in to Claude Code again.');
    }
  } catch (error) {
    console.log('Check failed ❌');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }

  // Config status
  if (configExists()) {
    try {
      const config = await loadConfig();
      console.log(`Database: ${expandPath(config.database.path)}`);
      console.log(`Model: ${config.agent.model}`);
      console.log(`Log level: ${config.logging.level}`);
    } catch (error) {
      console.log(
        `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    console.log('\n⚠️  Configuration file not found. Please run mama init.');
  }

  console.log('');
}
