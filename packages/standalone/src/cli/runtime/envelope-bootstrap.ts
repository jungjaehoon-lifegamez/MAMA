import { homedir } from 'node:os';
import { join } from 'node:path';

import { DebugLogger } from '@jungjaehoon/mama-core/debug-logger';

import type { SQLiteDatabase } from '../../sqlite.js';
import type { MAMAConfig } from '../config/types.js';
import { loadConnectorConfig } from '../../connectors/config-loader.js';
import { applyEnvelopeTablesMigration } from '../../db/migrations/envelope-tables.js';
import { EnvelopeAuthority } from '../../envelope/authority.js';
import {
  loadEnvelopeSigningKeyFromEnv,
  loadOrCreateLocalEnvelopeSigningKey,
  makeEnvKeyLookup,
} from '../../envelope/key-provider.js';
import { createDefaultReactiveEnvelopeConfig } from '../../envelope/reactive-config.js';
import type { EnvLike, ReactiveEnvelopeConfig } from '../../envelope/reactive-config.js';
import { EnvelopeStore } from '../../envelope/store.js';

const logger = new DebugLogger('envelope-bootstrap');

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
  const configured = env.MAMA_ENVELOPE_ISSUANCE;
  if (configured === undefined) {
    return 'enabled';
  }
  const raw = configured.trim().toLowerCase();
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

  const connectorConfigPath = join(env.HOME?.trim() || homedir(), '.mama', 'connectors.json');
  const connectorConfig = loadConnectorConfig(connectorConfigPath);
  if (!connectorConfig.ok) {
    logger.error(
      `[envelope] failed to load connector configuration (${connectorConfig.error.code}): ` +
        connectorConfig.error.message
    );
  }
  const enabledConnectorNames = Object.freeze([...connectorConfig.enabledNames]);
  const driveDestinations = Object.freeze(
    connectorConfig.ok && connectorConfig.config.drive?.enabled
      ? Object.values(connectorConfig.config.drive.channels)
          .filter((channel) => channel.role !== 'ignore')
          .flatMap((channel) => [channel.folderId, channel.driveId])
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => ({ kind: 'drive' as const, id }))
      : []
  );

  const signingKey =
    issuance === 'required'
      ? loadEnvelopeSigningKeyFromEnv(env)
      : loadOrCreateLocalEnvelopeSigningKey(env);
  applyEnvelopeTablesMigration(db);
  const envelopeAuthority = new EnvelopeAuthority(
    new EnvelopeStore(db),
    signingKey,
    makeEnvKeyLookup(signingKey)
  );

  return {
    envelopeConfig: createDefaultReactiveEnvelopeConfig(
      config,
      env,
      enabledConnectorNames,
      driveDestinations
    ),
    envelopeAuthority,
    metadata: {
      issuance,
      key_id: signingKey.key_id,
      key_version: signingKey.key_version,
    },
  };
}
