import { describe, expect, it } from 'vitest';

import { getSettingsModelOptions } from '../../public/viewer/src/modules/settings.js';

describe('Settings viewer model options', () => {
  it('preserves custom current models during unrelated settings edits', () => {
    expect(getSettingsModelOptions('codex', 'custom-codex-model')).toContain('custom-codex-model');
    expect(getSettingsModelOptions('claude', 'claude-custom-model')).toContain(
      'claude-custom-model'
    );
  });
});
