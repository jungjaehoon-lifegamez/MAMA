import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import { memberNoticeRegistrations, type MemberNoticePorts } from '../api/member-notice-actions.js';
import {
  createPersonalNoticeStore,
  type NoticeRef,
  type PersonalNoticeStore,
} from './personal-notices.js';
import { documentActionRegistrations, type DocumentActionPorts } from '../api/document-actions.js';
import { StimulusQuarantine } from '@jungjaehoon/mama-core/runtime/runtime';
import { createPersonalJobStore, type PersonalJobStore } from './personal-jobs.js';
import { personalJobRegistrations, PERSONAL_JOB_ACTIONS } from '../api/personal-job-actions.js';
import {
  createMemberEnrollment,
  type MemberEnrollmentPorts,
  type MemberSelection,
} from '../api/member-enrollment.js';
import {
  memberLifecycleRegistrations,
  MEMBER_MANAGEMENT_ACTIONS,
  type MemberLifecyclePorts,
  type MemberManagementContext,
} from '../api/member-lifecycle.js';
import { createMemberRecords, type MemberRecordsPorts } from '../api/member-records.js';
import { traceSummary } from '@jungjaehoon/mama-core/runtime/trace-summary';
import { createNativeToolTraceObserver } from '@jungjaehoon/mama-core/runtime/native-tool-trace-observer';
import type { OutboundAttemptEvent } from '../api/security-events.js';
import { withOutboundAttempts } from './outbound-attempts.js';
import {
  appendOperationToolTrace,
  appendToolTrace,
  coreActionRegistrations,
  createCatalog,
  createDispatcher,
  createPrincipalRepository,
  isErasedRecord,
  type ActionContext,
  type ActionContract,
  type ActionDispatcher,
  type DispatcherOptions,
} from '@jungjaehoon/mama-core';
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import type { JudgmentAccess, Knowledge } from '@jungjaehoon/mama-core/knowledge';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core/memory/types';
import { reportActionRegistrations } from '../api/report-actions.js';
import { createReportPublisher, type ReportStore } from '../api/report-handler.js';
import {
  createAttachmentActionRegistrations,
  type AttachmentActionPorts,
} from '../api/attachment-actions.js';
import { sourceActionRegistrations } from '../api/source-actions.js';
import { ownerTimeZoneActionRegistrations } from '../api/owner-timezone-actions.js';
import { ownerPolicyActionRegistrations } from '../api/owner-policy-actions.js';
import { actionCatalogLine, helpActionRegistrations } from '../api/help-actions.js';
import { CODE_ACT_CONTRACT, codeActRegistration } from '../api/code-act-actions.js';
import {
  activeOwnerMessageCaller,
  guardOwnerRules,
  holdsOwnerRole,
  messageTurnCaller,
} from './owner-authority.js';
import { workNoUpdateActionRegistrations } from '../api/record-actions.js';
import { judgeActionRegistrations, type JudgePorts } from '../api/judge-actions.js';
import {
  ownerMessageActionRegistrations,
  type OwnerMessagePorts,
} from '../api/owner-message-actions.js';
import type { TimeZoneSetting } from './timezone.js';
import { reportSourceActionRegistrations } from '../api/report-source-actions.js';
import { trelloActionRegistrations } from '../api/trello-actions.js';
import { driveActionRegistrations } from '../api/drive-actions.js';
import {
  driveDeliveryActionRegistrations,
  type DriveDeliveryPorts,
} from '../api/drive-delivery.js';
import {
  minimalWorkActionRegistrations,
  workListActionRegistrations,
} from '../api/work-actions.js';
import type { StoredSourceReader } from '../api/stored-source-reader.js';
import { wikiActionRegistrations, type WikiPorts } from '../api/wiki-actions.js';
import type { BoardSlots } from '../operator/board-read-views.js';
import { LOADABLE_CONNECTORS as OWNER_CONNECTORS } from '../connectors/index.js';
import {
  guardMemberSharedRecords,
  memberShareActionRegistrations,
} from '../api/member-share-actions.js';

