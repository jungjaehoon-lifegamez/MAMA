/**
 * Collecting each person's own sources (personal-connectors.md, C3). One scheduler per person and
 * kind, with its own poll state, runs the kind's existing connector on the person's credential.
 * Every item is stored as connector personal-<kind>, with a channel key and source id carrying the
 * person and the person's scope, so two people binding one channel keep their own copies and no
 * read of the install's connectors reaches them. A batch starts no turn (owner decision 1): reports
 * are the person's own personal jobs.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { PersonalKindAdapter } from '../connectors/personal/kinds.js';
import {
  canonicalChannelKey,
  PollingScheduler,
} from '../connectors/framework/polling-scheduler.js';
import { ConnectorRegistry } from '../connectors/framework/connector-registry.js';
import type { ConnectorConfig, IConnector } from '../connectors/framework/types.js';
import type { RawIndexSink, RawStore } from '../storage/source-archive.js';
import type { AccountStore } from './account-store.js';
import {
  personalChannelKey,
  personalConnectorName,
  type PersonalSourceKind,
  type PersonalSourceStore,
} from './personal-source-store.js';

/** How far back a newly connected source is read. */
export const PERSONAL_FIRST_LOOKBACK_MS = 7 * 86_400_000;

export interface PersonalSourceRuntimeOptions {
  store: PersonalSourceStore;
  accounts: AccountStore;
  kinds: Record<PersonalSourceKind, PersonalKindAdapter>;
  rawStore: RawStore;
  indexSink: RawIndexSink;
  /** Where each person's poll state lives: <root>/<person hash>/<kind>/. */
  root: string;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  log(line: string): void;
}

const personHash = (principalId: string) =>
  createHash('sha256').update(principalId).digest('hex').slice(0, 16);

/** The kind's connector, its items re-keyed to the person. */
function personalConnector(
  inner: IConnector,
  principalId: string,
  kind: PersonalSourceKind,
  config: ConnectorConfig
): IConnector {
  const name = personalConnectorName(kind);
  const own = { [inner.name]: config.channels };
  const prefix = personHash(principalId);
  return {
    name,
    type: inner.type,
    init: () => inner.init(),
    dispose: () => inner.dispose(),
    healthCheck: () => inner.healthCheck(),
    getAuthRequirements: () => inner.getAuthRequirements(),
    authenticate: () => inner.authenticate(),
    ...(inner.beginPollHandoff ? { beginPollHandoff: () => inner.beginPollHandoff!() } : {}),
    ...(inner.commitPoll ? { commitPoll: () => inner.commitPoll!() } : {}),
    ...(inner.abortPollHandoff ? { abortPollHandoff: () => inner.abortPollHandoff!() } : {}),
    ...(inner.partialFailure ? { partialFailure: () => inner.partialFailure!() } : {}),
    async poll(since, cursor) {
      return (await inner.poll(since, cursor)).flatMap((item) => {
        // The kind names a channel by id or by its configured name; the upstream id is the key.
        const upstream = canonicalChannelKey(item, own);
        if (upstream === null) return [];
        return [
          {
            ...item,
            source: name,
            channel: personalChannelKey(principalId, upstream),
            sourceId: `${prefix}:${item.sourceId}`,
            ...(item.sourceEntityId === undefined
              ? {}
              : { sourceEntityId: `${prefix}:${item.sourceEntityId}` }),
            memoryScopeKind: 'user',
            memoryScopeId: principalId,
          },
        ];
      });
    },
  };
}

