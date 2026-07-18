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

/**
 * Story S2-T3 (review M1): operator notices must use the SAME key on the
 * write and read sides - the original defect parked host alarms under a key
 * no owner turn ever peeked (dead-letter). Source-coherence check: both the
 * accessor and the resumed-turn peek/drain reference the exported constant.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATOR_BROADCAST_NOTICE_KEY } from '../../src/gateways/message-router.js';

describe('Story S2-T3: operator notice broadcast key coherence (M1)', () => {
  const source = readFileSync(join(__dirname, '../../src/gateways/message-router.ts'), 'utf-8');

  it('write and read sides share OPERATOR_BROADCAST_NOTICE_KEY', () => {
    expect(OPERATOR_BROADCAST_NOTICE_KEY).toBe('operator:broadcast');
    // Writer: the host-code accessor.
    expect(source).toMatch(
      /enqueueOperatorNotice[\s\S]{0,400}enqueue\(OPERATOR_BROADCAST_NOTICE_KEY/
    );
    // Reader: the broadcast peek is OWNER-GATED (review N3 - a non-owner or
    // group turn must neither see internal ops state nor drain it away).
    expect(source).toMatch(
      /'owner_console'\s*\n?\s*\?\s*this\.memoryNoticeQueue\.peek\(OPERATOR_BROADCAST_NOTICE_KEY\)/
    );
    // Drains are PER-QUEUE by their own peeked counts (review N2 - a combined
    // count over-drained one queue, dropping mid-turn notices undisplayed).
    expect(source).toMatch(/drain\(channelKey, pendingChannelNoticeCount\)/);
    expect(source).toMatch(/drain\(OPERATOR_BROADCAST_NOTICE_KEY, pendingBroadcastNoticeCount\)/);
    // Bare (count-less) broadcast drain must not come back.
    expect(source).not.toMatch(/drain\(OPERATOR_BROADCAST_NOTICE_KEY\)[^,]/);
    // The dead-letter key must not come back.
    expect(source).not.toMatch(/enqueueOperatorNotice[\s\S]{0,400}'memory-agent:shared'/);
  });
});

/**
 * Story S2-T3 (review round 3 F1): the start.ts N4 wiring is closure-bound -
 * pin it with the same source-coherence pattern so a silent revert of the
 * shadow rollback hunk fails a test.
 */
describe('Story S2-T3: shadow rollback wiring coherence (N4/F1)', () => {
  const startSource = readFileSync(join(__dirname, '../../src/cli/commands/start.ts'), 'utf-8');

  it('boot pass cancels non-board orders BEFORE bootRecover, and runOptionsFor refuses non-board at shadow', () => {
    // (a) scoped cleanup call with exactly the non-board kinds...
    expect(startSource).toMatch(
      /cancelOpenWorkOrders\('shadow-board-only',\s*\[\s*'wiki',\s*'memory-curation',?\s*\]\)/
    );
    // (b) ...ordered before bootRecover in the same boot pass.
    const cleanupIdx = startSource.indexOf("cancelOpenWorkOrders('shadow-board-only'");
    const recoverIdx = startSource.indexOf('workOrderConsumer.bootRecover()');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(recoverIdx).toBeGreaterThan(cleanupIdx);
    // (c) defense-in-depth: non-board runs refused at shadow inside runOptionsFor.
    expect(startSource).toMatch(
      /workKind !== 'board'[\s\S]{0,200}shadow is board-only - refusing live/
    );
  });
});
