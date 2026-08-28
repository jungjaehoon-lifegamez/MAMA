import { describe, expect, it } from 'vitest';
import {
  assessOnboarding,
  renderContractStatus,
  type AssessDeps,
} from '../../src/onboarding/agent-contract.js';

const base: AssessDeps = {
  configLoadable: true,
  daemonRunning: true,
  telegramConfigured: true,
  allowedChats: true,
  enabledConnectors: 1,
  readyConnectors: 1,
  firstReportAt: '2026-08-28T00:00:00Z',
};

describe('Story ONB-1: self-teaching onboarding contract', () => {
  describe('AC #1: completion follows the six observed journey items', () => {
    it('reports complete only when every item is done', () => {
      expect(assessOnboarding(base).complete).toBe(true);
      expect(assessOnboarding(base).missing).toEqual([]);
    });

    it('requires the daemon before the first report can complete the journey', () => {
      const state = assessOnboarding({ ...base, daemonRunning: false });

      expect(state.complete).toBe(false);
      expect(state.missing).toEqual(['daemon']);
      expect(state.items.map((item) => item.id)).toEqual([
        'config',
        'gateway',
        'trust_anchor',
        'daemon',
        'sources',
        'first_report',
      ]);
    });

    it('never completes without a trust anchor even if everything else is done', () => {
      const state = assessOnboarding({ ...base, allowedChats: false });

      expect(state.complete).toBe(false);
      expect(state.missing).toContain('trust_anchor');
    });

    it('does not complete when a source is enabled but none authenticate', () => {
      const state = assessOnboarding({
        ...base,
        enabledConnectors: 1,
        readyConnectors: 0,
      });

      expect(state.complete).toBe(false);
      expect(state.missing).toContain('sources');
      expect(state.items.find((item) => item.id === 'sources')?.guidance).toContain(
        'mama connector status'
      );
    });

    it('missing preserves journey order: config first, first_report last', () => {
      const state = assessOnboarding({
        ...base,
        configLoadable: false,
        firstReportAt: null,
      });

      expect(state.missing[0]).toBe('config');
      expect(state.missing[state.missing.length - 1]).toBe('first_report');
    });
  });

  describe('AC #2: guidance is executable without leaking secrets through argv', () => {
    it('every missing item carries actionable guidance with a command', () => {
      const state = assessOnboarding({
        ...base,
        telegramConfigured: false,
        allowedChats: false,
        daemonRunning: false,
        enabledConnectors: 0,
        readyConnectors: 0,
        firstReportAt: null,
      });

      for (const item of state.items.filter((candidate) => !candidate.done)) {
        expect(item.guidance).toMatch(/mama /);
      }
    });

    it('uses stdin for the Telegram token and never places a token placeholder on argv', () => {
      const state = assessOnboarding({ ...base, telegramConfigured: false });
      const gateway = state.items.find((item) => item.id === 'gateway');

      expect(gateway?.guidance).toContain('--token-stdin');
      expect(gateway?.guidance).not.toMatch(/<.*token.*>/i);
    });

    it('says to stop the daemon before changing the Telegram gateway or anchor', () => {
      const state = assessOnboarding({
        ...base,
        telegramConfigured: false,
        allowedChats: false,
      });

      expect(state.items.find((item) => item.id === 'gateway')?.guidance).toContain('mama stop');
      expect(state.items.find((item) => item.id === 'trust_anchor')?.guidance).toContain(
        'mama stop'
      );
    });
  });

  describe('AC #3: rendering separates agent actions from human-required actions', () => {
    it('shows every missing action and identifies the human-required trust anchor', () => {
      const state = assessOnboarding({
        ...base,
        allowedChats: false,
        enabledConnectors: 0,
        readyConnectors: 0,
        firstReportAt: null,
      });
      const text = renderContractStatus(state);

      expect(text).toContain('Agent can do now:');
      expect(text).toContain('Human required:');
      expect(text).toContain('trust_anchor');
      expect(text).toContain('sources');
      expect(text).toContain('first_report');
    });
  });
});
