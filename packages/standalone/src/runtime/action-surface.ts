import { traceSummary } from '@jungjaehoon/mama-core/runtime/trace-summary';
import { createNativeToolTraceObserver } from '@jungjaehoon/mama-core/runtime/native-tool-trace-observer';
import {
  appendOperationToolTrace,
  appendToolTrace,
  coreActionRegistrations,
  createCatalog,
  createDispatcher,
  type ActionContext,
  type ActionContract,
  type ActionDispatcher,
} from '@jungjaehoon/mama-core';
import type { ServerResponse } from 'node:http';
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
import { actionCatalogLine, helpActionRegistrations } from '../api/help-actions.js';
import { CODE_ACT_CONTRACT, codeActRegistration } from '../api/code-act-actions.js';
import { guardOwnerRules } from './owner-authority.js';
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
  minimalWorkActionRegistrations,
  workListActionRegistrations,
} from '../api/work-actions.js';
import type { StoredSourceReader } from '../api/stored-source-reader.js';
import { wikiActionRegistrations, type WikiPorts } from '../api/wiki-actions.js';
import type { BoardSlots } from '../operator/board-read-views.js';
import { LOADABLE_CONNECTORS as OWNER_CONNECTORS } from '../connectors/index.js';

const OWNER_ACTIONS = [
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
  'memory.retire',
  'report.read',
  'report.publish',
  'manage.wiki.publish',
  'manage.wiki.read',
  'manage.wiki.update',
  'source.attachment.list',
  'source.attachment.download',
  'deliver.telegram.file',
  'deliver.discord.file',
  'deliver.slack.file',
] as const;

export interface HostToolDefinition {
  name: string;
  description: string;
  inputSchema: ActionContract['inputSchema'];
}

export interface ActionSurfaceOptions {
  adapter: DatabaseInstance;
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
  /** Jev, the agent's filter for candidates it should not read whole; absent unless enabled. */
  judge?: JudgePorts;
  /** The owner conversation by time span; absent where no owner mailbox exists. */
  ownerMessages?: OwnerMessagePorts;
  /** The procedures help({topic}) returns, read when a turn needs one. */
  helpTopics?: Readonly<Record<string, string>>;
  timeZone: TimeZoneSetting;
  configPath: string;
  isOwnerMessageTurn: (sourceMessageRef: string) => boolean;
}

export interface ActionSurface {
  createNativeEffectObserver(modelRunId: string): ReturnType<typeof createNativeToolTraceObserver>;
  catalog: ReturnType<typeof createCatalog>;
  dispatch: ActionDispatcher;
  ownerAccess: JudgmentAccess;
  hostToolDefinitions(): HostToolDefinition[];
  hostToolCall(
    name: string,
    input: unknown,
    operationId: string,
    context?: Omit<ActionContext, 'access' | 'operationId'>
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
  const core = coreActionRegistrations(options.knowledge, options.adapter)
    .filter(({ contract }) =>
      [
        'graph.query',
        'memory.save',
        'memory.search',
        // The cited source messages behind a memory, checked against the caller's source-read
        // authority: a fact found by memory.search is traced to its evidence in one call.
        'memory.read:provenance',
        'memory.read:record',
        'memory.retire',
        'memory.checkpoint.list',
        // The agent's hand-off for a later session, shown in its [session_start] as Kagemusha's is.
        'memory.checkpoint.save',
        'work.show',
      ].includes(contract.name)
    )
    // Only an owner-chat turn changes an owner rule (owner-authority.ts).
    .map((registration) =>
      registration.contract.name === 'memory.save' || registration.contract.name === 'memory.retire'
        ? guardOwnerRules(registration, options.adapter, options.ownerPrincipalId)
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
  const registrations = [
    ...core,
    ...sourceActionRegistrations({
      stored: options.storedSourceReader,
      timeZone: options.timeZone,
    }),
    ...reportSourceActionRegistrations({
      adapter: options.adapter,
      ownerPrincipalId: options.ownerPrincipalId,
      timeZone: options.timeZone,
    }),
    ...ownerTimeZoneActionRegistrations({
      configPath: options.configPath,
      ownerPrincipalId: options.ownerPrincipalId,
      setting: options.timeZone,
      isOwnerMessageTurn: options.isOwnerMessageTurn,
    }),
    ...createAttachmentActionRegistrations({
      ...(options.attachmentPorts ?? {}),
      stored: options.storedSourceReader,
    }),
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
      ownerPrincipalId: options.ownerPrincipalId,
      ...(options.attachmentPorts?.downloadsDir === undefined
        ? {}
        : { downloadsDir: options.attachmentPorts.downloadsDir }),
    }),
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
      topics: () => options.helpTopics ?? {},
      contracts: () =>
        catalog
          .list()
          .filter(
            (contract) =>
              contract.name !== CODE_ACT_CONTRACT.name &&
              ownerAccess.actions!.includes(contract.name)
          ),
    }),
    // Claude calls every action from inside code_act, as Kagemusha's code_act; the inner calls go
    // through the dispatcher below, so each is granted and traced as the caller's.
    codeActRegistration(() => dispatch),
  ];
  const catalog = createCatalog(registrations);
  const dispatch = createDispatcher(catalog, {
    observeCall: async ({ action, operationId, input, result, durationMs, context }) => {
      const session = context.session;
      const common = {
        tool_name: action,
        gateway_call_id: session?.gatewayCallId ?? null,
        input_summary: traceSummary(input),
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
        actor_principal_id: context.access.principalId,
      });
      return trace.trace_id;
    },
  });
  const ownerAccess: JudgmentAccess = {
    principalId: options.ownerPrincipalId,
    agentId: options.agentId,
    scopes: [
      ...ownerMemoryScopes(options.ownerPrincipalId, options.connectors ?? OWNER_CONNECTORS),
      ...(options.scopes ?? []),
    ].filter(
      (scope, index, all) =>
        all.findIndex((candidate) => candidate.kind === scope.kind && candidate.id === scope.id) ===
        index
    ),
    connectors: options.connectors ?? OWNER_CONNECTORS,
    // The owner reads every channel of its own connectors; imported originals carry no
    // memory-scope tag, so without this their observations are invisible in the graph.
    connectorWideRead: options.connectors ?? OWNER_CONNECTORS,
    actions: [...OWNER_ACTIONS],
  };

  return {
    createNativeEffectObserver: (modelRunId) =>
      createNativeToolTraceObserver(options.adapter, modelRunId),
    catalog,
    dispatch,
    ownerAccess,
    // Progressive, as Kagemusha's code_act catalog: every turn carries one line per action with
    // its arguments; types, allowed values and examples come from `help`. The dispatcher still
    // validates each call against the action's own schema.
    // Codex calls actions from its own exec, so it is not offered code_act.
    hostToolDefinitions: () =>
      catalog
        .list()
        .filter((contract) => contract.name !== CODE_ACT_CONTRACT.name)
        .map((contract) => ({
          name: contract.name,
          description: actionCatalogLine(contract),
          inputSchema: { type: 'object' },
        })),
    hostToolCall: (name, input, operationId, context = {}) =>
      dispatch(
        { action: name, input, operationId },
        { ...context, access: ownerAccess, operationId }
      ),
  };
}

export { OWNER_ACTIONS, OWNER_CONNECTORS };
