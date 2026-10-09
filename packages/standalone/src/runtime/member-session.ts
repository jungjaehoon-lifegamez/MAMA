import { randomUUID } from 'node:crypto';
import {
  readMemoryRecordsInScopes,
  isErasedRecord,
  type JudgmentAccess,
  type MemoryRecord,
} from '@jungjaehoon/mama-core';
import { ChatSources } from '../storage/chat-sources.js';
import type { RawStore } from '../storage/source-archive.js';
import type { CoreDatabase } from './core-db.js';
import type { ActionSurface } from './action-surface.js';
import type { OwnerRuntimeOptions } from './owner-runtime.js';
import { runtimeModelRun, guidanceInSearchOrder } from './owner-runtime.js';
import { createNativeSession, type NativeSession } from './native-session.js';
import { normalizeReadPaths } from './backend-security.js';
import { ensureMemberPaths, otherMemberReadPaths } from './member-paths.js';
import { MEMBER_SYSTEM_PROMPT } from './member-system-prompt.js';
import { MEMBER_VOICE } from './turn-orders.js';
import { resolvePrincipalAccess } from './principal-access.js';
import { readSessionStartInput } from './session-start-context.js';
import { createStimulusDelivery, type StimulusDeliveryOptions } from './stimulus-delivery.js';
import { ownerRuleIds, RULE_KINDS } from './owner-authority.js';

export function createMemberSession(
  principalId: string,
  root: string,
  ports: {
    options: OwnerRuntimeOptions;
    ownerDeniedPaths: readonly string[];
    registeredMemberIds: () => string[];
    database: CoreDatabase;
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
  const chat = new ChatSources(rawStore, database.adapter, principalId, agentId);
  const denyPaths = () =>
    normalizeReadPaths([
      ...ports.ownerDeniedPaths,
      ...otherMemberReadPaths(root, principalId, ports.registeredMemberIds()),
    ]).sort();
  let deniedReadPaths = denyPaths();
  const create = () =>
    (options.createSession ?? createNativeSession)({
      backend: options.backend,
      model: options.model,
      ...paths,
      socketPath: options.socketPath,
      actionSurface: surface,
      principal: {
        principalId,
        agentId,
        sessionKey,
        systemPrompt: MEMBER_SYSTEM_PROMPT,
        prepareAccess: access,
      },
      // Native session also denies this member's runtime and Codex credentials.
      deniedReadPaths,
      sandboxNetworkProxy: options.sandboxNetworkProxy,
      mcpServerPath: options.mcpServerPath,
      effort: options.effort,
      timeout: options.timeout,
      maxTurnMs: options.maxTurnMs,
      maxTurns: options.maxTurns,
      runTokenBudget: options.runTokenBudget,
      codexSandbox: options.codexSandbox,
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
    stop: () => current.stop(),
    runTurn: async (content, request) => {
      const next = denyPaths();
      if (JSON.stringify(next) !== JSON.stringify(deniedReadPaths)) {
        // Enrollment runs in the owner's turn on the shared serial chain. Here that turn has
        // finished and no other principal is executing. Never resume a thread with stale policy.
        await current.resetSession(sessionKey);
        await current.stop();
        deniedReadPaths = next;
        current = create();
      }
      return current.runTurn(content, request);
    },
  };
  const delivery = createStimulusDelivery({
    backend: options.backend,
    timeZone: options.timeZone,
    turnChain: ports.turnChain,
    member: { sessionKey, voice: MEMBER_VOICE },
    readResult: ports.readResult,
    sessionStart: (row) => {
      access();
      return readSessionStartInput({
        exchanges: chat.recentExchanges(row.stimulusId),
        records: async () =>
          (
            await readMemoryRecordsInScopes(database.adapter, personalScopes, {
              status: 'active',
              excludeAmendments: true,
            })
          ).filter((record): record is MemoryRecord => !isErasedRecord(record)),
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
      const result = await surface.hostToolCall(
        'memory.search',
        { query: text.slice(0, 2_000), limit: 40, includeRelated: false },
        `member-lessons:${randomUUID()}`,
        { access: { ...access(), readScopes: [] } }
      );
      if (result.status !== 'completed')
        throw new Error(`memory.search ${result.status}: ${result.error.message}`);
      const hits = (result.data as { results?: Array<{ id: string }> }).results ?? [];
      const records = (
        await readMemoryRecordsInScopes(database.adapter, personalScopes, {
          kind: [...RULE_KINDS],
          status: 'active',
        })
      ).filter((record): record is MemoryRecord => !isErasedRecord(record));
      const hitIds = hits.map((hit) => hit.id);
      return guidanceInSearchOrder(
        hitIds,
        records,
        10,
        ownerRuleIds(database.adapter, hitIds, principalId)
      );
    },
    onOwnerResult: options.onMemberResult,
    onDelivered: options.onStimulusDelivered,
    onFailed: options.onStimulusFailed,
    onUncertain: options.onStimulusUncertain,
    onDead: options.onStimulusDead,
  });
  return { native, delivery, chat, paths, access, initialAccess };
}
