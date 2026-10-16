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

    const found = await call(
      'memory.search',
      { query: 'lesson the previous release saved', limit: 5 },
      'upgrade-check:read:lesson'
    );
    expect(
      found.results.some((result) => result.id === written.lessonId),
      `lesson ${written.lessonId} is not found`
    );

    // The pending owner message: this release's owner loop reads its stored payload and runs a
    // turn for it. The turn needs a signed-in backend, which the check replaces with a stand-in
    // that exits; a turn run for this message is what shows the old payload was read.
    const turnFor = context.owner.database.adapter.prepare(
      "SELECT status FROM model_runs WHERE json_extract(input_refs_json, '$.sourceMessageRef') = ?"
    );
    const deadline = Date.now() + 60_000;
    let turn = turnFor.get(written.messageRef);
    while ((turn === undefined || turn.status === 'running') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      turn = turnFor.get(written.messageRef);
    }
    expect(turn, `no turn ran for the pending message ${written.messageRef} within 60 s`);
    expect(
      turn?.status !== 'running',
      `the turn for ${written.messageRef} did not end within 60 s`
    );
  },
});
await daemon.stop();

for (const stage of ['config', 'isolation', 'owner_runtime', 'replay']) {
  expect(stages.includes(stage), `boot did not reach ${stage} (reached ${stages.join(', ')})`);
}
// The one error expected: that turn failing at the stand-in backend.
const unexpected = errors.filter(
  (line) =>
    !(
      line.startsWith(`stimulus failed kind=owner_message id=${written.messageRef} `) &&
      line.includes('upgrade check: no backend')
    )
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
    `upgrade check: read back work ${written.commitmentId} at revision ${written.revision}, lesson ${written.lessonId}, and took up ${written.messageRef}`
  );
}
