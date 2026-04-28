import type { SQLiteDatabase } from '../../sqlite.js';
import type { MAMAConfig } from '../config/types.js';
import { applyEnvelopeTablesMigration } from '../../db/migrations/envelope-tables.js';
import { EnvelopeAuthority } from '../../envelope/authority.js';
import { loadEnvelopeSigningKeyFromEnv, makeEnvKeyLookup } from '../../envelope/key-provider.js';
import { createDefaultReactiveEnvelopeConfig } from '../../envelope/reactive-config.js';
import type { EnvLike, ReactiveEnvelopeConfig } from '../../envelope/reactive-config.js';
import { EnvelopeStore } from '../../envelope/store.js';

export type EnvelopeIssuanceMode = 'off' | 'enabled' | 'required';

export interface RuntimeEnvelopeBootstrap {
  envelopeConfig?: ReactiveEnvelopeConfig;
  envelopeAuthority?: EnvelopeAuthority;
  metadata: {
    issuance: EnvelopeIssuanceMode;
    key_id?: string;
    key_version?: number;
  };
}

function parseEnvelopeIssuanceMode(env: EnvLike): EnvelopeIssuanceMode {
  const raw = env.MAMA_ENVELOPE_ISSUANCE?.trim().toLowerCase();
  if (!raw || raw === 'off' || raw === 'false') {
    return 'off';
  }
  if (raw === 'enabled' || raw === 'required') {
    return raw;
  }
  throw new Error(
    `[envelope] MAMA_ENVELOPE_ISSUANCE must be one of off, false, enabled, required; got ${env.MAMA_ENVELOPE_ISSUANCE}`
  );
}

export function buildRuntimeEnvelopeBootstrap(
  db: SQLiteDatabase,
  config: MAMAConfig,
  env: EnvLike = process.env
): RuntimeEnvelopeBootstrap {
  const issuance = parseEnvelopeIssuanceMode(env);

  if (issuance === 'off') {
    return {
      metadata: { issuance },
    };
  }

  const signingKey = loadEnvelopeSigningKeyFromEnv(env);
  applyEnvelopeTablesMigration(db);
  const envelopeAuthority = new EnvelopeAuthority(
    new EnvelopeStore(db),
    signingKey,
    makeEnvKeyLookup(signingKey)
  );

  return {
    envelopeConfig: createDefaultReactiveEnvelopeConfig(config, env),
    envelopeAuthority,
    metadata: {
      issuance,
      key_id: signingKey.key_id,
      key_version: signingKey.key_version,
    },
  };
}
