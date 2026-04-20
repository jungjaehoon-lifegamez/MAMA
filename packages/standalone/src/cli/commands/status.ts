/**
 * mama status command
 *
 * Show MAMA agent status
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import http from 'node:http';
import { isDaemonRunning, getUptime, isProcessRunning } from '../utils/pid-manager.js';
import { loadConfig, configExists, expandPath } from '../config/config-manager.js';
import { OAuthManager, getClaudeCodeAuthStatus } from '../../auth/index.js';

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

    // Health score
    const health = await fetchHealthScore();
    if (health) {
      console.log(`Health: ${health.score}/100 (${health.status})`);
      if (health.checks && health.checks.length > 0) {
        for (const c of health.checks) {
          const icon =
            c.status === 'pass'
              ? '✓'
              : c.severity === 'critical'
                ? '✗'
                : c.status === 'warn' || c.status === 'fail'
                  ? '⚠'
                  : 'ℹ';
          console.log(`  ${icon} ${c.name}: ${c.message}`);
        }
      }
    }

    // Watchdog status
    const watchdogStatus = getWatchdogStatus();
    if (watchdogStatus) {
      console.log(`Watchdog: Active ✓ (PID ${watchdogStatus.pid})`);
    } else {
      console.log('Watchdog: Inactive ✗');
    }
  } else {
    console.log('Status: Stopped ✗');
    console.log('To start: mama start');
  }

  console.log('');

  // Config status
  if (configExists()) {
    try {
      const config = await loadConfig();
      const backend = config.agent.backend;
      console.log(`Backend: ${backend}`);
      if (backend === 'codex-mcp') {
        console.log('Codex MCP backend: Uses MCP protocol for Codex communication');
      } else {
        const authStatus = getClaudeCodeAuthStatus();
        process.stdout.write('Claude Code auth: ');

        if (!authStatus.loggedIn) {
          if (!authStatus.cliInstalled) {
            console.log('Missing ❌');
            console.log('  Install Claude Code first: https://claude.ai/code');
          } else {
            console.log('Logged out ❌');
            console.log('  Run: claude auth login');
          }
        } else if (authStatus.source === 'cli_status') {
          const summary = authStatus.subscriptionType
            ? `Valid (${authStatus.authMethod ?? 'unknown'}, ${authStatus.subscriptionType})`
            : `Valid (${authStatus.authMethod ?? 'unknown'})`;
          console.log(summary);
        } else {
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
        }
      }

      console.log(`Database: ${expandPath(config.database.path)}`);
      console.log(`Model: ${config.agent.model}`);
      if (config.agent.tools) {
        const gatewayTools = config.agent.tools.gateway ?? ['*'];
        const mcpTools = config.agent.tools.mcp ?? [];
        const mcpConfigPath = expandPath(
          config.agent.tools.mcp_config ?? '~/.mama/mama-mcp-config.json'
        );
        console.log(
          `Tool routing: gateway=${gatewayTools.length} pattern(s), mcp=${mcpTools.length} pattern(s)`
        );
        console.log(`MCP config: ${mcpConfigPath}`);
      }
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

interface HealthCheck {
  name: string;
  severity: string;
  status: string;
  message: string;
}

function fetchHealthScore(): Promise<{
  score: number;
  status: string;
  checks?: HealthCheck[];
} | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3847,
        path: '/api/metrics/health',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (typeof json.score === 'number' && typeof json.status === 'string') {
              resolve({ score: json.score, status: json.status, checks: json.checks });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function getWatchdogStatus(): { pid: number; startedAt: number } | null {
  const watchdogPidPath = `${homedir()}/.mama/watchdog.pid`;
  if (!existsSync(watchdogPidPath)) return null;
  try {
    const content = readFileSync(watchdogPidPath, 'utf-8');
    const info = JSON.parse(content);
    if (typeof info.pid === 'number' && isProcessRunning(info.pid)) {
      return info;
    }
  } catch {
    /* ignore */
  }
  return null;
}
