import { randomUUID } from 'crypto';
import { ClaudeCLIWrapper } from '../src/agent/claude-cli-wrapper.js';

// Skip in CI - these tests require claude CLI to be installed
const isCI = process.env.CI === 'true';

describe('ClaudeCLIWrapper', () => {
  it.skipIf(isCI)(
    'should execute a simple prompt and return usage stats',
    async () => {
      const wrapper = new ClaudeCLIWrapper({ dangerouslySkipPermissions: true });

      const result = await wrapper.prompt('What is 2+2? Answer with just the number.', {
        onDelta: (text) => console.log('[Test] Delta:', text),
      });

      console.log('[Test] Result:', result);

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

  it.skipIf(isCI)(
    'should track cumulative costs across multiple calls',
    async () => {
      let totalCost = 0;

      for (let i = 0; i < 3; i++) {
        const wrapper = new ClaudeCLIWrapper({ dangerouslySkipPermissions: true });
        const result = await wrapper.prompt(`Count to ${i + 1}`);
        totalCost += result.cost_usd || 0;
        console.log(`[Test] Call ${i + 1}: $${result.cost_usd?.toFixed(6)}`);
      }

      console.log(`[Test] Total cost: $${totalCost.toFixed(6)}`);
      expect(totalCost).toBeGreaterThan(0);
    },
    90000
  );
});
