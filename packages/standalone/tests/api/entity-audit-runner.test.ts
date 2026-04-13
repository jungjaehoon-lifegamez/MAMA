import { beforeEach, describe, expect, it } from 'vitest';
import { resolveEntityAuditFixturesPath } from '../../src/api/entity-audit-runner.js';
import { resolve } from 'node:path';

const RUNTIME_FIXTURES = resolve(process.cwd(), 'templates/entity-audit-fixtures');
const LEGACY_FIXTURES = resolve(process.cwd(), '../mama-core/tests/entities/fixtures');

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
    const resolved = resolveEntityAuditFixturesPath(LEGACY_FIXTURES);
    expect(resolved).toBe(LEGACY_FIXTURES);
  });

  it('AC #2: falls back to env var when fixturesPath argument is absent', () => {
    process.env.MAMA_ENTITY_AUDIT_FIXTURES_PATH = LEGACY_FIXTURES;
    const resolved = resolveEntityAuditFixturesPath();
    expect(resolved).toBe(LEGACY_FIXTURES);
  });

  it('AC #3: throws a clear error when the configured fixtures path does not exist', () => {
    expect(() => resolveEntityAuditFixturesPath('/tmp/does-not-exist-entity-fixtures')).toThrow(
      /fixtures path/i
    );
  });

  it('AC #4: uses the packaged runtime fixtures by default', () => {
    delete process.env.MAMA_ENTITY_AUDIT_FIXTURES_PATH;
    const resolved = resolveEntityAuditFixturesPath();
    expect(resolved).toBe(RUNTIME_FIXTURES);
  });
});
