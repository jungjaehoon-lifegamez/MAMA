/**
 * What a temporal run is allowed to read.
 *
 * `temporalPacketRawSourcesWithinBoundSource` refuses a reconcile whose packet contains a
 * raw ref outside the task's connector:channel. While raw reads returned nothing that
 * check was vacuous - every packet had zero raw refs and passed. The channel grant makes
 * raw reads return rows, and at that moment a lane-wide envelope hands the compile every
 * configured channel of every granted connector, so every raw-backed temporal run fails a
 * check it has no way to satisfy.
 *
 * The existing temporal tests cannot see this: they stub the compile service and derive
 * the packet's channel from the task's own source, so the check can only pass. These
 * assert the envelope scope itself, and then the grant that scope produces.
 *
 * Synthetic data only.
 */
import { describe, it, expect } from 'vitest';
import { temporalTaskBinding, workOrderEnvelopeScope } from '../../src/cli/commands/start.js';
import { narrowGrantToEnvelope } from '../../src/evidence/read.js';

const CONFIGURED = { chat: ['C001', 'C002'], board: ['b-1'] };

function ledgerWith(sourceChannel: string | null) {
  return { getById: () => ({ sourceChannel }) };
}

describe('temporalTaskBinding', () => {
  it('splits the task channel on the first colon', () => {
    expect(temporalTaskBinding(ledgerWith('chat:C001'), 1)).toEqual({
      connector: 'chat',
      channel: 'C001',
    });
  });

  // Channel ids contain colons of their own; splitting on the last one, or on all of
  // them, binds the run to a channel that does not exist.
  it('keeps colons inside the channel id', () => {
    expect(temporalTaskBinding(ledgerWith('kagemusha:kakao:room-1'), 1)).toEqual({
      connector: 'kagemusha',
      channel: 'kakao:room-1',
    });
  });

  it('returns null for a task that names no channel', () => {
    expect(temporalTaskBinding(ledgerWith(null), 1)).toBeNull();
    expect(temporalTaskBinding(ledgerWith(''), 1)).toBeNull();
    expect(temporalTaskBinding(ledgerWith('chat'), 1)).toBeNull();
    expect(temporalTaskBinding(ledgerWith('chat:'), 1)).toBeNull();
    expect(temporalTaskBinding({ getById: () => null }, 1)).toBeNull();
  });
});

describe('workorder envelope scope', () => {
  const base = {
    projectId: '/w/project',
    laneConnectors: ['chat', 'board'],
  };

  it('binds a temporal run to its task connector and channel', () => {
    const scope = workOrderEnvelopeScope({
      ...base,
      workKind: 'temporal',
      temporalBinding: { connector: 'chat', channel: 'C001' },
    });

    expect(scope.raw_connectors).toEqual(['chat']);
    expect(scope.memory_scopes).toContainEqual({ kind: 'channel', id: 'chat:C001' });
  });

  // The check requires ZERO raw refs when the task names no channel, so the grant has to
  // be empty rather than merely narrow - "narrow" would still admit a ref.
  it('gives a temporal run with no task channel no connector at all', () => {
    const scope = workOrderEnvelopeScope({
      ...base,
      workKind: 'temporal',
      temporalBinding: null,
    });

    expect(scope.raw_connectors).toEqual([]);
  });

  it('leaves every other lane on its configured connectors', () => {
    const scope = workOrderEnvelopeScope({
      ...base,
      workKind: 'board',
      temporalBinding: null,
      grant: {},
    });

    expect(scope.raw_connectors).toEqual(['chat', 'board']);
    expect(scope.memory_scopes).toContainEqual({ kind: 'channel', id: 'operator:worker:board' });
  });

  it('a non-temporal lane mirrors the grant into memory scopes - recall follows raw', () => {
    // The dominant compile failure S2 named: lanes held only synthetic
    // identities, so every recall of a real channel's memories was denied.
    const scope = workOrderEnvelopeScope({
      ...base,
      workKind: 'board',
      temporalBinding: null,
      grant: { chat: ['C001', 'C002'], board: ['b-1'], gmail: ['inbox'] },
    });

    expect(scope.memory_scopes).toContainEqual({ kind: 'channel', id: 'chat:C001' });
    expect(scope.memory_scopes).toContainEqual({ kind: 'channel', id: 'board:b-1' });
    // gmail is not a lane connector - its memories stay invisible.
    expect(scope.memory_scopes).not.toContainEqual({ kind: 'channel', id: 'gmail:inbox' });
  });

  it('a temporal run does NOT mirror - the one-channel binding stays strict', () => {
    const scope = workOrderEnvelopeScope({
      ...base,
      workKind: 'temporal',
      temporalBinding: { connector: 'chat', channel: 'C001' },
      grant: { chat: ['C001', 'C002'] },
    });

    expect(scope.memory_scopes).toContainEqual({ kind: 'channel', id: 'chat:C001' });
    expect(scope.memory_scopes).not.toContainEqual({ kind: 'channel', id: 'chat:C002' });
  });
});

describe('the grant that scope produces', () => {
  // The property the packet check depends on: a bound temporal envelope can only read one
  // channel, so the packet cannot contain a ref the check would refuse.
  it('narrows to exactly the task channel', () => {
    const scope = workOrderEnvelopeScope({
      projectId: '/w/project',
      laneConnectors: ['chat', 'board'],
      workKind: 'temporal',
      temporalBinding: { connector: 'chat', channel: 'C001' },
    });

    expect(
      narrowGrantToEnvelope(CONFIGURED, {
        connectors: scope.raw_connectors,
        scopes: scope.memory_scopes,
      })
    ).toEqual({ chat: ['C001'] });
  });

  // The regression. A lane-wide envelope carries only `channel:operator:worker:temporal`,
  // whose connector is not in the grant, so nothing narrows and the run may read every
  // channel of every granted connector - which is what made the packet check unsatisfiable.
  it('is what the lane-wide envelope failed to do', () => {
    const laneWide = workOrderEnvelopeScope({
      projectId: '/w/project',
      laneConnectors: ['chat', 'board'],
      workKind: 'temporal',
      temporalBinding: null,
    });

    // Same scopes, but with the lane's connectors restored - the shape before this change.
    expect(
      narrowGrantToEnvelope(CONFIGURED, {
        connectors: ['chat', 'board'],
        scopes: laneWide.memory_scopes,
      })
    ).toEqual({ chat: ['C001', 'C002'], board: ['b-1'] });
  });

  // A task bound to a channel the owner never configured reads nothing, rather than
  // falling back to the connector's other channels.
  it('reads nothing when the task channel is not configured', () => {
    const scope = workOrderEnvelopeScope({
      projectId: '/w/project',
      laneConnectors: ['chat'],
      workKind: 'temporal',
      temporalBinding: { connector: 'chat', channel: 'C-never-configured' },
    });

    expect(
      narrowGrantToEnvelope(CONFIGURED, {
        connectors: scope.raw_connectors,
        scopes: scope.memory_scopes,
      })
    ).toEqual({ chat: [] });
  });
});
