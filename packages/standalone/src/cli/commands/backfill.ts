import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bootDaemon, type DaemonBootOptions } from './daemon.js';
import { CliInputError } from '../prompt.js';
import { parseBackfillFile } from '../../backfill/format.js';
import {
  indexSourceResolver,
  ledgerFirstEventAt,
  pushBackfill,
  type BackfillPushResult,
} from '../../backfill/push.js';

export interface BackfillCommandOptions {
  daemon?: Omit<DaemonBootOptions, 'mode' | 'replay'>;
}

function readPublished(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { operationId: string }).operationId)
  );
}

/**
 * `mama backfill <file>`: push a checked backfill file through the owner's actions, with the
 * daemon stopped (it opens the owner runtime the way `mama replay` does, without collectors).
 * The period's end is the replay ceiling, so no revision can claim a later source time.
 */
export async function runBackfill(
  args: readonly string[],
  options: BackfillCommandOptions = {}
): Promise<BackfillPushResult> {
  if (args.length !== 1) throw new CliInputError('Usage: mama backfill <file.json>');
  const path = resolve(args[0]!);
  let file;
  try {
    file = parseBackfillFile(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new CliInputError(error instanceof Error ? error.message : String(error));
  }
  let result: BackfillPushResult | undefined;
  const daemon = await bootDaemon({
    ...(options.daemon ?? {}),
    mode: 'replay',
    replay: async (context) => {
      const pagesPath = join(
        context.paths.runtimeRoot,
        'backfill',
        `${file.period.from}.pages.jsonl`
      );
      mkdirSync(dirname(pagesPath), { recursive: true });
      const surface = context.owner.surface;
      try {
        result = await pushBackfill(file, {
          callAction: async (name, input, operationId) => {
            const outcome = await surface.hostToolCall(name, input, operationId, {
              session: { replaySourceEndMs: file.period.until - 1 },
            });
            if (outcome.status !== 'completed')
              throw new Error(
                `${name} ${operationId} failed: ${outcome.error.code} ${outcome.error.message}`
              );
            return outcome.data;
          },
          resolveSources: indexSourceResolver(context.owner.database.adapter),
          firstEventAt: ledgerFirstEventAt((query) =>
            context.owner.knowledge.readWork(query, surface.ownerAccess)
          ),
          publishedPages: readPublished(pagesPath),
          pagePublished: (operationId) =>
            appendFileSync(pagesPath, `${JSON.stringify({ operationId, at: Date.now() })}\n`),
        });
      } catch (error) {
        throw new CliInputError(error instanceof Error ? error.message : String(error));
      }
    },
  });
  await daemon.stop();
  console.log(JSON.stringify(result));
  return result!;
}
