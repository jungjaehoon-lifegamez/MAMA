import type { NormalizedMessage } from '../../../src/gateways/types.js';
import type { PrincipalContext } from '../../../src/gateways/principal.js';
import { makeHostPrincipal } from '../../../src/gateways/principal.js';

const OWNER_PRINCIPAL: PrincipalContext = Object.freeze({
  class: 'owner',
  lane: 'owner',
  canonicalId: 'test:owner:synthetic',
  consoleEligible: true,
});

export function withOwnerPrincipal<T extends NormalizedMessage>(
  message: T
): T & { principal: PrincipalContext } {
  if (message.principal !== undefined) {
    return message as T & { principal: PrincipalContext };
  }
  const principal =
    message.source === 'viewer' || message.source === 'mobile' || message.source === 'system'
      ? makeHostPrincipal(message.source)
      : OWNER_PRINCIPAL;
  return { ...message, principal };
}
