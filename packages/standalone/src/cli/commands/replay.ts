import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { bootDaemon, type DaemonBootOptions, type DaemonReplayContext } from './daemon.js';
import { loadConnectorConfig } from '../../connectors/config-loader.js';
import { setLiveConnectorPollCursors } from '../../runtime/connectors.js';
import { createOwnerPolicyProvider } from '../../runtime/owner-policy.js';
import { readImportManifest } from '../../replay/import-manifest.js';
import { ReplayFeeder, type ReplayFeederResult } from '../../replay/replay-feeder.js';
import {
  createReplaySourceCatalog,
  type ReplayLedgerDigestItem,
} from '../../replay/replay-source-catalog.js';
import { createJevClient } from '../../replay/jev-client.js';
import { buildWindowQueue, trelloCardsFromEvents } from '../../replay/window-queue.js';
import {
  OWNER_REPLAY_SESSION_KEY,
  OWNER_RUNTIME_SESSION_KEY,
} from '../../runtime/stimulus-delivery.js';

export interface ReplayCommandOptions {
  daemon?: Omit<DaemonBootOptions, 'mode' | 'replay'>;
  manifestPath?: string;
  cursorPath?: string;
  ledgerPath?: string;
  runId?: string;
}

/** Channel display names from connectors.json, keyed `${connector}\0${channelId}`. */
function configuredChannelNames(configPath: string): ReadonlyMap<string, string> {
  const loaded = loadConnectorConfig(configPath);
  if (!loaded.ok) throw new Error(`Replay cannot read channel names: ${loaded.error.message}`);
  const names = new Map<string, string>();
  for (const [connector, config] of Object.entries(loaded.config)) {
    for (const [channelId, channel] of Object.entries(config.channels ?? {})) {
      if (channel.name) names.set(`${connector}\0${channelId}`, channel.name);
    }
  }
  return names;
}

function requireMailbox(context: DaemonReplayContext) {
  const mailbox = context.owner.runtime.mailbox;
  if (!mailbox) throw new Error('Replay owner runtime did not open its mailbox');
  return mailbox;
}

function replayLedgerDigest(
  context: DaemonReplayContext,
  asOfMs?: number
): readonly ReplayLedgerDigestItem[] {
  const result: ReplayLedgerDigestItem[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = context.owner.knowledge.readWork(
      {
        history: 'current',
        limit: 100,
        ...(asOfMs === undefined ? {} : { asOf: asOfMs }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      context.owner.surface.ownerAccess
    );
    for (const item of page.items) {
      const values = item.values as Record<string, unknown>;
      const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
      const status = text(values.status) ?? (item.withdrawn ? 'cancelled' : null);
      result.push({
        commitmentId: item.commitmentId,
        revision: item.revision,
        title: text(values.title),
        stage: text(values.stage),
        status,
        assignee: text(values.assignee) ?? text(values.assigneeText),
        lastEventTime: text(values.lastEventTime),
      });
    }
    if (page.nextCursor === null) {
      if (!page.coverage.complete) {
        throw new Error(
          `Replay work ledger digest is incomplete: ${page.coverage.reasons.join('; ')}`
        );
      }
      break;
    }
    cursor = page.nextCursor;
  }
  return Object.freeze(result);
}

/** Run the owner-only replay and fence the unchanged live connector set at T. */
export async function runReplay(options: ReplayCommandOptions = {}): Promise<ReplayFeederResult> {
  let result: ReplayFeederResult | undefined;
  const daemon = await bootDaemon({
    ...(options.daemon ?? {}),
    mode: 'replay',
    replay: async (context) => {
      const manifestPath =
        options.manifestPath ?? join(context.paths.runtimeRoot, 'september-import-manifest.json');
      const cursorPath =
        options.cursorPath ?? join(context.paths.runtimeRoot, 'september-replay-cursor.json');
      const ledgerPath =
        options.ledgerPath ?? join(context.paths.runtimeRoot, 'september-replay-ledger.jsonl');
      const manifest = readImportManifest(manifestPath);
      const catalog = createReplaySourceCatalog(
        context.owner.database.adapter,
        manifest.fromMs,
        manifest.untilMs,
        {
          rawRoot: context.paths.connectorsRoot,
          channelNames: configuredChannelNames(context.paths.connectorsConfigPath),
          timeZone: context.timeZone,
        }
      );
      const feeder = new ReplayFeeder({
        catalog,
        intake: context.owner.intake,
        mailbox: requireMailbox(context),
        principalId: 'owner',
        runId: options.runId ?? randomUUID(),
        policyFingerprint: createOwnerPolicyProvider(context.paths.mamaRoot)().fingerprint,
        fromMs: manifest.fromMs,
        untilMs: manifest.untilMs,
        cursorPath,
        ledgerPath,
        readLedgerDigest: (asOfMs) => replayLedgerDigest(context, asOfMs),
        buildQueue: async (window, ledgerDigest) => {
          const jev = createJevClient({
            keyFile: context.config.jev.keyFile,
            vocabFile: context.config.jev.vocabFile,
          });
          return buildWindowQueue({
            startMs: window.startMs,
            endMs: window.endMs,
            timeZone: context.timeZone,
            events: catalog.eventsForWindow(window.startMs, window.endMs),
            workItems: (ledgerDigest ?? []).map((item) => ({
              commitmentId: item.commitmentId,
              revision: item.revision,
              title: item.title,
              stage: item.stage,
              status: item.status,
            })),
            // Card facts as of the window end: a replayed day must not see later activity.
            trelloCards: trelloCardsFromEvents(
              catalog.allEvents().filter((event) => event.sourceAtMs < window.endMs)
            ),
            vocabulary: jev.vocabulary,
            jev,
          });
        },
      });
      const preflight = feeder.preflight();
      context.logger.info(
        `replay preflight windows=${String(preflight.windows.length)} deltas=${String(preflight.deltas.length)}`
      );
      result = await feeder.run();
      if (result.nextWindowStartMs !== manifest.untilMs) {
        throw new Error('Replay feeder stopped before the import fence');
      }
      const session = context.owner.runtime.nativeSession;
      if (!session?.resetSession)
        throw new Error('Replay finalization requires native session reset');
      // The replay rewrote the ledger: its session ends, and the next live turn gets startup context.
      await session.resetSession(OWNER_REPLAY_SESSION_KEY);
      await session.resetSession(OWNER_RUNTIME_SESSION_KEY);
      setLiveConnectorPollCursors({
        configPath: context.paths.connectorsConfigPath,
        statePath: context.paths.connectorsRoot,
        fenceMs: manifest.untilMs,
      });
      context.logger.info(
        `replay complete windows=${String(result.windows)} deltas=${String(result.deltas)} settled=${String(result.settled)} fence=${new Date(manifest.untilMs).toISOString()}`
      );
    },
  });
  await daemon.stop();
  if (!result) throw new Error('Replay feeder returned no result');
  return result;
}
