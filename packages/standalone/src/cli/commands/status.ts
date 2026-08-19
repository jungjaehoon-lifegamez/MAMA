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
import { resolvePackageVersion } from '../../package-version.js';

export function formatVersionStatus(cliVersion: string, runtimeVersion: string | null): string[] {
  const lines = [
    `CLI version: ${cliVersion}`,
    `Runtime version: ${runtimeVersion ?? 'unavailable'}`,
  ];
  if (runtimeVersion !== null && runtimeVersion !== cliVersion) {
    lines.push(
      '⚠️  Version mismatch: the running daemon and this CLI use different packages. Verify or update the daemon service entrypoint, then restart and recheck.'
    );
  }
  return lines;
}

/**
 * Execute status command
 */
export async function statusCommand(): Promise<void> {
  console.log('\n📊 MAMA Standalone Status\n');

  // Check if running
  const runningInfo = await isDaemonRunning();
  const runtimeVersionPromise = runningInfo
    ? fetchRuntimeVersion()
    : Promise.resolve<string | null>(null);

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
  for (const line of formatVersionStatus(resolvePackageVersion(), await runtimeVersionPromise)) {
    console.log(line);
  }
  console.log('');

  // Config status
  if (configExists()) {
    try {
      const config = await loadConfig();
      const backend = config.agent.backend;
      console.log(`Backend: ${backend}`);
      if (backend === 'codex') {
        console.log('Codex transport: app-server');
      } else if (backend === 'cline') {
        console.log('Cline transport: Hub runtime');
        console.log(`Cline provider: ${config.agent.cline_provider ?? 'cline'}`);
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

export interface RuntimeVersionEndpointOptions {
  hostname?: string;
  port?: number;
  timeoutMs?: number;
}

const MAX_RUNTIME_VERSION_RESPONSE_BYTES = 64 * 1024;

export function fetchRuntimeVersion(
  options: RuntimeVersionEndpointOptions = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? 2000;
    let settled = false;
    let response: http.IncomingMessage | undefined;

    const settle = (value: string | null, destroy = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (destroy) {
        response?.destroy();
        req.destroy();
      }
      resolve(value);
    };

    const deadline = setTimeout(() => settle(null, true), timeoutMs);
    const req = http.request(
      {
        hostname: options.hostname ?? '127.0.0.1',
        port: options.port ?? 3847,
        path: '/api/runtime/status',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        response = res;
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        let ended = false;

        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          responseBytes += chunk.byteLength;
          if (responseBytes > MAX_RUNTIME_VERSION_RESPONSE_BYTES) {
            settle(null, true);
            return;
          }
          chunks.push(chunk);
        });
        res.once('aborted', () => settle(null, true));
        res.once('error', () => settle(null, true));
        res.on('end', () => {
          ended = true;
          if (settled) return;
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              version?: unknown;
            };
            settle(
              typeof json.version === 'string' && json.version.length > 0 ? json.version : null
            );
          } catch {
            settle(null);
          }
        });
        res.once('close', () => {
          if (!ended) settle(null, true);
        });
      }
    );
    req.once('error', () => settle(null));
    req.on('timeout', () => {
      settle(null, true);
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
