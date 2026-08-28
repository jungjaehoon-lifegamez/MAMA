import { describe, expect, it } from 'vitest';
import * as startModule from '../../src/cli/commands/start.js';
import { assessOnboarding } from '../../src/onboarding/agent-contract.js';

interface StartContractModule {
  buildStartOnboardingOutput?: (state: ReturnType<typeof assessOnboarding>) => string | null;
}

const buildStartOnboardingOutput = (startModule as StartContractModule).buildStartOnboardingOutput;

describe('Story ONB-3: start renders the same onboarding contract', () => {
  describe('AC #3: start replaces browser launch with current missing-item guidance', () => {
    it('returns the dynamic contract only while onboarding is incomplete', () => {
      const incomplete = assessOnboarding({
        configLoadable: true,
        daemonRunning: true,
        telegramConfigured: true,
        allowedChats: true,
        enabledConnectors: 1,
        firstReportAt: null,
      });
      const complete = assessOnboarding({
        configLoadable: true,
        daemonRunning: true,
        telegramConfigured: true,
        allowedChats: true,
        enabledConnectors: 1,
        firstReportAt: '2026-08-28T00:00:00Z',
      });

      expect(buildStartOnboardingOutput?.(incomplete)).toContain('mama report now');
      expect(buildStartOnboardingOutput?.(complete)).toBeNull();
    });
  });
});
