import { describe, expect, it } from 'vitest';

import {
  getModelsForBackend,
  MANAGED_AGENT_BACKENDS,
} from '../../public/viewer/src/modules/agents.js';

describe('Agents viewer model options', () => {
  it('includes the current Codex model so unrelated edits preserve it', () => {
    expect(getModelsForBackend('codex', 'gpt-5.4')).toContain('gpt-5.4');
    expect(getModelsForBackend('codex', 'custom-codex-model')).toContain('custom-codex-model');
  });

  it('TG-03/TG-04 exposes Cline instead of the unsupported Gemini backend', () => {
    expect(MANAGED_AGENT_BACKENDS).toEqual(['claude', 'codex', 'cline']);
    expect(getModelsForBackend('cline')).toEqual(['deepseek/deepseek-v4-flash']);
    expect(getModelsForBackend('cline', 'custom/cline-model')).toContain('custom/cline-model');
  });
});
