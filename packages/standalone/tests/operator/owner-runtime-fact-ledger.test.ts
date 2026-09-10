import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/agent/tool-registry.js';
import { OWNER_RUNTIME_RULES } from '../../src/operator/owner-runtime.js';

/**
 * 2026-09-10 measurement: 173 owner-event runs read connector deltas and wrote ONE memory
 * fact all day (mama_save 1, contract_no_update 150). The turn that reads the events had
 * no obligation to record what they changed, and the separate memory-curation lane that
 * had the obligation never saw the events. A later question about the same item then
 * crawled raw pages with code_act because the ledger held nothing.
 *
 * The fix is a rule, not a table: the reading turn saves one atomic fact per anchor the
 * delta changed, keyed by the same item/person key the task row carries, and the question
 * turn reads that key first.
 */
describe('owner runtime: raw events become anchored facts in the turn that reads them', () => {
  it('obligates the event turn to save one fact per changed anchor, keyed like the task title', () => {
    expect(OWNER_RUNTIME_RULES).toContain('WHAT THIS BATCH CHANGED IS MEMORY');
    expect(OWNER_RUNTIME_RULES).toMatch(/mama_save\(\{type:"decision", topic:/);
    expect(OWNER_RUNTIME_RULES).toContain('event_date');
    expect(OWNER_RUNTIME_RULES).toContain('supersede it with mama_update');
    expect(OWNER_RUNTIME_RULES).toContain('A task_update without its fact');
  });

  it('routes item/person/task questions to the fact ledger before any raw read', () => {
    expect(OWNER_RUNTIME_RULES).toContain('mama_search({topicPrefix:');
    expect(OWNER_RUNTIME_RULES).toContain('Read raw connector pages only for what the ledger lacks');
  });

  it('advertises event_date on the gateway mama_save so facts carry when they happened', () => {
    const save = ToolRegistry.getTool('mama_save');
    expect(save).toBeDefined();
    expect(save!.params).toContain('event_date?');
  });
});
