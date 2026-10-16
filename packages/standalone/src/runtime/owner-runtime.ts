import { createPersonalJobScheduler } from './personal-jobs.js';
import { createSkillTurnContext } from './skills.js';
import { homedir } from 'node:os';
import type { MemberEnrollmentPorts, MemberSelection } from '../api/member-enrollment.js';
import type { ActionResult } from '@jungjaehoon/mama-core';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { personalNoticePayload } from './personal-notices.js';
import { StimulusQuarantine } from '@jungjaehoon/mama-core/runtime/runtime';
import { createPrincipalSessions } from './principal-sessions.js';
import type { MemberRecordsTelegram } from '../api/member-records.js';
import {
  retirePersonalTurnReceipt,
  type OwnerMessageLedger,
} from '../gateways/telegram-message-ledger.js';
import { createMemberSession, memberRoomsRoot, roomDirectory } from './member-session.js';
import { ownerDataReadPaths, ownerNativeDataReadPaths } from './backend-security.js';
import { memberPaths, validateMemberRoot, setAsideMemberPaths } from './member-paths.js';
import {
  memberRoomSessionKey,
  memberSessionKey,
  resolvePrincipalAccess,
} from './principal-access.js';
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
import { basename, join, isAbsolute } from 'node:path';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import type { OwnerAttachment } from '../gateways/telegram-attachments.js';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { ServerResponse } from 'node:http';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeModelRunPort } from '@jungjaehoon/mama-core/runtime/native-turn';
import { createStoredSourceReader } from '../api/stored-source-reader.js';
import type { AttachmentActionPorts } from '../api/attachment-actions.js';
import { credentialReadPaths } from './backend-security.js';
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
import { holdsOwnerRole, ownerRuleIds, RULE_KINDS } from './owner-authority.js';
import {
  createNativeSession,
  OWNER_RUNTIME_SESSION_KEY,
  type NativeSession,
} from './native-session.js';
import type { ActionDispatcher } from '@jungjaehoon/mama-core/api/dispatch';
import type { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { TimeZoneSetting } from './timezone.js';
import { ownerHelpTopics, ownerSystemPrompt } from './owner-system-prompt.js';
import { storedSourceFamilies } from '../connectors/framework/stored-index-read.js';
import { createOwnerPolicyProvider, type OwnerPolicyProvider } from './owner-policy.js';
import { readSessionStartInput } from './session-start-context.js';
import { ChatSources } from '../storage/chat-sources.js';
import type {
  ConversationTarget,
  OwnerMessageInput,
  OwnerHostExchangeInput,
  TurnIntake,
} from '../gateways/turn-contract.js';
import { getSessionPool, type SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
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
  prepareDeferredMemberInput?(id: string, input: OwnerMessageInput): Promise<OwnerMessageInput>;
  onPersonalJobError?: (error: unknown) => void;
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
  commonChannelId?: string;
  roomChannels?: readonly string[];
  agentId: string;
  scopes: readonly MemoryScopeRef[];
  connectors?: readonly string[];
  rawPath: string;
  embedder?: NonNullable<KnowledgeOptions['embedder']>;
  memberRoot?: string;
  toolsRoot?: string;
  memberEnrollment?: Omit<MemberEnrollmentPorts, 'memberRoot' | 'serveMember'>;
  /** Additional configured owner locations (config, logging, custom MCP), denied only to members. */
  ownerDeniedReadPaths?: readonly string[];
  createSession?: typeof createNativeSession;
  /** The pool this runtime's sessions take their turns from; the process-wide one by default. */
  sessionPool?: SessionPool;
  onMemberResult?: StimulusDeliveryOptions['onOwnerResult'];
  nativeSession?: NativeSessionHandle & Partial<Pick<NativeSession, 'callAction'>>;
  modelRun?: NativeModelRunPort;
  effort?: RuntimeEffort;
  /** Hosts a turn with no person in it may WebFetch (`agent.autonomous_web_fetch`). */
  autonomousWebFetch?: readonly string[];
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
  personalJobs: ReturnType<typeof createPersonalJobScheduler>;
  readonly runtime: RuntimeHandle;
  readonly database: CoreDatabase;
  readonly knowledge: Knowledge;
  readonly surface: ActionSurface;
  readonly reportStore: ReturnType<typeof createPersistentReportStore>;
  readonly reportSseClients: Set<ServerResponse>;
  readonly wikiRoot: string | null;
  readonly intake: StimulusIntake;
  readonly acceptSourceDelta: StimulusIntake['acceptSourceDelta'];
  serveMember(principalId: string): Promise<StimulusIntake>;
  /** `deferIncoming` is set while an erasure has the member retired. */
  memberIntake(
    principalId: string,
    roomChannel?: string
  ): StimulusIntake & Pick<TurnIntake, 'deferIncoming'>;
  principalPaths(
    principalId: string,
    roomChannel?: string
  ): { workspaceDir: string; downloadsDir: string };
  completeMemberEnrollment(selection: MemberSelection): Promise<ActionResult>;
  recordHostExchange(input: OwnerHostExchangeInput): void;
  /** Whether a turn is running in this conversation now. */
  turnRunning(target: ConversationTarget): boolean;
  /**
   * Start a conversation over: its native context goes, its records stay. It is busy while a
   * turn of that person (the common session's, for the common conversation) runs or an input of
   * theirs waits. A member's own conversation is reset with their group conversations, as every
   * member reset is.
   */
  startOver(target: ConversationTarget): Promise<'started_over' | 'busy'>;
  beginStop(): void;
  drain(): Promise<void>;
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
  ownerRuleRecordIds: ReadonlySet<string>,
  skillScopes: readonly MemoryScopeRef[] = []
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
              ...(record.kind === 'workflow' &&
              record.scopes.some((scope) =>
                skillScopes.some(
                  (admitted) => admitted.kind === scope.kind && admitted.id === scope.id
                )
              )
                ? { skillId: record.id }
                : {}),
              ownerRule: ownerRuleRecordIds.has(record.id),
            },
          ]
        : [];
    })
    .slice(0, limit);
}

