/**
 * The wiring between a lane's tool grant and what the lane is told to do with it.
 *
 * Every defect found in this session was a wiring defect, not a logic defect:
 *
 *   - `changes_read` was granted to the report lane and never instructed. A tool the
 *     report is never told to call is a tool the report does not call, and it was absent
 *     from the run audit's gather set too, so the run would have been recorded as having
 *     gathered nothing from it.
 *   - `delegate` was wired zero times over the whole log history.
 *   - `bindConfiguredScope` required a config field no channel has ever declared.
 *
 * None of those are visible to a unit test of the module involved, and all of them live in
 * `src/cli/commands` and `src/cli/runtime` - measured at 33% coverage, against 98% for the
 * connectors and 93% for the operator. The coverage is inside the modules; the failures
 * were between them.
 *
 * So these are not tests of behaviour. They are tests that two lists agree.
 */
import { describe, it, expect } from 'vitest';
import {
  OPERATOR_REPORT_TOOL_POLICY,
  WORKORDER_TOOL_POLICIES,
} from '../../src/cli/commands/start.js';

const REPORT_GRANT = new Set<string>(OPERATOR_REPORT_TOOL_POLICY.allowedTools);

describe('report lane: instructions against the grant', () => {
  it('TG-03/TG-04/TG-05 grants no rediscovery or mutation tools to packet-only reports', () => {
    expect([...REPORT_GRANT]).toEqual([]);
  });
});

describe('workorder lanes: every granted tool is a real tool', () => {
  it('TG-04/TG-06 keeps private tools out of static lane grants', () => {
    const privateTools = [
      'kagemusha_overview',
      'kagemusha_entities',
      'kagemusha_tasks',
      'kagemusha_messages',
    ];
    for (const lane of [...Object.values(WORKORDER_TOOL_POLICIES), OPERATOR_REPORT_TOOL_POLICY]) {
      for (const tool of privateTools) {
        expect(lane.allowedTools).not.toContain(tool);
      }
    }
  });

  // A lane granting a name no registry knows is a permission that can never be exercised -
  // the shape `delegate` had for its entire life.
  it('grants only tools the report lane also recognises as real', async () => {
    const { ToolRegistry } = await import('../../src/agent/tool-registry.js');
    const known = new Set(ToolRegistry.getAllTools().map((t) => t.name));
    for (const [kind, policy] of Object.entries(WORKORDER_TOOL_POLICIES)) {
      const unknown = policy.allowedTools.filter((t: string) => !known.has(t));
      expect(unknown, `workorder lane '${kind}' grants unknown tools`).toEqual([]);
    }
    const unknownReport = OPERATOR_REPORT_TOOL_POLICY.allowedTools.filter(
      (t: string) => !known.has(t)
    );
    expect(unknownReport, 'report lane grants unknown tools').toEqual([]);
  });

  // A temporal run is bound to one task on one channel; granting it a task-mutation tool
  // would let it change work items outside the reconcile it was issued for.
  it('keeps task mutation out of the temporal and report lanes', () => {
    for (const lane of [WORKORDER_TOOL_POLICIES.temporal, OPERATOR_REPORT_TOOL_POLICY]) {
      expect(lane.allowedTools).not.toContain('task_create');
      expect(lane.allowedTools).not.toContain('task_update');
    }
  });
});
