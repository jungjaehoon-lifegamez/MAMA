import { deliverPersonalJobResult, type PersonalJobStore } from './personal-jobs.js';
import { createSkillTurnContext } from './skills.js';
import { deliverPersonalNoticeResult, personalNoticePayload } from './personal-notices.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPrincipalRepository, type JudgmentAccess } from '@jungjaehoon/mama-core';
import { ChatSources } from '../storage/chat-sources.js';
import type { RawStore } from '../storage/source-archive.js';
import type { CoreDatabase } from './core-db.js';
import type { ActionSurface } from './action-surface.js';
import type { OwnerRuntimeOptions } from './owner-runtime.js';
import { runtimeModelRun, guidanceInSearchOrder, readOwnerMemoryRecords } from './owner-runtime.js';
import { createNativeSession, type NativeSession } from './native-session.js';
import { normalizeReadPaths, MEMBER_CLAUDE_TMP_PARENT } from './backend-security.js';
import {
  ensureMemberPaths,
  otherMemberReadPaths,
  memberRoomTmpRoot,
  memberRoomClaudeTmpDir,
} from './member-paths.js';
import {
  DM_OWNER_POLICY_NOTE,
  MEMBER_SYSTEM_PROMPT,
  MEMBER_ROOM_SYSTEM_PROMPT,
} from './member-system-prompt.js';
import { MEMBER_VOICE } from './turn-orders.js';
import {
  resolvePrincipalAccess,
  memberSessionKey,
  memberRoomSessionKey,
  memberRoomChannel,
} from './principal-access.js';
import { readSessionStartInput } from './session-start-context.js';
import { readableSourcesLine } from './owner-system-prompt.js';
import { storedSourceFamilies } from '../connectors/framework/stored-index-read.js';
import { createStimulusDelivery, type StimulusDeliveryOptions } from './stimulus-delivery.js';
import { holdsOwnerRole, ownerRuleIds, RULE_KINDS } from './owner-authority.js';
import type { OwnerPolicyProvider } from './owner-policy.js';
import { startMemberEgressProxy, type EgressProxy } from './egress-proxy.js';
import { retirePersonalTurnReceipt } from '../gateways/telegram-message-ledger.js';

interface MemberSession {
  native: NativeSession;
  delivery: ReturnType<typeof createStimulusDelivery>;
  chat: ChatSources;
  paths: ReturnType<typeof ensureMemberPaths>;
  access: () => JudgmentAccess;
  initialAccess: JudgmentAccess;
  roomSession: (channel: string) => MemberSession;
  activeSessionKey: () => string;
  activeSessionFacts: () => import('@jungjaehoon/mama-core').ActionContext['session'];
  activePaths: () => ReturnType<typeof ensureMemberPaths>;
  activeDeniedReadPaths: () => readonly string[];
}

/** Where a member's room sessions keep their backend state, across restarts (Codex threads). */
export function memberRoomsRoot(memberRuntimeRoot: string): string {
  return join(memberRuntimeRoot, 'rooms');
}

