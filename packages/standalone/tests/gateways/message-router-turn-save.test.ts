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
  it('detects a mama_save in the reasoning header', () => {
    expect(agentSavedInTurn('||📚 Memory | 🔧 mama_save | ⏱️ 2 turns||\nsaved ok')).toBe(true);
    expect(agentSavedInTurn('||🔧 kagemusha_tasks, 🔧 mama_save | ⏱️ 3 turns||\nreport')).toBe(
      true
    );
  });

  it('does not trigger on other tools or plain mentions', () => {
    expect(agentSavedInTurn('||🔧 mama_search | ⏱️ 1 turns||\nanswer')).toBe(false);
    expect(agentSavedInTurn('the mama_save tool exists')).toBe(false);
    expect(agentSavedInTurn('plain answer')).toBe(false);
  });
});
