/**
 * mama run command
 *
 * Run a single prompt through the agent loop (for testing)
 */

import { loadConfig, configExists, expandPath } from '../config/config-manager.js';
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

  const backend = config.agent.backend ?? 'claude';
  process.env.MAMA_BACKEND = backend;

  let oauthManager: OAuthManager;
  if (backend === 'codex') {
    console.log('✓ Codex CLI backend (OAuth handled by Codex login)');
    oauthManager = new OAuthManager();
  } else {
    // Check OAuth token
    process.stdout.write('Verifying OAuth token... ');
    try {
      oauthManager = new OAuthManager();
      await oauthManager.getToken();
      console.log('✓');
    } catch (error) {
      console.log('❌');
      console.error(
        `\nOAuth token error: ${error instanceof Error ? error.message : String(error)}`
      );
      console.error('Please log in to Claude Code again.\n');
      process.exit(1);
    }
  }

  // Create agent loop
  const agentLoop = new AgentLoop(oauthManager, {
    backend,
    model: config.agent.model,
    codexHome: config.agent.codex_home ? expandPath(config.agent.codex_home) : undefined,
    codexCwd: config.agent.codex_cwd ? expandPath(config.agent.codex_cwd) : undefined,
    codexSandbox: config.agent.codex_sandbox,
    codexSkipGitRepoCheck: config.agent.codex_skip_git_repo_check,
    codexProfile: config.agent.codex_profile,
    codexEphemeral: config.agent.codex_ephemeral,
    codexAddDirs: config.agent.codex_add_dirs,
    codexConfigOverrides: config.agent.codex_config_overrides,
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