const OWNER_ACTIONS = [
  'member.directory',
  'member.notice',
  'document.render',
  'code_act',
  'graph.query',
  'source.search',
  'source.recent',
  'schedule.upcoming',
  'source.read',
  'trello.read',
  'drive.read',
  'drive.download',
  'judge',
  'owner.timezone.set',
  ...MEMBER_MANAGEMENT_ACTIONS,
  'manage.member.enroll',
  'owner.messages',
  'memory.checkpoint.list',
  'memory.checkpoint.save',
  'work.create',
  'work.revise',
  'work.link',
  'work.list',
  'work.show',
  'work.no_update',
  'help',
  'memory.save',
  'memory.search',
  'memory.read:provenance',
  'memory.read:record',
  'memory.read:timeline',
  'memory.retire',
  'report.read',
  'report.publish',
  'manage.wiki.move',
  'manage.policy.read',
  'manage.policy.update',
  'manage.wiki.publish',
  'manage.wiki.read',
  'manage.wiki.update',
  'source.attachment.list',
  'source.attachment.download',
  'deliver.telegram.file',
  'deliver.discord.file',
  'deliver.slack.file',
  'deliver.drive.file',
] as const;

/** The member role: Telegram file delivery honours the caller's DM. Exact catalog names only. */
export const MEMBER_ACTIONS = [
  'document.render',
  ...PERSONAL_JOB_ACTIONS,
  'graph.query',
  'work.list',
  'work.show',
  'memory.search',
  'memory.read:provenance',
  'memory.read:record',
  'memory.read:timeline',
  'source.search',
  'source.read',
  'source.recent',
  'source.attachment.list',
  'source.attachment.download',
  'deliver.telegram.file',
  'trello.read',
  'schedule.upcoming',
  'judge',
  'memory.save',
  'memory.share',
  'records.export',
  'records.erase',
  'memory.retire',
  'memory.checkpoint.list',
  'memory.checkpoint.save',
  'help',
  'code_act',
] as const;

export interface HostToolDefinition {
  name: string;
  description: string;
  inputSchema: ActionContract['inputSchema'];
}

export interface ActionSurfaceOptions {
  runtimeRoot: string;
  adapter: DatabaseInstance;
  /** Native shell commands that open a network connection, reported as they start (W35). */
  outboundAttempts?: (event: OutboundAttemptEvent) => void;
  knowledge: Knowledge;
  ownerPrincipalId: string;
  agentId: string;
  scopes?: readonly MemoryScopeRef[];
  connectors?: readonly string[];
  storedSourceReader?: StoredSourceReader | null;
  reportStore?: ReportStore | null;
  reportSseClients?: Set<ServerResponse>;
  wikiPorts?: WikiPorts;
  attachmentPorts?: AttachmentActionPorts;
  documentPorts?: Omit<DocumentActionPorts, 'ownerPrincipalId'>;
  /** Large-file delivery to the owner's Drive folder; absent unless delivery.drive is configured. */
  driveDelivery?: Omit<DriveDeliveryPorts, 'ownerPrincipalId'>;
  /** Jev, the agent's filter for candidates it should not read whole; absent unless enabled. */
  judge?: JudgePorts;
  /** The owner conversation by time span; absent where no owner mailbox exists. */
  ownerMessages?: OwnerMessagePorts;
  /** The procedures help({topic}) returns, read when a turn needs one. */
  helpTopics?: Readonly<Record<string, string>>;
  timeZone: TimeZoneSetting;
  configPath: string;
  isOwnerMessageTurn: (sourceMessageRef: string, principalId: string) => boolean;
  memberRecords?: MemberRecordsPorts;
  memberEnrollment?: MemberEnrollmentPorts;
  memberLifecycle?: MemberLifecyclePorts;
  memberNotices?: MemberNoticePorts;
  memberDirectoryChange?: <T>(work: () => Promise<T>) => Promise<T>;
  recordManagementReceipt?(receipt: {
    callerPrincipalId?: string;
    operationId: string;
    action: string;
    input: unknown;
    result: Awaited<ReturnType<ActionDispatcher>>;
  }): void;
}

