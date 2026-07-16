// packages/standalone/tests/agent/persona-native-tools.test.ts
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';

const adapterOptions = (loop: AgentLoop): { tools?: string } =>
  (
    loop as unknown as {
      persistentCLI: { getOptions(): { tools?: string } };
    }
  ).persistentCLI.getOptions();

describe('Story BOUNDARY-2: persona native tool lockdown', () => {
  describe('AC #1: builtinTools option controls the CLI --tools surface', () => {
    it('passes builtinTools through to the CLI adapter as the --tools value', () => {
      const loop = new AgentLoop({} as never, {
        backend: 'claude',
        toolsConfig: { gateway: ['*'], mcp: [] },
        builtinTools: '',
      });
      expect(adapterOptions(loop).tools).toBe('');
    });

    it('leaves native tools untouched when builtinTools is not set', () => {
      const loop = new AgentLoop({} as never, {
        backend: 'claude',
        toolsConfig: { gateway: ['*'], mcp: [] },
      });
      expect(adapterOptions(loop).tools).toBeUndefined();
    });
  });
});
