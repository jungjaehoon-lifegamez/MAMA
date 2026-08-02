import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSettingsModelOptions,
  SettingsModule,
} from '../../public/viewer/src/modules/settings.js';

describe('Settings viewer model options', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves custom current models during unrelated settings edits', () => {
    expect(getSettingsModelOptions('codex', 'custom-codex-model')).toContain('custom-codex-model');
    expect(getSettingsModelOptions('claude', 'claude-custom-model')).toContain(
      'claude-custom-model'
    );
  });

  it('TG-03/TG-04 exposes the Cline default and preserves a custom current model', () => {
    expect(getSettingsModelOptions('cline')).toEqual(['deepseek/deepseek-v4-flash']);
    expect(getSettingsModelOptions('cline', 'custom/cline-model')).toContain('custom/cline-model');
  });

  it('TG-03/TG-04 preserves Cline when unrelated settings are saved without agent controls', () => {
    vi.stubGlobal('document', {
      getElementById: () => null,
      querySelectorAll: () => [],
    });
    const settings = new SettingsModule();
    settings.config = {
      agent: {
        backend: 'cline',
        model: 'deepseek/deepseek-v4-flash',
        max_turns: 12,
        timeout: 420000,
        tools: {
          gateway: ['mama_search'],
          mcp: ['context7'],
          mcp_config: '~/.mama/custom-mcp.json',
        },
      },
    };

    const payload = settings.collectFormData();

    expect(payload.agent).toMatchObject({
      backend: 'cline',
      model: 'deepseek/deepseek-v4-flash',
      max_turns: 12,
      timeout: 420000,
      tools: {
        gateway: ['mama_search'],
        mcp: ['context7'],
        mcp_config: '~/.mama/custom-mcp.json',
      },
    });
    expect(payload.use_claude_cli).toBe(false);
  });
});
