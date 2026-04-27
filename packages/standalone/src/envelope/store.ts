import type { SQLiteDatabase } from '../sqlite.js';
import { canonicalJson } from './canonical.js';
import type { Envelope } from './types.js';

type EnvelopeRow = Record<string, unknown>;

export class EnvelopeStore {
  constructor(private readonly db: SQLiteDatabase) {}

  insert(env: Envelope): void {
    if (!env.signature) {
      throw new Error(
        '[envelope] EnvelopeStore.insert: envelope must be signed. ' +
          'Use EnvelopeAuthority.persist or buildAndPersist.'
      );
    }

    const params = this.envelopeToParams(env);
    const stmt = this.db.prepare(`
      INSERT INTO envelopes (
        envelope_hash, instance_id, parent_instance_id, agent_id, source,
        channel_id, trigger_context, scope, tier, budget, expires_at, signature
      ) VALUES (
        @envelope_hash, @instance_id, @parent_instance_id, @agent_id, @source,
        @channel_id, @trigger_context, @scope, @tier, @budget, @expires_at, @signature
      )
    `);

    try {
      stmt.run(params);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const existing = this.getByHash(env.envelope_hash);
        if (existing && this.sameEnvelopeParams(this.envelopeToParams(existing), params)) {
          return;
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[envelope] EnvelopeStore.insert conflict for envelope_hash=${env.envelope_hash}: ${message}`
      );
    }
  }

  getByHash(envelopeHash: string): Envelope | undefined {
    const row = this.db
      .prepare('SELECT * FROM envelopes WHERE envelope_hash = ?')
      .get(envelopeHash) as EnvelopeRow | undefined;
    return row ? this.rowToEnvelope(row) : undefined;
  }

  getByInstanceId(instanceId: string): Envelope | undefined {
    const row = this.db.prepare('SELECT * FROM envelopes WHERE instance_id = ?').get(instanceId) as
      | EnvelopeRow
      | undefined;
    return row ? this.rowToEnvelope(row) : undefined;
  }

  private rowToEnvelope(row: EnvelopeRow): Envelope {
    const envelopeHash = String(row.envelope_hash);
    const envelope: Envelope = {
      envelope_hash: envelopeHash,
      instance_id: String(row.instance_id),
      agent_id: String(row.agent_id),
      source: row.source as Envelope['source'],
      trigger_context: this.parseEnvelopeJsonField<Envelope['trigger_context']>(
        row,
        'trigger_context',
        envelopeHash
      ),
      scope: this.parseEnvelopeJsonField<Envelope['scope']>(row, 'scope', envelopeHash),
      tier: this.parseTier(row.tier, envelopeHash),
      budget: this.parseEnvelopeJsonField<Envelope['budget']>(row, 'budget', envelopeHash),
      expires_at: String(row.expires_at),
      signature: row.signature
        ? this.parseEnvelopeJsonField<Envelope['signature']>(row, 'signature', envelopeHash)
        : undefined,
    };

    if (row.parent_instance_id) {
      envelope.parent_instance_id = String(row.parent_instance_id);
    }
    if (row.channel_id) {
      envelope.channel_id = String(row.channel_id);
    }

    return envelope;
  }

  private envelopeToParams(env: Envelope): Record<string, unknown> {
    return {
      envelope_hash: env.envelope_hash,
      instance_id: env.instance_id,
      parent_instance_id: env.parent_instance_id ?? null,
      agent_id: env.agent_id,
      source: env.source,
      channel_id: env.channel_id ?? null,
      trigger_context: canonicalJson(env.trigger_context),
      scope: canonicalJson(env.scope),
      tier: env.tier,
      budget: canonicalJson(env.budget),
      expires_at: env.expires_at,
      signature: canonicalJson(env.signature),
    };
  }

  private sameEnvelopeParams(
    left: Record<string, unknown>,
    right: Record<string, unknown>
  ): boolean {
    return canonicalJson(left) === canonicalJson(right);
  }

  private parseTier(value: unknown, envelopeHash: string): 1 | 2 | 3 {
    const tier = Number(value);
    if (tier !== 1 && tier !== 2 && tier !== 3) {
      throw new Error(
        `[envelope] corrupted tier for envelope_hash=${envelopeHash}: expected 1, 2, or 3`
      );
    }
    return tier;
  }

  private parseEnvelopeJsonField<T>(
    row: EnvelopeRow,
    fieldName: 'trigger_context' | 'scope' | 'budget' | 'signature',
    envelopeHash: string
  ): T {
    try {
      return JSON.parse(String(row[fieldName])) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[envelope] corrupted JSON field ${fieldName} for envelope_hash=${envelopeHash}: ${message}`
      );
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
  }
}
