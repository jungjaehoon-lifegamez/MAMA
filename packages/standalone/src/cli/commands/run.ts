/**
 * mama run command
 *
 * Run a single prompt through the agent loop (for testing)
 */

import { loadConfig, configExists } from '../config/config-manager.js';
import { OAuthManager } from '../../auth/index.js';
import { AgentLoop } from '../../agent/index.js';

/**
 * Options for run command
 */
export interface RunOptions {
  /** Prompt to execute */
  prompt: string;
  /** Enable verbose output */
  verbose?: boolean;
}

/**
 * Execute run command
 */
export async function runCommand(options: RunOptions): Promise<void> {
  console.log('\n🤖 MAMA Run - Single Prompt Execution\n');

  // Check config exists
  if (!configExists()) {
    console.log('⚠️  설정 파일이 없습니다.');
    console.log('   먼저 초기화하세요: mama init\n');
    process.exit(1);
  }

  // Load config
  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    console.error(`설정 로드 실패: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // Check OAuth token
  process.stdout.write('OAuth 토큰 확인... ');
  let oauthManager: OAuthManager;
  try {
    oauthManager = new OAuthManager();
    await oauthManager.getToken();
    console.log('✓');
  } catch (error) {
    console.log('❌');
    console.error(`\nOAuth 토큰 오류: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Claude Code에 다시 로그인하세요.\n');
    process.exit(1);
  }

  // Create agent loop
  const agentLoop = new AgentLoop(oauthManager, {
    model: config.agent.model,
    maxTurns: config.agent.max_turns,
    onTurn: options.verbose
      ? (turn) => {
          console.log(`\n--- Turn ${turn.turn} (${turn.role}) ---`);
          if (turn.stopReason) {
            console.log(`Stop reason: ${turn.stopReason}`);
          }
          if (turn.usage) {
            console.log(`Tokens: ${turn.usage.input_tokens} in / ${turn.usage.output_tokens} out`);
          }
        }
      : undefined,
    onToolUse: options.verbose
      ? (toolName, input, result) => {
          console.log(`\n🔧 Tool: ${toolName}`);
          console.log(`   Input: ${JSON.stringify(input)}`);
          console.log(`   Result: ${JSON.stringify(result).substring(0, 200)}...`);
        }
      : undefined,
  });

  // Run the prompt
  console.log(`\n📝 Prompt: "${options.prompt}"\n`);
  console.log('─'.repeat(50));
  console.log('Processing...\n');

  try {
    const startTime = Date.now();
    const result = await agentLoop.run(options.prompt);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('─'.repeat(50));
    console.log('\n📤 Response:\n');
    console.log(result.response);
    console.log('\n─'.repeat(50));
    console.log(`\n✓ 완료 (${result.turns} turns, ${elapsed}s)`);
    console.log(
      `  Tokens: ${result.totalUsage.input_tokens} input / ${result.totalUsage.output_tokens} output\n`
    );
  } catch (error) {
    console.error(`\n❌ 실행 실패: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
