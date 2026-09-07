/**
 * Task B2: external binding / lifecycle decisions from a verified OWNER RUN.
 *
 * A Board attempt is no longer the only holder of candidate authority. The host
 * attests candidate snapshots it built itself under (owner scope, model run,
 * envelope); the ledger then applies the same receipted CAS decision it applies
 * for a Board attempt. No fabricated Board row is ever created. Synthetic data,
 * in-memory sqlite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';
import { TaskLedger, type ExternalBindingReceipt } from '../../src/operator/task-ledger.js';
import type {
  ExternalLifecycleCandidateSet,
  LifecycleCandidate,
} from '../../src/operator/external-lifecycle.js';
import { externalLifecycleCandidateId } from '../../src/operator/external-lifecycle-candidates.js';
import type { OwnerActionContext } from '../../src/operator/owner-action-effects.js';
import { listEffects } from '../../src/evidence/effects.js';
import {
  attestOwnerExternalLifecycleCandidates,
  buildReconcileExternalLifecycleCandidates,
} from '../../src/operator/external-lifecycle-discovery.js';
import { buildReconcileExternalLifecycleCandidates as legacyReExport } from '../../src/cli/runtime/api-routes-init.js';
import { resolvePrivateConnectorPolicy } from '../../src/connectors/private-connector-policy.js';
import {
  bindingCandidateFor,
  enqueueAndClaimBindingAttempt,
} from './external-lifecycle-fixtures.js';

const kagemushaPolicy = resolvePrivateConnectorPolicy({
  ok: true,
  config: {
    kagemusha: { enabled: true, pollIntervalMinutes: 60, channels: {}, auth: { type: 'none' } },
  },
  enabledNames: ['kagemusha'],
});

function seedConnectorEventIndex(db: SQLiteDatabase, rows: Array<[string, string, number]>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS connector_event_index (
    event_index_id TEXT PRIMARY KEY, source_connector TEXT, source_type TEXT, source_id TEXT,
    channel TEXT, content_hash TEXT, source_timestamp_ms INTEGER, operator_ingest_seq INTEGER,
    operator_observation_seq INTEGER, metadata_json TEXT)`);
  for (const [eventId, channel, seq] of rows) {
    db.prepare(`INSERT INTO connector_event_index VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      eventId,
      'kagemusha',
      'kanban_card',
      'task:42',
      channel,
      'a'.repeat(64),
      1_775_260_800_000,
      seq,
      seq,
      JSON.stringify({ taskId: 42, status: 'done', rawConnector: 'kagemusha' })
    );
  }
}

const NOW = Date.parse('2026-09-07T04:00:00Z');
const ownerRun: OwnerActionContext = {
  ownerScope: 'owner:test-project',
  occurrenceKey: 'telegram:msg:1001',
  modelRunId: 'mr-owner-1',
  envelopeHash: 'env-owner-1',
};
const retryRun: OwnerActionContext = {
  ...ownerRun,
  modelRunId: 'mr-owner-2',
  envelopeHash: 'env-owner-2',
};
const source = (context: OwnerActionContext) => ({ kind: 'owner_run' as const, context });
const originFor = (context: OwnerActionContext, eventId: string) => ({
  runId: context.modelRunId,
  causeEventIds: [eventId],
});

function setOf(
  ...candidates: Array<
    ExternalLifecycleCandidateSet['bindingCandidates'][number] | LifecycleCandidate
  >
): ExternalLifecycleCandidateSet {
  return {
    bindingCandidates: candidates.filter((c) => c.kind === 'binding'),
    lifecycleCandidates: candidates.filter((c) => c.kind === 'lifecycle'),
    diagnostics: [],
  };
}

describe('Story B2: owner-run external candidate attestation and receipts (TG-04/TG-06)', () => {
  const databases: SQLiteDatabase[] = [];
  afterEach(() => {
    while (databases.length > 0) {
      databases.pop()!.close();
    }
  });

  function fresh(onOwnerTaskChangeCommitted?: (generation: string) => void) {
    const db = new Database(':memory:');
    databases.push(db);
    const ledger = new TaskLedger(db, {
      now: () => NOW,
      timeZone: 'Asia/Seoul',
      onOwnerTaskChangeCommitted,
    });
    const task = ledger.create({ title: 'native task', completion_criteria: 'card closed' });
    const candidate = bindingCandidateFor({ task });
    return { db, ledger, task, candidate };
  }

  it('TG-04 applies an attested binding through the ordinary gateway and rejects revoked source access', async () => {
    const { ledger, task, candidate } = fresh();
    const envelope = makeSignedEnvelope({
      scope: {
        project_refs: [],
        raw_connectors: ['kagemusha'],
        memory_scopes: [],
        allowed_destinations: [],
      },
    });
    const context: OwnerActionContext = {
      ...ownerRun,
      ownerScope: 'owner:runtime',
      envelopeHash: envelope.envelope_hash,
    };
    ledger.attestOwnerActionCandidates(context, setOf(candidate));
    let visible = false;
    let running = true;
    const executor = new GatewayToolExecutor({
      privateConnectorPolicy: kagemushaPolicy,
      channelGrantProvider: () => ({ kagemusha: visible ? ['room-a'] : [] }),
      mamaApi: {
        appendToolTrace: async () => undefined,
        getModelRun: async () => ({
          status: running ? 'running' : 'committed',
          envelope_hash: envelope.envelope_hash,
        }),
      } as never,
    });
    executor.setTaskLedger(ledger);
    const execution = {
      envelope,
      modelRunId: context.modelRunId,
      sourceMessageRef: context.occurrenceKey,
    };
    const decision = {
      candidate_id: candidate.candidateId,
      decision: 'bind',
      reason: 'verified source',
      expected_revision: task.revision,
    };
    await expect(
      executor.execute('task_external_bind', decision as never, execution)
    ).rejects.toThrow(/no longer visible/);
    visible = true;
    running = false;
    await expect(
      executor.execute('task_external_bind', decision as never, execution)
    ).rejects.toThrow(/no longer current/);
    running = true;
    await expect(
      executor.execute('task_external_bind', decision as never, execution)
    ).resolves.toMatchObject({
      success: true,
      receipt: { taskId: task.id, workorderAttemptId: null, outcome: 'bound' },
    });
  });

  function boundFixture(onOwnerTaskChangeCommitted?: (generation: string) => void) {
    const base = fresh(onOwnerTaskChangeCommitted);
    base.ledger.attestOwnerActionCandidates(ownerRun, setOf(base.candidate));
    const bound = base.ledger.applyExternalBindingDecision(
      source(ownerRun),
      {
        candidate_id: base.candidate.candidateId,
        decision: 'bind',
        reason: 'exact task identity confirmed',
        expected_revision: base.candidate.taskRevision,
      },
      originFor(ownerRun, base.candidate.eventId)
    );
    const binding = base.ledger.getExternalBinding(base.task.id)!;
    const sourceTimestampMs = Date.parse('2026-09-07T03:00:00Z');
    const contentSha256 = 'b'.repeat(64);
    const task = base.ledger.getById(base.task.id)!;
    const lifecycle: LifecycleCandidate = {
      kind: 'lifecycle',
      candidateId: externalLifecycleCandidateId({
        kind: 'lifecycle',
        eventId: 'evt_lifecycle_owner',
        externalSourceId: binding.externalSourceId,
        channelPartition: 'room-b',
        contentSha256,
        operatorObservationSeq: binding.lastObservationSeq + 1,
        bindingId: binding.id,
        bindingRevision: binding.revision,
        taskId: task.id,
        taskRevision: task.revision,
        proposedStatus: 'done',
      }),
      eventId: 'evt_lifecycle_owner',
      connector: 'kagemusha',
      sourceType: 'kanban_card',
      externalSourceId: binding.externalSourceId,
      channelPartition: 'room-b',
      contentSha256,
      sourceTimestampMs,
      operatorIngestSeq: 4,
      operatorObservationSeq: binding.lastObservationSeq + 1,
      observedStatus: 'done',
      evidenceSummary: `Kagemusha task 42 reported done at ${new Date(sourceTimestampMs).toISOString()}`,
      bindingId: binding.id,
      bindingRevision: binding.revision,
      taskId: task.id,
      taskRevision: task.revision,
      proposedStatus: 'done',
    };
    return { ...base, bound, binding, lifecycle, task };
  }

  it('TG-04 discovers selected visible source rows through the gateway without a Board workorder', async () => {
    const { db, ledger } = fresh();
    ledger.create({
      title: 'visible task',
      source_event_id: 'evt_visible',
      completion_criteria: 'card closed',
    });
    ledger.create({
      title: 'hidden task',
      source_event_id: 'evt_hidden',
      completion_criteria: 'card closed',
    });
    seedConnectorEventIndex(db, [
      ['evt_visible', 'room-visible', 7],
      ['evt_hidden', 'room-hidden', 8],
    ]);
    const envelope = makeSignedEnvelope({
      scope: {
        project_refs: [],
        raw_connectors: ['kagemusha'],
        memory_scopes: [],
        allowed_destinations: [],
      },
    });
    const executor = new GatewayToolExecutor({
      connectorEventAdapter: db,
      privateConnectorPolicy: kagemushaPolicy,
      channelGrantProvider: () => ({ kagemusha: ['room-visible'] }),
      mamaApi: {
        appendToolTrace: async () => undefined,
        getModelRun: async () => ({ status: 'running', envelope_hash: envelope.envelope_hash }),
      } as never,
    });
    executor.setTaskLedger(ledger);
    const execution = {
      envelope,
      modelRunId: ownerRun.modelRunId,
      sourceMessageRef: ownerRun.occurrenceKey,
    };
    const result = await executor.execute(
      'task_external_candidates',
      {
        event_ids: ['evt_visible', 'evt_hidden'],
      } as never,
      execution
    );
    expect(result).toMatchObject({
      success: true,
      attested: 1,
      candidates: { bindingCandidates: [{ eventId: 'evt_visible' }], diagnostics: [] },
    });
    expect(JSON.stringify(result)).not.toContain('evt_hidden');
    await expect(
      executor.execute(
        'task_external_candidates',
        { event_ids: Array(21).fill('evt_visible') } as never,
        execution
      )
    ).rejects.toThrow(/1-20/);
  });

  describe('AC: a verified owner run binds, declines, applies and retains', () => {
    it('binds from an attested owner-run candidate without any Board attempt', () => {
      const { db, ledger, task, candidate } = fresh();
      expect(ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate))).toEqual({
        attested: 1,
        alreadyAttested: 0,
      });
      const receipt = ledger.applyExternalBindingDecision(
        source(ownerRun),
        {
          candidate_id: candidate.candidateId,
          decision: 'bind',
          reason: 'exact task identity confirmed',
          expected_revision: candidate.taskRevision,
        },
        originFor(ownerRun, candidate.eventId)
      );
      expect(receipt).toMatchObject({
        kind: 'binding',
        outcome: 'bound',
        taskId: task.id,
        workOrderAttemptId: null,
        originRunId: 'mr-owner-1',
        originOwnerScope: 'owner:test-project',
        bindingId: expect.any(Number),
      });
      expect(ledger.getExternalBinding(task.id)).toMatchObject({
        taskId: task.id,
        createdByAttemptId: null,
        createdByRunId: 'mr-owner-1',
        lastObservationSeq: candidate.operatorObservationSeq,
      });
      expect(
        db
          .prepare(
            `SELECT workorder_attempt_id, origin_run_id, origin_owner_scope, origin_envelope_hash
               FROM operator_external_binding_receipts WHERE candidate_id = ?`
          )
          .get(candidate.candidateId)
      ).toEqual({
        workorder_attempt_id: null,
        origin_run_id: 'mr-owner-1',
        origin_owner_scope: 'owner:test-project',
        origin_envelope_hash: 'env-owner-1',
      });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM operator_tasks WHERE kind = 'system'`).get()
      ).toEqual({ n: 0 });
      // The stored receipt reads back as exactly the object the decision returned.
      expect(ledger.getExternalCandidateReceipt(candidate.candidateId)).toEqual(receipt);
    });

    it('declines without creating a binding', () => {
      const { ledger, task, candidate } = fresh();
      ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate));
      const receipt = ledger.applyExternalBindingDecision(
        source(ownerRun),
        {
          candidate_id: candidate.candidateId,
          decision: 'decline',
          reason: 'identity remains ambiguous',
          expected_revision: candidate.taskRevision,
        },
        originFor(ownerRun, candidate.eventId)
      );
      expect(receipt).toMatchObject({ outcome: 'declined', workOrderAttemptId: null });
      expect(ledger.getExternalBinding(task.id)).toBeNull();
    });

    it('applies a lifecycle observation in one receipted revision with an effect receipt', () => {
      const { ledger, task, lifecycle, binding, db } = boundFixture();
      ledger.attestOwnerActionCandidates(retryRun, setOf(lifecycle));
      const before = listEffects(db as never).length;
      const receipt = ledger.applyExternalLifecycleDecision(
        source(retryRun),
        {
          candidate_id: lifecycle.candidateId,
          decision: 'apply',
          reason: 'card reports done',
          expected_revision: lifecycle.taskRevision,
        },
        originFor(retryRun, lifecycle.eventId)
      );
      expect(receipt).toMatchObject({
        kind: 'lifecycle',
        outcome: 'applied',
        workOrderAttemptId: null,
        originRunId: 'mr-owner-2',
        taskRevisionBefore: task.revision,
        taskRevisionAfter: task.revision + 1,
      });
      expect(ledger.getById(task.id)).toMatchObject({
        status: 'done',
        resolutionKind: 'completed_evidence',
        latestEvent: lifecycle.evidenceSummary,
      });
      expect(ledger.getExternalBinding(task.id)).toMatchObject({
        id: binding.id,
        revision: binding.revision + 1,
        lastObservationSeq: lifecycle.operatorObservationSeq,
      });
      const effects = listEffects(db as never);
      expect(effects.length).toBe(before + 1);
      expect(effects.find((effect) => effect.runId === 'mr-owner-2')).toMatchObject({
        kind: 'task_update',
        targetId: String(task.id),
        sourceEventIds: [lifecycle.eventId],
      });
    });

    it('retains an observation, consuming its watermark without touching the task', () => {
      const { ledger, task, lifecycle, binding } = boundFixture();
      ledger.attestOwnerActionCandidates(ownerRun, setOf(lifecycle));
      const receipt = ledger.applyExternalLifecycleDecision(
        source(ownerRun),
        {
          candidate_id: lifecycle.candidateId,
          decision: 'retain',
          reason: 'owner keeps the native status',
          expected_revision: lifecycle.taskRevision,
        },
        originFor(ownerRun, lifecycle.eventId)
      );
      expect(receipt).toMatchObject({ outcome: 'retained', taskRevisionAfter: task.revision });
      expect(ledger.getById(task.id)?.status).toBe('pending');
      expect(ledger.getExternalBinding(task.id)?.lastObservationSeq).toBe(
        binding.lastObservationSeq + 1
      );
    });

    it('notifies only after an applied lifecycle decision commits', async () => {
      const notifications: string[] = [];
      const { ledger, lifecycle } = boundFixture((generation) => notifications.push(generation));
      await Promise.resolve();
      notifications.length = 0;
      ledger.attestOwnerActionCandidates(ownerRun, setOf(lifecycle));
      ledger.applyExternalLifecycleDecision(
        source(ownerRun),
        {
          candidate_id: lifecycle.candidateId,
          decision: 'apply',
          reason: 'card reports done',
          expected_revision: lifecycle.taskRevision,
        },
        originFor(ownerRun, lifecycle.eventId)
      );
      expect(notifications).toEqual([]);
      await Promise.resolve();
      expect(notifications).toEqual([ledger.readGeneration()]);
    });
  });

  describe('AC: exact replay returns the same receipt without another effect', () => {
    it('replays within the run and from a later attested retry run', () => {
      const { ledger, lifecycle, db } = boundFixture();
      ledger.attestOwnerActionCandidates(ownerRun, setOf(lifecycle));
      const input = {
        candidate_id: lifecycle.candidateId,
        decision: 'apply' as const,
        reason: 'card reports done',
        expected_revision: lifecycle.taskRevision,
      };
      const first = ledger.applyExternalLifecycleDecision(
        source(ownerRun),
        input,
        originFor(ownerRun, lifecycle.eventId)
      );
      const effectsAfterFirst = listEffects(db as never).length;
      expect(
        ledger.applyExternalLifecycleDecision(
          source(ownerRun),
          input,
          originFor(ownerRun, lifecycle.eventId)
        )
      ).toEqual(first);
      // A retry run re-attests the same host-built snapshot and gets the same receipt.
      ledger.attestOwnerActionCandidates(retryRun, setOf(lifecycle));
      expect(
        ledger.applyExternalLifecycleDecision(
          source(retryRun),
          input,
          originFor(retryRun, lifecycle.eventId)
        )
      ).toEqual(first);
      expect(listEffects(db as never).length).toBe(effectsAfterFirst);
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM operator_external_lifecycle_receipts`).get()
      ).toEqual({ n: 1 });
      expect(() =>
        ledger.applyExternalLifecycleDecision(
          source(retryRun),
          { ...input, decision: 'retain' },
          originFor(retryRun, lifecycle.eventId)
        )
      ).toThrow(/receipt|decision/i);
      expect(() =>
        ledger.applyExternalLifecycleDecision(
          source(retryRun),
          { ...input, reason: 'changed reason' },
          originFor(retryRun, lifecycle.eventId)
        )
      ).toThrow(/receipt|reason/i);
    });
  });

  describe('AC: attestation identity, candidate bytes and revisions are checked', () => {
    it('refuses a run, envelope or owner that did not attest the candidate', () => {
      const { ledger, candidate } = fresh();
      ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate));
      const input = {
        candidate_id: candidate.candidateId,
        decision: 'bind' as const,
        reason: 'exact task identity confirmed',
        expected_revision: candidate.taskRevision,
      };
      for (const context of [
        { ...ownerRun, modelRunId: 'mr-unattested' },
        { ...ownerRun, envelopeHash: 'env-forged' },
        { ...ownerRun, ownerScope: 'owner:other' },
      ]) {
        expect(() =>
          ledger.applyExternalBindingDecision(
            source(context),
            input,
            originFor(context, candidate.eventId)
          )
        ).toThrow(/attest|absent|owner run/i);
      }
      expect(ledger.getExternalCandidateReceipt(candidate.candidateId)).toBeNull();
    });

    it('refuses occurrence or workorder metadata different from the attested owner context', () => {
      const { ledger, candidate } = fresh();
      const attempt = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'owner-attestation-audit-attempt',
        input: { batchId: 'owner-attestation', events: ['boot'] },
      });
      const attestingContext = { ...ownerRun, workOrderAttemptId: attempt.id };
      ledger.attestOwnerActionCandidates(attestingContext, setOf(candidate));

      expect(() =>
        ledger.loadOwnerActionCandidate(
          { ...attestingContext, occurrenceKey: 'telegram:msg:different' },
          candidate.candidateId,
          'binding'
        )
      ).toThrow(/occurrence/i);
      expect(() =>
        ledger.loadOwnerActionCandidate(
          { ...attestingContext, workOrderAttemptId: undefined },
          candidate.candidateId,
          'binding'
        )
      ).toThrow(/attempt/i);
      expect(
        ledger.listOwnerActionCandidates({
          ...attestingContext,
          occurrenceKey: 'telegram:msg:different',
        })
      ).toEqual([]);
      expect(
        ledger.listOwnerActionCandidates({ ...attestingContext, workOrderAttemptId: undefined })
      ).toEqual([]);
    });

    it('refuses an origin that does not name the attesting run or the exact host event', () => {
      const { ledger, candidate } = fresh();
      ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate));
      const input = {
        candidate_id: candidate.candidateId,
        decision: 'bind' as const,
        reason: 'exact task identity confirmed',
        expected_revision: candidate.taskRevision,
      };
      expect(() =>
        ledger.applyExternalBindingDecision(source(ownerRun), input, {
          runId: 'mr-someone-else',
          causeEventIds: [candidate.eventId],
        })
      ).toThrow(/trusted.*origin|origin/i);
      expect(() =>
        ledger.applyExternalBindingDecision(source(ownerRun), input, {
          runId: ownerRun.modelRunId,
          causeEventIds: ['evt_other'],
        })
      ).toThrow(/exact host origin event/i);
      expect(() =>
        ledger.applyExternalBindingDecision(source(ownerRun), input, {
          runId: ownerRun.modelRunId,
          workOrderAttemptId: 77,
          causeEventIds: [candidate.eventId],
        })
      ).toThrow(/attempt/i);
    });

    it('refuses a decision after its carried non-Board attempt becomes terminal', () => {
      const { ledger, candidate } = fresh();
      const attempt = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'owner-candidate-stale-wiki-attempt',
        input: { batchId: 'owner-candidate-stale', events: ['boot'] },
      });
      expect(ledger.claimNextWorkOrder()?.id).toBe(attempt.id);
      const context = { ...ownerRun, workOrderAttemptId: attempt.id };
      ledger.attestOwnerActionCandidates(context, setOf(candidate));
      ledger.completeWorkOrder(attempt.id);

      expect(() =>
        ledger.applyExternalBindingDecision(
          source(context),
          {
            candidate_id: candidate.candidateId,
            decision: 'bind',
            reason: 'late decision',
            expected_revision: candidate.taskRevision,
          },
          {
            ...originFor(context, candidate.eventId),
            workOrderAttemptId: attempt.id,
          }
        )
      ).toThrow(new RegExp(`wiki workorder ${attempt.id} is no longer active`));
      expect(ledger.getExternalCandidateReceipt(candidate.candidateId)).toBeNull();
    });

    it('refuses the wrong candidate kind and model-authored or changed snapshots', () => {
      const { ledger, candidate, db } = fresh();
      // A snapshot whose id does not derive from its content is not host-built.
      const forged = { ...candidate, taskRevision: candidate.taskRevision + 1 };
      expect(() => ledger.attestOwnerActionCandidates(ownerRun, setOf(forged))).toThrow(
        /candidate id|content|host-built/i
      );
      ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate));
      expect(() =>
        ledger.loadOwnerActionCandidate(ownerRun, candidate.candidateId, 'lifecycle')
      ).toThrow(/kind/i);
      // A snapshot with an edited derived field is not host-built at all.
      expect(() =>
        ledger.attestOwnerActionCandidates(ownerRun, setOf({ ...candidate, evidenceSummary: 'x' }))
      ).toThrow(/host-derived|host-built/i);
      // Same run, same id, different bytes (a field outside the id) is a
      // conflict, not a second attestation.
      expect(() =>
        ledger.attestOwnerActionCandidates(
          ownerRun,
          setOf({ ...candidate, operatorIngestSeq: candidate.operatorIngestSeq + 1 })
        )
      ).toThrow(/conflict|differs/i);
      expect(ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate))).toEqual({
        attested: 0,
        alreadyAttested: 1,
      });
      // Attested rows are immutable at the storage layer...
      expect(() =>
        db
          .prepare(
            `UPDATE operator_owner_action_candidates SET candidate_json = '{}' WHERE candidate_id = ?`
          )
          .run(candidate.candidateId)
      ).toThrow(/immutable/i);
      expect(() =>
        db
          .prepare(`DELETE FROM operator_owner_action_candidates WHERE candidate_id = ?`)
          .run(candidate.candidateId)
      ).toThrow(/immutable/i);
      // ...and even bytes changed behind the trigger fail integrity on load.
      db.exec('DROP TRIGGER trg_operator_owner_action_candidates_immutable_update');
      db.prepare(
        `UPDATE operator_owner_action_candidates SET candidate_json = ? WHERE candidate_id = ?`
      ).run(JSON.stringify({ ...candidate, taskRevision: 9 }), candidate.candidateId);
      expect(() =>
        ledger.loadOwnerActionCandidate(ownerRun, candidate.candidateId, 'binding')
      ).toThrow(/integrity|sha256|tamper/i);
      expect(() =>
        ledger.applyExternalBindingDecision(
          source(ownerRun),
          {
            candidate_id: candidate.candidateId,
            decision: 'bind',
            reason: 'exact task identity confirmed',
            expected_revision: 9,
          },
          originFor(ownerRun, candidate.eventId)
        )
      ).toThrow(/integrity|sha256|tamper/i);
      expect(ledger.getExternalCandidateReceipt(candidate.candidateId)).toBeNull();
    });

    it('rejects a stale expected_revision and supersedes after task drift', () => {
      const { ledger, task, candidate } = fresh();
      ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate));
      expect(() =>
        ledger.applyExternalBindingDecision(
          source(ownerRun),
          {
            candidate_id: candidate.candidateId,
            decision: 'bind',
            reason: 'exact task identity confirmed',
            expected_revision: candidate.taskRevision + 1,
          },
          originFor(ownerRun, candidate.eventId)
        )
      ).toThrow(/revision/i);
      ledger.update(task.id, { title: 'drifted' });
      const receipt = ledger.applyExternalBindingDecision(
        source(ownerRun),
        {
          candidate_id: candidate.candidateId,
          decision: 'bind',
          reason: 'exact task identity confirmed',
          expected_revision: candidate.taskRevision,
        },
        originFor(ownerRun, candidate.eventId)
      );
      expect(receipt.outcome).toBe('superseded');
      expect(ledger.getExternalBinding(task.id)).toBeNull();
    });

    it('validates the owner action identity fields before touching storage', () => {
      const { ledger, candidate } = fresh();
      for (const context of [
        { ...ownerRun, ownerScope: '' },
        { ...ownerRun, modelRunId: '  ' },
        { ...ownerRun, envelopeHash: '' },
        { ...ownerRun, occurrenceKey: '' },
        { ...ownerRun, workOrderAttemptId: 0 },
      ]) {
        expect(() => ledger.attestOwnerActionCandidates(context, setOf(candidate))).toThrow(
          /owner action/
        );
      }
    });
  });

  describe('AC: owner-run receipts stay visible to existing inspection and discovery', () => {
    it('is seen as decided by a Board attempt carrying the same candidate and by discovery', () => {
      const { ledger, task, candidate } = fresh();
      ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate));
      const owned = ledger.applyExternalBindingDecision(
        source(ownerRun),
        {
          candidate_id: candidate.candidateId,
          decision: 'decline',
          reason: 'identity remains ambiguous',
          expected_revision: candidate.taskRevision,
        },
        originFor(ownerRun, candidate.eventId)
      );
      expect(ledger.getReceiptedExternalCandidateIds([candidate.candidateId])).toEqual(
        new Set([candidate.candidateId])
      );
      expect(ledger.inspectOwnerActionCandidateRun(ownerRun)).toEqual({
        disposition: 'complete',
        outcomes: ['declined'],
      });
      // A legacy queued Board attempt that still carries this candidate is
      // complete by receipt, not "undecided", and its legacy replay returns
      // the owner-run receipt unchanged.
      const legacy = enqueueAndClaimBindingAttempt(ledger, candidate, 'legacy-after-owner');
      expect(ledger.inspectBoardCandidateAttempt(legacy.id)).toEqual({
        disposition: 'complete',
        outcomes: ['declined'],
      });
      const replayed: ExternalBindingReceipt = ledger.applyExternalBindingDecision(
        legacy.id,
        {
          candidate_id: candidate.candidateId,
          decision: 'decline',
          reason: 'identity remains ambiguous',
          expected_revision: candidate.taskRevision,
        },
        { runId: 'mr-board', workOrderAttemptId: legacy.id, causeEventIds: [candidate.eventId] }
      );
      expect(replayed).toEqual(owned);
      expect(ledger.getExternalBinding(task.id)).toBeNull();
    });

    it('discovers through the shared builder, honours exact partition visibility, and attests', () => {
      const db = new Database(':memory:');
      databases.push(db);
      const ledger = new TaskLedger(db, { now: () => NOW });
      const task = ledger.create({ title: 'native task', source_event_id: 'evt_visible' });
      ledger.create({ title: 'hidden task', source_event_id: 'evt_hidden' });
      seedConnectorEventIndex(db, [
        ['evt_visible', 'room-visible', 7],
        ['evt_hidden', 'room-hidden', 8],
      ]);
      const base = {
        eventIds: ['evt_visible', 'evt_hidden'],
        getAdapter: () => db,
        ledger,
        privateConnectorPolicy: kagemushaPolicy,
        rawConnectorScope: ['kagemusha'],
      };
      // The re-export from api-routes-init is the same function.
      expect(legacyReExport).toBe(buildReconcileExternalLifecycleCandidates);
      // Without an owner predicate the boot-level scope alone governs (legacy behaviour).
      expect(
        buildReconcileExternalLifecycleCandidates(base).bindingCandidates.map((c) => c.eventId)
      ).toEqual(['evt_visible', 'evt_hidden']);
      // With the owner's exact partition grant, the hidden partition is consumed
      // silently: no candidate and no diagnostic that would leak its existence.
      const visibleOnly = buildReconcileExternalLifecycleCandidates({
        ...base,
        isPartitionVisible: ({ connector, channel }) =>
          connector === 'kagemusha' && channel === 'room-visible',
      });
      expect(visibleOnly.bindingCandidates.map((c) => c.eventId)).toEqual(['evt_visible']);
      expect(visibleOnly.diagnostics).toEqual([]);

      const attestation = attestOwnerExternalLifecycleCandidates({
        ...base,
        context: ownerRun,
        isPartitionVisible: ({ channel }) => channel === 'room-visible',
      });
      expect(attestation).toMatchObject({ attested: 1, alreadyAttested: 0 });
      expect(ledger.listOwnerActionCandidates(ownerRun)).toEqual([
        {
          candidateId: attestation.candidates.bindingCandidates[0]!.candidateId,
          kind: 'binding',
          taskId: task.id,
          eventId: 'evt_visible',
        },
      ]);
      // Deciding it then removes it from the next discovery (receipt suppression).
      const candidate = attestation.candidates.bindingCandidates[0]!;
      ledger.applyExternalBindingDecision(
        source(ownerRun),
        {
          candidate_id: candidate.candidateId,
          decision: 'bind',
          reason: 'exact task identity confirmed',
          expected_revision: candidate.taskRevision,
        },
        originFor(ownerRun, candidate.eventId)
      );
      expect(
        attestOwnerExternalLifecycleCandidates({ ...base, context: retryRun }).candidates
          .bindingCandidates
      ).toEqual([]);
    });

    it('reports zero and partial receipt states for an owner run', () => {
      const { ledger, task, candidate } = fresh();
      const second = bindingCandidateFor({
        task,
        eventId: 'evt_binding_2',
        externalSourceId: 'task:43',
        operatorObservationSeq: 10,
      });
      expect(ledger.inspectOwnerActionCandidateRun(ownerRun)).toEqual({ disposition: 'none' });
      ledger.attestOwnerActionCandidates(ownerRun, setOf(candidate, second));
      expect(ledger.inspectOwnerActionCandidateRun(ownerRun)).toEqual({ disposition: 'zero' });
      ledger.applyExternalBindingDecision(
        source(ownerRun),
        {
          candidate_id: candidate.candidateId,
          decision: 'decline',
          reason: 'first decided',
          expected_revision: candidate.taskRevision,
        },
        originFor(ownerRun, candidate.eventId)
      );
      expect(ledger.inspectOwnerActionCandidateRun(ownerRun)).toEqual({
        disposition: 'partial',
        missingCandidateIds: [second.candidateId],
      });
      expect(ledger.listOwnerActionCandidates(ownerRun)).toEqual([
        {
          candidateId: candidate.candidateId,
          kind: 'binding',
          taskId: task.id,
          eventId: candidate.eventId,
        },
        {
          candidateId: second.candidateId,
          kind: 'binding',
          taskId: task.id,
          eventId: second.eventId,
        },
      ]);
      expect(ledger.listOwnerActionCandidates({ ...ownerRun, ownerScope: 'owner:other' })).toEqual(
        []
      );
    });
  });
});
