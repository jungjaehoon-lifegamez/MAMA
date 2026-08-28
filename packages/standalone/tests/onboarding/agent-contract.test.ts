import { describe, it, expect } from 'vitest';
import {
  assessOnboarding,
  renderContractStatus,
  type AssessDeps,
} from '../../src/onboarding/agent-contract.js';

const base: AssessDeps = {
  mamaHome: '/tmp/x',
  configExists: true,
  daemonRunning: false,
  telegramToken: true,
  allowedChats: true,
  ownerFacts: true,
  enabledConnectors: 1,
  firstReportAt: '2026-08-28T00:00:00Z',
};

describe('assessOnboarding', () => {
  it('reports complete only when every item is done', () => {
    expect(assessOnboarding(base).complete).toBe(true);
    expect(assessOnboarding(base).missing).toEqual([]);
  });

  it('never completes without trust anchor even if everything else is done', () => {
    const s = assessOnboarding({ ...base, allowedChats: false });
    expect(s.complete).toBe(false);
    expect(s.missing).toContain('trust_anchor');
  });

  it('missing preserves journey order: config first, first_report last', () => {
    const s = assessOnboarding({
      ...base,
      configExists: false,
      firstReportAt: null,
    });
    expect(s.missing[0]).toBe('config');
    expect(s.missing[s.missing.length - 1]).toBe('first_report');
  });

  it('every missing item carries actionable guidance with a command', () => {
    const s = assessOnboarding({
      ...base,
      telegramToken: false,
      allowedChats: false,
      enabledConnectors: 0,
      firstReportAt: null,
    });
    for (const item of s.items.filter((i) => !i.done)) {
      expect(item.guidance).toMatch(/mama /);
    }
  });

  it('gateway guidance says stop the daemon first when it is running', () => {
    const s = assessOnboarding({ ...base, daemonRunning: true, telegramToken: false, allowedChats: false });
    const gateway = s.items.find((i) => i.id === 'gateway');
    expect(gateway?.guidance).toContain('mama stop');
  });

  it('renderContractStatus prints next action for the first missing item', () => {
    const s = assessOnboarding({ ...base, firstReportAt: null });
    const text = renderContractStatus(s);
    expect(text).toContain('first_report');
    expect(text).toContain('mama report now');
  });
});
