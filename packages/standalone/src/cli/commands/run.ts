/**
 * mama run command
 *
 * Run a single prompt through the agent loop (for testing)
 */

import { loadConfig, configExists } from '../config/config-manager.js';
import { OAuthManager, getClaudeCodeAuthStatus } from '../../auth/index.js';
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
    console.log('⚠️  Configuration file not found.');
    console.log('   Please initialize first: mama init\n');
    process.exit(1);
  }

  // Load config
  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    console.error(
      `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }

  const backend = config.agent.backend;
  process.env.MAMA_BACKEND = backend;

  let oauthManager: OAuthManager;
  if (backend === 'codex-mcp') {
    console.log('✓ Codex MCP backend (OAuth handled by Codex login)');
    oauthManager = new OAuthManager();
  } else {
    process.stdout.write('Checking Claude Code login... ');
    const authStatus = getClaudeCodeAuthStatus();
    if (!authStatus.loggedIn) {
      console.log('❌');
      if (!authStatus.cliInstalled) {
        console.error('\nClaude Code CLI is not installed.');
        console.error('Install and log in first: https://claude.ai/code\n');
      } else {
        console.error('\nClaude Code is installed but not logged in.');
        console.error('Please run: claude auth login\n');
      }
      process.exit(1);
    }
    oauthManager = new OAuthManager();
    console.log('✓');
  }

  // Create agent loop
  const agentLoop = new AgentLoop(oauthManager, {
    backend,
    model: config.agent.model,
    timeoutMs: config.agent.timeout,
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
    console.log(`\n✓ Complete (${result.turns} turns, ${elapsed}s)`);
    console.log(
      `  Tokens: ${result.totalUsage.input_tokens} input / ${result.totalUsage.output_tokens} output\n`
    );
  } catch (error) {
    console.error(
      `\n❌ Execution failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
