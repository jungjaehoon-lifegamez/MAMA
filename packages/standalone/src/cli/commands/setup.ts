/**
 * mama setup command
 *
 * Interactive setup wizard with Claude assistance
 */

import { existsSync } from 'node:fs';

import { expandPath } from '../config/config-manager.js';
import type { MAMAConfig } from '../config/types.js';
import { getClaudeCodeAuthStatus } from '../../auth/index.js';
import { hasPersistedClineCredential } from '../../agent/cline-cli-adapter.js';
import { statusCommand } from './status.js';

/**
 * Options for setup command
 */
export interface SetupOptions {
  /** Port for setup server (default: 3848) */
  port?: number;
  /** Skip browser auto-open */
  noBrowser?: boolean;
}

interface SetupBackendCheckDependencies {
  getClaudeStatus: typeof getClaudeCodeAuthStatus;
  hasClineCredential: typeof hasPersistedClineCredential;
  exists: typeof existsSync;
}

export interface SetupBackendStatus {
  ok: boolean;
  detail?: string;
  error?: string;
}

export async function checkSetupBackend(
  config: MAMAConfig,
  dependencies: SetupBackendCheckDependencies = {
    getClaudeStatus: getClaudeCodeAuthStatus,
    hasClineCredential: hasPersistedClineCredential,
    exists: existsSync,
  }
): Promise<SetupBackendStatus> {
  if (config.agent.backend === 'cline') {
    const command =
      config.agent.cline_command ??
      process.env.MAMA_CLINE_COMMAND ??
      process.env.CLINE_COMMAND ??
      'cline';
    try {
      const authenticated = await dependencies.hasClineCredential({
        command,
        provider: config.agent.cline_provider,
        dataDir: config.agent.cline_data_dir,
      });
      return authenticated
        ? { ok: true, detail: `Cline Hub (${command})` }
        : { ok: false, error: 'Cline credentials are unavailable. Run: cline auth cline' };
    } catch (error) {
      return {
        ok: false,
        error: `Cline backend is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (config.agent.backend === 'codex') {
    const authPaths = [expandPath('~/.mama/.codex/auth.json'), expandPath('~/.codex/auth.json')];
    const authPath = authPaths.find((candidate) => dependencies.exists(candidate));
    return authPath
      ? { ok: true, detail: `Codex app-server (${authPath})` }
      : { ok: false, error: 'Codex credentials are unavailable. Run: codex login' };
  }

  const authStatus = dependencies.getClaudeStatus();
  if (!authStatus.loggedIn) {
    return {
      ok: false,
      error: authStatus.cliInstalled
        ? 'Claude Code is installed but not logged in. Run: claude auth login'
        : 'Claude Code CLI not found. Install it from https://claude.ai/code',
    };
  }
  const detail = authStatus.subscriptionType
    ? `Claude Code (${authStatus.subscriptionType})`
    : 'Claude Code';
  return { ok: true, detail };
}

/**
 * Execute setup command
 */
export async function setupCommand(_options: SetupOptions = {}): Promise<void> {
  await statusCommand({ json: false });
}

/**
 * Wait for user to press Ctrl+C
 */
export async function waitForExit(server: { close: () => Promise<void> }): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const cleanup = () => {
      if (closing) return;
      closing = true;
      console.log('\n\n🛑 Shutting down setup server...');
      void server
        .close()
        .then(() => {
          console.log('✓ Shutdown complete\n');
          process.exitCode = 0;
          process.off('SIGINT', cleanup);
          process.off('SIGTERM', cleanup);
          resolve();
        })
        .catch((error) => {
          process.off('SIGINT', cleanup);
          process.off('SIGTERM', cleanup);
          reject(error);
        });
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}
