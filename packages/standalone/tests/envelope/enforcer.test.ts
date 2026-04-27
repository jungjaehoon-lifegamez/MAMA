import { describe, expect, it } from 'vitest';
import { EnvelopeEnforcer, EnvelopeViolation } from '../../src/envelope/enforcer.js';
import { makeEnvelope } from './fixtures.js';

describe('EnvelopeEnforcer', () => {
  const enforcer = new EnvelopeEnforcer();

  it('allows tool call within destination scope', () => {
    const env = makeEnvelope();

    expect(() =>
      enforcer.check(env, 'telegram_send', { chat_id: 'tg:1', message: 'hi' })
    ).not.toThrow();
  });

  it('rejects telegram_send to destination outside allowed_destinations', () => {
    const env = makeEnvelope();

    expect(() =>
      enforcer.check(env, 'telegram_send', { chat_id: 'tg:OTHER', message: 'leak' })
    ).toThrow(EnvelopeViolation);
  });

  it('rejects send tool without destination id', () => {
    const env = makeEnvelope();

    expect(() => enforcer.check(env, 'telegram_send', { message: 'missing dest' })).toThrow(
      /missing_destination/
    );
  });

  it('rejects expired envelope', () => {
    const env = makeEnvelope({ expires_at: new Date(Date.now() - 1000).toISOString() });

    expect(() => enforcer.check(env, 'mama_search', { query: 'x' })).toThrow(EnvelopeViolation);
  });

  it('rejects unparsable expires_at', () => {
    const env = makeEnvelope({ expires_at: 'not-a-date' });

    expect(() => enforcer.check(env, 'mama_search', { query: 'x' })).toThrow(/invalid_expiry/);
  });

  it('rejects raw access outside envelope.scope.raw_connectors', () => {
    const env = makeEnvelope();

    expect(() => enforcer.check(env, 'raw.search', { connectors: ['slack'], query: 'x' })).toThrow(
      EnvelopeViolation
    );
  });

  it('allows raw access for connectors inside envelope.scope.raw_connectors', () => {
    const env = makeEnvelope();

    expect(() =>
      enforcer.check(env, 'raw.search', { connectors: ['telegram'], query: 'x' })
    ).not.toThrow();
  });

  it('rejects kagemusha_messages when kagemusha is outside raw_connectors', () => {
    const env = makeEnvelope();

    expect(() =>
      enforcer.check(env, 'kagemusha_messages', { channelId: 'room:1', search: 'x' })
    ).toThrow(EnvelopeViolation);
  });

  it('allows kagemusha_messages when kagemusha is inside raw_connectors', () => {
    const env = makeEnvelope({
      scope: {
        ...makeEnvelope().scope,
        raw_connectors: ['telegram', 'kagemusha'],
      },
    });

    expect(() =>
      enforcer.check(env, 'kagemusha_messages', { channelId: 'room:1', search: 'x' })
    ).not.toThrow();
  });

  it('rejects kagemusha_messages without channelId', () => {
    const env = makeEnvelope({
      scope: {
        ...makeEnvelope().scope,
        raw_connectors: ['kagemusha'],
      },
    });

    expect(() => enforcer.check(env, 'kagemusha_messages', { search: 'x' })).toThrow(
      /missing_raw_target/
    );
  });

  it('rejects write/send tools at tier 3', () => {
    const env = makeEnvelope({ tier: 3 });

    expect(() => enforcer.check(env, 'mama_save', { topic: 'x' })).toThrow(/tier_violation/);
  });

  it('allows read tools at tier 3', () => {
    const env = makeEnvelope({ tier: 3 });

    expect(() => enforcer.check(env, 'mama_search', { query: 'x' })).not.toThrow();
  });

  it('rejects null envelope', () => {
    expect(() =>
      // @ts-expect-error testing runtime guard
      enforcer.check(null, 'mama_search', { query: 'x' })
    ).toThrow(EnvelopeViolation);
  });
});
