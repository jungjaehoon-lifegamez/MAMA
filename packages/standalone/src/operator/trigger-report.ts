/**
 * TriggerReporter - the OUTPUT leg of the trigger loop (M1.5).
 *
 * Accumulates fire/author activity between report ticks; on the report cadence the
 * AGENT composes a short owner digest from the AGGREGATE activity (agent-first: the
 * agent judges what is worth saying - answering NOTHING suppresses the send entirely),
 * and the system delivers it via the injected OutputSink (telegram gateway in prod).
 *
 * No activity -> no agent call, no send (no spam). Send failures propagate loudly
 * (no-fallback) and keep the buffer so the next cadence retries.
 */

import type { OutputSink } from './operator-interfaces.js';
import type { AskAgent } from './trigger-author.js';

export interface FireActivity {
  triggerId: string;
  kind: string;
  channelId: string;
  recalledTopics: string[];
}

export class TriggerReporter {
  private fires: FireActivity[] = [];
  private authored = 0;

  recordFire(activity: FireActivity): void {
    this.fires.push(activity);
  }

  recordAuthored(count: number): void {
    this.authored += count;
  }

  hasActivity(): boolean {
    return this.fires.length > 0 || this.authored > 0;
  }

  /** Agent composes the digest from aggregate activity; sink delivers it. */
  async maybeReport(askAgent: AskAgent, output: Pick<OutputSink, 'send'>): Promise<boolean> {
    if (!this.hasActivity()) return false;

    const digest = (await askAgent(this.buildPrompt())).trim();
    if (digest === '' || /^NOTHING\b/i.test(digest)) {
      // The agent judged there is nothing worth reporting - drop the buffer quietly.
      this.reset();
      return false;
    }

    await output.send(digest); // throws loudly on failure; buffer kept for retry
    this.reset();
    return true;
  }

  private reset(): void {
    this.fires = [];
    this.authored = 0;
  }

  private buildPrompt(): string {
    // Aggregate per (trigger, channel): counts + recalled topics. English default;
    // personal phrasing/language overrides belong in ~/.mama config, never source.
    const byKey = new Map<string, { kind: string; channelId: string; count: number; topics: Set<string> }>();
    for (const f of this.fires) {
      const key = `${f.triggerId}|${f.channelId}`;
      const entry = byKey.get(key) ?? { kind: f.kind, channelId: f.channelId, count: 0, topics: new Set<string>() };
      entry.count += 1;
      for (const t of f.recalledTopics) entry.topics.add(t);
      byKey.set(key, entry);
    }
    const lines = [...byKey.values()].map(
      (e) => `- trigger "${e.kind}" fired ${e.count}x on ${e.channelId}; recalled: ${[...e.topics].join(', ') || '(none)'}`
    );
    return [
      'You are the operator agent. Write a SHORT proactive digest for your owner about the',
      'trigger activity below - what situations recurred, what memory you surfaced, and what',
      'the owner may want to look at. 2-6 lines, plain language, no markdown tables.',
      'Reply in the language the owner uses on these channels if you can tell; otherwise English.',
      'If the activity is genuinely not worth the owner\'s attention, reply exactly: NOTHING',
      '',
      `Triggers newly authored this window: ${this.authored}`,
      'Fire activity:',
      ...lines,
    ].join('\n');
  }
}
