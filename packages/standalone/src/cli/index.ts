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

const VERSION = '1.0.0';

const program = new Command();

program
  .name('mama')
  .description('MAMA Standalone - Always-on AI Assistant powered by Claude Pro')
  .version(VERSION, '-v, --version', '버전 정보 출력');

program
  .command('init')
  .description('MAMA 설정 초기화')
  .option('-f, --force', '기존 설정 덮어쓰기')
  .option('--skip-auth-check', '인증 확인 건너뛰기 (테스트용)')
  .action(async (options) => {
    await initCommand({
      force: options.force,
      skipAuthCheck: options.skipAuthCheck,
    });
  });

program
  .command('setup')
  .description('대화형 설정 마법사 (Claude가 도와드립니다)')
  .option('-p, --port <port>', '포트 번호', '3848')
  .option('--no-browser', '브라우저 자동 열기 끄기')
  .action(async (options) => {
    await setupCommand({
      port: parseInt(options.port),
      noBrowser: !options.browser,
    });
  });

program
  .command('start')
  .description('MAMA 에이전트 시작')
  .option('-f, --foreground', 'Foreground에서 실행')
  .action(async (options) => {
    await startCommand({ foreground: options.foreground });
  });

program
  .command('stop')
  .description('MAMA 에이전트 종료')
  .action(async () => {
    await stopCommand();
  });

program
  .command('status')
  .description('MAMA 에이전트 상태 확인')
  .action(async () => {
    await statusCommand();
  });

program
  .command('run')
  .description('단일 프롬프트 실행 (테스트용)')
  .argument('<prompt>', '실행할 프롬프트')
  .option('-v, --verbose', '상세 출력')
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
