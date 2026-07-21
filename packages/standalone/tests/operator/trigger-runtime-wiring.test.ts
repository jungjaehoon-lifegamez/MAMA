import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('trigger runtime provider wiring', () => {
  it('selects one trigger agent runtime from runtimeBackend for both author and review', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).toContain('createTriggerAgentRuntime(runtimeBackend');
    expect(startSource).toMatch(/askAgent:\s*triggerAgentRuntime\.askAuthor/);
    expect(startSource).toMatch(
      /review:\s*\(trigger, context\)\s*=>\s*reviewTriggerCLI\(trigger, context, triggerAgentRuntime\.askReview\)/
    );
  });

  it('registers the selected trigger runtime for daemon shutdown', () => {
    const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

    expect(startSource).toContain('await triggerAgentRuntime.stop()');
  });
});
