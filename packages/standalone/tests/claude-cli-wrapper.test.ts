import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { DebugLogger } from '@jungjaehoon/mama-core/debug-logger';
import { ClaudeCLIWrapper } from '../src/agent/claude-cli-wrapper.js';

// Skip in CI - these tests require claude CLI to be installed
const isCI = process.env.CI === 'true';
process.env.MAMA_FORCE_TIER_3 = 'true';
const testLogger = new DebugLogger('ClaudeCLIWrapperTest');
const hasClaudeCli = (() => {
  const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude';
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || err.status === 127) {
      return false;
    }
    throw new Error(`Failed to check claude CLI availability: ${err.message || String(error)}`);
  }
})();
const shouldSkip = isCI || !hasClaudeCli;

describe('ClaudeCLIWrapper', () => {
  /**
   * Story ID: CLI-001
   * Acceptance Criteria:
   * - CLI prompt returns response with usage stats.
   * - Costs can be aggregated across calls.
   * - Session continuity test remains skipped with documented rationale.
   */
  it.skipIf(shouldSkip)(
    'should execute a simple prompt and return usage stats',
    async () => {
      const wrapper = new ClaudeCLIWrapper({ dangerouslySkipPermissions: true });

      const result = await wrapper.prompt('What is 2+2? Answer with just the number.', {
        onDelta: (text) => testLogger.info('[Test] Delta:', text),
      });

      testLogger.info('[Test] Result:', result);

      expect(result.response).toBeTruthy();
      expect(result.usage.input_tokens).toBeGreaterThan(0);
      expect(result.usage.output_tokens).toBeGreaterThan(0);
      expect(result.cost_usd).toBeGreaterThan(0);
      expect(result.session_id).toBeTruthy();
    },
    60000 // Increased timeout - Claude CLI can take longer on first run
  );

  it.skip('should maintain session continuity across multiple prompts', async () => {
    // SKIPPED: Each prompt() spawns a new claude process, causing "Session ID already in use" errors.
    // Session continuity would require keeping a single claude process alive and communicating via stdin/stdout,
    // which is not the current implementation.
    const testSessionId = randomUUID();
    const wrapper = new ClaudeCLIWrapper({
      sessionId: testSessionId,
      dangerouslySkipPermissions: true,
    });

    const result1 = await wrapper.prompt('My favorite color is blue. Remember this.');
    expect(result1.session_id).toBe(testSessionId);

    const result2 = await wrapper.prompt('What is my favorite color?');
    expect(result2.session_id).toBe(testSessionId);
    expect(result2.response.toLowerCase()).toContain('blue');
  }, 60000);

  it.skipIf(shouldSkip)(
    'should track cumulative costs across multiple calls',
    async () => {
      let totalCost = 0;

      for (let i = 0; i < 3; i++) {
        const wrapper = new ClaudeCLIWrapper({ dangerouslySkipPermissions: true });
        const result = await wrapper.prompt(`Count to ${i + 1}`);
        totalCost += result.cost_usd || 0;
        testLogger.info(`[Test] Call ${i + 1}: $${result.cost_usd?.toFixed(6)}`);
      }

      testLogger.info(`[Test] Total cost: $${totalCost.toFixed(6)}`);
      expect(totalCost).toBeGreaterThan(0);
    },
    90000
  );
});
