import {
  beginModelRun,
  commitModelRun,
  createKnowledge,
  failModelRun,
  generateEmbedding,
  readMemoryRecordsInScopes,
  startRuntime,
  type Knowledge,
  type KnowledgeOptions,
  type RuntimeHandle,
  type JudgmentAccess,
  type MemoryRecord,
  type MemoryScopeRef,
} from '@jungjaehoon/mama-core';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeModelRunPort } from '@jungjaehoon/mama-core/runtime/native-turn';
import { createStoredSourceReader } from '../api/stored-source-reader.js';
import type { AttachmentActionPorts } from '../api/attachment-actions.js';
import { createPersistentReportStore } from '../api/report-persistence.js';
import { ObsidianWriter } from '../wiki/obsidian-writer.js';
import { RawStore } from '../storage/source-archive.js';
import type {
  RuntimeBackend,
  RuntimeEffort,
  RuntimeSandbox,
  W1DriveDeliveryConfig,
} from './config.js';
import { openCoreDatabase, type CoreDatabase } from './core-db.js';
import { createActionSurface, type ActionSurface } from './action-surface.js';
import type { OutboundAttemptEvent } from '../api/security-events.js';
import type { SandboxNetworkProxy } from '../cli/runtime/claude-caller-config.js';
import { ownerRuleIds, RULE_KINDS } from './owner-authority.js';
import { createNativeSession, type NativeSession } from './native-session.js';
import type { ActionDispatcher } from '@jungjaehoon/mama-core/api/dispatch';
import type { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { TimeZoneSetting } from './timezone.js';
import { ownerHelpTopics, ownerSystemPrompt } from './owner-system-prompt.js';
import { storedSourceFamilies } from '../connectors/framework/stored-index-read.js';
import { createOwnerPolicyProvider, type OwnerPolicyProvider } from './owner-policy.js';
import { readSessionStartInput } from './session-start-context.js';
import { ChatSources } from '../storage/chat-sources.js';
import { createJevClient } from '../replay/jev-client.js';
import { createRecordOrders, type RecordOrderEvent } from './record-orders.js';
import { initTokenEstimator } from '@jungjaehoon/mama-core/runtime/token-estimator';
import {
  createStimulusDelivery,
  createStimulusIntake,
  type ReplayClockDelivery,
  type StimulusDeliveryOptions,
  type StimulusIntake,
  type TurnLesson,
} from './stimulus-delivery.js';
import { ownerRulesBlock, type OwnerRuleLine } from './turn-orders.js';

export interface OwnerRuntimeOptions {
  /** Native shell commands that open a network connection, reported as they start (W35). */
  outboundAttempts?: (event: OutboundAttemptEvent) => void;
  backend: RuntimeBackend;
  model: string;
  databasePath: string;
  socketPath: string;
  credentialPath: string;
  runtimeRoot: string;
  timeZone: TimeZoneSetting;
  workspaceDir: string;
  ownerPrincipalId: string;
  agentId: string;
  scopes: readonly MemoryScopeRef[];
  connectors?: readonly string[];
  rawPath: string;
  embedder?: KnowledgeOptions['embedder'];
  nativeSession?: NativeSessionHandle & Partial<Pick<NativeSession, 'callAction'>>;
  modelRun?: NativeModelRunPort;
  effort?: RuntimeEffort;
  timeout: number;
  maxTurnMs?: number;
  runTokenBudget?: number;
  codexHome?: string;
  replayKeyFile?: string;
  /** The host's logging proxy for the Claude shell sandbox's network (W35.4). */
  sandboxNetworkProxy?: SandboxNetworkProxy;
  /** Jev key and vocabulary paths when the owner enabled Jev; with them the agent can call judge. */
  jev?: { keyFile: string; vocabFile: string };
  codexSandbox?: RuntimeSandbox;
  mcpConfigPath?: string;
  mcpServerPath?: string;
  pluginDir?: string;
  reportPath?: string;
  wiki?: {
    enabled: boolean;
    vaultPath: string;
    wikiDir: string;
  };
  formattingRoutes?: { reports: string; notifications: string };
  ownerPolicyProvider?: OwnerPolicyProvider;
  onOwnerResult?: StimulusDeliveryOptions['onOwnerResult'];
  onSourceResult?: StimulusDeliveryOptions['onSourceResult'];
  onScheduledResult?: StimulusDeliveryOptions['onScheduledResult'];
  onStimulusDelivered?: StimulusDeliveryOptions['onDelivered'];
  onStimulusFailed?: StimulusDeliveryOptions['onFailed'];
  onStimulusUncertain?: StimulusDeliveryOptions['onUncertain'];
  onStimulusDead?: StimulusDeliveryOptions['onDead'];
  /** Live only: closes rows parked uncertain once their remaining duty has a place. */
  closeUncertain?: StimulusDeliveryOptions['closeUncertain'];
  /** Record-order outcomes (recorded, retry, lost); the daemon logs them. */
  onRecordOrderEvent?: (event: RecordOrderEvent) => void;
  /** Lesson recall for a turn; defaults to memory.search over the owner's guidance. */
  lessons?: StimulusDeliveryOptions['lessons'];
  /** The record order's owner-rule index; defaults to the active owner rules in the owner's scopes. */
  ownerRules?: StimulusDeliveryOptions['ownerRules'];
  /** A lesson search that did not complete; the turn goes on with what the others found. */
  onLessonSearchFailed?: (reason: string) => void;
  /** A live delta acked without a turn (only history lines). */
  onStimulusSkipped?: StimulusDeliveryOptions['onSkipped'];
  /** Keep accepted inputs queued while product delivery ports are starting. */
  deliveryReady?: () => boolean;
  maxTurns: number;
  attachmentPorts?: Pick<
    AttachmentActionPorts,
    'connectors' | 'telegram' | 'discord' | 'slack' | 'downloadsDir'
  >;
  /** delivery.drive from config with a daemon-owned staging directory; absent turns it off. */
  driveDelivery?: { delivery: W1DriveDeliveryConfig; stagingDir: string };
}

export interface OwnerRuntime {
  readonly runtime: RuntimeHandle;
  readonly database: CoreDatabase;
  readonly knowledge: Knowledge;
  readonly surface: ActionSurface;
  readonly reportStore: ReturnType<typeof createPersistentReportStore>;
  readonly reportSseClients: Set<ServerResponse>;
  readonly wikiRoot: string | null;
  readonly intake: StimulusIntake;
  readonly acceptSourceDelta: StimulusIntake['acceptSourceDelta'];
  stop(): Promise<void>;
}

function runtimeEmbedder(options: OwnerRuntimeOptions): NonNullable<KnowledgeOptions['embedder']> {
  return (
    options.embedder ?? {
      embed: (text, role) => generateEmbedding(text, role),
    }
  );
}

function runtimeModelRun(
  options: OwnerRuntimeOptions,
  adapter: Parameters<typeof beginModelRun>[0]
): NativeModelRunPort {
  return {
    begin: async (request, cliSessionId) => {
      const current = request as
        | (typeof request & {
            sourceMessageRef?: string;
            parentModelRunId?: string | null;
          })
        | undefined;
      const record = beginModelRun(adapter, {
        model_id: options.model,
        model_provider: options.backend,
        agent_id: options.agentId,
        instance_id: current?.channelId ?? null,
        parent_model_run_id: current?.parentModelRunId ?? null,
        input_refs: {
          sessionKey: current?.sessionKey ?? null,
          cliSessionId,
          nativeInputId: current?.nativeInputId ?? null,
          sourceMessageRef: current?.sourceMessageRef ?? null,
        },
      });
      return record.model_run_id;
    },
    commit: async (modelRunId, summary, tokenCount) => {
      commitModelRun(adapter, modelRunId, summary, tokenCount);
    },
    fail: async (modelRunId, summary, tokenCount) => {
      failModelRun(adapter, modelRunId, summary, tokenCount);
    },
  };
}

function searchHits(data: unknown): Array<{ id: string; score: number }> {
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((row) =>
    row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
      ? [
          {
            id: (row as { id: string }).id,
            score: Number((row as { retrieval_score?: unknown }).retrieval_score) || 0,
          },
        ]
      : []
  );
}

function isOwnerGuidanceRecord(record: MemoryRecord): boolean {
  return (RULE_KINDS as readonly string[]).includes(record.kind);
}

/**
 * The record order's index: the owner's rules among active guidance, as memory reads them; a rule
 * saved without an applies-when line shows its own words.
 */
export function ownerRuleLines(
  records: readonly MemoryRecord[],
  ownerRules: ReadonlySet<string>
): OwnerRuleLine[] {
  return records
    .filter((record) => ownerRules.has(record.id))
    .map((record) => ({ topic: record.topic, when: record.applies_when ?? record.summary }));
}

/** Active guidance among the search hits, in the search's own order. */
export function guidanceInSearchOrder(
  hitIds: readonly string[],
  records: readonly MemoryRecord[],
  limit: number,
  ownerRules: ReadonlySet<string>
): TurnLesson[] {
  const active = new Map(
    records
      .filter((record) => isOwnerGuidanceRecord(record) && record.status === 'active')
      .map((record) => [record.id, record])
  );
  return hitIds
    .flatMap((id) => {
      const record = active.get(id);
      return record
        ? [
            {
              id: record.id,
              topic: record.topic,
              summary: record.summary,
              ...(record.applies_when ? { appliesWhen: record.applies_when } : {}),
              ownerRule: ownerRules.has(record.id),
            },
          ]
        : [];
    })
    .slice(0, limit);
}

/** Assemble the one owner database, catalog, native session and mailbox runtime. */
export async function createOwnerRuntime(options: OwnerRuntimeOptions): Promise<OwnerRuntime> {
  // The session's system prompt is composed at its first turn; counting it before the tokenizer
  // loads used the byte estimate, which nearly doubles Korean text.
  await initTokenEstimator();
  const database = await openCoreDatabase({ path: options.databasePath });
  let rawStore: RawStore | undefined;
  let nativeSession: OwnerRuntimeOptions['nativeSession'] = options.nativeSession;
  let delivery: ReplayClockDelivery | undefined;
  let ownerMailbox: Mailbox | undefined;
  const reportStore = createPersistentReportStore({
    filePath: options.reportPath ?? join(options.runtimeRoot, 'report-slots.json'),
  });
  const reportSseClients = new Set<ServerResponse>();
  let wikiRoot: string | null = null;
  try {
    const knowledge = createKnowledge({
      adapter: database.adapter,
      embedder: runtimeEmbedder(options),
    });
    rawStore = new RawStore(options.rawPath);
    const chat = new ChatSources(
      rawStore,
      database.adapter,
      options.ownerPrincipalId,
      options.agentId
    );
    const sourceStore = rawStore;
    const storedSourceReader = createStoredSourceReader({
      adapter: database.adapter,
      ownerPrincipalId: () => options.ownerPrincipalId,
      rawStore: () => sourceStore,
    });
    const wikiPorts = options.wiki?.enabled
      ? (() => {
          if (options.wiki.vaultPath.trim() === '' || options.wiki.wikiDir.trim() === '') {
            throw new Error('Enabled wiki requires vaultPath and wikiDir');
          }
          wikiRoot = isAbsolute(options.wiki.wikiDir)
            ? options.wiki.wikiDir
            : join(options.wiki.vaultPath, options.wiki.wikiDir);
          const writer = new ObsidianWriter(wikiRoot, '.');
          writer.ensureDirectories();
          return {
            vault: { path: writer.getWikiPath(), name: null },
            publisher: (
              pages: Parameters<
                NonNullable<import('../api/wiki-actions.js').WikiPorts['publisher']>
              >[0]
            ) => {
              const versioned = pages.some((page) => page.expectedContentVersion !== undefined);
              if (versioned) {
                writer.writePagesAtomically(pages);
                return;
              }
              for (const page of pages) writer.writePage(page);
              // No host-written index: the owner agent keeps the table of contents (Home.md),
              // as in the archive v5 layout; appended "Published" blocks only grew the page.
              writer.appendLog('compile', `Published ${pages.length} pages`);
            },
          };
        })()
      : {};
    const surface = createActionSurface({
      runtimeRoot: options.runtimeRoot,
      adapter: database.adapter,
      ...(options.outboundAttempts === undefined
        ? {}
        : { outboundAttempts: options.outboundAttempts }),
      knowledge,
      ownerPrincipalId: options.ownerPrincipalId,
      agentId: options.agentId,
      scopes: options.scopes,
      connectors: options.connectors,
      storedSourceReader,
      timeZone: options.timeZone,
      configPath: join(options.runtimeRoot, 'config.yaml'),
      isOwnerMessageTurn: (sourceMessageRef) =>
        ownerMailbox?.readInput(sourceMessageRef, options.ownerPrincipalId)?.kind ===
        'owner_message',
      reportStore,
      reportSseClients,
      wikiPorts,
      attachmentPorts: {
        ...(options.attachmentPorts ?? {}),
        stored: storedSourceReader,
        workspaceDir: options.workspaceDir,
      },
      ...(options.driveDelivery === undefined
        ? {}
        : { driveDelivery: { ...options.driveDelivery, workspaceDir: options.workspaceDir } }),
      ownerMessages: { exchanges: (since, before) => chat.exchanges(since, before) },
      // Both report paths read this procedure, scheduled and requested (2026-09-29 to 10-05), and
      // the owner's rules for reports reached neither: a scheduled order carries no lessons and a
      // request's three recalled lessons depend on its wording.
      helpTopicContext: async (topic) =>
        topic === 'full-report' ? ownerRulesBlock(await ownerRules()) : '',
      helpTopics: ownerHelpTopics(
        options.backend,
        options.wiki?.enabled ?? false,
        options.jev !== undefined,
        options.driveDelivery !== undefined
      ),
      ...(options.jev === undefined
        ? {}
        : (() => {
            const jev = createJevClient(options.jev);
            // A judge call cites no observation; refs only name the batch a replay window lost.
            return { judge: { ask: (request) => jev.ask({ ...request, observationRefs: [] }) } };
          })()),
    });
    const access: JudgmentAccess = surface.ownerAccess;
    // Every active owner rule, oldest first as memory reads them; learned lessons stay on recall.
    const ownerRules =
      options.ownerRules ??
      (async (): Promise<OwnerRuleLine[]> => {
        const active = await readMemoryRecordsInScopes(database.adapter, [...access.scopes], {
          kind: [...RULE_KINDS],
          status: 'active',
        });
        return ownerRuleLines(
          active,
          ownerRuleIds(
            database.adapter,
            active.map((record) => record.id)
          )
        );
      });
    const standingText = ownerSystemPrompt(
      options.backend,
      null,
      storedSourceFamilies(database.adapter, access.connectors!),
      options.wiki?.enabled ?? false,
      options.timeZone.get(),
      options.jev !== undefined
    );
    const ownerPolicyProvider =
      options.ownerPolicyProvider ?? createOwnerPolicyProvider(options.runtimeRoot);
    if (nativeSession === undefined) {
      nativeSession = createNativeSession({
        backend: options.backend,
        model: options.model,
        workspaceDir: options.workspaceDir,
        runtimeRoot: options.runtimeRoot,
        replayKeyFile: options.replayKeyFile,
        ...(options.sandboxNetworkProxy === undefined
          ? {}
          : { sandboxNetworkProxy: options.sandboxNetworkProxy }),
        actionSurface: surface,
        // The standing text is the session's system prompt: sent on a new thread and
        // re-supplied when a durable thread resumes after a restart.
        ownerSystemPrompt: standingText,
        ownerPolicyProvider,
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        timeout: options.timeout,
        ...(options.maxTurnMs === undefined ? {} : { maxTurnMs: options.maxTurnMs }),
        maxTurns: options.maxTurns,
        ...(options.runTokenBudget === undefined ? {} : { runTokenBudget: options.runTokenBudget }),
        ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
        ...(options.codexSandbox === undefined ? {} : { codexSandbox: options.codexSandbox }),
        ...(options.mcpConfigPath === undefined ? {} : { mcpConfigPath: options.mcpConfigPath }),
        ...(options.mcpServerPath === undefined ? {} : { mcpServerPath: options.mcpServerPath }),
        ...(options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir }),
        modelRun: options.modelRun ?? runtimeModelRun(options, database.adapter),
        replaySourceEndMs: () => delivery?.getReplaySourceEndMs(),
      });
    }
    const processStartedAt = Date.now();
    const recordOrders = createRecordOrders({
      adapter: database.adapter,
      accept: (stimulus) =>
        intakeRuntime.accept({ ...stimulus, principalId: options.ownerPrincipalId }),
      processStartedAt,
      ...(options.onRecordOrderEvent === undefined ? {} : { onEvent: options.onRecordOrderEvent }),
    });
    delivery = createStimulusDelivery({
      backend: options.backend,
      timeZone: options.timeZone,
      wikiEnabled: options.wiki?.enabled ?? false,
      formattingRoutes: options.formattingRoutes ?? {
        reports: 'telegram',
        notifications: 'telegram',
      },
      readResult: (row) =>
        row.nativeDelivery?.receipt
          ? intakeRuntime.mailbox!.nativeInputs.resultForReceipt(
              row.nativeDelivery.receipt,
              row.principalId
            )
          : null,
      ...(options.onStimulusUncertain === undefined
        ? {}
        : { onUncertain: options.onStimulusUncertain }),
      ...(options.onStimulusDead === undefined ? {} : { onDead: options.onStimulusDead }),
      ...(options.onStimulusSkipped === undefined ? {} : { onSkipped: options.onStimulusSkipped }),
      ...(options.closeUncertain === undefined ? {} : { closeUncertain: options.closeUncertain }),
      sessionStart: (row) =>
        readSessionStartInput({
          exchanges: chat.recentExchanges(row.stimulusId),
          records: () =>
            readMemoryRecordsInScopes(database.adapter, [...access.scopes], {
              status: 'active',
              excludeAmendments: true,
            }),
          checkpoint: async () => {
            const listed = await surface.hostToolCall(
              'memory.checkpoint.list',
              { limit: 1 },
              `session-start:${randomUUID()}`
            );
            if (listed.status !== 'completed')
              throw new Error(
                `memory.checkpoint.list ${listed.status}: ${listed.error.code} ${listed.error.message}`
              );
            const [latest] = (
              listed.data as {
                checkpoints: Array<{ summary?: string; next_steps?: string; timestamp?: number }>;
              }
            ).checkpoints;
            return latest?.summary && typeof latest.timestamp === 'number'
              ? {
                  summary: latest.summary,
                  nextSteps: latest.next_steps ?? '',
                  createdAt: latest.timestamp,
                }
              : null;
          },
          now: Date.now(),
        }),
      // Kagemusha's lesson recall: the corrections memory.search ranks highest for the turn's text,
      // active ones only, read in full.
      lessons:
        options.lessons ??
        (async (text): Promise<TurnLesson[]> => {
          // One ranking: retrieval_score is rank within one search, so separate searches per kind
          // would put each kind's first hit on every turn. Guidance is a few dozen records among
          // hundreds of work records, so the search reads deep and keeps guidance in its order.
          // Lessons rank on the turn's own text; records a link reaches are for the agent to weigh.
          const search = await surface.hostToolCall(
            'memory.search',
            { query: text.slice(0, 2_000), limit: 40, includeRelated: false },
            `turn-lessons:${randomUUID()}`
          );
          if (search.status !== 'completed') {
            options.onLessonSearchFailed?.(`memory.search ${search.status}`);
            return [];
          }
          const hits = searchHits(search.data);
          if (hits.length === 0) return [];
          const active = await readMemoryRecordsInScopes(database.adapter, [...access.scopes], {
            kind: [...RULE_KINDS],
            status: 'active',
          });
          // Ten in search order: the session filter drops lessons already shown and keeps three.
          const hitIds = hits.map((hit) => hit.id);
          return guidanceInSearchOrder(hitIds, active, 10, ownerRuleIds(database.adapter, hitIds));
        }),
      ownerRules,
      recordOrders,
      ...(options.onOwnerResult === undefined ? {} : { onOwnerResult: options.onOwnerResult }),
      ...(options.onSourceResult === undefined ? {} : { onSourceResult: options.onSourceResult }),
      ...(options.onScheduledResult === undefined
        ? {}
        : { onScheduledResult: options.onScheduledResult }),
      ...(options.onStimulusDelivered === undefined
        ? {}
        : { onDelivered: options.onStimulusDelivered }),
      ...(options.onStimulusFailed === undefined ? {} : { onFailed: options.onStimulusFailed }),
    });
    const socketDispatch: ActionDispatcher = Object.assign(
      async (...[call, context]: Parameters<ActionDispatcher>) => {
        const caller = context.session?.nativeCaller;
        if (caller !== undefined) {
          if (
            options.backend !== 'claude' ||
            context.access.principalId !== options.ownerPrincipalId ||
            !nativeSession?.callAction
          ) {
            throw new Error('Native caller attribution requires the Claude owner session');
          }
          return nativeSession.callAction(call, caller);
        }
        return surface.dispatch(call, context);
      },
      { contracts: surface.dispatch.contracts }
    );
    const intakeRuntime = await startRuntime({
      paths: { socketPath: options.socketPath },
      catalog: surface.catalog,
      dispatch: socketDispatch,
      principals: [{ access, credentialPath: options.credentialPath }],
      sessionFacts: (_access, request) => {
        const ceiling = delivery?.getReplaySourceEndMs();
        return {
          ...(ceiling === undefined ? {} : { replaySourceEndMs: ceiling }),
          ...(request.session?.nativeCaller === undefined
            ? {}
            : { nativeCaller: request.session.nativeCaller }),
        };
      },
      mailbox: { adapter: database.adapter },
      nativeSession,
      delivery: {
        ...delivery,
        ...(options.deliveryReady === undefined ? {} : { ready: options.deliveryReady }),
      },
      reclaimStaleSocket: true,
    });
    ownerMailbox = intakeRuntime.mailbox;
    recordOrders.recover();
    const intake = createStimulusIntake(intakeRuntime, options.ownerPrincipalId, chat);
    let stopped = false;
    return {
      runtime: intakeRuntime,
      database,
      knowledge,
      surface,
      reportStore,
      reportSseClients,
      wikiRoot,
      intake,
      acceptSourceDelta: intake.acceptSourceDelta,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        recordOrders.stop();
        await intakeRuntime.stop();
        rawStore?.close();
        await database.close();
      },
    };
  } catch (error) {
    rawStore?.close();
    await database.close();
    throw error;
  }
}
