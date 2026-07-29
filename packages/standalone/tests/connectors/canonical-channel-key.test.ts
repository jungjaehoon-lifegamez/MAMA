/**
 * The one place a display name becomes an identity.
 *
 * Measured before this existed: zero of 30,671 indexed events were readable in production.
 * Six of seven connectors wrote `item.channel` as a display name while the config declared
 * the same channel under its upstream id, and the binding step absorbed the difference by
 * falling back to a name match - so binding always succeeded, the name was written to the
 * index anyway, and every reader downstream compared that name against a config key and
 * matched nothing. Nothing looked broken at any single step.
 */
import { describe, it, expect } from 'vitest';
import { canonicalChannelKey } from '../../src/connectors/framework/polling-scheduler.js';
import type { ChannelConfig } from '../../src/connectors/framework/types.js';

const configs: Record<string, Record<string, ChannelConfig>> = {
  board: {
    // What the live Trello config looks like: keyed by the upstream's stable id, with the
    // human name as a field.
    b1a2c3d4e5f6a7b8c9d0e1f2: { role: 'truth', name: 'Production Board' } as ChannelConfig,
    f9e8d7c6b5a4938271605142: { role: 'truth', name: 'Archive Board' } as ChannelConfig,
  },
  chat: {
    C0123456789: { role: 'hub', name: 'general' } as ChannelConfig,
  },
};

describe('canonicalChannelKey', () => {
  it('turns the display name a connector emits into the configured identity', () => {
    expect(canonicalChannelKey({ source: 'board', channel: 'Production Board' }, configs)).toBe(
      'b1a2c3d4e5f6a7b8c9d0e1f2'
    );
    expect(canonicalChannelKey({ source: 'chat', channel: 'general' }, configs)).toBe(
      'C0123456789'
    );
  });

  it('leaves an already-canonical key alone', () => {
    expect(
      canonicalChannelKey({ source: 'board', channel: 'f9e8d7c6b5a4938271605142' }, configs)
    ).toBe('f9e8d7c6b5a4938271605142');
  });

  // Inventing a key for an unconfigured channel would put rows in the index that no grant
  // can ever name - which is the shape of the problem this replaces, not a fix for it.
  it('refuses to invent an identity for an unconfigured channel', () => {
    expect(canonicalChannelKey({ source: 'board', channel: 'Some Other Board' }, configs)).toBe(
      null
    );
    expect(canonicalChannelKey({ source: 'unknown', channel: 'general' }, configs)).toBe(null);
  });

  // A name that matches nothing must not fall through to a different channel's key just
  // because one exists. Identity is exact or it is absent.
  it('does not approximate', () => {
    expect(canonicalChannelKey({ source: 'chat', channel: 'gener' }, configs)).toBe(null);
    expect(canonicalChannelKey({ source: 'chat', channel: 'general ' }, configs)).toBe(null);
  });
});
