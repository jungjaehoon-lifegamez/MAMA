import type { MemberEnrollmentPorts, MemberSelection } from '../api/member-enrollment.js';
import type { ActionResult } from '@jungjaehoon/mama-core';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { createPrincipalSessions } from './principal-sessions.js';
import type { MemberRecordsTelegram } from '../api/member-records.js';
import type { OwnerMessageLedger } from '../gateways/telegram-message-ledger.js';
import { createMemberSession } from './member-session.js';
import { ownerDataReadPaths, ownerNativeDataReadPaths } from './backend-security.js';
import { validateMemberRoot, setAsideMemberPaths } from './member-paths.js';
import { resolvePrincipalAccess } from './principal-access.js';
import {
  beginModelRun,
  commitModelRun,
  createKnowledge,
  failModelRun,
  generateEmbedding,
  readMemoryRecordsInScopes,
  isErasedRecord,
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
import type { OutboundAttemptEvent, MemberConnectionEvent } from '../api/security-events.js';
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
import type { OwnerHostExchangeInput } from '../gateways/turn-contract.js';
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

export interface OwnerRuntimeOptions {
  messageLedger?: () => OwnerMessageLedger | undefined;
  memberRecordsTelegram?: () => MemberRecordsTelegram | undefined;
  /** Native shell commands that open a network connection, reported as they start (W35). */
  outboundAttempts?: (event: OutboundAttemptEvent | MemberConnectionEvent) => void;
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
  embedder?: NonNullable<KnowledgeOptions['embedder']>;
  memberRoot?: string;
  memberEnrollment?: Omit<MemberEnrollmentPorts, 'memberRoot' | 'serveMember'>;
  /** Additional configured owner locations (config, logging, custom MCP), denied only to members. */
  ownerDeniedReadPaths?: readonly string[];
  createSession?: typeof createNativeSession;
  onMemberResult?: StimulusDeliveryOptions['onOwnerResult'];
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
  serveMember(principalId: string): StimulusIntake;
  completeMemberEnrollment(selection: MemberSelection): Promise<ActionResult>;
  recordHostExchange(input: OwnerHostExchangeInput): void;
  stop(): Promise<void>;
}

export async function readOwnerMemoryRecords(
  adapter: Parameters<typeof readMemoryRecordsInScopes>[0],
  scopes: readonly MemoryScopeRef[],
  options: Parameters<typeof readMemoryRecordsInScopes>[2] = {}
) {
  const records = await readMemoryRecordsInScopes(adapter, scopes, options);
  return records.filter((record): record is MemoryRecord => !isErasedRecord(record));
}

function runtimeEmbedder(options: OwnerRuntimeOptions): NonNullable<KnowledgeOptions['embedder']> {
  return (
    options.embedder ?? {
      embed: (text, role) => generateEmbedding(text, role),
    }
  );
}

export function runtimeModelRun(
  options: OwnerRuntimeOptions,
  adapter: Parameters<typeof beginModelRun>[0]
): NativeModelRunPort {
  return {
    begin: async (request, cliSessionId) => {
      const current = request as
        | (typeof request & {
            access?: JudgmentAccess;
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
          principalId: current?.access?.principalId ?? null,
          sessionKey: current?.sessionKey ?? null,
          cliSessionId,
          nativeInputId: current?.nativeInputId ?? null,
          sourceMessageRef: current?.sourceMessageRef ?? null,
        },
      });
      return record.model_run_id;
    },
    commit: async (modelRunId, summary, tokenCount, usage) => {
      commitModelRun(adapter, modelRunId, summary, tokenCount, usage);
    },
    fail: async (modelRunId, summary, tokenCount, usage) => {
      failModelRun(adapter, modelRunId, summary, tokenCount, usage);
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

/** Active guidance among the search hits, in the search's own order. */
export function guidanceInSearchOrder(
  hitIds: readonly string[],
  records: readonly MemoryRecord[],
  limit: number,
  ownerRuleRecordIds: ReadonlySet<string>
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
              ownerRule: ownerRuleRecordIds.has(record.id),
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
  let actionSurface: ActionSurface | undefined;
  let stopping = false;
  const sessions = createPrincipalSessions(
    options.ownerPrincipalId,
    {
      onUncertain: options.onStimulusUncertain,
      onDead: options.onStimulusDead,
    },
    (id) => {
      if (stopping) throw new Error('Runtime is stopping');
      return !actionSurface?.memberRecords.isBlocked(id);
    }
  );
  const members = new Map<string, ReturnType<typeof createMemberSession>>();
  const memberIntakes = new Map<string, StimulusIntake>();
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
    const activeMembers = createPrincipalRepository(database.adapter)
      .listMembers()
      .filter((member) => member.status === 'active');
    if (activeMembers.length && options.memberRoot === undefined)
      throw new Error('Active members require member_root');
    const ownerDeniedPaths = options.memberRoot === undefined ? [] : ownerDataReadPaths(options);
    // A denied owner path that contains member_root would deny the members' own workspaces.
    const memberRoot =
      options.memberRoot === undefined
        ? undefined
        : validateMemberRoot(options.memberRoot, ownerDeniedPaths);
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
      isOwnerMessageTurn: (sourceMessageRef, principalId = options.ownerPrincipalId) =>
        ownerMailbox?.readInput(sourceMessageRef, principalId)?.kind === 'owner_message',
      // Without member_root no member can be served or set aside, so no change may be committed.
      ...(memberRoot === undefined
        ? {}
        : {
            memberRecords: {
              root: memberRoot,
              isStopping: () => stopping,
              resumeQueued: () => {
                void intakeRuntime
                  .drainOnce()
                  .catch((error) =>
                    console.error('[Owner runtime] queued delivery resume failed', error)
                  );
              },
              rawStore: sourceStore,
              mailbox: () => ownerMailbox!,
              ledger: () => options.messageLedger?.(),
              telegram: () => options.memberRecordsTelegram?.(),
              access: (id) => executionAccess(id),
              turnChain: sessions.turnChain,
              retire: (id) => retireMember(id, false),
              serve: (id) => {
                serveMember(id);
              },
              recordExchange: (id, kind, ref, text, deliveryVerified) => {
                const memberChat = new ChatSources(
                  sourceStore,
                  database.adapter,
                  id,
                  `member-agent:${id}`
                );
                const at = Date.now();
                memberChat.saveOwnerMessage({
                  id: ref,
                  channelKey: 'records',
                  occurredAt: at,
                  text: `Personal records ${kind === 'export' ? 'export' : 'erasure'} host receipt`,
                });
                memberChat.saveReply({
                  messageRef: ref,
                  text,
                  occurredAt: at,
                  deliveryVerified,
                  author: 'host',
                });
              },
            },
            memberLifecycle: {
              resetSession: async (id) => {
                const member = members.get(id);
                if (!member) throw new Error(`Member session is not served: ${id}`);
                await member.native.resetSession(member.native.sessionKey);
              },
              cancelQueued: (id, reason) => ownerMailbox!.cancelQueued(id, reason),
              retire: (id) => retireMember(id),
              resume: async (id) => {
                // A suspended member may retain a session after an earlier stop/move failure.
                await retireMember(id);
                const repo = createPrincipalRepository(database.adapter);
                repo.resume(id, Date.now());
                try {
                  serveMember(id);
                } catch (error) {
                  // A failed preparation never leaves an active registry entry with a partial runtime.
                  repo.suspend(id, Date.now());
                  throw error;
                }
              },
            },
          }),
      ...(options.memberEnrollment === undefined
        ? {}
        : {
            memberEnrollment: {
              ...options.memberEnrollment,
              memberRoot,
              serveMember: (id) => {
                serveMember(id);
              },
            },
          }),
      reportStore,
      reportSseClients,
      wikiPorts,
      attachmentPorts: {
        ...(options.attachmentPorts ?? {}),
        stored: storedSourceReader,
        workspaceDir: options.workspaceDir,
        principalPaths: (principalId) => {
          if (principalId === options.ownerPrincipalId)
            return {
              workspaceDir: options.workspaceDir,
              downloadsDir: options.attachmentPorts?.downloadsDir ?? '',
            };
          sessions.get(principalId);
          return members.get(principalId)!.paths;
        },
      },
      ...(options.driveDelivery === undefined
        ? {}
        : { driveDelivery: { ...options.driveDelivery, workspaceDir: options.workspaceDir } }),
      ownerMessages: { exchanges: (since, before) => chat.exchanges(since, before) },
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
    // The surface keeps this shared object live: access.scopes resolves active partitions on use.
    actionSurface = surface;
    const access: JudgmentAccess = surface.ownerAccess;
    const standingText = ownerSystemPrompt(
      options.backend,
      null,
      storedSourceFamilies(database.adapter, access.connectors!, access),
      options.wiki?.enabled ?? false,
      options.timeZone.get(),
      options.jev !== undefined
    );
    const ownerPolicyProvider =
      options.ownerPolicyProvider ?? createOwnerPolicyProvider(options.runtimeRoot);
    if (nativeSession === undefined) {
      nativeSession = (options.createSession ?? createNativeSession)({
        backend: options.backend,
        model: options.model,
        workspaceDir: options.workspaceDir,
        runtimeRoot: options.runtimeRoot,
        deniedReadPaths: ownerNativeDataReadPaths(options),
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
      turnChain: sessions.turnChain,
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
            readOwnerMemoryRecords(database.adapter, [...access.scopes], {
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
          const active = await readOwnerMemoryRecords(database.adapter, [...access.scopes], {
            kind: [...RULE_KINDS],
            status: 'active',
          });
          // Ten in search order: the session filter drops lessons already shown and keeps three.
          const hitIds = hits.map((hit) => hit.id);
          return guidanceInSearchOrder(
            hitIds,
            active,
            10,
            ownerRuleIds(database.adapter, hitIds, options.ownerPrincipalId)
          );
        }),
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
    sessions.add(options.ownerPrincipalId, { native: nativeSession, delivery });
    const prepareMember = (principalId: string) => {
      if (memberRoot === undefined) throw new Error('Active members require member_root');
      const principal = createPrincipalRepository(database.adapter).findById(principalId);
      if (principal?.kind !== 'member' || principal.status !== 'active')
        throw new Error(`serveMember requires an active member: ${principalId}`);
      const member = createMemberSession(principalId, memberRoot, {
        options,
        ownerDeniedPaths,
        registeredMemberIds: () =>
          createPrincipalRepository(database.adapter)
            .listMembers()
            .map((row) => row.principalId),
        database,
        rawStore: sourceStore,
        surface,
        turnChain: sessions.turnChain,
        readResult: (row) =>
          row.nativeDelivery?.receipt
            ? intakeRuntime.mailbox!.nativeInputs.resultForReceipt(
                row.nativeDelivery.receipt,
                row.principalId
              )
            : null,
      });
      members.set(principalId, member);
      sessions.add(principalId, member);
      return member;
    };
    for (const member of activeMembers) prepareMember(member.principalId);
    const executionAccess = (principalId: string) =>
      principalId === options.ownerPrincipalId
        ? access
        : resolvePrincipalAccess(principalId, {
            adapter: database.adapter,
            ownerAccess: access,
            agentId: `member-agent:${principalId}`,
          });
    const socketDispatch: ActionDispatcher = Object.assign(
      async (...[call, context]: Parameters<ActionDispatcher>) => {
        context = { ...context, access: executionAccess(context.access.principalId) };
        const caller = context.session?.nativeCaller;
        if (caller !== undefined) {
          const principalSession = sessions.get(context.access.principalId).native;
          if (options.backend !== 'claude' || !principalSession.callAction)
            throw new Error(
              context.access.principalId === options.ownerPrincipalId
                ? 'Native caller attribution requires the Claude owner session'
                : 'Native caller attribution requires a served Claude session'
            );
          return principalSession.callAction(call, caller);
        }
        return surface.dispatch(call, context);
      },
      { contracts: surface.dispatch.contracts }
    );
    const intakeRuntime = await startRuntime({
      paths: { socketPath: options.socketPath },
      catalog: surface.catalog,
      dispatch: socketDispatch,
      principals: [
        { access, credentialPath: options.credentialPath },
        ...[...members.values()].map((member) => ({
          access: member.initialAccess,
          credentialPath: member.paths.credentialPath,
        })),
      ],
      sessionFacts: (callerAccess, request) => {
        executionAccess(callerAccess.principalId);
        const ceiling = sessions.replaySourceEndMs(callerAccess.principalId);
        return {
          ...(ceiling === undefined ? {} : { replaySourceEndMs: ceiling }),
          ...(request.session?.nativeCaller === undefined
            ? {}
            : { nativeCaller: request.session.nativeCaller }),
        };
      },
      mailbox: { adapter: database.adapter },
      nativeSession: sessions.native,
      delivery: {
        ...sessions.delivery,
        onSettled: surface.memberRecords.onSettled,
        onDead: (row, reason) => {
          surface.memberRecords.onDead(row, reason);
          return sessions.delivery.onDead?.(row, reason);
        },
        onUncertain: (row, reason) => {
          surface.memberRecords.onUncertain(row, reason);
          return sessions.delivery.onUncertain?.(row, reason);
        },
        ready: () =>
          !stopping && !surface.memberRecords.isBusy() && (options.deliveryReady?.() ?? true),
      },
      reclaimStaleSocket: true,
    });
    ownerMailbox = intakeRuntime.mailbox;
    recordOrders.recover();
    const intake = createStimulusIntake(intakeRuntime, options.ownerPrincipalId, chat);
    const createMemberIntake = (id: string, member: ReturnType<typeof createMemberSession>) =>
      createStimulusIntake(intakeRuntime, id, {
        saveOwnerMessage: (input) => {
          executionAccess(id);
          if (!intakeRuntime.servesPrincipal(id))
            throw new Error(`Member session is not served: ${id}`);
          return member.chat.saveOwnerMessage(input);
        },
        saveReply: (input) => member.chat.saveReply(input),
      });
    for (const [id, member] of members) memberIntakes.set(id, createMemberIntake(id, member));
    const retireMember = async (id: string, setAside = true) => {
      if (memberRoot === undefined) throw new Error('Member lifecycle requires member_root');
      intakeRuntime.unservePrincipal(id);
      const member = members.get(id);
      if (member) {
        // Stopping keeps the shared session-pool entry; reset first so a resume cannot reopen the
        // archived native context.
        await member.native.resetSession(member.native.sessionKey);
        await member.native.stop();
      }
      sessions.remove(id);
      members.delete(id);
      memberIntakes.delete(id);
      if (setAside) setAsideMemberPaths(memberRoot, id);
    };
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    const serveMember = (principalId: string): StimulusIntake => {
      if (stopped) throw new Error('Cannot serve a member after runtime stop');
      executionAccess(principalId);
      const existing = memberIntakes.get(principalId);
      if (existing) {
        // A failed reset/stop leaves the existing native handle available, but its socket was
        // already unserved. Restore the actual registration, not just the cached intake.
        if (!intakeRuntime.servesPrincipal(principalId))
          intakeRuntime.servePrincipal({
            access: executionAccess(principalId),
            credentialPath: members.get(principalId)!.paths.credentialPath,
          });
        return existing;
      }
      const member = prepareMember(principalId);
      try {
        intakeRuntime.servePrincipal({
          access: member.initialAccess,
          credentialPath: member.paths.credentialPath,
        });
      } catch (error) {
        // Unregister, so a later serveMember can try again in this process.
        sessions.remove(principalId);
        members.delete(principalId);
        void member.native.stop();
        throw error;
      }
      const memberIntake = createMemberIntake(principalId, member);
      memberIntakes.set(principalId, memberIntake);
      return memberIntake;
    };
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
      serveMember: (id) => {
        // Erasure owns restoration once it unserves the member. Intake callers must not
        // recreate a writer while the host takes and delivers that member's snapshot.
        if (surface.memberRecords.isBlocked(id) && !intakeRuntime.servesPrincipal(id))
          throw new Error(`Member session is not served: ${id}`);
        return serveMember(id);
      },
      completeMemberEnrollment: (selection) =>
        sessions.turnChain(async () => {
          if (stopped) throw new Error('Cannot enroll a member after runtime stop');
          return surface.completeMemberEnrollment(selection);
        }),
      recordHostExchange: ({ message, reply }) => {
        chat.saveOwnerMessage(message);
        chat.saveReply({ ...reply, messageRef: message.id, author: 'host' });
      },
      stop: () => {
        if (stopPromise) return stopPromise;
        stopping = true;
        stopPromise = (async () => {
          await surface.memberRecords.idle();
          stopped = true;
          recordOrders.stop();
          await intakeRuntime.stop();
          rawStore?.close();
          await database.close();
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    await sessions.native.stop();
    rawStore?.close();
    await database.close();
    throw error;
  }
}
