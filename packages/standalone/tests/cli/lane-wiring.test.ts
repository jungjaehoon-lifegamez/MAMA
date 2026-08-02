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
  CONDUCTOR_TOOL_POLICY,
  OPERATOR_REPORT_TOOL_POLICY,
  WORKORDER_TOOL_POLICIES,
  buildFullReportGatherLines,
} from '../../src/cli/commands/start.js';
import { GATHER_TOOLS, WRITE_TOOLS } from '../../src/operator/report-run.js';

/**
 * Tool names an instruction line actually names, as `tool(` or `tool({`.
 *
 * No whitespace before the paren, deliberately. These lines are prose with calls embedded
 * in them, and prose has parentheses too - `awaiting review (status values must be...)`
 * reads as a call to `review` the moment a space is allowed.
 */
function toolsNamedIn(lines: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/\b([a-z][a-z0-9_]{2,})\(/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

const REPORT_GRANT = new Set<string>(OPERATOR_REPORT_TOOL_POLICY.allowedTools);

describe('report lane: instructions against the grant', () => {
  const instructed = toolsNamedIn(
    buildFullReportGatherLines({ lastSuccessIso: '2026-07-28T00:00:00Z' })
  );

  // An instruction naming a tool the lane cannot call is a lie told to the agent every run.
  it('never instructs a tool the lane was not granted', () => {
    const ungranted = [...instructed].filter((t) => !REPORT_GRANT.has(t));
    expect(ungranted).toEqual([]);
  });

  // The direction that matters. The classification set is deliberately WIDER than the grant -
  // it is an observability net, so a tool that should never appear is still recorded honestly
  // if it ever does. But a granted tool missing from it is counted as nothing: the run gathers
  // through it and `gatherTools` stays empty, which fires the full-report WARNING claiming the
  // task board was never verified. That was true of four granted reads.
  it('classifies every tool the lane is allowed to call', () => {
    const unclassified = [...REPORT_GRANT].filter(
      (t) => !GATHER_TOOLS.has(t) && !WRITE_TOOLS.has(t)
    );
    expect(unclassified).toEqual([]);
  });

  // The guard that would have caught `changes_read`. A grant with no instruction is prompt
  // budget spent on a tool that will not be used - not fatal, but it must be a decision
  // rather than a drift, so the set is pinned here.
  it('pins the granted-but-never-instructed set', () => {
    const silent = [...REPORT_GRANT].filter((t) => !instructed.has(t)).sort();
    expect(silent).toEqual([
      // Read on demand while writing, not part of the gather sequence.
      'mama_provenance',
      'mama_save',
      'mama_search',
      'report_publish',
      'task_external_correlation',
      'trello_kanban',
    ]);
  });

  // Product premise (S1 spec): MAMA presupposes no Kagemusha. An instruction
  // line reaching for kagemusha_* would rebuild the dependency this pin ended.
  it('never instructs a kagemusha tool', () => {
    for (const lines of [
      buildFullReportGatherLines({ lastSuccessIso: '2026-07-28T00:00:00Z' }),
      buildFullReportGatherLines({ lastSuccessIso: null }),
    ]) {
      expect(lines.join('\n')).not.toContain('kagemusha_');
    }
  });

  it('instructs the delta tool with the last successful report as its window', () => {
    const [withAnchor] = buildFullReportGatherLines({
      lastSuccessIso: '2026-07-28T00:00:00Z',
    }).filter((l) => l.startsWith('changes_read('));
    expect(withAnchor).toContain('2026-07-28T00:00:00Z');

    const [withoutAnchor] = buildFullReportGatherLines({ lastSuccessIso: null }).filter((l) =>
      l.startsWith('changes_read(')
    );
    // No anchor still bounds the window; an unbounded delta is not a delta.
    expect(withoutAnchor).toContain('since');
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
    const unknownConductor = CONDUCTOR_TOOL_POLICY.allowedTools.filter(
      (t: string) => !known.has(t)
    );
    expect(unknownConductor, 'conductor lane grants unknown tools').toEqual([]);
  });

  // The conductor ingests untrusted channel text into a long-lived session -
  // it must stay the MOST restricted lane: no sends, no memory writes, no
  // compile, no raw connector reads.
  it('keeps sends, memory writes, and compile out of the conductor lane', () => {
    for (const forbidden of [
      'telegram_send',
      'discord_send',
      'slack_send',
      'webchat_send',
      'mama_save',
      'mama_update',
      'context_compile',
      'wiki_publish',
      'report_publish',
      'Bash',
      'Write',
    ]) {
      expect(CONDUCTOR_TOOL_POLICY.allowedTools).not.toContain(forbidden);
    }
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