export interface ActionSurface {
  personalNotices: PersonalNoticeStore;
  readNoticeRef(ref: NoticeRef, access: JudgmentAccess): Promise<boolean>;
  personalJobs: PersonalJobStore;
  memberRecords: ReturnType<typeof createMemberRecords>;
  releasePrincipal(principalId: string): void;
  deliverManagement(row: MailboxRow): Promise<'handled' | 'deferred' | 'unhandled'>;
  onManagementDead(row: MailboxRow, reason: string): void;
  completeMemberEnrollment(selection: MemberSelection): ReturnType<ActionDispatcher>;
  createNativeEffectObserver(
    modelRunId: string,
    access?: JudgmentAccess
  ): ReturnType<typeof createNativeToolTraceObserver>;
  catalog: ReturnType<typeof createCatalog>;
  dispatch: ActionDispatcher;
  ownerAccess: JudgmentAccess;
  hostToolDefinitions(access?: JudgmentAccess): HostToolDefinition[];
  hostToolCall(
    name: string,
    input: unknown,
    operationId: string,
    context?: Omit<ActionContext, 'access' | 'operationId'> & { access?: JudgmentAccess }
  ): Promise<Awaited<ReturnType<ActionDispatcher>>>;
}

/** The owner grant spans the durable global/user records and connector roots. */
export function ownerMemoryScopes(
  ownerPrincipalId: string,
  connectors: readonly string[] = OWNER_CONNECTORS
): MemoryScopeRef[] {
  const scopes: MemoryScopeRef[] = [
    { kind: 'global', id: 'system' },
    { kind: 'user', id: ownerPrincipalId },
  ];
  for (const connector of connectors) {
    scopes.push({ kind: 'channel', id: connector }, { kind: 'project', id: connector });
  }
  return [...new Map(scopes.map((scope) => [`${scope.kind}\0${scope.id}`, scope])).values()];
}

