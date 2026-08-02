/**
 * mama setup command
 *
 * Interactive setup wizard with Claude assistance
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { expandPath, initConfig } from '../config/config-manager.js';
import type { MAMAConfig } from '../config/types.js';
import { getClaudeCodeAuthStatus } from '../../auth/index.js';
import { hasPersistedClineCredential } from '../../agent/cline-cli-adapter.js';
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
export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  console.log('\n🚀 MAMA Standalone Setup Wizard\n');

  const config = await initConfig();

  // 1. Check the configured backend only
  console.log(`Step 1: Checking ${config.agent.backend} backend authentication`);
  process.stdout.write(`  Checking ${config.agent.backend} backend... `);

  const backendStatus = await checkSetupBackend(config);
  if (!backendStatus.ok) {
    console.log('❌\n');
    console.error(`⚠️  ${backendStatus.error}\n`);
    process.exit(1);
  }

  console.log('✓');
  if (backendStatus.detail) {
    console.log(`  Backend: ${backendStatus.detail}`);
  }

  // 2. Start setup server
  console.log('\nStep 2: Starting setup server');
  const port = options.port || 3848;

  let server;
  try {
    process.stdout.write(`  Starting server on port ${port}... `);
    server = await startSetupServer(port);
    console.log('✓');
  } catch (error) {
    console.log('❌\n');
    console.error(
      `   Failed to start server: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  // 3. Open browser
  const setupUrl = `http://localhost:${port}/setup`;

  if (!options.noBrowser) {
    console.log('\nStep 3: Opening browser');
    process.stdout.write(`  Opening ${setupUrl}... `);

    try {
      await openBrowser(setupUrl);
      console.log('✓');
    } catch {
      console.log('⚠️');
      console.log(`   Could not open automatically. Please open manually:`);
      console.log(`   ${setupUrl}`);
    }
  }

  // 4. Instructions
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✨ Setup Wizard has started!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`Complete the setup by chatting with MAMA in your browser:`);
  console.log(`👉 ${setupUrl}\n`);
  console.log(`When setup is complete, return to this terminal and press Ctrl+C to exit.\n`);

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