/** A room session's directory name under `memberRoomsRoot`; it exists from the room's first turn. */
export function roomDirectory(channel: string): string {
  return createHash('sha256').update(channel).digest('hex');
}
export function createMemberSession(
  principalId: string,
  root: string,
  ports: {
    options: OwnerRuntimeOptions;
    ownerPolicyProvider: OwnerPolicyProvider;
    ownerDeniedPaths: readonly string[];
    registeredMemberIds: () => string[];
    database: CoreDatabase;
    personalJobs: PersonalJobStore;
    rawStore: RawStore;
    surface: ActionSurface;
    turnChain: NonNullable<StimulusDeliveryOptions['turnChain']>;
    readResult: NonNullable<StimulusDeliveryOptions['readResult']>;
  },
  room?: string
): MemberSession {
  const { options, database, rawStore, surface } = ports;
  const agentId = `member-agent:${principalId}`;
  const sessionKey =
    room === undefined ? memberSessionKey(principalId) : memberRoomSessionKey(principalId, room);
  const access = (): JudgmentAccess =>
    resolvePrincipalAccess(principalId, {
      adapter: database.adapter,
      ownerAccess: surface.ownerAccess,
      agentId,
      sessionKey,
      commonChannelId: options.commonChannelId,
    });
  const initialAccess = access(); // Unknown/inactive ids fail before creating their paths.
  const personalPaths = ensureMemberPaths(root, principalId);
  const paths =
    room === undefined
      ? personalPaths
      : {
          ...ensureMemberPaths(memberRoomsRoot(personalPaths.runtimeRoot), roomDirectory(room)),
          credentialPath: personalPaths.credentialPath,
        };
  const rooms = new Map<string, ReturnType<typeof createMemberSession>>();
  const roomSession = (channel: string): ReturnType<typeof createMemberSession> => {
    if (!options.roomChannels?.includes(channel)) throw new Error('Room channel is not configured');
    let session = rooms.get(channel);
    if (!session)
      rooms.set(channel, (session = createMemberSession(principalId, root, ports, channel)));
    return session;
  };
  let activeRoom: ReturnType<typeof createMemberSession> | undefined;
  let activeRequest: Parameters<NativeSession['runTurn']>[1];
  const personalScopes = [{ kind: 'user' as const, id: principalId }];
  const principals = createPrincipalRepository(database.adapter);
  const readsOwnerRules = () => holdsOwnerRole(principals, principalId);
  const readRecords = async (readOptions: Parameters<typeof readOwnerMemoryRecords>[2]) => {
    const records = await readOwnerMemoryRecords(
      database.adapter,
      room === undefined ? personalScopes : [...access().scopes],
      readOptions
    );
    if (room === undefined && readsOwnerRules())
      records.push(
        ...(await readOwnerMemoryRecords(database.adapter, surface.ownerAccess.scopes, {
          ...readOptions,
          kind: [...RULE_KINDS],
        }))
      );
    return [...new Map(records.map((record) => [record.id, record])).values()];
  };
  const chat = new ChatSources(
    rawStore,
    database.adapter,
    room === undefined ? principalId : options.ownerPrincipalId,
    agentId
  );
  // Include future configured rooms before any of them starts. Literal path denies cannot
  // express a parent minus its own subtree; snapshot existing debris as well at room creation.
  const siblingRooms =
    room === undefined
      ? []
      : [
          ...new Set([
            ...readdirSync(join(personalPaths.runtimeRoot, 'rooms')).map((entry) =>
              join(personalPaths.runtimeRoot, 'rooms', entry)
            ),
            ...(options.roomChannels ?? []).map((channel) =>
              join(
                personalPaths.runtimeRoot,
                'rooms',
                createHash('sha256').update(channel).digest('hex')
              )
            ),
          ]),
        ].filter((path) => path !== paths.runtimeRoot);
  const siblingTemps =
    room === undefined
      ? []
      : [
          ...new Set([
            ...(existsSync(memberRoomTmpRoot(principalId))
              ? readdirSync(memberRoomTmpRoot(principalId)).map((entry) =>
                  join(memberRoomTmpRoot(principalId), entry)
                )
              : []),
            ...(options.roomChannels ?? []).map((channel) =>
              memberRoomClaudeTmpDir(principalId, channel)
            ),
          ]),
        ].filter((path) => path !== memberRoomClaudeTmpDir(principalId, room!));
  const denyPaths = () =>
    normalizeReadPaths([
      ...ports.ownerDeniedPaths,
      paths.claudeConfigDir,
      ...(room === undefined
        ? [join(personalPaths.runtimeRoot, 'rooms'), memberRoomTmpRoot(principalId)]
        : [
            ...readdirSync(personalPaths.runtimeRoot)
              .filter((entry) => entry !== 'rooms')
              .map((entry) => join(personalPaths.runtimeRoot, entry)),
            ...siblingRooms,
            MEMBER_CLAUDE_TMP_PARENT,
            ...siblingTemps,
          ]),
      ...otherMemberReadPaths(root, principalId, ports.registeredMemberIds(), room !== undefined),
    ]).sort();
  let deniedReadPaths = denyPaths();
  const roles = () =>
    principals
      .listRoles(principalId)
      .map(({ role }) => role)
      .sort();
  let sessionRoles = roles();
  let proxy: EgressProxy | undefined;
  const create = () =>
    (options.createSession ?? createNativeSession)({
      backend: options.backend,
      model: options.model,
      ...(options.sessionPool === undefined ? {} : { sessionPool: options.sessionPool }),
      toolsRoot: options.toolsRoot,
      ...paths,
      socketPath: options.socketPath,
      actionSurface: surface,
      principal: {
        principalId,
        agentId,
        sessionKey,
        systemPrompt: room === undefined ? MEMBER_SYSTEM_PROMPT : MEMBER_ROOM_SYSTEM_PROMPT,
        ...(room === undefined ? {} : { tmpDir: memberRoomClaudeTmpDir(principalId, room) }),
        ...(room === undefined ? {} : { scopeFingerprint: () => JSON.stringify(access()) }),
        roles: sessionRoles,
        prepareAccess: access,
      },
      // The host reads the common policy; the person's native tools still cannot read its file.
      // A room reads it only in the common channel, where it may change it.
      ownerPolicyProvider: () => {
        if (room !== undefined ? room !== options.commonChannelId : !readsOwnerRules())
          return { content: null, fingerprint: '', loaded: false };
        const policy = ports.ownerPolicyProvider();
        // The policy is written for the common session. A DM reads it to know how the work is
        // run; told nothing, it took the common session's duties for its own (2026-10-15).
        return room !== undefined || policy.content === null
          ? policy
          : { ...policy, content: `${DM_OWNER_POLICY_NOTE}\n\n${policy.content}` };
      },
      // Native session also denies this member's runtime and Codex credentials.
      deniedReadPaths,
      sandboxNetworkProxy: proxy,
      mcpServerPath: options.mcpServerPath,
      effort: options.effort,
      autonomousWebFetch: options.autonomousWebFetch,
      timeout: options.timeout,
      maxTurnMs: options.maxTurnMs,
      maxTurns: options.maxTurns,
      runTokenBudget: options.runTokenBudget,
      codexSandbox: options.codexSandbox,
      // Members sign in with the owner's login (2026-10-09): copy the owner's managed credential.
      codexAuthSourcePath: join(
        options.codexHome ?? join(options.runtimeRoot, '.codex'),
        'auth.json'
      ),
      modelRun: runtimeModelRun({ ...options, agentId }, database.adapter),
    });
  let current = create();
  const native: NativeSession = {
    backend: current.backend,
    sessionKey,
    get supportsNativeSubagents() {
      return current.supportsNativeSubagents;
    },
    hostToolDefinitions: () => current.hostToolDefinitions(),
    callAction: (call, caller) => (activeRoom?.native ?? current).callAction(call, caller),
    resetSession: async (key) => {
      if (room === undefined && key === sessionKey)
        for (const session of rooms.values())
          await session.native.resetSession(session.native.sessionKey);
      const channel = memberRoomChannel(principalId, key);
      await (
        room === undefined && channel !== undefined ? roomSession(channel).native : current
      ).resetSession(key);
    },
    steer: (content, target, key) => {
      const channel = memberRoomChannel(principalId, key);
      return (
        room === undefined && channel !== undefined ? roomSession(channel).native : current
      ).steer(content, target, key);
    },
    interrupt: (key) => {
      const channel = memberRoomChannel(principalId, key);
      if (room === undefined && channel !== undefined) {
        // A room that has not opened in this process runs no turn.
        return rooms.has(channel)
          ? rooms.get(channel)!.native.interrupt(key)
          : Promise.resolve(false);
      }
      return current.interrupt(key);
    },
    stop: async () => {
      try {
        await Promise.all([...rooms.values()].map((session) => session.native.stop()));
        await current.stop();
      } finally {
        await proxy?.close();
      }
    },
    runTurn: async (content, request) => {
      const channel = memberRoomChannel(principalId, request?.sessionKey);
      if (room === undefined && channel !== undefined) {
        activeRoom = roomSession(channel);
        try {
          return await activeRoom.native.runTurn(content, request);
        } finally {
          activeRoom = undefined;
        }
      }
      const next = denyPaths();
      const nextRoles = roles();
      const rolesChanged = JSON.stringify(nextRoles) !== JSON.stringify(sessionRoles);
      if (rolesChanged || JSON.stringify(next) !== JSON.stringify(deniedReadPaths)) {
        // New member paths and archives finish exclusively between member turns. Refresh
        // this session's read denies before its next process runs.
        await current.resetSession(sessionKey);
        await current.stop();
        if (rolesChanged) {
          await proxy?.close();
          proxy = undefined;
        }
        deniedReadPaths = next;
        sessionRoles = nextRoles;
        current = create();
      }
      // Bind only when the configured Claude sandbox starts executing this member. No member
      // receives the owner's endpoint; Codex's OS-level network deny has no proxy observation.
      if (
        options.backend === 'claude' &&
        options.sandboxNetworkProxy !== undefined &&
        proxy === undefined
      ) {
        proxy = await startMemberEgressProxy(principalId, sessionRoles.includes('owner'), (event) =>
          options.outboundAttempts?.(event)
        );
        await current.stop();
        current = create();
      }
      const key = request?.sessionKey ?? sessionKey;
      const stateless =
        key.startsWith(`member:${principalId}:job:`) ||
        key.startsWith(`member:${principalId}:notice:`);
      if (stateless) await current.resetSession(key); // Includes an orphan context left by a process crash.
      try {
        activeRequest = request;
        return await current.runTurn(content, request);
      } finally {
        activeRequest = undefined;
        if (stateless) await current.resetSession(key);
      }
    },
  };
  const ownDelivery = createStimulusDelivery({
    // A room holds no personal records, so the person's skill inventory stays out of it. A DM
    // is told where its readable sources live with its full inventory (the common session's
    // standing text says it), under its own grant and outside the session fingerprint, so a
    // session resumed across a deploy learns it too and new rows never rotate it.
    ...(room === undefined
      ? {
          skills: createSkillTurnContext(
            () => surface.skills.list(principalId),
            () => {
              const current = access();
              return readableSourcesLine(
                storedSourceFamilies(database.adapter, current.connectors ?? [], current)
              );
            }
          ),
        }
      : {}),
    backend: options.backend,
    timeZone: options.timeZone,
    turnChain: ports.turnChain,
    member: { principalId, sessionKey, voice: MEMBER_VOICE },
    ...(room === undefined
      ? {}
      : {
          ownerMessageSenderActive: (id: string) =>
            id === principalId && principals.findById(id)?.status === 'active',
        }),
    personalJobs: ports.personalJobs,
    personalNotices: surface.personalNotices,
    readNoticeRef: (ref) => surface.readNoticeRef(ref, access()),
    retirePersonalJobText: (key) => {
      // Receipts live in the shared ledger the gateway writes; it exists without Telegram.
      const ledger = options.messageLedger?.();
      if (!ledger) throw new Error('Personal turn receipt ledger is unavailable');
      retirePersonalTurnReceipt(ledger, key);
    },
    onScheduledResult: (row, result) => {
      const deliveryPorts = {
        access,
        chat,
        delivered: (key: string) => {
          const telegram = options.memberRecordsTelegram?.();
          if (!telegram) throw new Error('Personal turn Telegram delivery is unavailable');
          return telegram.memberTextDelivered(initialAccess, key);
        },
        send: (resolved: JudgmentAccess, text: string, key: string) => {
          const telegram = options.memberRecordsTelegram?.();
          if (!telegram) throw new Error('Personal turn Telegram delivery is unavailable');
          return telegram.sendMemberText(resolved, text, key);
        },
      };
      return personalNoticePayload(row)
        ? deliverPersonalNoticeResult(row, result, {
            ...deliveryPorts,
            store: surface.personalNotices,
            read: surface.readNoticeRef,
          })
        : deliverPersonalJobResult(row, result, { ...deliveryPorts, store: ports.personalJobs });
    },
    principalRoles: (id) => principals.listRoles(id).map(({ role }) => role),
    principalDisplayName: (id) => principals.findById(id)?.displayName,
    commonPrincipalId: options.ownerPrincipalId,
    readResult: ports.readResult,
    sessionStart: (row) => {
      access();
      return readSessionStartInput({
        exchanges: room === undefined ? chat.recentExchanges(row.stimulusId) : [],
        records: () => readRecords({ status: 'active', excludeAmendments: true }),
        checkpoint: async () => {
          if (room !== undefined) return null;
          const result = await surface.hostToolCall(
            'memory.checkpoint.list',
            { limit: 1 },
            `member-start:${randomUUID()}`,
            { access: access() }
          );
          if (result.status !== 'completed')
            throw new Error(`memory.checkpoint.list ${result.status}: ${result.error.message}`);
          const [latest] = (
            result.data as {
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
      });
    },
    lessons: async (text) => {
      const ownerRole = room === undefined && readsOwnerRules();
      // Personal guidance (a room: only its granted partitions) is ranked on its own, so common
      // records never take its slots.
      const ownScopes = room === undefined ? personalScopes : [...access().scopes];
      const result =
        ownScopes.length === 0
          ? ({ status: 'completed', data: { results: [] } } as const)
          : await surface.hostToolCall(
              'memory.search',
              { query: text.slice(0, 2_000), limit: 40, includeRelated: false, scopes: ownScopes },
              `member-lessons:${randomUUID()}`,
              { access: access() }
            );
      if (result.status !== 'completed')
        throw new Error(`memory.search ${result.status}: ${result.error.message}`);
      const hits = (result.data as { results?: Array<{ id: string }> }).results ?? [];
      const records = await readRecords({ kind: [...RULE_KINDS], status: 'active' });
      let hitIds = hits.map((hit) => hit.id);
      if (ownerRole) {
        const common = await surface.hostToolCall(
          'memory.search',
          {
            query: text.slice(0, 2_000),
            limit: 40,
            includeRelated: false,
            scopes: surface.ownerAccess.scopes,
          },
          `member-owner-lessons:${randomUUID()}`,
          { access: { ...access(), readScopes: surface.ownerAccess.scopes } }
        );
        if (common.status !== 'completed')
          throw new Error(`memory.search ${common.status}: ${common.error.message}`);
        const commonHits = (common.data as { results?: Array<{ id: string }> }).results ?? [];
        hitIds = [...new Set([...hitIds, ...commonHits.map((hit) => hit.id)])];
      }
      // Keep common facts and other kinds out of the personal guidance ranking. A room reads only
      // its granted partitions, and skills.workflows includes the person's own workflows.
      if (!ownerRole && room === undefined) {
        const common = await surface.hostToolCall(
          'memory.search',
          {
            query: text.slice(0, 2_000),
            kind: 'workflow',
            scopes: surface.ownerAccess.defaultScopes,
            limit: 40,
            includeRelated: false,
          },
          `member-workflows:${randomUUID()}`,
          { access: { ...access(), readScopes: surface.ownerAccess.defaultScopes } }
        );
        if (common.status !== 'completed')
          throw new Error(`memory.search ${common.status}: ${common.error.message}`);
        const commonHits = (common.data as { results?: Array<{ id: string }> }).results ?? [];
        hitIds = [...new Set([...hitIds, ...commonHits.map((hit) => hit.id)])];
        const workflows = await surface.skills.workflows(principalId);
        records.push(...workflows.filter((record) => !records.some((own) => own.id === record.id)));
      }
      const ruleIds = ownerRuleIds(database.adapter, hitIds, principalId);
      const commonRuleIds = ownerRole
        ? ownerRuleIds(database.adapter, hitIds, surface.ownerAccess.principalId)
        : new Set<string>();
      for (const id of commonRuleIds) ruleIds.add(id);
      const merged = guidanceInSearchOrder(
        hitIds,
        records,
        10,
        ruleIds,
        surface.skills.workflowScopes(principalId)
      );
      return merged.map((lesson) => ({
        ...lesson,
        commonOwnerRule: commonRuleIds.has(lesson.id),
      }));
    },
    onOwnerResult: options.onMemberResult,
    onDelivered: options.onStimulusDelivered,
    onFailed: options.onStimulusFailed,
    onUncertain: options.onStimulusUncertain,
    onDead: options.onStimulusDead,
    closeUncertain: options.closeUncertain,
  });
  const rowDelivery = (
    row: Parameters<NonNullable<typeof ownDelivery.deliver>>[0]
  ): typeof ownDelivery => {
    const channel =
      row.kind === 'owner_message' &&
      row.payload &&
      typeof row.payload === 'object' &&
      !Array.isArray(row.payload)
        ? row.payload.roomChannel
        : undefined;
    return room === undefined && typeof channel === 'string'
      ? roomSession(channel).delivery
      : ownDelivery;
  };
  const delivery: typeof ownDelivery = {
    ...ownDelivery,
    deliver: (row, context) => rowDelivery(row).deliver!(row, context),
    reconcile: (row) => rowDelivery(row).reconcile!(row),
    onUncertain: (row, reason) => rowDelivery(row).onUncertain?.(row, reason),
    onDead: (row, reason) => rowDelivery(row).onDead?.(row, reason),
  };
  return {
    native,
    delivery,
    chat,
    paths,
    access,
    initialAccess,
    roomSession,
    activeSessionKey: () => activeRoom?.native.sessionKey ?? sessionKey,
    activePaths: () => activeRoom?.activePaths() ?? paths,
    activeDeniedReadPaths: () => activeRoom?.activeDeniedReadPaths() ?? denyPaths(),
    activeSessionFacts: () =>
      activeRoom?.activeSessionFacts() ??
      (activeRequest
        ? {
            sourceMessageRef: activeRequest.sourceMessageRef,
            sourceRefs: activeRequest.sourceRefs,
            channelId: activeRequest.channelId,
          }
        : undefined),
  };
}
