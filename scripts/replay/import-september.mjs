#!/usr/bin/env node

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_FROM = '2026-09-01T00:00:00.000+09:00';

/** A window bound must carry its offset; a local time would be read in the machine's zone. */
function windowTime(text, name) {
  if (!/(Z|[+-]\d\d:\d\d)$/.test(text)) {
    throw new Error(`${name} must be an ISO time with its offset, e.g. 2026-08-01T00:00:00+09:00`);
  }
  const ms = Date.parse(text);
  if (!Number.isSafeInteger(ms)) {
    throw new Error(`${name} is not a valid time: ${text}`);
  }
  return ms;
}

function value(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

function required(args, name, fallback) {
  const result = value(args, name, fallback);
  if (typeof result !== 'string' || result.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return resolve(result);
}

function help() {
  console.log(
    'Usage: node scripts/replay/import-september.mjs --mama-db PATH --raw-root PATH --connectors-config PATH --manifest PATH [--source-db PATH] [--from ISO] [--until ISO]'
  );
  console.log(
    `--from defaults to ${DEFAULT_FROM}; --until (exclusive) defaults to the newest source row.`
  );
  console.log('Trello credentials come from TRELLO_API_KEY and TRELLO_TOKEN.');
}

async function main(argv) {
  if (argv.includes('--help')) {
    help();
    return;
  }
  const home = process.env.MAMA_HOME ?? join(homedir(), '.mama');
  const sourceDbPath = required(
    argv,
    '--source-db',
    join(dirnameOf(home), '.kagemusha', 'kagemusha.db')
  );
  const mamaDbPath = required(argv, '--mama-db', join(home, 'memory.db'));
  const rawRoot = required(argv, '--raw-root', join(home, 'connectors'));
  const connectorsConfigPath = required(argv, '--connectors-config', join(home, 'connectors.json'));
  const manifestPath = required(
    argv,
    '--manifest',
    join(home, 'runtime', 'september-import-manifest.json')
  );
  const fromMs = windowTime(value(argv, '--from', DEFAULT_FROM), '--from');
  const untilText = value(argv, '--until', undefined);
  const untilMs = untilText === undefined ? undefined : windowTime(untilText, '--until');
  if (untilMs !== undefined && untilMs <= fromMs) {
    throw new Error('--until must follow --from');
  }
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!apiKey || !token) {
    throw new Error('TRELLO_API_KEY and TRELLO_TOKEN are required');
  }

  const [
    { openCoreDatabase },
    { RawStore },
    { createCoreRawIndexSink },
    { importKagemushaRows },
    { importTrelloActions },
  ] = await Promise.all([
    import('../../packages/standalone/dist/runtime/core-db.js'),
    import('../../packages/standalone/dist/storage/source-archive.js'),
    import('../../packages/standalone/dist/replay/import-manifest.js'),
    import('../../packages/standalone/dist/replay/kagemusha-import.js'),
    import('../../packages/standalone/dist/replay/trello-import.js'),
  ]);

  const observedAtMs = Date.now();
  const database = await openCoreDatabase({ path: mamaDbPath });
  const rawStore = new RawStore(rawRoot);
  try {
    const rawIndexSink = createCoreRawIndexSink(database.adapter);
    const kagemusha = await importKagemushaRows({
      sourceDbPath,
      connectorsConfigPath,
      rawStore,
      rawIndexSink,
      fromMs,
      ...(untilMs === undefined ? {} : { untilMs }),
      observedAtMs,
      manifestPath,
    });
    const trello = await importTrelloActions({
      connectorsConfigPath,
      rawStore,
      rawIndexSink,
      credentials: { apiKey, token },
      fromMs,
      untilMs: kagemusha.untilMs,
      observedAtMs,
      manifestPath,
    });
    console.log(
      JSON.stringify({
        kagemushaRows: kagemusha.importedCount,
        feedbackRows: kagemusha.importedByOrigin.feedback ?? 0,
        unmappedFeedbackRows: kagemusha.unmappedByOrigin.feedback ?? 0,
        projectedRows: kagemusha.projectedCount + trello.projectedCount,
        trelloRows: trello.importedCount,
        unmappedRows: Object.values(kagemusha.unmappedByOrigin).reduce(
          (sum, count) => sum + count,
          0
        ),
        fromMs: kagemusha.fromMs,
        untilMs: kagemusha.untilMs,
      })
    );
  } finally {
    rawStore.close();
    await database.close();
  }
}

function dirnameOf(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash);
}

try {
  await main(process.argv.slice(2));
} catch {
  process.exitCode = 1;
}