/**
 * Whether an input of this person is about to run or running: pending and due, or claimed with a
 * delivery not parked as uncertain. One waiting out a retry backoff or parked for reconciliation
 * can take hours, and runs in whatever conversation is there by then.
 */
export function hasWaitingInput(
  adapter: CoreDatabase['adapter'],
  principalId: string,
  now: number
): boolean {
  return (
    adapter
      .prepare(
        `SELECT 1 FROM mailbox_inputs m LEFT JOIN native_input_deliveries n ON n.input_id = m.id
          WHERE m.principal_id = ?
            AND ((m.status = 'pending' AND COALESCE(m.retry_after, 0) <= ?)
              OR (m.status = 'claimed' AND (n.state IS NULL OR n.state != 'uncertain')))
          LIMIT 1`
      )
      .get(principalId, now) !== undefined
  );
}

/**
 * Inputs not yet done: pending, or claimed and queued or running (not parked as uncertain).
 * Everyone's, one person's, or one person's in one chat (a room input's channel is its group's
 * chat). A claimed input may wait on the person's chain while another conversation of theirs runs.
 */
export function countInputsNotDone(
  adapter: CoreDatabase['adapter'],
  scope: { principalId?: string; channel?: string }
): number {
  const row = adapter
    .prepare(
      `SELECT COUNT(*) AS count FROM mailbox_inputs m
         LEFT JOIN native_input_deliveries n ON n.input_id = m.id
        WHERE (m.status = 'pending' OR (m.status = 'claimed' AND (n.state IS NULL OR n.state != 'uncertain')))
          AND (? IS NULL OR m.principal_id = ?) AND (? IS NULL OR m.channel_key = ?)`
    )
    .get(
      scope.principalId ?? null,
      scope.principalId ?? null,
      scope.channel ?? null,
      scope.channel ?? null
    ) as { count: number };
  return row.count;
}

/** The session key a conversation's turns run under. */
function conversationKey(target: ConversationTarget): string {
  if (target.kind === 'common') return OWNER_RUNTIME_SESSION_KEY;
  return target.room === undefined
    ? memberSessionKey(target.principalId)
    : memberRoomSessionKey(target.principalId, target.room);
}

