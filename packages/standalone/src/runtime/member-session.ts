import { deliverPersonalJobResult, type PersonalJobStore } from './personal-jobs.js';
import { createSkillTurnContext } from './skills.js';
import { deliverPersonalNoticeResult, personalNoticePayload } from './personal-notices.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPrincipalRepository, type JudgmentAccess } from '@jungjaehoon/mama-core';
import { ChatSources } from '../storage/chat-sources.js';
import type { RawStore } from '../storage/source-archive.js';
import type { CoreDatabase } from './core-db.js';
import type { ActionSurface } from './action-surface.js';
import type { OwnerRuntimeOptions } from './owner-runtime.js';
import { runtimeModelRun, guidanceInSearchOrder, readOwnerMemoryRecords } from './owner-runtime.js';
import { createNativeSession, type NativeSession } from './native-session.js';
import { normalizeReadPaths } from './backend-security.js';
import { ensureMemberPaths, otherMemberReadPaths } from './member-paths.js';
import { MEMBER_SYSTEM_PROMPT } from './member-system-prompt.js';
import { MEMBER_VOICE } from './turn-orders.js';
import { resolvePrincipalAccess } from './principal-access.js';
import { readSessionStartInput } from './session-start-context.js';
import { readableSourcesLine } from './owner-system-prompt.js';
import { storedSourceFamilies } from '../connectors/framework/stored-index-read.js';
import { createStimulusDelivery, type StimulusDeliveryOptions } from './stimulus-delivery.js';
import { holdsOwnerRole, ownerRuleIds, RULE_KINDS } from './owner-authority.js';
import type { OwnerPolicyProvider } from './owner-policy.js';
import { startMemberEgressProxy, type EgressProxy } from './egress-proxy.js';
import { retirePersonalTurnReceipt } from '../gateways/telegram-message-ledger.js';

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
  }
) {
  const { options, database, rawStore, surface } = ports;
  const agentId = `member-agent:${principalId}`;
  const sessionKey = `member:${principalId}:runtime`;
  const access = (): JudgmentAccess =>
    resolvePrincipalAccess(principalId, {
      adapter: database.adapter,
      ownerAccess: surface.ownerAccess,
      agentId,
    });
  const initialAccess = access(); // Unknown/inactive ids fail before creating their paths.
  const paths = ensureMemberPaths(root, principalId);
  const personalScopes = [{ kind: 'user' as const, id: principalId }];
  const principals = createPrincipalRepository(database.adapter);
  const readsOwnerRules = () => holdsOwnerRole(principals, principalId);
  const readRecords = async (readOptions: Parameters<typeof readOwnerMemoryRecords>[2]) => {
    const records = await readOwnerMemoryRecords(database.adapter, personalScopes, readOptions);
    if (readsOwnerRules())
      records.push(
        ...(await readOwnerMemoryRecords(database.adapter, surface.ownerAccess.scopes, {
          ...readOptions,
          kind: [...RULE_KINDS],
        }))
      );
    return [...new Map(records.map((record) => [record.id, record])).values()];
  };
  const chat = new ChatSources(rawStore, database.adapter, principalId, agentId);
  const denyPaths = () =>
    normalizeReadPaths([
      ...ports.ownerDeniedPaths,
      paths.claudeConfigDir,
      ...otherMemberReadPaths(root, principalId, ports.registeredMemberIds()),
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
      toolsRoot: options.toolsRoot,
      ...paths,
      socketPath: options.socketPath,
      actionSurface: surface,
      principal: {
        principalId,
        agentId,
        sessionKey,
        systemPrompt: MEMBER_SYSTEM_PROMPT,
        roles: sessionRoles,
        prepareAccess: access,
      },
      // The host reads the common policy; the person's native tools still cannot read its file.
      ownerPolicyProvider: () =>
        readsOwnerRules()
          ? ports.ownerPolicyProvider()
          : { content: null, fingerprint: '', loaded: false },
      // Native session also denies this member's runtime and Codex credentials.
      deniedReadPaths,
      sandboxNetworkProxy: proxy,
      mcpServerPath: options.mcpServerPath,
      effort: options.effort,
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
    callAction: (call, caller) => current.callAction(call, caller),
    resetSession: (key) => current.resetSession(key),
    steer: (content, target, key) => current.steer(content, target, key),
    stop: async () => {
      try {
        await current.stop();
      } finally {
        await proxy?.close();
      }
    },
    runTurn: async (content, request) => {
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
      const stateless = key !== sessionKey;
      if (stateless) await current.resetSession(key); // Includes an orphan context left by a process crash.
      try {
        return await current.runTurn(content, request);
      } finally {
        if (stateless) await current.resetSession(key);
      }
    },
  };
  const delivery = createStimulusDelivery({
    // The common session's standing text says where sources live; a DM is told with its full
    // inventory, under its own grant and outside the session fingerprint, so a session resumed
    // across a deploy learns it too and new rows never rotate it.
    skills: createSkillTurnContext(
      () => surface.skills.list(principalId),
      () => {
        const current = access();
        return readableSourcesLine(
          storedSourceFamilies(database.adapter, current.connectors ?? [], current)
        );
      }
    ),
    backend: options.backend,
    timeZone: options.timeZone,
    turnChain: ports.turnChain,
    member: { principalId, sessionKey, voice: MEMBER_VOICE },
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
        exchanges: chat.recentExchanges(row.stimulusId),
        records: () => readRecords({ status: 'active', excludeAmendments: true }),
        checkpoint: async () => {
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
      const ownerRole = readsOwnerRules();
      // Personal guidance is ranked on its own, so common records never take its slots.
      const result = await surface.hostToolCall(
        'memory.search',
        { query: text.slice(0, 2_000), limit: 40, includeRelated: false, scopes: personalScopes },
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
      // Keep common facts and other kinds out of the personal guidance ranking.
      if (!ownerRole) {
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
  return { native, delivery, chat, paths, access, initialAccess };
}
