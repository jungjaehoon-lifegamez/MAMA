/** TG-04/TG-05/TG-06: persistence/activation mechanics, not model learning proof.
 * The separate frozen Task 5 fixture checks actual model-created review artifacts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from '../../src/sqlite.js';
import { DEFAULT_ROLES } from '../../src/cli/config/types.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';
import { ProcedureRuntime, deriveProcedureAccess } from '../../src/operator/procedure-runtime.js';
import { ProcedureStore } from '../../src/operator/procedure-store.js';
import { consoleBriefPath, hashConsoleBrief } from '../../src/operator/console-brief.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

function state(source: string, stimulus: string): GatewayToolExecutionContext {
  return {
    executionSurface: 'model_tool',
    source: 'telegram',
    channelId: 'tg:1',
    sourceMessageRef: source,
    procedureStimulus: stimulus,
    envelope: makeSignedEnvelope(),
    agentContext: {
      principalId: 'owner:telegram',
      roleName: 'owner_console',
      role: { ...DEFAULT_ROLES.os_agent, allowedTools: ['*'], blockedTools: [] },
      platform: 'telegram',
      source: 'telegram',
      capabilities: [],
      limitations: [],
      session: { sessionId: 'owner:runtime', channelId: 'tg:1', startedAt: new Date() },
    },
  };
}

let home: string;
let db: Database;
let store: ProcedureStore;
let runtime: ProcedureRuntime;
function reopen(): void {
  db.close();
  db = new Database(join(home, 'operator.db'));
  store = new ProcedureStore(db);
  runtime = new ProcedureRuntime(store, home);
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mama-correction-activation-'));
  db = new Database(join(home, 'operator.db'));
  store = new ProcedureStore(db);
  runtime = new ProcedureRuntime(store, home);
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe('TG-04/TG-05/TG-06 correction activation across fresh runtime state', () => {
  it('retains a report-only correction and obsolete memory links after reopen without changing unrelated text', () => {
    const oldRule = '- Apply the report layout to every reply.';
    const correctedRule =
      '- Apply the report layout only to requested reports; ordinary conversation and verified no-change notices are excluded.';
    const original = `# Manual\n\n${oldRule}\n\n- Preserve source files.\n`;
    const path = consoleBriefPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, original);
    const owner = state(
      'message:correction',
      'Use that layout only for reports. Ordinary replies and no-change notices should stay ordinary.'
    );
    const result = runtime.execute(
      'console_brief_update',
      {
        operation: 'replace',
        target: oldRule,
        replacement: correctedRule,
        expected_hash: hashConsoleBrief(original),
        reason: 'Prior interpretation applied the instruction too broadly.',
        superseded_memory_ids: ['policy:overbroad'],
      },
      owner
    );
    expect(result).toMatchObject({ success: true, status: 'projected', behaviorVerified: false });
    expect(readFileSync(path, 'utf8')).toBe(original.replace(oldRule, correctedRule));
    expect(store.read('owner-console-brief', deriveProcedureAccess(owner)!)?.previousBody).toBe(
      original
    );
    reopen();
    const fresh = state('message:fresh', 'Thanks. I will send more material later.');
    expect(runtime.canonicalBrief(fresh)).toBe(original.replace(oldRule, correctedRule));
    expect(store.supersededMemoryIds(deriveProcedureAccess(fresh)!)).toEqual(['policy:overbroad']);
    const otherProject = {
      ...fresh,
      envelope: makeSignedEnvelope({
        scope: {
          ...fresh.envelope!.scope,
          project_refs: [{ kind: 'project', id: '/workspace/other-project' }],
        },
      }),
    };
    expect(runtime.canonicalBrief(otherProject)).toBeNull();
  });

  it('keeps real receipt categories and selected revisions distinct across feedback-driven changes', () => {
    const id = 'feedback-review-copy';
    const initial = state(
      'message:file',
      'Create a new Markdown review copy from this feedback document and preserve the original.'
    );
    const baseline = {
      id,
      expected_revision: 0,
      title: 'Feedback review copy',
      description: 'Create review copies from feedback documents.',
      when_to_use: 'A feedback document is provided for a new review copy.',
      when_not_to_use: 'Ordinary chat or no document supplied.',
      body: 'Keep open records and summarize resolved records.',
      expected_results: ['A reviewable new artifact and unchanged original'],
      reason: 'Initial procedure',
    };
    runtime.execute('procedure_update', baseline, initial);
    const access = deriveProcedureAccess(initial)!;
    // Scripted observations exercise the public persistence contract only.
    for (const [receipt, status] of [
      ['review:a', 'failed'],
      ['review:b', 'failed'],
      ['send:c', 'unknown'],
    ] as const) {
      runtime.execute(
        'procedure_observe',
        {
          id,
          revision: 1,
          receipt_id: receipt,
          status,
          evidence_refs: [`artifact:${receipt}`, `source:${receipt}`],
        },
        state(`run:${receipt}`, `Completed artifact review: ${receipt}; result ${status}.`)
      );
    }
    expect(store.read(id, access)?.revision).toBe(1); // No count-based automatic rewrite.
    const assessment = state(
      'run:assessment',
      'Completed reviews found resolved source records absent from two review copies. Delivery of the third artifact is unknown.'
    );
    const updated = runtime.execute(
      'procedure_update',
      {
        ...baseline,
        expected_revision: 1,
        body: 'Preserve every feedback record with its source ID, scene, status, and evidence in the new review copy. Preserve the original.',
        reason:
          'Two independently reviewed artifacts omitted resolved records; unknown delivery is not satisfaction evidence.',
        source_refs: ['artifact:review:a', 'artifact:review:b'],
      },
      assessment
    );
    expect(updated).toMatchObject({ status: 'stored', behaviorVerified: false });
    reopen();
    const fresh = state(
      'message:transfer',
      'Prepare this newly received document for review as before.'
    );
    const hinted = runtime.prepareContext(fresh, { threadId: 'transfer-thread', fresh: true });
    expect(hinted.text).toContain('Feedback review copy');
    expect(hinted.text).not.toContain('Preserve every feedback record');
    expect(runtime.execute('procedure_read', { id }, fresh)).toMatchObject({
      procedure: { revision: 2, body: expect.stringContaining('Preserve every feedback record') },
      behaviorVerified: false,
      observations: [
        expect.objectContaining({ status: 'failed', revision: 1 }),
        expect.objectContaining({ status: 'failed', revision: 1 }),
        expect.objectContaining({ status: 'unknown', revision: 1 }),
      ],
    });
    expect(store.getOutcomes(id, deriveProcedureAccess(fresh)!).map((item) => item.status)).toEqual(
      ['failed', 'failed', 'unknown']
    );
    expect(store.history(id, deriveProcedureAccess(fresh)!).map((item) => item.revision)).toEqual([
      1, 2,
    ]);
    expect(store.read(id, deriveProcedureAccess(fresh)!)?.originalInstruction).toBe(
      assessment.procedureStimulus
    );
  });
});
