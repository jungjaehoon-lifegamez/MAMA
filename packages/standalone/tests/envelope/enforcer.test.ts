import { describe, expect, it } from 'vitest';
import { EnvelopeEnforcer, EnvelopeViolation } from '../../src/envelope/enforcer.js';
import { makeEnvelope } from './fixtures.js';

describe('EnvelopeEnforcer', () => {
  const enforcer = new EnvelopeEnforcer();

  function captureViolation(run: () => void): EnvelopeViolation {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeViolation);
      return error as EnvelopeViolation;
    }
    throw new Error('expected EnvelopeViolation');
  }

  it('allows tool call within destination scope', () => {
    const env = makeEnvelope();

    expect(() =>
      enforcer.check(env, 'telegram_send', { chat_id: 'tg:1', message: 'hi' })
    ).not.toThrow();
  });

  it('rejects telegram_send to destination outside allowed_destinations', () => {
    const env = makeEnvelope();
    const sentinel = 'tg:private-destination-secret-42';
    const violation = captureViolation(() =>
      enforcer.check(env, 'telegram_send', { chat_id: sentinel, message: 'leak' })
    );

    expect(violation.code).toBe('destination_out_of_scope');
    expect(
      JSON.stringify({
        message: violation.message,
        code: violation.code,
        metadata: violation.metadata,
      })
    ).not.toContain(sentinel);
  });

  it('rejects send tool without destination id', () => {
    const env = makeEnvelope();

    expect(() => enforcer.check(env, 'telegram_send', { message: 'missing dest' })).toThrow(
      /missing_destination/
    );
  });

  it('rejects expired envelope', () => {
    const instanceSentinel = 'private-expired-instance-secret-43';
    const expirySentinel = new Date(Date.now() - 1000).toISOString();
    const env = makeEnvelope({ instance_id: instanceSentinel, expires_at: expirySentinel });
    const violation = captureViolation(() => enforcer.check(env, 'mama_search', { query: 'x' }));

    expect(violation.code).toBe('expired');
    const serialized = JSON.stringify({
      message: violation.message,
      code: violation.code,
      metadata: violation.metadata,
    });
    expect(serialized).not.toContain(instanceSentinel);
    expect(serialized).not.toContain(expirySentinel);
  });

  it('rejects unparsable expires_at', () => {
    const instanceSentinel = 'private-invalid-instance-secret-44';
    const expirySentinel = 'private-invalid-expiry-secret-45';
    const env = makeEnvelope({ instance_id: instanceSentinel, expires_at: expirySentinel });
    const violation = captureViolation(() => enforcer.check(env, 'mama_search', { query: 'x' }));

    expect(violation.code).toBe('invalid_expiry');
    const serialized = JSON.stringify({
      message: violation.message,
      code: violation.code,
      metadata: violation.metadata,
    });
    expect(serialized).not.toContain(instanceSentinel);
    expect(serialized).not.toContain(expirySentinel);
  });

  it('rejects parseable non-ISO expires_at values', () => {
    const env = makeEnvelope({ expires_at: '2099-01-01 00:00:00' });

    expect(() => enforcer.check(env, 'mama_search', { query: 'x' })).toThrow(/invalid_expiry/);
  });

  it('rejects raw access outside envelope.scope.raw_connectors', () => {
    const env = makeEnvelope();

    const sentinel = 'private-card-text-secret-42';
    let violation: EnvelopeViolation | null = null;
    try {
      enforcer.check(env, 'raw.search', { connectors: [sentinel], query: 'x' });
    } catch (error) {
      violation = error as EnvelopeViolation;
    }

    expect(violation).toBeInstanceOf(EnvelopeViolation);
    expect(violation?.code).toBe('connector_out_of_scope');
    expect(JSON.stringify(violation)).not.toContain(sentinel);
    expect(violation?.message).not.toContain(sentinel);
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

  it('requires Drive tools to stay inside the raw Drive connector scope', () => {
    const withoutDrive = makeEnvelope();
    const withDrive = makeEnvelope({
      scope: {
        ...makeEnvelope().scope,
        raw_connectors: ['telegram', 'drive'],
      },
    });

    expect(() => enforcer.check(withoutDrive, 'drive_browse', { folderId: 'folder-1' })).toThrow(
      /connector_out_of_scope/
    );
    expect(() => enforcer.check(withDrive, 'drive_browse', { folderId: 'folder-1' })).not.toThrow();
  });

  it('requires Drive uploads to target a host-authorized folder destination', () => {
    const base = makeEnvelope();
    const withFolder = makeEnvelope({
      scope: {
        ...base.scope,
        raw_connectors: [...base.scope.raw_connectors, 'drive'],
        allowed_destinations: [
          ...base.scope.allowed_destinations,
          { kind: 'drive', id: 'folder-1' } as never,
        ],
      },
    });

    expect(() =>
      enforcer.check(withFolder, 'drive_upload', {
        localPath: '/workspace/outbound/file.txt',
        folderId: 'folder-2',
      })
    ).toThrow(/destination_out_of_scope/);
    expect(() =>
      enforcer.check(withFolder, 'drive_upload', {
        localPath: '/workspace/outbound/file.txt',
        folderId: 'folder-1',
      })
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
    expect(() =>
      enforcer.check(
        makeEnvelope({
          tier: 3,
          scope: {
            ...env.scope,
            raw_connectors: [...env.scope.raw_connectors, 'drive'],
            allowed_destinations: [
              ...env.scope.allowed_destinations,
              { kind: 'drive', id: 'folder-1' } as never,
            ],
          },
        }),
        'drive_upload',
        { localPath: '/workspace/file.txt', folderId: 'folder-1' }
      )
    ).toThrow(/tier_violation/);
  });

  it('allows read tools at tier 3', () => {
    const env = makeEnvelope({ tier: 3 });

    expect(() =>
      enforcer.check(env, 'mama_search', { query: 'x', scopes: env.scope.memory_scopes })
    ).not.toThrow();
  });

  it('rejects null envelope', () => {
    expect(() =>
      // @ts-expect-error testing runtime guard
      enforcer.check(null, 'mama_search', { query: 'x' })
    ).toThrow(EnvelopeViolation);
  });
});