export function startPersonalSources(options: PersonalSourceRuntimeOptions) {
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const running = new Map<
    string,
    {
      scheduler: PollingScheduler;
      registry: ConnectorRegistry;
      channels: Record<string, Record<string, ConnectorConfig['channels'][string]>>;
      timer: ReturnType<typeof setInterval>;
    }
  >();
  const id = (principalId: string, kind: PersonalSourceKind) => `${principalId}\0${kind}`;
  // A batch starts no turn (owner decision 1); the poll's outcome is the source's row.
  const noTurn = () => {};

  const stop = async (principalId: string, kind: PersonalSourceKind) => {
    const entry = running.get(id(principalId, kind));
    if (!entry) return;
    running.delete(id(principalId, kind));
    clearIntervalFn(entry.timer);
    // Waits for a poll in flight, so nothing it read lands after the stop.
    await entry.scheduler.stop();
    await entry.registry.disposeAll();
  };

  const start = async (principalId: string, kind: PersonalSourceKind) => {
    await stop(principalId, kind);
    const source = options.store.get(principalId, kind);
    if (!source) return;
    const account = options.accounts.get(principalId, kind);
    if (!account) {
      options.store.recordPoll(principalId, kind, {
        at: now(),
        error: `the ${kind} account is not connected: connect it again from your DM`,
      });
      return;
    }
    const adapter = options.kinds[kind];
    const config = adapter.config(
      { ...(account.fields ?? {}), token: account.token },
      source.channels
    );
    const dir = join(options.root, personHash(principalId), kind);
    const name = personalConnectorName(kind);
    const registry = new ConnectorRegistry();
    const scheduler = new PollingScheduler(options.rawStore, dir, {
      rawIndexSink: options.indexSink,
      initialLookbackMs: PERSONAL_FIRST_LOOKBACK_MS,
      now,
      recordPollOutcome: (_connector, outcome) => {
        options.store.recordPoll(principalId, kind, {
          at: outcome.at,
          error: outcome.error ?? null,
        });
        if (outcome.error)
          options.log(
            `personal source ${kind} for ${personHash(principalId)} failed: ${outcome.error}`
          );
      },
    });
    try {
      const inner = await adapter.build(config, join(dir, 'connector-state.json'));
      await inner.init();
      registry.register(name, personalConnector(inner, principalId, kind, config));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.store.recordPoll(principalId, kind, { at: now(), error: message });
      options.log(
        `personal source ${kind} for ${personHash(principalId)} did not start: ${message}`
      );
      await registry.disposeAll();
      return;
    }
    const channels = {
      [name]: Object.fromEntries(
        source.channels.map((channel) => [
          personalChannelKey(principalId, channel.id),
          { role: 'hub' as const, ...(channel.name === null ? {} : { name: channel.name }) },
        ])
      ),
    };
    const timer = setIntervalFn(
      () => void scheduler.pollConnector(name, registry, channels, noTurn),
      config.pollIntervalMinutes * 60_000
    );
    running.set(id(principalId, kind), { scheduler, registry, channels, timer });
    await scheduler.pollConnector(name, registry, channels, noTurn);
  };

  return {
    start,
    stop,
    async startAll(): Promise<void> {
      for (const source of options.store.listAll()) await start(source.principalId, source.kind);
    },
    async stopAll(): Promise<void> {
      for (const key of [...running.keys()]) {
        const [principalId, kind] = key.split('\0') as [string, PersonalSourceKind];
        await stop(principalId, kind);
      }
    },
    async pollNow(principalId: string, kind: PersonalSourceKind): Promise<void> {
      const entry = running.get(id(principalId, kind));
      if (!entry) return;
      await entry.scheduler.pollConnector(
        personalConnectorName(kind),
        entry.registry,
        entry.channels,
        noTurn
      );
    },
    count: (): number => running.size,
  };
}

export type PersonalSources = ReturnType<typeof startPersonalSources>;

/**
 * Deletes what a person's source collected: its raw items and index rows (C5). Run after the
 * source's collector has stopped, so no poll lands after it.
 */
export function deletePersonalSourceData(
  adapter: { prepare(sql: string): { run(...params: unknown[]): { changes: number } } },
  rawStore: Pick<RawStore, 'eraseScope'>,
  principalId: string,
  kind: PersonalSourceKind
): { raw: Record<string, number>; index: number } {
  const name = personalConnectorName(kind);
  const raw = rawStore.eraseScope(name, 'user', principalId);
  const index = adapter
    .prepare(
      `DELETE FROM connector_event_index
        WHERE source_connector = ? AND memory_scope_kind = 'user' AND memory_scope_id = ?`
    )
    .run(name, principalId).changes;
  return { raw, index };
}
