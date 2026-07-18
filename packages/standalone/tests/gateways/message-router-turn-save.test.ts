/**
 * Story SMALLFIX-2: dual-save dedup predicate
 *
 * When the agent already persisted memory during the turn (gateway mama_save
 * visible in the reasoning header), the extractor safety net must skip -
 * one owner directive produced BOTH decision_* and mem_* records live.
 */

import { describe, expect, it } from 'vitest';
import { agentSavedInTurn } from '../../src/gateways/message-router.js';

describe('Story SMALLFIX-2: agentSavedInTurn', () => {
  describe('AC #1: mama_save in the reasoning header suppresses the extractor', () => {
    it('detects a mama_save in the reasoning header', () => {
      expect(agentSavedInTurn('||📚 Memory | 🔧 mama_save | ⏱️ 2 turns||\nsaved ok')).toBe(true);
      expect(agentSavedInTurn('||🔧 kagemusha_tasks, 🔧 mama_save | ⏱️ 3 turns||\nreport')).toBe(
        true
      );
    });

    it('detects a header-only response without a body', () => {
      expect(agentSavedInTurn('||🔧 mama_save | ⏱️ 1 turns||')).toBe(true);
    });
  });

  describe('AC #2: other tools, prose mentions, and body markers never suppress', () => {
    it('does not trigger on other tools or plain mentions', () => {
      expect(agentSavedInTurn('||🔧 mama_search | ⏱️ 1 turns||\nanswer')).toBe(false);
      expect(agentSavedInTurn('the mama_save tool exists')).toBe(false);
      expect(agentSavedInTurn('plain answer')).toBe(false);
    });

    it('ignores a marker mentioned in the body below the header', () => {
      expect(
        agentSavedInTurn('||🔧 mama_search | ⏱️ 1 turns||\nI could run 🔧 mama_save for you')
      ).toBe(false);
    });

    it('does not partial-match longer tool names', () => {
      expect(agentSavedInTurn('||🔧 mama_save_draft | ⏱️ 1 turns||\nx')).toBe(false);
    });
  });

  describe('AC #3: falsy or headerless responses are safe no-ops', () => {
    it('returns false for null/undefined/empty', () => {
      expect(agentSavedInTurn(null)).toBe(false);
      expect(agentSavedInTurn(undefined)).toBe(false);
      expect(agentSavedInTurn('')).toBe(false);
    });
  });
});
