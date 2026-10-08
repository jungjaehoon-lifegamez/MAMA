/**
 * Knowledge identity: the T4 correction command — alias, merge, split, and ref
 * assignment — under the knowledge boundary. The registry keeps the SQL owner;
 * this module is the §3 access-facing home that maps the caller's trusted
 * authority onto it.
 *
 * @module knowledge/identity
 */

import type { DatabaseAdapter } from '../db-manager.js';
import type { IdentityCorrection, IdentityCorrectionReceipt } from '../memory/judgment-types.js';
import { appendIdentityCorrection } from '../registry/corrections.js';
import type { JudgmentAccess } from './judgments.js';

export interface IdentityDeps {
  adapter: DatabaseAdapter;
}

export function correctIdentity(
  command: IdentityCorrection,
  access: JudgmentAccess,
  deps: IdentityDeps
): IdentityCorrectionReceipt {
  return appendIdentityCorrection(deps.adapter, command, {
    principalId: access.principalId,
    agentId: access.agentId,
    scopes: access.scopes,
    defaultScopes: access.defaultScopes,
    connectors: access.connectors ?? [],
    channels: access.channels,
  });
}
