/**
 * Unit tests for SituationReporter (M2-T1). Supersedes TriggerReporter (M1.5): the four M1.5
 * behaviors are ported here (no-activity / accumulate-and-send / NOTHING-suppress / no-fallback),
 * plus the new M2 window + recalled-memory + digest/full framings + explicit prompt bounds.
 * Agent injected (vi.fn) - no real CLI. Synthetic data only.
 */
import { describe, it, expect, vi } from 'vitest';
import { SituationReporter } from '../../src/operator/situation-report.js';
import type { OperatorChannelEvent } from '../../src/operator/operator-interfaces.js';

function ev(id: number, channelId: string, content: string): OperatorChannelEvent {
  return { id, channel: 'slack', channelId, userId: 'u1', role: 'user', content, createdAt: id * 100 };
}
function fire(triggerId: string, kind: string, channelId: string, recalled: { topic: string; content: string }[] = []) {
  return { triggerId, kind, channelId, recalled };
}

describe('SituationReporter (M2, supersedes TriggerReporter M1.5)', () => {
  // ---- ported M1.5 behaviors ----
  it('no activity -> no agent call, no send', async () => {
    const askAgent = vi.fn();
    const send = vi.fn();
    const r = new SituationReporter();
    expect(await r.report(askAgent, { send }, 'digest')).toBe(false);
    expect(askAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('accumulated fires -> agent composes digest -> sent once, buffer cleared', async () => {
    const askAgent = vi.fn(async () => 'DIGEST: report-trigger fired on slack.');
    const send = vi.fn(async () => {});
    const r = new SituationReporter();
    r.recordFire(fire('t1', 'weekly_report', 'slack:c1', [{ topic: 'report-cadence', content: 'Fridays' }]));
    r.recordFire(fire('t1', 'weekly_report', 'slack:c1', [{ topic: 'report-cadence', content: 'Fridays' }]));
    r.recordAuthored(1);
    expect(await r.report(askAgent, { send }, 'digest')).toBe(true);
    const prompt = askAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('weekly_report');  // aggregate fire activity reaches the agent
    expect(prompt).toContain('report-cadence');  // recalled memory reaches the agent
    expect(send).toHaveBeenCalledWith('DIGEST: report-trigger fired on slack.');
    expect(await r.report(askAgent, { send }, 'digest')).toBe(false); // buffer cleared
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('agent answering NOTHING suppresses the send', async () => {
    const askAgent = vi.fn(async () => 'NOTHING');
    const send = vi.fn();
    const r = new SituationReporter();
    r.recordFire(fire('t1', 'k', 'c'));
    expect(await r.report(askAgent, { send }, 'digest')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('send failure propagates loudly (no-fallback), buffer preserved for retry', async () => {
    const askAgent = vi.fn(async () => 'digest');
    const send = vi.fn(async () => { throw new Error('telegram down'); });
    const r = new SituationReporter();
    r.recordFire(fire('t1', 'k', 'c'));
    await expect(r.report(askAgent, { send }, 'digest')).rejects.toThrow('telegram down');
    const send2 = vi.fn(async () => {});
    await r.report(askAgent, { send: send2 }, 'digest');
    expect(send2).toHaveBeenCalledTimes(1);
  });

  // ---- new M2 behaviors ----
  it('window: per-channel counts + recent excerpts reach the agent; window activity alone is enough', async () => {
    const askAgent = vi.fn(async () => 'situation');
    const send = vi.fn(async () => {});
    const r = new SituationReporter();
    r.recordWindow([ev(1, 'slack:a', 'deploy is failing again'), ev(2, 'slack:b', 'lunch?'), ev(3, 'slack:a', 'still failing')]);
    expect(r.hasActivity()).toBe(true);
    expect(await r.report(askAgent, { send }, 'full')).toBe(true);
    const prompt = askAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('slack:a: 2 msg');
    expect(prompt).toContain('deploy is failing again');
    expect(prompt).toContain('slack:b: 1 msg');
  });

  it('window excerpts are bounded: only the last K per channel, each truncated', async () => {
    const askAgent = vi.fn(async () => 'x');
    const send = vi.fn(async () => {});
    const r = new SituationReporter();
    const long = 'y'.repeat(500);
    for (let i = 1; i <= 20; i++) {
      const tag = `mark_${String(i).padStart(3, '0')}_`;
      r.recordWindow([ev(i, 'slack:a', tag + long)]);
    }
    await r.report(askAgent, { send }, 'full');
    const prompt = askAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('slack:a: 20 msg');   // exact count
    expect(prompt).toContain('mark_020_');          // last excerpt kept
    expect(prompt).not.toContain('mark_001_');      // early excerpts dropped (last-K only)
    expect(prompt).not.toContain('y'.repeat(200));  // each excerpt truncated
  });

  it('digest vs full framing differ; both keep NOTHING + the M1.5 fire section', () => {
    const r = new SituationReporter();
    r.recordWindow([ev(1, 'slack:a', 'hi')]);
    expect(r.buildPrompt('digest')).toContain('digest');
    expect(r.buildPrompt('full')).toContain('FULLER');
    for (const mode of ['digest', 'full'] as const) {
      expect(r.buildPrompt(mode)).toContain('NOTHING');
      expect(r.buildPrompt(mode)).toContain('Fire activity:');
    }
  });

  it('many channels are bounded in the prompt (busiest first, rest collapsed)', () => {
    const r = new SituationReporter();
    for (let c = 0; c < 20; c++) {
      for (let i = 0; i <= c; i++) r.recordWindow([ev(c * 100 + i, `ch:${c}`, `m${i}`)]);
    }
    const prompt = r.buildPrompt('full');
    expect(prompt).toContain('more channel(s)'); // collapsed tail
    expect(prompt).toContain('ch:19');           // busiest channel shown
  });
});
