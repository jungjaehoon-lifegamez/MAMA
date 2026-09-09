/**
 * Drift guard for the ONE code-owned canonical wiki contract and the provisioned default
 * persona built from it. The persona is that contract plus a managed marker, so the two
 * cannot drift.
 *
 * The RUNTIME wiki turn no longer carries this script (owner decision 2026-09-09): a work
 * order is a stimulus stating the result the host verifies, and ~7,000 characters of
 * procedure told the agent how to work instead. The last test here pins that.
 */
import { describe, it, expect } from 'vitest';

import { buildTurnKindSection } from '../../src/operator/workorder-consumer.js';
import { WIKI_AGENT_PERSONA } from '../../src/multi-agent/wiki-agent-persona.js';
import { WIKI_TURN_CONTRACT_TEXT, WIKI_TURN_CONTRACT } from '../../src/wiki/wiki-turn-contract.js';

// Every required behavioral section of the canonical contract that the persona ships.
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
  'kind "os_task"',
  'legacy_kind:"message"',
  'Never invent kinds',
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
  it('the canonical contract carries every required behavioral section', () => {
    for (const required of REQUIRED_RUNTIME_SECTIONS) {
      expect(WIKI_TURN_CONTRACT_TEXT, `canonical contract is missing: ${required}`).toContain(
        required
      );
    }
  });

  it('the default persona is exactly the managed marker plus the canonical contract', () => {
    expect(WIKI_AGENT_PERSONA).toContain('<!-- MAMA managed wiki persona v7 -->');
    // The persona ends with the canonical contract verbatim (no persona-only rules).
    expect(WIKI_AGENT_PERSONA.trimEnd().endsWith(WIKI_TURN_CONTRACT_TEXT)).toBe(true);
  });

  it('warns there is no input/range sandbox variable and requires literal values (P0-5)', () => {
    const section = WIKI_TURN_CONTRACT_TEXT;
    expect(section).toContain('there is NO `input` or `range` variable');
    // Requires copying the literal payload values, and names the code form to avoid.
    expect(section.toLowerCase()).toContain('literal');
    expect(section).toContain('never write `input.connectors` or `range.start_ms` as code');
  });

  it('keeps task boundaries host-owned instead of asking the model to repeat them', () => {
    const section = WIKI_TURN_CONTRACT_TEXT;
    expect(section).toContain('task_list({view:"items"})');
    expect(section).toContain('taskUpdatedSince/taskUpdatedBefore');
    expect(section).toContain('the host injects');
    expect(section).not.toContain('updated_since: range.start_ms');
  });

  it('the no-update contract uses the literal noUpdateScope and forbids batchId (P0-6)', () => {
    const section = WIKI_TURN_CONTRACT_TEXT;
    expect(section).toContain('contract_no_update({reason, scope:');
    expect(section).toContain('literal noUpdateScope');
    expect(section).toContain('never derive the scope from batchId');
  });

  it('instructs LEGACY_INPUT_UNBOUND for a legacy payload missing typed fields (M2)', () => {
    const section = WIKI_TURN_CONTRACT_TEXT;
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

  it('the runtime wiki turn is an outcome contract, not the script', () => {
    const section = buildTurnKindSection('wiki');
    expect(section).toContain(
      'Result required: the wiki pages this batch affects published with wiki_publish, or contract_no_update'
    );
    // P1-2: the literal host-issued scope, never an `input.` variable the sandbox lacks.
    expect(buildTurnKindSection('wiki', 'wiki:2026-09-09')).toContain(
      'contract_no_update({reason, scope: "wiki:2026-09-09"})'
    );
    expect(section).not.toContain('input.');
    expect(section).not.toContain(WIKI_TURN_CONTRACT_TEXT);
    // P3-8 names the host's coverage requirement for a no-update; the SCRIPT stayed out.
    for (const script of ['task_list({view:"items"', 'wiki_read({', '## Progress']) {
      expect(section, `runtime wiki turn still scripts: ${script}`).not.toContain(script);
    }
    expect(section.length).toBeLessThan(1300);
  });
});
