/**
 * Drift guard: the runtime wiki turn and the provisioned default persona carry
 * the ONE code-owned canonical wiki contract. The contract is complete enough
 * for the actual workorder run - daily journal behavior, lesson rules, Home.md
 * maintenance, and the progressive source reads - so removing any required
 * section from the runtime fails here. The persona is that contract plus a
 * managed marker, so the two cannot drift.
 */
import { describe, it, expect } from 'vitest';

import { buildTurnKindSection } from '../../src/operator/workorder-consumer.js';
import { WIKI_AGENT_PERSONA } from '../../src/multi-agent/wiki-agent-persona.js';
import { WIKI_TURN_CONTRACT_TEXT, WIKI_TURN_CONTRACT } from '../../src/wiki/wiki-turn-contract.js';

// Every required behavioral section. Removing any of these from the canonical
// contract (and therefore from the runtime turn) fails this test.
const REQUIRED_RUNTIME_SECTIONS = [
  // Input boundary (typed, host-supplied; batchId is not a watermark)
  'ownerDate',
  'range',
  'start_ms',
  'end_ms',
  'sourceWatermark',
  'connectors',
  'is not a watermark',
  // Progressive source reads with host-injected connector/range authority.
  'context_compile({task',
  'the host injects the exact payload connector scope and range',
  'task_list({view:"items"',
  // The host owns and injects both RFC3339 boundaries on every page.
  'taskUpdatedSince/taskUpdatedBefore',
  'the host injects',
  'nextCursor',
  'mama_search',
  // Daily journal behavior
  'daily/<ownerDate>.md',
  '## Progress',
  '## Decisions',
  '## Issues',
  'Lesson candidates',
  // read-before-create/append
  'wiki_read',
  'expectedContentVersion',
  'APPEND',
  // Lesson rules
  'superseded',
  'last_verified',
  // Home.md maintenance
  'Home.md',
  // No-update settlement
  'contract_no_update',
  // Legacy in-flight payload handling (M2)
  'LEGACY_INPUT_UNBOUND',
] as const;

describe('wiki turn contract does not drift from the provisioned persona', () => {
  it('the runtime wiki turn embeds the canonical contract verbatim', () => {
    expect(buildTurnKindSection('wiki')).toContain(WIKI_TURN_CONTRACT_TEXT);
  });

  it('the runtime wiki turn carries every required behavioral section', () => {
    const section = buildTurnKindSection('wiki');
    for (const required of REQUIRED_RUNTIME_SECTIONS) {
      expect(section, `runtime wiki turn is missing: ${required}`).toContain(required);
    }
  });

  it('the default persona is exactly the managed marker plus the canonical contract', () => {
    expect(WIKI_AGENT_PERSONA).toContain('<!-- MAMA managed wiki persona v7 -->');
    // The persona ends with the canonical contract verbatim (no persona-only rules).
    expect(WIKI_AGENT_PERSONA.trimEnd().endsWith(WIKI_TURN_CONTRACT_TEXT)).toBe(true);
  });

  it('warns there is no input/range sandbox variable and requires literal values (P0-5)', () => {
    const section = buildTurnKindSection('wiki');
    expect(section).toContain('there is NO `input` or `range` variable');
    // Requires copying the literal payload values, and names the code form to avoid.
    expect(section.toLowerCase()).toContain('literal');
    expect(section).toContain('never write `input.connectors` or `range.start_ms` as code');
  });

  it('keeps task boundaries host-owned instead of asking the model to repeat them', () => {
    const section = buildTurnKindSection('wiki');
    expect(section).toContain('task_list({view:"items"})');
    expect(section).toContain('taskUpdatedSince/taskUpdatedBefore');
    expect(section).toContain('the host injects');
    expect(section).not.toContain('updated_since: range.start_ms');
  });

  it('the no-update contract uses the literal noUpdateScope and forbids batchId (P0-6)', () => {
    const section = buildTurnKindSection('wiki');
    expect(section).toContain('contract_no_update({reason, scope:');
    expect(section).toContain('literal noUpdateScope');
    expect(section).toContain('never derive the scope from batchId');
  });

  it('instructs LEGACY_INPUT_UNBOUND for a legacy payload missing typed fields (M2)', () => {
    const section = buildTurnKindSection('wiki');
    expect(section).toContain('LEGACY_INPUT_UNBOUND');
    expect(section.toLowerCase()).toContain('do not infer');
    // Never publish or invent a contract_no_update scope for a legacy payload.
    expect(section.toLowerCase()).toContain('do not publish');
    expect(section).toContain('the next typed boot/hourly occurrence');
  });

  it('the canonical contract does not impose a fixed business source order', () => {
    const text = WIKI_TURN_CONTRACT.join('\n');
    expect(text.toLowerCase()).toContain('do not impose one fixed business source order');
  });

  it('the persona no longer teaches mama_search as the authoritative novelty gate', () => {
    expect(WIKI_AGENT_PERSONA).not.toContain('NOVELTY CHECK by recency');
    expect(WIKI_AGENT_PERSONA).not.toContain('authoritative for WHAT is new');
    // The only mention of the last-30 search is the contract FORBIDDING it as the gate.
    expect(WIKI_AGENT_PERSONA).toContain(
      'mama_search({limit: 30}) must not stand in for checking connector and task movement'
    );
  });
});
