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
import { createConnectorCommand } from './commands/connector.js';
import { createGatewayCommand } from './commands/gateway.js';
import { createReportCommand } from './commands/report.js';
import { initConfig } from './config/config-manager.js';
import { resolvePackageVersion } from '../package-version.js';
import { renderContractIntro } from '../onboarding/agent-contract.js';

const VERSION = resolvePackageVersion();

const program = new Command();

program
  .name('mama')
  .description('MAMA Standalone - Always-on AI Assistant')
  .version(VERSION, '-v, --version', 'Print version information');

program.addHelpText('after', `\n${renderContractIntro()}\n`);

program
  .command('init')
  .description('Initialize MAMA configuration')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('--skip-auth-check', 'Skip authentication check (for testing)')
  .option(
    '--backend <backend>',
    'Preferred backend: auto | claude | codex | cline (default: auto)',
    'auto'
  )
  .action(async (options) => {
    const backend =
      options.backend === 'claude' || options.backend === 'codex' || options.backend === 'cline'
        ? options.backend
        : 'auto';
    await initCommand({
      force: options.force,
      skipAuthCheck: options.skipAuthCheck,
      backend,
    });
  });

program
  .command('setup')
  .description('Print onboarding contract and current state')
  .action(async () => {
    await setupCommand();
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
  .option('--json', 'Machine-readable status with onboarding contract')
  .action(async (options: { json?: boolean }) => {
    await statusCommand(options);
  });

program
  .command('run')
  .description('Run a single prompt (for testing)')
  .argument('<prompt>', 'Prompt to execute')
  .option('-v, --verbose', 'Verbose output')
  .action(async (prompt, options) => {
    await runCommand({ prompt, verbose: options.verbose });
  });

program.addCommand(createConnectorCommand());
program.addCommand(createGatewayCommand());
program.addCommand(createReportCommand());

// Hidden daemon command (used internally for background process)
program
  .command('daemon', { hidden: true })
  .description('Run as daemon (internal use)')
  .action(async () => {
    try {
      const config = await initConfig();
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
