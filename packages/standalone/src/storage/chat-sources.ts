import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import type { OwnerExchange } from '../api/owner-message-actions.js';
import type { OwnerMessageInput, OwnerReplyInput } from '../gateways/turn-contract.js';
import type { SessionStartExchange } from '../runtime/turn-orders.js';
import { createCoreRawIndexSink } from '../replay/import-manifest.js';
import { RawStore, type NormalizedItem } from './source-archive.js';

export function ownerMessageItem(input: OwnerMessageInput, principalId: string): NormalizedItem {
  return {
    source: 'chat',
    sourceId: input.id,
    channel: `${input.id.split(':')[0]}:${input.channelKey}`,
    author: principalId,
    content: input.text,
    timestamp: new Date(input.occurredAt),
    type: 'message',
    memoryScopeKind: 'user',
    memoryScopeId: principalId,
    metadata: {
      kind: 'owner_message',
      messageRef: input.id,
      replyTo: input.replyTo ?? null,
      input: input.payload ?? null,
    },
  };
}

export function ownerReplyItem(
  input: OwnerReplyInput,
  principalId: string,
  agentId: string,
  channel: string
): NormalizedItem {
  return {
    source: 'chat',
    sourceId: `${input.messageRef}:reply`,
    channel,
    author: input.author === 'host' ? 'host' : agentId,
    content: input.text,
    timestamp: new Date(input.occurredAt),
    type: 'message',
    memoryScopeKind: 'user',
    memoryScopeId: principalId,
    metadata: {
      kind: 'reply',
      messageRef: input.messageRef,
      deliveryVerified: input.deliveryVerified,
    },
  };
}

export class ChatSources {
  constructor(
    private readonly rawStore: RawStore,
    private readonly adapter: DatabaseInstance,
    private readonly principalId: string,
    private readonly agentId: string
  ) {}

  saveOwnerMessage(input: OwnerMessageInput): string {
    return this.save(ownerMessageItem(input, this.principalId));
  }

  saveReply(input: OwnerReplyInput): void {
    const message = this.adapter
      .prepare(
        "SELECT channel FROM connector_event_index WHERE source_connector = 'chat' AND source_id = ? AND json_extract(metadata_json, '$.kind') = 'owner_message'"
      )
      .get(input.messageRef) as { channel: string } | undefined;
    if (!message) throw new Error(`Owner message is not stored: ${input.messageRef}`);
    this.save(ownerReplyItem(input, this.principalId, this.agentId, message.channel));
  }

  private save(item: NormalizedItem): string {
    const [saved] = this.rawStore.save('chat', [item], { collectOnly: true });
    // Intake cannot proceed without exactly one raw item and its projection.
    if (!saved) throw new Error('Chat raw save omitted its item');
    // Redelivery of an acknowledged item must reuse its observation, not create another version.
    if (saved.pendingProjectionId === undefined) {
      const row = this.adapter
        .prepare(
          "SELECT current_observation_id FROM connector_event_index WHERE source_connector = 'chat' AND source_id = ?"
        )
        .get(saved.sourceId) as { current_observation_id: string } | undefined;
      // An acknowledged raw item without its index is a broken storage contract.
      if (!row?.current_observation_id)
        throw new Error('Saved chat item has no indexed observation');
      return row.current_observation_id;
    }
    const [projection] = createCoreRawIndexSink(this.adapter)('chat', [saved]);
    if (!projection || projection.sourceId !== saved.sourceId)
      throw new Error('Chat projection omitted its source identity');
    this.rawStore.acknowledgeProjection('chat', saved.sourceId, saved.pendingProjectionId);
    return projection.observationRef;
  }

  exchanges(since: number, before: number): OwnerExchange[] {
    return this.readExchanges(
      'AND m.source_timestamp_ms >= ? AND m.source_timestamp_ms < ?',
      [since, before],
      'ASC'
    );
  }

  recentExchanges(currentMessageRef: string): SessionStartExchange[] {
    return this.readExchanges(
      'AND m.source_id != ? AND r.source_id IS NOT NULL',
      [currentMessageRef],
      'DESC',
      10
    )
      .reverse()
      .map(({ at, owner, reply }) => ({
        at,
        owner,
        answer: reply!,
      }));
  }

  private readExchanges(
    filter: string,
    params: unknown[],
    order: 'ASC' | 'DESC',
    limit?: number
  ): OwnerExchange[] {
    // Backfilled model output is not a delivery receipt.
    return this.adapter
      .prepare(
        `SELECT m.source_timestamp_ms AS at, m.content AS owner, r.content AS reply
       FROM connector_event_index m
       LEFT JOIN connector_event_index r ON r.source_connector = 'chat'
         AND r.source_id = (
           SELECT reply.source_id FROM connector_event_index reply
           WHERE reply.source_connector = 'chat' AND reply.source_entity_id = m.source_entity_id || ':reply'
             AND reply.memory_scope_kind = 'user' AND reply.memory_scope_id = m.memory_scope_id
             AND json_extract(reply.metadata_json, '$.deliveryVerified') = 1
           ORDER BY reply.source_timestamp_ms DESC, reply.rowid DESC LIMIT 1
         )
       WHERE m.source_connector = 'chat' AND m.memory_scope_kind = 'user' AND m.memory_scope_id = ?
         AND json_extract(m.metadata_json, '$.kind') = 'owner_message' ${filter}
       ORDER BY m.source_timestamp_ms ${order}, m.source_id ${order} ${limit === undefined ? '' : 'LIMIT ?'}`
      )
      .all(this.principalId, ...params, ...(limit === undefined ? [] : [limit])) as OwnerExchange[];
  }
}