/** Assemble the one owner database, catalog, native session and mailbox runtime. */
export async function createOwnerRuntime(options: OwnerRuntimeOptions): Promise<OwnerRuntime> {
  const sessionPool = options.sessionPool ?? getSessionPool();
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
      onDead: async (row, reason) => {
        if (personalNoticePayload(row)) {
          await actionSurface?.personalNotices.close(row);
          const ledger = options.messageLedger?.();
          if (ledger) retirePersonalTurnReceipt(ledger, row.stimulusId);
        }
        await options.onStimulusDead?.(row, reason);
      },
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
    const principals = createPrincipalRepository(database.adapter);
    const knowledge = createKnowledge({
      adapter: database.adapter,
      embedder: runtimeEmbedder(options),
    });
    const activeMembers = principals.listMembers().filter((member) => member.status === 'active');
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
    // A member's personal copy of a host exchange; the common management copy is separate.
    const writeMemberHostExchange = (id: string, { message, reply }: OwnerHostExchangeInput) => {
      const archive = new ChatSources(sourceStore, database.adapter, id, `member-agent:${id}`);
      archive.saveOwnerMessage({ ...message, senderPrincipalId: id });
      archive.saveReply({ ...reply, messageRef: message.id, author: 'host' });
    };
    // A member's chat archive: its personal records for a DM, the common records for a room
    // (as its room session keeps them).
    const memberChat = (id: string, room?: string) =>
      new ChatSources(
        sourceStore,
        database.adapter,
        room === undefined ? id : options.ownerPrincipalId,
        `member-agent:${id}`
      );
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
      commonChannelId: options.commonChannelId,
      runtimeRoot: options.runtimeRoot,
      skillPaths: {
        toolsRoot: options.toolsRoot,
        workspace: (id) => {
          if (id === options.ownerPrincipalId) return options.workspaceDir;
          if (memberRoot === undefined) throw new Error('Member skills require member_root');
          return memberPaths(memberRoot, id).workspaceDir;
        },
      },
      documentPorts: {
        toolsRoot: options.toolsRoot,
        workspaceDir: options.workspaceDir,
        deniedReadPaths: [
          homedir(),
          ...credentialReadPaths(options.runtimeRoot, options.codexHome, options.replayKeyFile),
          ...ownerNativeDataReadPaths(options),
        ],
        ...(memberRoot === undefined
          ? {}
          : {
              principalPaths: (id: string) => {
                sessions.get(id);
                return members.get(id)!.activePaths();
              },
              // Linked document resources have the same private-data boundary as native tools.
              principalDeniedReadPaths: (id: string) => {
                sessions.get(id);
                return members.get(id)!.activeDeniedReadPaths();
              },
            }),
      },
      memberDirectoryChange: sessions.exclusive,
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
      isOwnerMessageTurn: (sourceMessageRef, principalId) =>
        ownerMailbox?.readInput(sourceMessageRef, principalId)?.kind === 'owner_message',
      recordManagementReceipt: ({ callerPrincipalId, operationId, action, input, result }) => {
        const at = Date.now();
        const ref = `host:management:${operationId}`;
        chat.saveOwnerMessage({
          id: ref,
          channelKey: 'management',
          ...(callerPrincipalId === undefined ? {} : { senderPrincipalId: callerPrincipalId }),
          occurredAt: at,
          text: action,
          payload: { managementAction: action },
        });
        chat.saveReply({
          messageRef: ref,
          text: JSON.stringify({ action, input, result }),
          occurredAt: at,
          deliveryVerified: true,
          author: 'host',
        });
      },
      // Without member_root no member can be served or set aside, so no change may be committed.
      ...(memberRoot === undefined
        ? {}
        : {
            memberNotices: {
              mailbox: () => ownerMailbox!,
              wake: () => {
                // The recipient delivery prepares service outside the common turn.
                void intakeRuntime
                  .drainOnce()
                  .catch((error: unknown) => options.onPersonalJobError?.(error));
              },
            },
            memberRecords: {
              root: memberRoot,
              isStopping: () => stopping,
              isReady: () => options.deliveryReady?.() ?? true,
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
              writeHostExchange: (id, exchange) => writeMemberHostExchange(id, exchange),
              recordExchange: (id, kind, ref, text, deliveryVerified) => {
                if (
                  database.adapter
                    .prepare(
                      "SELECT 1 FROM connector_event_index WHERE source_connector='chat' AND source_entity_id=? AND memory_scope_id=?"
                    )
                    .get(`${ref}:reply`, id)
                )
                  return;
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
              mailbox: () => ownerMailbox!,
              isStopping: () => stopping,
              isServed: (id) => members.has(id),
              resumeQueued: () => {
                void intakeRuntime
                  .drainOnce()
                  .catch((error) => console.error('[Member management] delivery failed', error));
              },
              turnChain: sessions.turnChain,
              resetSession: async (id) => {
                const member = members.get(id);
                if (!member) throw new Error(`Member session is not served: ${id}`);
                await member.native.resetSession(member.native.sessionKey);
              },
              cancelQueued: (id, reason) => {
                if (reason === 'member_suspend') options.memberEnrollment?.cancelSelection?.(id);
                return ownerMailbox!.cancelQueued(id, reason);
              },
              retire: (id) => retireMember(id),
              resume: async (id) => {
                // A suspended member may retain a session after an earlier stop/move failure.
                await retireMember(id);
                const resumedAt = Date.now();
                await surface.personalJobs.resume(id, resumedAt);
                principals.resume(id, resumedAt);
                try {
                  serveMember(id);
                } catch (error) {
                  // A failed preparation never leaves an active registry entry with a partial runtime.
                  principals.suspend(id, Date.now());
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
                if (stopping) return 'next_start';
                // Serving recreates the member's paths; an erasure checks them against the
                // delivered export and serves the member itself when it ends.
                if (surface.memberRecords.excludePrincipals().includes(id)) return 'after_erasure';
                serveMember(id);
                return undefined;
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
          return members.get(principalId)!.activePaths();
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
        ...(options.sessionPool === undefined ? {} : { sessionPool: options.sessionPool }),
        workspaceDir: options.workspaceDir,
        runtimeRoot: options.runtimeRoot,
        toolsRoot: options.toolsRoot,
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
        ...(options.autonomousWebFetch === undefined
          ? {}
          : { autonomousWebFetch: options.autonomousWebFetch }),
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
      skills: createSkillTurnContext(() => surface.skills.list(options.ownerPrincipalId)),
      turnChain: sessions.turnChain(options.ownerPrincipalId),
      backend: options.backend,
      timeZone: options.timeZone,
      principalRoles: (principalId) => principals.listRoles(principalId).map(({ role }) => role),
      principalDisplayName: (principalId) => principals.findById(principalId)?.displayName,
      commonPrincipalId: options.ownerPrincipalId,
      ownerMessageSenderActive: (id) => {
        const person = principals.findById(id);
        return (
          person?.kind === 'member' && person.status === 'active' && holdsOwnerRole(principals, id)
        );
      },
      rerouteOwnerMessage: async (row, sender) => {
        const person = principals.findById(sender);
        if (
          person?.kind !== 'member' ||
          person.status !== 'active' ||
          !row.stimulusId.startsWith(`telegram:${row.channelKey}:`) ||
          !options.roomChannels?.includes(row.channelKey)
        )
          return false;
        await serveMemberOnLane(sender);
        // The room session cannot read the common downloads; its files go to the room's own.
        const payload = row.payload as {
          input?: { attachments?: OwnerAttachment[] } & Record<string, unknown>;
        };
        let input = payload.input;
        if (input?.attachments?.length) {
          const target = join(
            members.get(sender)!.roomSession(row.channelKey).paths.downloadsDir,
            'telegram'
          );
          mkdirSync(target, { recursive: true });
          input = {
            ...input,
            attachments: input.attachments.map((attachment) => {
              if (!('path' in attachment)) return attachment;
              const path = join(target, basename(attachment.path));
              copyFileSync(attachment.path, path);
              return { ...attachment, path };
            }),
          };
        }
        // A deterministic handoff ref survives a crash between this append and the common
        // acknowledgement. Mailbox ref identities are global; keep the evidence handles.
        intakeRuntime.accept({
          id: row.stimulusId,
          kind: 'owner_message',
          principalId: sender,
          channelKey: row.channelKey,
          occurredAt: row.occurredAt,
          refs: row.refs.map((ref) => ({ ...ref, refId: `room-handoff:${sender}:${ref.refId}` })),
          replyTo: row.replyTo,
          payload: {
            ...(row.payload as object),
            ...(input === undefined ? {} : { input }),
            senderPrincipalId: sender,
            roomChannel: row.channelKey,
          } as unknown as JsonValue,
        });
        return true;
      },
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
      onSkipped: async (row, reason) => {
        if (row.kind === 'owner_message')
          database.adapter
            .prepare('UPDATE mailbox_inputs SET last_error = ? WHERE id = ?')
            .run(reason, row.id);
        await options.onStimulusSkipped?.(row, reason);
      },
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
            ownerRuleIds(database.adapter, hitIds, options.ownerPrincipalId),
            surface.skills.workflowScopes(options.ownerPrincipalId)
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
      const principal = principals.findById(principalId);
      if (principal?.kind !== 'member' || principal.status !== 'active')
        throw new Error(`serveMember requires an active member: ${principalId}`);
      const member = createMemberSession(principalId, memberRoot, {
        options,
        personalJobs: surface.personalJobs,
        ownerPolicyProvider,
        ownerDeniedPaths,
        registeredMemberIds: () => principals.listMembers().map((row) => row.principalId),
        database,
        rawStore: sourceStore,
        surface,
        turnChain: sessions.turnChain(principalId),
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
    for (const member of activeMembers)
      if (!surface.memberRecords.isBlocked(member.principalId)) prepareMember(member.principalId);
    const executionAccess = (principalId: string, sessionKey?: string) =>
      principalId === options.ownerPrincipalId
        ? access
        : resolvePrincipalAccess(principalId, {
            adapter: database.adapter,
            ownerAccess: access,
            agentId: `member-agent:${principalId}`,
            sessionKey,
            commonChannelId: options.commonChannelId,
          });
    const socketDispatch: ActionDispatcher = Object.assign(
      async (...[call, context]: Parameters<ActionDispatcher>) => {
        context = {
          ...context,
          access: executionAccess(
            context.access.principalId,
            members.get(context.access.principalId)?.activeSessionKey()
          ),
        };
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
          ...members.get(callerAccess.principalId)?.activeSessionFacts(),
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
        deliverHost: surface.deliverManagement,
        prepareNative: async (row) => {
          const payload = row.payload as
            | {
                text?: string;
                input?: OwnerMessageInput['payload'];
                senderPrincipalId?: string;
                deferredMemberMessage?: boolean;
                roomChannel?: string;
              }
            | undefined;
          if (row.kind === 'owner_message' && payload?.deferredMemberMessage) {
            if (!intakeRuntime.servesPrincipal(row.principalId))
              await serveMemberOnLane(row.principalId);
            // A room message belongs to its room session's common archive, never to the
            // member's personal records.
            const room = payload.roomChannel;
            const archive = memberChat(row.principalId, room);
            const existing = database.adapter
              .prepare(
                "SELECT current_observation_id, metadata_json FROM connector_event_index WHERE source_connector='chat' AND source_id=? AND memory_scope_id=?"
              )
              .get(
                row.stimulusId,
                room === undefined ? row.principalId : options.ownerPrincipalId
              ) as { current_observation_id: string; metadata_json: string } | undefined;
            let observation: string;
            let input = payload.input;
            if (existing) {
              observation = existing.current_observation_id;
              input = JSON.parse(existing.metadata_json).input ?? undefined;
            } else {
              let message: OwnerMessageInput = {
                id: row.stimulusId,
                channelKey: row.channelKey,
                occurredAt: row.occurredAt,
                text: payload.text ?? '',
                replyTo: row.replyTo,
                ...(payload.input === undefined ? {} : { payload: payload.input }),
                ...(payload.senderPrincipalId === undefined
                  ? {}
                  : { senderPrincipalId: payload.senderPrincipalId }),
              };
              if (
                message.payload &&
                typeof message.payload === 'object' &&
                !Array.isArray(message.payload) &&
                'pendingTelegramMessage' in message.payload
              ) {
                if (!options.prepareDeferredMemberInput)
                  throw new Error('Deferred Telegram input requires its gateway preparer');
                message = await options.prepareDeferredMemberInput(row.principalId, message);
              }
              observation = archive.saveOwnerMessage(message);
              input = message.payload;
            }
            intakeRuntime.mailbox!.bindInputObservation(row.id, row.stimulusId, observation);
            for (const ref of row.refs)
              if (ref.refId === row.stimulusId) ref.observationRef = observation;
            // The immutable accepted payload remains the dedupe identity. Native delivery sees
            // the stored projection's prepared attachments rather than downloading them again.
            row.payload = { ...payload, ...(input === undefined ? {} : { input }) };
          }

          if (personalNoticePayload(row)) {
            if (principals.findById(row.principalId)?.status !== 'active')
              throw new StimulusQuarantine('Personal notice person is no longer active');
            // Core calls this port before native admission, including scheduled inputs.
            // Serve-on-demand may wait here, in this recipient's delivery, never in the common
            // action. The one durable notice remains claimed without a native dispatch meanwhile.
            try {
              if (!intakeRuntime.servesPrincipal(row.principalId))
                await serveMemberOnLane(row.principalId);
            } catch (error) {
              // Suspend/offboard can finish while service waits for the directory lane.
              // That lifecycle cancellation is final; an active person's preparation error retries.
              if (principals.findById(row.principalId)?.status !== 'active')
                throw new StimulusQuarantine('Personal notice person is no longer active');
              throw error;
            }
          }
        },
        hostReady: () => !stopping,
        excludePrincipals: surface.memberRecords.excludePrincipals,
        onSettled: surface.memberRecords.onSettled,
        onDead: (row, reason) => {
          surface.onManagementDead(row, reason);
          surface.memberRecords.onDead(row, reason);
          return sessions.delivery.onDead?.(row, reason);
        },
        onUncertain: (row, reason) => {
          surface.memberRecords.onUncertain(row, reason);
          return sessions.delivery.onUncertain?.(row, reason);
        },
        ready: () => !stopping && (options.deliveryReady?.() ?? true),
      },
      reclaimStaleSocket: true,
    });
    ownerMailbox = intakeRuntime.mailbox;
    recordOrders.recover();
    // Recovered host inputs need no new Telegram update to run.
    void intakeRuntime
      .drainOnce()
      .catch((error) => console.error('[Member management] recovery failed', error));
    const intake = createStimulusIntake(intakeRuntime, options.ownerPrincipalId, chat);
    const createMemberIntake = (
      id: string,
      member?: ReturnType<typeof createMemberSession>,
      room?: string
    ) => {
      const archive = member?.chat ?? memberChat(id, room);
      // A room intake made while the member was retired stays a room intake after the erasure
      // ends: its message runs in the room session and is kept in the room's common archive.
      const direct = createStimulusIntake(
        intakeRuntime,
        id,
        {
          saveOwnerMessage: (input) => {
            executionAccess(id);
            if (!intakeRuntime.servesPrincipal(id))
              throw new Error(`Member session is not served: ${id}`);
            return archive.saveOwnerMessage(input);
          },
          saveReply: (input) => archive.saveReply(input),
          hasOwnerMessage: (ref) => archive.hasOwnerMessage(ref),
        },
        room
      );
      const deferred = () =>
        surface.memberRecords.isBlocked(id) && !intakeRuntime.servesPrincipal(id);
      return {
        ...direct,
        deferIncoming: deferred,
        acceptOwnerMessage: (input: OwnerMessageInput) => {
          if (stopping) throw new Error('Runtime is stopping');
          if (!deferred()) return direct.acceptOwnerMessage(input);
          executionAccess(id);
          // New work received after retirement is durable, but creates no personal projection
          // while an idempotent erasure is finishing its already exported snapshot.
          const rowId = intakeRuntime.mailbox!.enqueue({
            id: input.id,
            kind: 'owner_message',
            principalId: id,
            channelKey: input.channelKey,
            occurredAt: input.occurredAt,
            refs: [{ refId: input.id, observationRef: null }],
            replyTo: input.replyTo,
            payload: {
              text: input.text,
              deferredMemberMessage: true,
              // A room message waits with its room, so it runs in that room session.
              ...(room === undefined ? {} : { roomChannel: room }),
              ...(input.payload === undefined ? {} : { input: input.payload }),
              ...(input.senderPrincipalId === undefined
                ? {}
                : { senderPrincipalId: input.senderPrincipalId }),
            },
          });
          return {
            inputId: rowId === null ? null : String(rowId),
            state: rowId === null ? ('duplicate' as const) : ('accepted' as const),
          };
        },
      };
    };
    for (const [id, member] of members) memberIntakes.set(id, createMemberIntake(id, member));
    const retireMember = async (id: string, setAside = true) => {
      if (memberRoot === undefined) throw new Error('Member lifecycle requires member_root');
      surface.releasePrincipal(id);
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
    // Gateway DMs and personal jobs serve active unserved members through the directory lane. A
    // served intake needs no directory work; P9 restores its own known paths on the member chain.
    const serveMemberOnLane = (id: string): Promise<StimulusIntake> => {
      executionAccess(id);
      if (stopping) return Promise.reject(new Error('Cannot serve a member after runtime stop'));
      if (surface.memberRecords.isBlocked(id) && !intakeRuntime.servesPrincipal(id))
        return Promise.resolve(createMemberIntake(id));
      if (intakeRuntime.servesPrincipal(id)) return Promise.resolve(memberIntakes.get(id)!);
      return sessions.exclusive(async () => {
        if (stopping) throw new Error('Cannot serve a member after runtime stop');
        if (surface.memberRecords.isBlocked(id) && !intakeRuntime.servesPrincipal(id))
          return createMemberIntake(id);
        return serveMember(id);
      });
    };
    const personalJobs = createPersonalJobScheduler({
      adapter: database.adapter,
      store: surface.personalJobs,
      mailbox: intakeRuntime.mailbox!,
      intake: serveMemberOnLane,
      blocked: surface.memberRecords.isBlocked,
      onError: (error) => options.onPersonalJobError?.(error),
    });
    let schedulerStop: Promise<void> | undefined;
    const beginStop = () => {
      if (stopping) return;
      stopping = true;
      schedulerStop = personalJobs.stop();
      recordOrders.stop();
      surface.memberRecords.stopRecovery();
      intakeRuntime.beginStop();
    };
    let drainPromise: Promise<void> | undefined;
    const drain = () =>
      (drainPromise ??= (async () => {
        beginStop();
        await intakeRuntime.stop();
        await schedulerStop;
        await surface.memberRecords.idle();
        await sessions.idle();
      })());
    surface.memberRecords.startRecovery();
    return {
      personalJobs,
      runtime: intakeRuntime,
      database,
      knowledge,
      surface,
      reportStore,
      reportSseClients,
      wikiRoot,
      intake,
      acceptSourceDelta: intake.acceptSourceDelta,
      serveMember: serveMemberOnLane,
      memberIntake: (id, room) => {
        // Erasure owns restoration once it unserves the member. Intake callers must not
        // recreate a writer while the host takes and delivers that member's snapshot.
        if (surface.memberRecords.isBlocked(id) && !intakeRuntime.servesPrincipal(id))
          return createMemberIntake(id, undefined, room);
        if (stopped) throw new Error('Cannot obtain member intake after runtime stop');
        executionAccess(id);
        const intake = memberIntakes.get(id);
        if (!intake || !intakeRuntime.servesPrincipal(id))
          throw new Error(`Member session is not served: ${id}`);
        if (room === undefined) return intake;
        const session = members.get(id)!.roomSession(room);
        return createStimulusIntake(
          intakeRuntime,
          id,
          {
            saveOwnerMessage: (input) => {
              executionAccess(id, session.native.sessionKey);
              return session.chat.saveOwnerMessage(input);
            },
            saveReply: (input) => session.chat.saveReply(input),
            hasOwnerMessage: (ref) => session.chat.hasOwnerMessage(ref),
          },
          room
        );
      },
      principalPaths: (principalId, room) => {
        if (principalId === options.ownerPrincipalId) {
          const downloadsDir = options.attachmentPorts?.downloadsDir;
          if (!downloadsDir?.trim()) throw new Error('Owner downloads directory is required');
          return {
            workspaceDir: options.workspaceDir,
            downloadsDir,
          };
        }
        executionAccess(principalId);
        sessions.get(principalId);
        const member = members.get(principalId)!;
        return room === undefined ? member.paths : member.roomSession(room).paths;
      },
      completeMemberEnrollment: (selection) => {
        if (stopping) return Promise.reject(new Error('Cannot enroll a member after runtime stop'));
        return surface.completeMemberEnrollment(selection);
      },
      recordHostExchange: ({ message, reply }) => {
        const person = message.id.startsWith('telegram:')
          ? principals.resolveByExternal('telegram', 'private', message.channelKey)
          : null;
        if (person?.kind !== 'member') {
          chat.saveOwnerMessage({
            ...message,
            ...(person ? { senderPrincipalId: person.principalId } : {}),
          });
          chat.saveReply({ ...reply, messageRef: message.id, author: 'host' });
        } else {
          // A member being erased gets its personal copy after the erasure, never inside it.
          if (!surface.memberRecords.deferWhileErasing(person.principalId, { message, reply }))
            writeMemberHostExchange(person.principalId, { message, reply });
          const ref = `host:management:${message.id}`;
          chat.saveOwnerMessage({
            ...message,
            id: ref,
            channelKey: 'management',
            senderPrincipalId: person.principalId,
          });
          chat.saveReply({ ...reply, messageRef: ref, author: 'host' });
        }
      },
      turnRunning: (target) => sessionPool.peekSession(conversationKey(target)).busy,
      startOver: async (target) => {
        if (stopping) throw new Error('Cannot start a conversation over after runtime stop');
        const principalId =
          target.kind === 'member' ? target.principalId : options.ownerPrincipalId;
        if (target.kind === 'member') {
          await serveMemberOnLane(principalId);
          // An erasure retired this member's sessions, resetting them; it serves them anew when
          // it ends, so their next message already starts over.
          if (!intakeRuntime.servesPrincipal(principalId)) return 'started_over';
        }
        // An input this person sent before /new would otherwise run in the new conversation,
        // and the next message would carry it on.
        const inputsWaiting = () => hasWaitingInput(database.adapter, principalId, Date.now());
        const chain = sessions.turnChain(principalId);
        if (chain.isBusy() || inputsWaiting()) return 'busy';
        // On the principal's chain no turn of theirs starts while the session is reset. A member's
        // conversations share that chain, so their DM reset reaches the rooms it resets as well.
        return chain.afterCurrent(async () => {
          if (inputsWaiting()) return 'busy';
          // The principal sessions always route a reset to the session that owns the key.
          await sessions.native.resetSession!(conversationKey(target));
          // A member's DM reset reaches the rooms open in this process. A room kept on disk from
          // before a restart (a Codex thread) would resume its old context, so it starts over too.
          if (target.kind === 'member' && target.room === undefined && memberRoot !== undefined) {
            const rooms = memberRoomsRoot(memberPaths(memberRoot, principalId).runtimeRoot);
            for (const channel of options.roomChannels ?? [])
              if (existsSync(join(rooms, roomDirectory(channel))))
                await sessions.native.resetSession!(memberRoomSessionKey(principalId, channel));
          }
          return 'started_over';
        });
      },
      stop: () => {
        if (stopPromise) return stopPromise;
        beginStop();
        stopPromise = (async () => {
          await drain();
          stopped = true;
          rawStore?.close();
          await database.close();
        })();
        return stopPromise;
      },
      beginStop,
      drain,
    };
  } catch (error) {
    await sessions.native.stop();
    rawStore?.close();
    await database.close();
    throw error;
  }
}
