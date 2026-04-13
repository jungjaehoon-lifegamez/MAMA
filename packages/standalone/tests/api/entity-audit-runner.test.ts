import { beforeEach, describe, expect, it } from 'vitest';
import { resolveEntityAuditFixturesPath } from '../../src/api/entity-audit-runner.js';
import { resolve } from 'node:path';

const LOCAL_FIXTURES = resolve(process.cwd(), '../mama-core/tests/entities/fixtures');

describe('Story E1.11A: entity audit runner fixture resolution', () => {
  const previousEnv = process.env.MAMA_ENTITY_AUDIT_FIXTURES_PATH;

  beforeEach(() => {
    if (previousEnv === undefined) {
      delete process.env.MAMA_ENTITY_AUDIT_FIXTURES_PATH;
    } else {
      process.env.MAMA_ENTITY_AUDIT_FIXTURES_PATH = previousEnv;
    }
  });

  it('AC #1: prefers an explicit fixturesPath argument', () => {
    const resolved = resolveEntityAuditFixturesPath(LOCAL_FIXTURES);
    expect(resolved).toBe(LOCAL_FIXTURES);
  });

  it('AC #2: falls back to env var when fixturesPath argument is absent', () => {
    process.env.MAMA_ENTITY_AUDIT_FIXTURES_PATH = LOCAL_FIXTURES;
    const resolved = resolveEntityAuditFixturesPath();
    expect(resolved).toBe(LOCAL_FIXTURES);
  });

  it('AC #3: throws a clear error when the configured fixtures path does not exist', () => {
    expect(() => resolveEntityAuditFixturesPath('/tmp/does-not-exist-entity-fixtures')).toThrow(
      /fixtures path/i
    );
  });
});
