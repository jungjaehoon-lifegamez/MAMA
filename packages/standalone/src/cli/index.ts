#!/usr/bin/env node

/**
 * MAMA Standalone CLI
 *
 * Entry point for the mama command
 */

import { Command } from 'commander';

import { initCommand } from './commands/init.js';
import { setupCommand } from './commands/setup.js';
import { startCommand, runAgentLoop } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { runCommand } from './commands/run.js';
import { loadConfig } from './config/config-manager.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read version from package.json at runtime
const getVersion = (): string => {
  try {
    // Try relative path from dist/cli/index.js
    const pkgPath = join(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown'; // Fallback if package.json not found
  }
};
const VERSION = getVersion();

const program = new Command();

program
  .name('mama')
  .description('MAMA Standalone - Always-on AI Assistant powered by Claude Pro')
  .version(VERSION, '-v, --version', 'Print version information');

program
  .command('init')
  .description('Initialize MAMA configuration')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('--skip-auth-check', 'Skip authentication check (for testing)')
  .option(
    '--backend <backend>',
    'Preferred backend: auto | claude | codex-mcp (default: auto)',
    'auto'
  )
  .action(async (options) => {
    const backend =
      options.backend === 'claude' || options.backend === 'codex-mcp' ? options.backend : 'auto';
    await initCommand({
      force: options.force,
      skipAuthCheck: options.skipAuthCheck,
      backend,
    });
  });

program
  .command('setup')
  .description('Interactive setup wizard (guided by Claude)')
  .option('-p, --port <port>', 'Port number', '3848')
  .option('--no-browser', 'Disable automatic browser opening')
  .action(async (options) => {
    await setupCommand({
      port: parseInt(options.port),
      noBrowser: !options.browser,
    });
  });

program
  .command('start')
  .description('Start MAMA agent')
  .option('-f, --foreground', 'Run in foreground')
  .action(async (options) => {
    await startCommand({ foreground: options.foreground });
  });

program
  .command('stop')
  .description('Stop MAMA agent')
  .action(async () => {
    await stopCommand();
  });

program
  .command('status')
  .description('Check MAMA agent status')
  .action(async () => {
    await statusCommand();
  });

program
  .command('run')
  .description('Run a single prompt (for testing)')
  .argument('<prompt>', 'Prompt to execute')
  .option('-v, --verbose', 'Verbose output')
  .action(async (prompt, options) => {
    await runCommand({ prompt, verbose: options.verbose });
  });

// Hidden daemon command (used internally for background process)
program
  .command('daemon', { hidden: true })
  .description('Run as daemon (internal use)')
  .action(async () => {
    try {
      const config = await loadConfig();
      await runAgentLoop(config);
    } catch (error) {
      console.error('Daemon error:', error);
      process.exit(1);
    }
  });

// Parse arguments
program.parse();

// If no arguments, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
