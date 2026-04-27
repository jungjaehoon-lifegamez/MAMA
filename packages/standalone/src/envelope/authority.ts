import {
  signEnvelope,
  verifyEnvelope,
  type EnvelopeKeyLookup,
  type EnvelopeSigningKey,
} from './signature.js';
import type { Envelope } from './types.js';
import type { EnvelopeStore } from './store.js';

export type EnvelopeBuildInput = Omit<Envelope, 'envelope_hash' | 'signature'>;

export class EnvelopeAuthority {
  constructor(
    private readonly store: EnvelopeStore,
    private readonly signer: EnvelopeSigningKey,
    private readonly keyLookup: EnvelopeKeyLookup
  ) {}

  build(input: EnvelopeBuildInput): Envelope {
    validateBuildInput(input);
    const envelope: Envelope = { ...input, envelope_hash: '' };
    if (envelope.parent_instance_id === undefined) {
      delete envelope.parent_instance_id;
    }
    if (envelope.channel_id === undefined) {
      delete envelope.channel_id;
    }
    return signEnvelope(envelope, this.signer);
  }

  persist(env: Envelope): void {
    if (!env.signature) {
      throw new Error('EnvelopeAuthority.persist: envelope must be signed');
    }
    this.store.insert(env);
  }

  buildAndPersist(input: EnvelopeBuildInput): Envelope {
    const env = this.build(input);
    this.persist(env);
    return env;
  }

  loadVerified(envelopeHash: string): Envelope | undefined {
    const env = this.store.getByHash(envelopeHash);
    if (!env) {
      return undefined;
    }
    if (!verifyEnvelope(env, this.keyLookup)) {
      throw new Error(
        `EnvelopeAuthority.loadVerified: signature mismatch for ${envelopeHash} ` +
          '(possible key rotation, tampering, or unknown key_id)'
      );
    }
    return env;
  }
}

function validateBuildInput(input: EnvelopeBuildInput): void {
  if (!input.agent_id || typeof input.agent_id !== 'string') {
    throw new Error('EnvelopeAuthority.build: agent_id required');
  }
  if (!input.instance_id || typeof input.instance_id !== 'string') {
    throw new Error('EnvelopeAuthority.build: instance_id required');
  }
  if (![1, 2, 3].includes(input.tier)) {
    throw new Error(`EnvelopeAuthority.build: tier must be 1|2|3, got ${input.tier}`);
  }
  if (typeof input.budget?.wall_seconds !== 'number' || input.budget.wall_seconds <= 0) {
    throw new Error('EnvelopeAuthority.build: budget.wall_seconds must be > 0');
  }
  if (input.budget.token_limit !== undefined && input.budget.token_limit < 0) {
    throw new Error('EnvelopeAuthority.build: budget.token_limit must be >= 0 if set');
  }
  if (input.budget.cost_cap !== undefined && input.budget.cost_cap < 0) {
    throw new Error('EnvelopeAuthority.build: budget.cost_cap must be >= 0 if set');
  }

  const expiresMs = Date.parse(input.expires_at);
  if (Number.isNaN(expiresMs)) {
    throw new Error(`EnvelopeAuthority.build: expires_at not parseable: ${input.expires_at}`);
  }
  if (expiresMs <= Date.now()) {
    throw new Error(`EnvelopeAuthority.build: expires_at already past: ${input.expires_at}`);
  }

  if (!input.scope || !Array.isArray(input.scope.project_refs)) {
    throw new Error('EnvelopeAuthority.build: scope.project_refs required');
  }
  if (!Array.isArray(input.scope.raw_connectors)) {
    throw new Error('EnvelopeAuthority.build: scope.raw_connectors required');
  }
  if (!Array.isArray(input.scope.memory_scopes)) {
    throw new Error('EnvelopeAuthority.build: scope.memory_scopes required');
  }
  if (!Array.isArray(input.scope.allowed_destinations)) {
    throw new Error('EnvelopeAuthority.build: scope.allowed_destinations required');
  }
}