export function createActionSurface(options: ActionSurfaceOptions): ActionSurface {
  let principals: ReturnType<typeof createPrincipalRepository> | undefined;
  const memberDirectoryChange = options.memberDirectoryChange;
  const memberRecords = createMemberRecords({
    adapter: options.adapter,
    isMessageTurn: options.isOwnerMessageTurn,
    ports: options.memberRecords,
  });
  const enrollment = createMemberEnrollment({
    adapter: options.adapter,
    ownerPrincipalId: options.ownerPrincipalId,
    isOwnerMessageTurn: options.isOwnerMessageTurn,
    ownerAccess: () => ownerAccess,
    ports: options.memberEnrollment,
    directoryChange: memberDirectoryChange,
  });
  const defaultScopes = ownerMemoryScopes(
    options.ownerPrincipalId,
    options.connectors ?? OWNER_CONNECTORS
  );
  const core = coreActionRegistrations(options.knowledge, options.adapter, {
    // The owner's checkpoint saves stay unscoped. A member's hand-off is personal,
    // irrespective of its shared read grants.
    checkpointScopes: (access) =>
      access.principalId === options.ownerPrincipalId
        ? undefined
        : [{ kind: 'user', id: access.principalId }],
    checkpointReadOptions: (access) =>
      access.principalId === options.ownerPrincipalId
        ? { scopes: [...access.scopes, ...(access.readScopes ?? [])], includeUnbound: true }
        : { scopes: [{ kind: 'user', id: access.principalId }] },
    ...(options.storedSourceReader === undefined || options.storedSourceReader === null
      ? {}
      : {
          readObservationBody: (ref, context) => {
            try {
              const { content } = options.storedSourceReader!.readObservation(
                ref,
                context.access,
                context.readAllowance
              );
              // An empty excerpt would read as evidence that says nothing.
              if (typeof content !== 'string')
                throw new Error(`Stored observation ${ref} has no readable body`);
              return content;
            } catch (error) {
              // The reader throws the raw store's reason; a missing version is distinct from an
              // integrity or access failure.
              if (error instanceof Error && error.message === 'VERSION_NOT_FOUND')
                return { status: 'body_unavailable' as const };
              throw error;
            }
          },
        }),
  })
    .filter(({ contract }) =>
      [
        'graph.query',
        'memory.save',
        'memory.search',
        // The cited source messages behind a memory, checked against the caller's source-read
        // authority: a fact found by memory.search is traced to its evidence in one call.
        'memory.read:provenance',
        'memory.read:record',
        // What was written when: the owner looks back over what was saved, in chat or the viewer.
        'memory.read:timeline',
        'memory.retire',
        'memory.checkpoint.list',
        // The agent's hand-off for a later session, shown in its [session_start] as Kagemusha's is.
        'memory.checkpoint.save',
        'work.show',
      ].includes(contract.name)
    )
    // Only an owner-chat turn changes an owner rule (owner-authority.ts); a member's own chat
    // changes only its own records (member-share-actions.ts).
    .map((registration) =>
      registration.contract.name === 'memory.save' || registration.contract.name === 'memory.retire'
        ? guardMemberSharedRecords(
            guardOwnerRules(registration, options.adapter, options.ownerPrincipalId),
            options.adapter,
            options.ownerPrincipalId
          )
        : registration
    );
  const reportSseClients = options.reportSseClients ?? new Set<ServerResponse>();
  const reportPorts = {
    ...(options.reportStore === undefined || options.reportStore === null
      ? {}
      : {
          publisher: createReportPublisher(options.reportStore, reportSseClients),
          reader: (): BoardSlots => {
            const slots: BoardSlots = {};
            for (const [name, slot] of Object.entries(options.reportStore!.getAll())) {
              slots[name] = {
                html: slot.html,
                publishable: options.reportStore!.isPublishable(name),
                updatedAt: Number.isFinite(slot.updatedAt)
                  ? new Date(slot.updatedAt).toISOString()
                  : null,
              };
            }
            return slots;
          },
        }),
  };
  const lifecycle = memberLifecycleRegistrations({
    adapter: options.adapter,
    ownerPrincipalId: options.ownerPrincipalId,
    ownerAccess: () => ownerAccess,
    isOwnerMessageTurn: options.isOwnerMessageTurn,
    timeZone: options.timeZone,
    ports: options.memberLifecycle,
    scheduleChange: async (name, input, context) => {
      const ports = options.memberLifecycle!;
      const { principalId } = input as { principalId: string };
      const earlier = context.operationId
        ? ports.mailbox().readInput(`member-management:${context.operationId}`, principalId)
        : null;
      if (earlier)
        return {
          principalId,
          change: name.slice('manage.member.'.length),
          status: 'scheduled',
          commandId: earlier.stimulusId,
        };
      // ACKed rows age out before their accepted identities. Do not turn their replay into
      // an immediate change, or reject a resume whose activation already succeeded.
      if (
        context.operationId &&
        options.adapter
          .prepare('SELECT 1 FROM mailbox_seen WHERE ref_id=?')
          .get(`member-management:${context.operationId}`)
      )
        return {
          principalId,
          change: name.slice('manage.member.'.length),
          status: 'duplicate',
          commandId: `member-management:${context.operationId}`,
        };
      const chain = ports.turnChain(principalId);
      const pendingHost =
        options.adapter
          .prepare(
            "SELECT 1 FROM mailbox_inputs WHERE principal_id=? AND kind='host_job' AND status IN ('pending','claimed') LIMIT 1"
          )
          .get(principalId) !== undefined;
      // A new resume needs a suspended target, unless an earlier queued change still owns it.
      // Executing the retained command later may instead find the target already activated.
      if (name === 'manage.member.resume' && !pendingHost) {
        const principal = createPrincipalRepository(options.adapter).findById(principalId);
        if (principal?.status !== 'suspended')
          throw new Error(`Cannot resume a ${principal?.status} member`);
      }
      const changesDirectory = [
        'manage.member.suspend',
        'manage.member.resume',
        'manage.member.offboard',
      ].includes(name);
      if (!changesDirectory && !chain.isBusy() && !pendingHost)
        return chain.afterCurrent(async () =>
          lifecycle
            .find((registration) => registration.contract.name === name)!
            .exec(input, { ...context, memberManagementQueued: true } as MemberManagementContext)
        );

      if (!context.operationId) throw new Error('Member management requires an operation id');
      const commandId = `member-management:${context.operationId}`;
      const rowId = ports.mailbox().enqueue({
        id: commandId,
        kind: 'host_job',
        principalId,
        channelKey: 'member-management',
        occurredAt: Date.now(),
        payload: JSON.parse(
          JSON.stringify({
            action: name,
            input,
            callerPrincipalId: activeOwnerMessageCaller(context, options),
          })
        ),
      });
      if (rowId !== null) ports.resumeQueued();
      return {
        principalId,
        change: name.slice('manage.member.'.length),
        status: rowId === null ? 'duplicate' : 'scheduled',
        commandId,
      };
    },
  });
  const codeAct = codeActRegistration(() => dispatch);
  const personalJobs = createPersonalJobStore(options.adapter, options.timeZone);
  const personalNotices = createPersonalNoticeStore(options.adapter);
  const readNoticeRef = async (ref: NoticeRef, access: JudgmentAccess): Promise<boolean> => {
    const result = await dispatch(
      { action: 'observationRef' in ref ? 'source.read' : 'memory.read:record', input: ref },
      { access }
    );
    if (result.status !== 'completed') {
      if (
        result.error.kind === 'denied' ||
        ['stored_source_out_of_scope', 'stored_source_not_found'].includes(result.error.code)
      )
        return false;
      throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), {
        name: result.error.code,
      });
    }
    if ('observationRef' in ref) return true;
    const record = (result.data as { record: object | null }).record;
    return record !== null && !isErasedRecord(record);
  };
  const registrations = [
    ...memberNoticeRegistrations({
      adapter: options.adapter,
      ownerPrincipalId: options.ownerPrincipalId,
      ownerAccess: () => ownerAccess,
      timeZone: options.timeZone,
      notices: options.memberNotices,
      read: readNoticeRef,
    }),
    ...documentActionRegistrations({
      ...options.documentPorts,
      ownerPrincipalId: options.ownerPrincipalId,
    }),
    ...personalJobRegistrations(personalJobs, options),
    ...core,
    ...lifecycle,
    ...memberRecords.registrations,
    ...memberShareActionRegistrations({
      adapter: options.adapter,
      ownerPrincipalId: options.ownerPrincipalId,
      ownerDefaultScopes: defaultScopes,
      isOwnerMessageTurn: options.isOwnerMessageTurn,
    }),
    ...sourceActionRegistrations({
      stored: options.storedSourceReader,
      timeZone: options.timeZone,
    }),
    ...reportSourceActionRegistrations({
      adapter: options.adapter,
      timeZone: options.timeZone,
    }),
    enrollment.registration,
    ...ownerTimeZoneActionRegistrations({
      configPath: options.configPath,
      ownerPrincipalId: options.ownerPrincipalId,
      setting: options.timeZone,
      adapter: options.adapter,
      isOwnerMessageTurn: options.isOwnerMessageTurn,
    }),
    ...ownerPolicyActionRegistrations({
      runtimeRoot: options.runtimeRoot,
      adapter: options.adapter,
      ownerPrincipalId: options.ownerPrincipalId,
    }),
    ...createAttachmentActionRegistrations(
      {
        ...(options.attachmentPorts ?? {}),
        stored: options.storedSourceReader,
      },
      options.ownerPrincipalId
    ),
    // trello.read reaches the live connector through the same registry port as attachments.
    ...trelloActionRegistrations({
      ...(options.attachmentPorts?.connectors === undefined
        ? {}
        : { connectors: options.attachmentPorts.connectors }),
      adapter: options.adapter,
      ownerPrincipalId: options.ownerPrincipalId,
    }),
    // Drive has no running connector (its poller stays off), so drive.* call gws directly.
    ...driveActionRegistrations({
      adapter: options.adapter,
      ownerPrincipalId: options.ownerPrincipalId,
      ...(options.attachmentPorts?.downloadsDir === undefined
        ? {}
        : { downloadsDir: options.attachmentPorts.downloadsDir }),
    }),
    ...(options.driveDelivery === undefined
      ? []
      : driveDeliveryActionRegistrations({
          ...options.driveDelivery,
          ownerPrincipalId: options.ownerPrincipalId,
        })),
    ...workListActionRegistrations({ knowledge: options.knowledge, timeZone: options.timeZone }),
    ...minimalWorkActionRegistrations({
      knowledge: options.knowledge,
      observationExists: (observationId) =>
        options.adapter
          .prepare('SELECT 1 FROM observation_versions WHERE observation_id = ? LIMIT 1')
          .get(observationId) !== undefined,
    }),
    ...reportActionRegistrations(reportPorts),
    ...wikiActionRegistrations(options.wikiPorts ?? {}),
    ...workNoUpdateActionRegistrations(),
    ...(options.judge === undefined ? [] : judgeActionRegistrations(options.judge)),
    ...(options.ownerMessages === undefined
      ? []
      : ownerMessageActionRegistrations(options.ownerMessages)),
    ...helpActionRegistrations({
      topics: (access) =>
        access.principalId === options.ownerPrincipalId ||
        holdsOwnerRole(
          (principals ??= createPrincipalRepository(options.adapter)),
          access.principalId
        )
          ? (options.helpTopics ?? {})
          : {},
      contracts: () =>
        catalog.list().filter((contract) => contract.name !== CODE_ACT_CONTRACT.name),
    }),
    // Claude calls every action from inside code_act, as Kagemusha's code_act; the inner calls go
    // through the dispatcher below, so each is granted and traced as the caller's.
    codeAct,
  ];
  const catalog = createCatalog(registrations);
  const observeCall: NonNullable<DispatcherOptions['observeCall']> = async ({
    action,
    operationId,
    input,
    result,
    durationMs,
    context,
  }) => {
    const session = context.session;
    const caller = action.startsWith('manage.member.')
      ? messageTurnCaller(context, options)
      : undefined;
    if (
      action !== 'manage.member.list' &&
      caller &&
      ((context as MemberManagementContext).memberManagementQueued ||
        activeOwnerMessageCaller(context, options) === caller) &&
      !(
        result.status === 'completed' &&
        ['scheduled', 'duplicate'].includes((result.data as { status?: string })?.status ?? '')
      )
    ) {
      options.recordManagementReceipt?.({
        callerPrincipalId: caller,
        operationId: operationId ?? randomUUID(),
        action,
        input,
        result,
      });
    }
    const common = {
      tool_name: action,
      gateway_call_id: session?.gatewayCallId ?? null,
      input_summary: traceSummary(caller ? { callerPrincipalId: caller, input } : input),
      output_summary: traceSummary(result),
      execution_status: result.status,
      duration_ms: durationMs,
      ...(result.status === 'failed' ? { failure_code: result.error.code } : {}),
    };
    if (session?.modelRunId) {
      const trace = await appendToolTrace(options.adapter, {
        ...common,
        model_run_id: session.modelRunId,
      });
      return trace.trace_id;
    }
    if (!operationId) return undefined;
    const trace = appendOperationToolTrace(options.adapter, {
      ...common,
      operation_id: operationId,
      actor_principal_id: caller ?? context.access.principalId,
    });
    return trace.trace_id;
  };
  const dispatch = createDispatcher(catalog, {
    observeCall,
  });
  // Built on the first scopes read, so constructing a surface touches no table.
  const ownerAccess: JudgmentAccess = {
    principalId: options.ownerPrincipalId,
    agentId: options.agentId,
    // Keep the access object shared by runtime, native turns and viewer live after boot.
    // Every read of scopes resolves grants again; failed DB reads propagate to the caller.
    get scopes() {
      return [
        ...defaultScopes,
        ...(options.scopes ?? []),
        ...(principals ??= createPrincipalRepository(options.adapter)).listGrantedPartitions(),
      ].filter(
        (scope, index, all) =>
          all.findIndex(
            (candidate) => candidate.kind === scope.kind && candidate.id === scope.id
          ) === index
      );
    },
    defaultScopes,
    connectors: [...(options.connectors ?? OWNER_CONNECTORS), 'chat'],
    get channels() {
      const rows = options.adapter
        .prepare(
          `SELECT DISTINCT channel FROM connector_event_index
         WHERE source_connector = 'chat' AND memory_scope_kind = 'user' AND memory_scope_id = ?
           AND channel IS NOT NULL`
        )
        .all(options.ownerPrincipalId) as Array<{ channel: string }>;
      return { chat: rows.map((row) => row.channel) };
    },
    // The owner reads every channel of non-chat connectors; imported originals carry no
    // memory-scope tag, so without this their observations are invisible in the graph.
    connectorWideRead: (options.connectors ?? OWNER_CONNECTORS).filter(
      (source) => source !== 'chat'
    ),
    // The grant follows the same wiring as the registrations above.
    actions: OWNER_ACTIONS.filter((name) => {
      const messenger = /^deliver\.(telegram|discord|slack)\.file$/.exec(name)?.[1] as
        | 'telegram'
        | 'discord'
        | 'slack'
        | undefined;
      if (name === 'deliver.drive.file') return options.driveDelivery !== undefined;
      return messenger === undefined || options.attachmentPorts?.[messenger] !== undefined;
    }),
  };

  return {
    personalNotices,
    readNoticeRef,
    personalJobs,
    memberRecords,
    releasePrincipal: codeAct.releasePrincipal,
    onManagementDead: (row, reason) => {
      if (row.kind !== 'host_job' || row.channelKey !== 'member-management') return;
      if (
        options.adapter
          .prepare('SELECT 1 FROM connector_event_index WHERE source_entity_id=?')
          .get(`host:management:${row.stimulusId}:reply`)
      )
        return;
      const payload = row.payload as {
        callerPrincipalId?: unknown;
        action?: unknown;
        input?: unknown;
      } | null;
      options.recordManagementReceipt?.({
        ...(typeof payload?.callerPrincipalId === 'string'
          ? { callerPrincipalId: payload.callerPrincipalId }
          : {}),
        operationId: row.stimulusId,
        action: typeof payload?.action === 'string' ? payload.action : 'member-management',
        input: payload?.input ?? null,
        result: {
          status: 'failed',
          error: { kind: 'internal', code: 'member_management_failed', message: reason },
        },
      });
    },
    deliverManagement: async (row) => {
      if (row.kind !== 'host_job' || row.channelKey !== 'member-management') return 'unhandled';
      const ports = options.memberLifecycle;
      if (!ports) throw new StimulusQuarantine('Member management job requires lifecycle ports');
      const job = row.payload as unknown as {
        action: string;
        input: unknown;
        callerPrincipalId: string;
      };
      if (
        !job ||
        !lifecycle.some((r) => r.contract.name === job.action) ||
        typeof job.callerPrincipalId !== 'string' ||
        !job.callerPrincipalId.trim()
      )
        throw new StimulusQuarantine('Invalid member management job');
      const execute = async (): Promise<'handled' | 'deferred'> => {
        if (ports.isStopping()) return 'deferred';
        // The common receipt is also the command's durable completion marker. A replay after
        // receipt storage but before mailbox ACK must not reset or move the session again.
        const receipt = options.adapter
          .prepare('SELECT 1 FROM connector_event_index WHERE source_entity_id=?')
          .get(`host:management:${row.stimulusId}:reply`);
        if (!receipt) {
          const result = await dispatch(
            { action: job.action, input: job.input, operationId: row.stimulusId },
            {
              access: {
                principalId: job.callerPrincipalId,
                agentId: 'member-management-host',
                scopes: [],
                actions: [job.action],
              },
              operationId: row.stimulusId,
              memberManagementQueued: true,
              memberManagementCaller: job.callerPrincipalId,
            } as MemberManagementContext
          );
          // The authenticated caller id survives even if that caller erased the requesting
          // message while the target was busy; a denied change still owes its common receipt.
          if (
            !options.adapter
              .prepare('SELECT 1 FROM connector_event_index WHERE source_entity_id=?')
              .get(`host:management:${row.stimulusId}:reply`)
          )
            options.recordManagementReceipt?.({
              callerPrincipalId: job.callerPrincipalId,
              operationId: row.stimulusId,
              action: job.action,
              input: job.input,
              result,
            });
        }
        return 'handled';
      };
      let completion: Promise<'handled' | 'deferred'> = Promise.resolve('deferred');
      await ports.turnChain(row.principalId).afterCurrent(async () => {
        if (ports.isStopping()) return;
        if (
          ['manage.member.suspend', 'manage.member.resume', 'manage.member.offboard'].includes(
            job.action
          )
        ) {
          // Release this reservation before the directory lane drains all current member work.
          // Awaiting that lane here would make it wait for its own target reservation.
          completion = memberDirectoryChange!(execute);
        } else {
          completion = execute();
          await completion;
        }
      });
      return completion;
    },
    createNativeEffectObserver: (modelRunId, access = ownerAccess) => {
      const traces = createNativeToolTraceObserver(options.adapter, modelRunId);
      return options.outboundAttempts === undefined
        ? traces
        : withOutboundAttempts(traces, modelRunId, options.outboundAttempts, {
            principalId: access.principalId,
            ownerPrincipalId: options.ownerPrincipalId,
            ownerRole: holdsOwnerRole(
              (principals ??= createPrincipalRepository(options.adapter)),
              access.principalId
            ),
          });
    },
    catalog,
    dispatch,
    completeMemberEnrollment: (selection) => enrollment.complete(selection, dispatch),
    ownerAccess,
    // Progressive, as Kagemusha's code_act catalog: every turn carries one line per action with
    // its arguments; types, allowed values and examples come from `help`. The dispatcher still
    // validates each call against the action's own schema.
    // Codex calls actions from its own exec, so it is not offered code_act.
    hostToolDefinitions: (access = ownerAccess) =>
      catalog
        .list()
        .filter(
          (contract) =>
            contract.name !== CODE_ACT_CONTRACT.name && access.actions.includes(contract.name)
        )
        .map((contract) => ({
          name: contract.name,
          description: actionCatalogLine(contract),
          inputSchema: { type: 'object' },
        })),
    hostToolCall: (name, input, operationId, context = {}) =>
      dispatch(
        { action: name, input, operationId },
        { ...context, access: context.access ?? ownerAccess, operationId }
      ),
  };
}

export { OWNER_ACTIONS, OWNER_CONNECTORS };
