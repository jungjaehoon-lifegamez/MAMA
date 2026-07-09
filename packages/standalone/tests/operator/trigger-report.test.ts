/**
 * Unit tests for the trigger-loop report leg (M1.5 - the OUTPUT half).
 * The AGENT composes the digest from accumulated fire/author activity (agent-first);
 * the system only schedules and sends. No activity -> no send (no spam).
 */

import { describe, it, expect, vi } from 'vitest';
import { TriggerReporter } from '../../src/operator/trigger-report.js';

function fire(triggerId: string, kind: string, channelId: string, topics: string[]) {
  return { triggerId, kind, channelId, recalledTopics: topics };
}

describe('TriggerReporter', () => {
  it('no activity -> no agent call, no send', async () => {
    const askAgent = vi.fn();
    const send = vi.fn();
    const r = new TriggerReporter();
    await r.maybeReport(askAgent, { send });
    expect(askAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('accumulated fires -> agent composes digest -> sent once, buffer cleared', async () => {
    const askAgent = vi.fn(async () => 'DIGEST: 2 report-triggers fired on slack; recalled cadence memory.');
    const send = vi.fn(async () => {});
    const r = new TriggerReporter();
    r.recordFire(fire('t1', 'weekly_report', 'slack:c1', ['report-cadence']));
    r.recordFire(fire('t1', 'weekly_report', 'slack:c1', ['report-cadence']));
    r.recordAuthored(1);

    await r.maybeReport(askAgent, { send });
    expect(askAgent).toHaveBeenCalledTimes(1);
    const prompt = askAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('weekly_report'); // aggregate activity reaches the agent
    expect(prompt).toContain('report-cadence');
    expect(send).toHaveBeenCalledWith('DIGEST: 2 report-triggers fired on slack; recalled cadence memory.');

    // buffer cleared -> second call sends nothing
    await r.maybeReport(askAgent, { send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('agent answering NOTHING suppresses the send (agent judges silence)', async () => {
    const askAgent = vi.fn(async () => 'NOTHING');
    const send = vi.fn();
    const r = new TriggerReporter();
    r.recordFire(fire('t1', 'k', 'c', []));
    await r.maybeReport(askAgent, { send });
    expect(send).not.toHaveBeenCalled();
  });

  it('send failure propagates loudly (no-fallback), buffer preserved for retry', async () => {
    const askAgent = vi.fn(async () => 'digest');
    const send = vi.fn(async () => {
      throw new Error('telegram down');
    });
    const r = new TriggerReporter();
    r.recordFire(fire('t1', 'k', 'c', []));
    await expect(r.maybeReport(askAgent, { send })).rejects.toThrow('telegram down');
    // still buffered -> a later attempt reports again
    const send2 = vi.fn(async () => {});
    await r.maybeReport(askAgent, { send: send2 });
    expect(send2).toHaveBeenCalledTimes(1);
  });
});
