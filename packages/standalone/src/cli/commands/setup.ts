/**
 * mama setup command
 *
 * Interactive setup wizard with Claude assistance
 */

import { spawn } from 'node:child_process';

import { expandPath } from '../config/config-manager.js';
import { getClaudeCodeAuthStatus } from '../../auth/index.js';
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
  console.log('Step 1: Checking Claude Code authentication');
  process.stdout.write('  Checking Claude Code login... ');

  const authStatus = getClaudeCodeAuthStatus();
  if (!authStatus.loggedIn) {
    console.log('❌\n');
    if (!authStatus.cliInstalled) {
      console.error('⚠️  Claude Code CLI not found.');
      console.error('\n   Please install and log in to Claude Code first:');
      console.error('   https://claude.ai/code\n');
    } else {
      console.error('⚠️  Claude Code is installed but not logged in.');
      console.error('   Please run:\n');
      console.error('   claude auth login\n');
    }
    process.exit(1);
  }

  console.log('✓');
  if (authStatus.subscriptionType) {
    console.log(`  Subscription type: ${authStatus.subscriptionType}`);
  }
  if (authStatus.source === 'legacy_credentials') {
    console.log(`  Legacy credentials file detected: ${expandPath('~/.claude/.credentials.json')}`);
  }
  if (authStatus.subscriptionType && authStatus.subscriptionType !== 'max') {
    console.log('\n⚠️  Warning: Claude Pro (Max) subscription is recommended.');
    console.log(`   Current subscription: ${authStatus.subscriptionType}\n`);
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
  console.log(`Complete the setup by chatting with Claude in your browser:`);
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
async function waitForExit(server: { close: (callback: () => void) => void }): Promise<void> {
  return new Promise(() => {
    const cleanup = () => {
      console.log('\n\n🛑 Shutting down setup server...');
      server.close(() => {
        console.log('✓ Shutdown complete\n');
        process.exit(0);
      });
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}
