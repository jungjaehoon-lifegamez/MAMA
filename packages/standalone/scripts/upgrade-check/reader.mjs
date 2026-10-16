/**
 * Boots this checkout on the install the previous release wrote (writer.mjs) and reads back every
 * item it wrote: the config it set up, the work and its revision, the lesson, and the owner message
 * it left pending, which this release's owner loop must take up.
 *
 * Usage: node reader.mjs <written.json>   (HOME and MAMA_API_PORT come from run.mjs)
 */
import { readFileSync } from 'node:fs';
import { bootDaemon } from '../../dist/cli/commands/daemon.js';

const [writtenPath] = process.argv.slice(2);
const written = JSON.parse(readFileSync(writtenPath, 'utf8'));
const errors = [];
const stages = [];
const mismatches = [];
const expect = (ok, message) => {
  if (!ok) {
    mismatches.push(message);
  }
};

const startedAt = Date.now();
const daemon = await bootDaemon({
  mode: 'replay',
  home: process.env.HOME,
  logger: {
    info: (line) => {
      const stage = /^boot stage=(\S+)/.exec(line);
      if (stage) {
        stages.push(stage[1]);
      }
    },
    error: (line) => errors.push(line),
  },
  replay: async (context) => {
    const call = async (name, input, operationId) => {
      const outcome = await context.owner.surface.hostToolCall(name, input, operationId, {});
      if (outcome?.status !== 'completed') {
        throw new Error(`${name} did not complete: ${JSON.stringify(outcome?.error ?? outcome)}`);
      }
      return outcome.data;
    };

    const listed = await call(
      'work.list',
      { view: 'items', text: 'upgrade fixture' },
      'upgrade-check:read:work'
    );
    const work = listed.tasks.find((task) => task.commitmentId === written.commitmentId);
    expect(work, `work ${written.commitmentId} is not listed`);
    expect(
      work?.revision === written.revision,
      `revision ${work?.revision}, written ${written.revision}`
    );
    expect(work?.title === written.title, `title ${JSON.stringify(work?.title)}`);
    expect(work?.status === written.status, `status ${JSON.stringify(work?.status)}`);

    // Task history is what sets MAMA apart: both revisions, not only the latest state.
    const detail = await call(
      'work.list',
      { view: 'detail', ids: [written.commitmentId] },
      'upgrade-check:read:history'
    );
    const history = detail.tasks[0];
    expect(history?.historyTotal === 2, `history has ${history?.historyTotal} revisions, not 2`);
    for (const expected of written.history) {
      const entry = history?.history?.find((revision) => revision.revision === expected.revision);
      expect(
        entry?.operation === expected.operation &&
          JSON.stringify(entry?.set) === JSON.stringify(expected.set) &&
          entry?.eventDatetime === expected.eventDatetime,
        `revision ${expected.revision} reads ${JSON.stringify(entry)}`
      );
    }

    const found = await call(
      'memory.search',
      { query: 'lesson the previous release saved', limit: 5 },
      'upgrade-check:read:lesson'
    );
    expect(
      found.results.some((result) => result.id === written.lessonId),
      `lesson ${written.lessonId} is not found`
    );

    // The owner message as the previous release stored it in the chat source.
    const chat = await call(
      'source.search',
      { source: 'chat', query: written.messageText },
      'upgrade-check:read:message'
    );
    expect(
      JSON.stringify(chat).includes(written.messageText),
      'the owner message the previous release stored is not in the chat source'
    );

    // The owner message the previous release left pending: this release's owner loop recovers its
    // stored row and runs a turn for it. That is the class of the boot-recovery crash on an old
    // row; the turn's text is not compared, since the backend is a stand-in that exits at once.
    const turnsFor = context.owner.database.adapter.prepare(
      "SELECT status FROM model_runs WHERE json_extract(input_refs_json, '$.sourceMessageRef') = ? AND created_at >= ?"
    );
    const deadline = Date.now() + 60_000;
    let turns = turnsFor.all(written.messageRef, startedAt);
    while (
      (turns.length === 0 || turns.some((turn) => turn.status === 'running')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      turns = turnsFor.all(written.messageRef, startedAt);
    }
    expect(turns.length === 1, `${turns.length} turns ran for ${written.messageRef}, not 1`);
    expect(
      turns.every((turn) => turn.status !== 'running'),
      `the turn for ${written.messageRef} did not end within 60 s`
    );
  },
});
await daemon.stop();

for (const stage of ['config', 'isolation', 'owner_runtime', 'replay']) {
  expect(stages.includes(stage), `boot did not reach ${stage} (reached ${stages.join(', ')})`);
}
// The one error expected: that turn failing at the stand-in backend (as an exit or as a closed
// pipe, whichever comes first).
const failure = `stimulus failed kind=owner_message id=${written.messageRef} `;
const unexpected = errors.filter((line) => !line.startsWith(failure));
expect(
  errors.filter((line) => line.startsWith(failure)).length === 1,
  `the pending message did not fail exactly once at the stand-in`
);
expect(unexpected.length === 0, `boot logged errors:\n${unexpected.join('\n')}`);
if (mismatches.length > 0) {
  console.error(`upgrade check: this release did not read the previous release's install:`);
  for (const line of mismatches) {
    console.error(`- ${line}`);
  }
  // Not process.exit(): the embedding runtime's threads abort the process when it exits under them.
  process.exitCode = 1;
} else {
  console.log(
    `upgrade check: read back work ${written.commitmentId} with its ${written.history.length} revisions, lesson ${written.lessonId} and the stored owner message, and ran its pending turn once`
  );
}
