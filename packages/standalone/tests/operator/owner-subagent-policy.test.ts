import { describe, expect, it } from 'vitest';

import {
  OWNER_SUBAGENT_INSTRUCTIONS,
  ownerSubagentInstructions,
} from '../../src/operator/owner-runtime.js';

/**
 * The standing policy is shared by every turn of the one owner session, chat included.
 * Measured 2026-09-10 20:01 KST: a 32-character owner question was answered with an
 * `Agent { run_in_background: true }` spawn and "backgrounded"; the CLI's own follow-up
 * turn then wrote the real answer outside any request, where nothing delivers it. The
 * background-and-end-turn mechanics belong to host work orders (they already say so in
 * their own prompt), never to the standing rule a conversation turn reads.
 */
describe('owner subagent policy (standing, session-wide)', () => {
  it('does not force a conversation turn to end after delegating (claude)', () => {
    const text = ownerSubagentInstructions('claude');
    expect(text).not.toMatch(/end (your|the) turn/i);
    expect(text).not.toMatch(/do not block on the result/i);
  });

  it('allows delegation and promises the late answer still reaches the channel that asked', () => {
    const text = ownerSubagentInstructions('claude');
    expect(text).toMatch(/delegate when it helps/i);
    expect(text).toMatch(/channel that asked/i);
    expect(text).not.toMatch(/do not spawn a subagent/i);
  });

  it('does not tell the codex runner to end the turn either', () => {
    expect(ownerSubagentInstructions('codex')).not.toMatch(/end (your|the) turn/i);
  });

  it('keeps the responsibility rules that are backend-neutral', () => {
    expect(OWNER_SUBAGENT_INSTRUCTIONS).toContain('one clear objective');
    expect(OWNER_SUBAGENT_INSTRUCTIONS).toContain('do NOT spawn another subagent');
    expect(ownerSubagentInstructions('claude')).toContain(OWNER_SUBAGENT_INSTRUCTIONS);
  });
});
