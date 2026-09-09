import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { ProcedureStore, type ProcedureSaveInput } from '../../src/operator/procedure-store.js';
import {
  OwnerEventInbox,
  type OwnerEventActivation,
} from '../../src/operator/owner-event-inbox.js';
import {
  resolveProcedureActivation,
  assertActiveProcedureActivations,
} from '../../src/operator/procedure-activation.js';
import { TriggerRegistry } from '../../src/operator/trigger-registry.js';
import { applyReview } from '../../src/operator/trigger-review.js';
import { buildOwnerEventPrompt } from '../../src/operator/owner-event-prompt.js';

const access = { ownerScope: 'owner', projectId: 'project', channelId: 'channel' };
const input: ProcedureSaveInput = {
  id: 'p',
  correctionId: 'c1',
  title: 'Private title',
  description: 'Private description',
  whenToUse: 'Feedback documents',
  whenNotToUse: 'Chat',
  body: 'old body',
  expectedResults: ['reviewed file'],
  scope: { ownerScope: 'owner', projectId: 'project', channelIds: ['channel'] },
  sourceRefs: ['message:1'],
  originalInstruction: 'Review file',
};
const activation: OwnerEventActivation = {
  triggerId: 't',
  kind: 'Private title',
  memoryQuery: 'Private description',
  procedure: [{ action: 'read', description: 'old body' }],
  requiredEvidence: [],
  procedureRef: { id: 'p', revision: 1 },
};
describe('TG-04/TG-05/TG-06 procedure admission', () => {
  let db: Database;
  let store: ProcedureStore;
  let inbox: OwnerEventInbox;
  beforeEach(() => {
    db = new Database(':memory:');
    store = new ProcedureStore(db);
    inbox = new OwnerEventInbox(db);
    store.save(input, access);
  });
  afterEach(() => db.close());
  it('resolves pending work after inbox recreation and pins admitted version across later changes', () => {
    inbox.enqueue({
      channelKey: 'channel',
      eventIds: ['event'],
      lines: ['feedback'],
      activations: [activation],
    });
    store.save({ ...input, expectedRevision: 1, correctionId: 'c2', body: 'new body' }, access);
    const pending = new OwnerEventInbox(db).claimNext()!;
    pending.activations = pending.activations.map((a) =>
      resolveProcedureActivation(store, access, a)
    );
    inbox.saveAdmittedActivations(pending);
    expect(pending.activations[0].queuedProcedureRef?.revision).toBe(1);
    expect(pending.activations[0].procedureRef?.revision).toBe(2);
    expect(pending.activations[0].procedure[0].description).toContain('new body');
    store.save({ ...input, expectedRevision: 2, correctionId: 'c3', body: 'newer body' }, access);
    expect(() => assertActiveProcedureActivations(store, access, pending)).not.toThrow();
    expect(pending.activations[0].procedureRef?.revision).toBe(2);
  });
  it('redacts unauthorized, retired and missing revision metadata before rendering', () => {
    for (const resolved of [
      resolveProcedureActivation(store, { ...access, channelId: 'other' }, activation),
      resolveProcedureActivation(store, access, {
        ...activation,
        procedureRef: { id: 'p', revision: 42 },
      }),
    ]) {
      expect(resolved.availability).toBe('unavailable');
      const prompt = buildOwnerEventPrompt({
        ownerBrief: '',
        batch: {
          id: 1,
          channelKey: 'channel',
          eventIds: [],
          lines: [],
          activations: [resolved],
          status: 'claimed',
          attempts: 0,
          createdAt: 0,
        },
      });
      expect(prompt).not.toContain('Private');
      expect(prompt).not.toContain('old body');
    }
    const admitted = resolveProcedureActivation(store, access, activation);
    store.retire('p', 1, 'retire', 'stop', access);
    expect(resolveProcedureActivation(store, access, activation).availability).toBe('unavailable');
    expect(() =>
      assertActiveProcedureActivations(store, access, { activations: [admitted] })
    ).toThrow(/unavailable/);
  });
  it('TG-04 rejects a foreign scope key before resolving metadata', () => {
    const resolved = resolveProcedureActivation(store, access, {
      ...activation,
      procedureRef: { id: 'p', revision: 1, scopeKey: 'f'.repeat(64) },
    });
    expect(resolved.availability).toBe('unavailable');
    expect(resolved.kind).toBe('');
    expect(resolved.procedure).toEqual([]);
    const own = resolveProcedureActivation(store, access, activation);
    expect(own.procedureRef?.scopeKey).toMatch(/^[0-9a-f]{64}$/);
  });
  it('imports separate channel mappings and preserves canonical routing after later review', () => {
    const legacy = { ...activation, procedureRef: undefined };
    const registry = new TriggerRegistry(db);
    registry.create({
      id: 't',
      kind: legacy.kind,
      memoryQuery: legacy.memoryQuery,
      procedure: legacy.procedure,
      requiredEvidence: legacy.requiredEvidence,
      match: { keywords: ['feedback'], keywordMode: 'any', minConfidence: 0.7 },
      authoredBy: 'agent',
      provenance: { createdFrom: 'test', note: '' },
    });
    const resolved = resolveProcedureActivation(store, access, legacy);
    const otherAccess = { ...access, channelId: 'other' };
    const other = resolveProcedureActivation(store, otherAccess, legacy);
    expect(resolved.availability).toBe('available');
    expect(other.availability).toBe('available');
    expect(resolved.procedureRef?.id).not.toBe(other.procedureRef?.id);
    const imported = store.read(resolved.procedureRef!.id, access)!;
    expect(imported.body).toContain('old body');
    expect(imported.origin?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(imported.scope.channelIds).toEqual(['channel']);
    expect(store.read(imported.id, otherAccess)).toBeNull();
    const current = registry.getById('t')!;
    applyReview(
      {
        action: 'refined',
        reason: 'narrow feedback',
        newSpec: {
          id: 't2',
          kind: current.kind,
          memoryQuery: current.memoryQuery,
          procedure: [],
          requiredEvidence: [],
          match: { ...current.match, keywords: ['review feedback'] },
        },
      },
      't',
      registry,
      current.revision
    );
    const next = registry.getById('t2')!;
    expect(next.procedureRef).toBeUndefined();
    const reactivated = resolveProcedureActivation(store, access, {
      ...legacy,
      triggerId: 't2',
      procedure: next.procedure,
    });
    expect(reactivated.procedureRef).toEqual(resolved.procedureRef);
    expect(store.history(imported.id, access)).toHaveLength(1);
  });
});
