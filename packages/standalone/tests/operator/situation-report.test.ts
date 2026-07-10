/**
 * Unit tests for SituationReporter (M2-T1). Supersedes TriggerReporter (M1.5): the four M1.5
 * behaviors are ported here (no-activity / accumulate-and-send / NOTHING-suppress / no-fallback),
 * plus the new M2 window + recalled-memory + digest/full framings + explicit prompt bounds.
 * Agent injected (vi.fn) - no real CLI. Synthetic data only.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SituationReporter,
  OPERATOR_FULL_REPORT_TAG,
} from '../../src/operator/situation-report.js';
import type { OperatorChannelEvent } from '../../src/operator/operator-interfaces.js';

function ev(id: number, channelId: string, content: string): OperatorChannelEvent {
  return {
    id,
    channel: 'slack',
    channelId,
    userId: 'u1',
    role: 'user',
    content,
    createdAt: id * 100,
  };
}
function fire(
  triggerId: string,
  kind: string,
  channelId: string,
  recalled: { topic: string; content: string }[] = []
) {
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
    r.recordFire(
      fire('t1', 'weekly_report', 'slack:c1', [{ topic: 'report-cadence', content: 'Fridays' }])
    );
    r.recordFire(
      fire('t1', 'weekly_report', 'slack:c1', [{ topic: 'report-cadence', content: 'Fridays' }])
    );
    r.recordAuthored(1);
    expect(await r.report(askAgent, { send }, 'digest')).toBe(true);
    const prompt = askAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('weekly_report'); // aggregate fire activity reaches the agent
    expect(prompt).toContain('report-cadence'); // recalled memory reaches the agent
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
    const send = vi.fn(async () => {
      throw new Error('telegram down');
    });
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
    r.recordWindow([
      ev(1, 'slack:a', 'deploy is failing again'),
      ev(2, 'slack:b', 'lunch?'),
      ev(3, 'slack:a', 'still failing'),
    ]);
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
    expect(prompt).toContain('slack:a: 20 msg'); // exact count
    expect(prompt).toContain('mark_020_'); // last excerpt kept
    expect(prompt).not.toContain('mark_001_'); // early excerpts dropped (last-K only)
    expect(prompt).not.toContain('y'.repeat(200)); // each excerpt truncated
  });

  it('digest keeps the NOTHING option (noise-only bar); full is a DUTY report without it (M2.1)', () => {
    const r = new SituationReporter();
    r.recordWindow([ev(1, 'slack:a', 'hi')]);
    const digest = r.buildPrompt('digest');
    const full = r.buildPrompt('full');
    expect(digest).toContain('digest');
    expect(digest).toContain('NOTHING'); // still available, but only for pure noise
    expect(full).toContain('FULLER');
    expect(full).not.toContain('NOTHING'); // scheduled report always arrives (aliveness)
    expect(full).toContain('quiet');
    for (const prompt of [digest, full]) expect(prompt).toContain('Fire activity:');
  });

  it('full mode injects self-gather tool instructions when configured (M2.3)', () => {
    const r = new SituationReporter({
      selfGatherLines: ['call overview() first', 'then read the busiest channels'],
    });
    r.recordWindow([ev(1, 'slack:a', 'hi')]);
    const full = r.buildPrompt('full');
    expect(full).toContain('call overview() first');
    expect(full).toContain('then read the busiest channels');
    expect(full).toContain('primary source'); // tools over the window hint
    expect(r.buildPrompt('digest')).not.toContain('call overview() first'); // digest stays tool-free
    // without the option nothing is injected
    const plain = new SituationReporter();
    plain.recordWindow([ev(1, 'slack:a', 'hi')]);
    expect(plain.buildPrompt('full')).not.toContain('primary source');
  });

  it('full mode injects board publish lines when configured; digest never does', () => {
    const r = new SituationReporter({
      boardPublishLines: ['BOARD: call report_publish with all four slots'],
    });
    r.recordWindow([ev(1, 'slack:a', 'hi')]);
    expect(r.buildPrompt('full')).toContain('BOARD: call report_publish with all four slots');
    expect(r.buildPrompt('digest')).not.toContain('report_publish');
    // without the option nothing board-related is injected
    const plain = new SituationReporter();
    plain.recordWindow([ev(1, 'slack:a', 'hi')]);
    expect(plain.buildPrompt('full')).not.toContain('report_publish');
  });

  it('full mode fixes the report skeleton: 5 generic sections, owner language (M2.2)', () => {
    const r = new SituationReporter();
    r.recordWindow([ev(1, 'slack:a', 'hi')]);
    const full = r.buildPrompt('full');
    for (const section of [
      'Key situation',
      'Action required',
      'Decisions needed',
      'Pipeline',
      'Next actions',
    ]) {
      expect(full).toContain(section);
    }
    expect(r.buildPrompt('digest')).not.toContain('Key situation'); // digest stays free-form short
  });

  it('full mode composes and sends even with an EMPTY buffer (scheduled aliveness, M2.1)', async () => {
    const askAgent = vi.fn(async () => 'Scheduled report: quiet window, nothing notable.');
    const send = vi.fn(async () => {});
    const r = new SituationReporter();
    expect(r.hasActivity()).toBe(false);
    expect(await r.report(askAgent, { send }, 'full')).toBe(true);
    const prompt = askAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('(no channel messages this window)');
    expect(send).toHaveBeenCalledWith('Scheduled report: quiet window, nothing notable.');
  });

  it('many channels are bounded in the prompt (busiest first, rest collapsed)', () => {
    const r = new SituationReporter();
    for (let c = 0; c < 20; c++) {
      for (let i = 0; i <= c; i++) r.recordWindow([ev(c * 100 + i, `ch:${c}`, `m${i}`)]);
    }
    const prompt = r.buildPrompt('full');
    expect(prompt).toContain('more channel(s)'); // collapsed tail
    expect(prompt).toContain('ch:19'); // busiest channel shown
  });

  it('full self-gather teaches the tool_call protocol and forbids native gathering (M3 GAP1)', () => {
    const r = new SituationReporter({
      selfGatherLines: ['kagemusha_tasks({status:"needs_review"}) for the board'],
    });
    r.recordWindow([ev(1, 'slack:a', 'hi')]);
    const full = r.buildPrompt('full');
    expect(full).toContain(OPERATOR_FULL_REPORT_TAG); // machine frame tag present
    expect(full).toContain('```tool_call'); // protocol block shown
    expect(full).toContain('"name":'); // JSON block shape shown
    expect(full).toMatch(/Do NOT read log files/i); // anti-native directive
    expect(full).toContain('kagemusha_tasks({status:"needs_review"}) for the board'); // raw line kept
    expect(full).toContain('primary source'); // window is only a hint
    // digest stays protocol-free and tag-free
    const digest = r.buildPrompt('digest');
    expect(digest).not.toContain('```tool_call');
    expect(digest).not.toContain(OPERATOR_FULL_REPORT_TAG);
  });

  it('full without self-gather stays plain (tag present, no protocol/gather block)', () => {
    const r = new SituationReporter(); // no selfGatherLines
    r.recordWindow([ev(1, 'slack:a', 'hi')]);
    const full = r.buildPrompt('full');
    expect(full).toContain(OPERATOR_FULL_REPORT_TAG);
    expect(full).not.toContain('```tool_call');
    expect(full).not.toContain('primary source');
  });

  it('full self-gather invites an agent-judged mama_save write (M3 GAP2)', () => {
    const r = new SituationReporter({ selfGatherLines: ['kagemusha_overview() for counts'] });
    r.recordWindow([ev(1, 'slack:a', 'hi')]);
    const full = r.buildPrompt('full');
    expect(full).toContain('mama_save');
    expect(full).toMatch(/durable decision or lesson/i);
    expect(full).toMatch(/your judgement, not a requirement/i); // agent-first, not forced
    // bounded to the tool-enabled full report: no self-gather -> no write instruction
    const plain = new SituationReporter();
    plain.recordWindow([ev(1, 'slack:a', 'hi')]);
    expect(plain.buildPrompt('full')).not.toContain('mama_save');
    // digest never invites a write
    expect(r.buildPrompt('digest')).not.toContain('mama_save');
  });
});
