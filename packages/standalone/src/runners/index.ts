/**
 * Runner Module
 *
 * Provides dual runner architecture:
 * - Embedded Runner: Direct Anthropic API calls
 * - CLI Runner: Claude Code CLI subprocess
 */

export { CliRunner } from './cli-runner.js';

export type { Runner, RunnerType, RunnerOptions, RunnerResult, CliBackendConfig } from './types.js';

export { DEFAULT_CLAUDE_BACKEND } from './types.js';
