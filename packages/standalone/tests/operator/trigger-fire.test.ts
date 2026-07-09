/**
 * Unit tests for fireTrigger (Task 2 - fire -> recall memoryQuery + gather evidence + surface).
 * Read-only, self-activating (G4). Tested against a fake OperatorMemoryPort; the real
 * mama-core recallMemory binding is wired at operator integration.
 */

import { describe, it, expect } from 'vitest';
import { fireTrigger } from '../../src/operator/trigger-fire.js';
import type { TriggerSignal } from '../../src/operator/trigger-types.js';
import type { OperatorMemoryPort } from '../../src/operator/operator-interfaces.js';

function sig(over: Partial<TriggerSignal> = {}): TriggerSignal {
  return {
    kind: 'k',
    memoryQuery: over.memoryQuery ?? 'weekly report cadence',
    requiredEvidence: over.requiredEvidence ?? ['current_message'],
    confidence: 0.7,
    detector: 'agent-authored:t1',
    channelId: 'c1',
    occurredAt: 1000,
    reason: 'r',
    text: over.text ?? 'the report is late',
    sourceRefs: [],
  };
}

function fakeMem(recalls: { topic: string; content: string; similarity?: number }[]): OperatorMemoryPort {
  return {
    async save() {
      return;
    },
    async recall() {
      return recalls;
    },
  };
}

describe('fireTrigger', () => {
  it('recalls the triggered memoryQuery and surfaces it', async () => {
    const mem = fakeMem([{ topic: 'report-cadence', content: 'reports go out Fridays', similarity: 0.8 }]);
    const out = await fireTrigger(sig(), mem);
    expect(out.recalled).toEqual([{ topic: 'report-cadence', content: 'reports go out Fridays' }]);
    expect(out.evidence.current_message).toBe('the report is late');
  });

  it('empty recall returns [] (logged, not thrown)', async () => {
    const out = await fireTrigger(sig(), fakeMem([]));
    expect(out.recalled).toEqual([]);
  });

  it('resolves injected evidence providers for requiredEvidence keys', async () => {
    const out = await fireTrigger(sig({ requiredEvidence: ['current_message', 'channel_history'] }), fakeMem([]), {
      channel_history: async () => ['msg1', 'msg2'],
    });
    expect(out.evidence.current_message).toBe('the report is late');
    expect(out.evidence.channel_history).toEqual(['msg1', 'msg2']);
  });

  it('unprovided evidence key resolves to null (no guess)', async () => {
    const out = await fireTrigger(sig({ requiredEvidence: ['task_state'] }), fakeMem([]));
    expect(out.evidence.task_state).toBeNull();
  });

  it('a THROWING evidence provider does not abort the fire; failure surfaces in the evidence (PR #119)', async () => {
    const out = await fireTrigger(
      sig({ requiredEvidence: ['current_message', 'channel_history'] }),
      fakeMem([{ topic: 't', content: 'c' }]),
      {
        channel_history: async () => {
          throw new Error('db locked');
        },
      }
    );
    expect(out.recalled).toHaveLength(1); // the fire itself completed
    expect(out.evidence.current_message).toBe('the report is late');
    expect(String(out.evidence.channel_history)).toContain('failed');
    expect(String(out.evidence.channel_history)).toContain('db locked'); // surfaced, not swallowed
  });

  it('calls the onFire observability hook once per fire', async () => {
    let fires = 0;
    await fireTrigger(sig(), fakeMem([]), {}, { onFire: () => (fires += 1) });
    expect(fires).toBe(1);
  });
});
