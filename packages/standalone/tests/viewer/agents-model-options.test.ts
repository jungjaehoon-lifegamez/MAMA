import { describe, expect, it } from 'vitest';

import { getModelsForBackend } from '../../public/viewer/src/modules/agents.js';

describe('Agents viewer model options', () => {
  it('includes the current Codex model so unrelated edits preserve it', () => {
    expect(getModelsForBackend('codex', 'gpt-5.4')).toContain('gpt-5.4');
    expect(getModelsForBackend('codex', 'custom-codex-model')).toContain('custom-codex-model');
  });
});
