import {
  assertNonEmptySourceRefs,
  serializeSourceRef,
  type SourceRef,
} from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import type {
  OperatorNoUpdateLedgerInput,
  OperatorNoUpdateLedgerRow,
} from './operator-commit-result.js';
import { requiredString } from './validation.js';

export function serializeRequiredSourceRefs(refs: readonly SourceRef[]): string[] {
  assertNonEmptySourceRefs(refs);
  return refs.map((ref) => serializeSourceRef(ref));
}

export function recordNoUpdate(
  db: SQLiteDatabase,
  input: OperatorNoUpdateLedgerInput
): OperatorNoUpdateLedgerRow {
  const noUpdateId = requiredString(input.noUpdateId, 'noUpdateId');
  const scopeKey = requiredString(input.scopeKey, 'scopeKey');
  const reason = requiredString(input.reason, 'reason');
  const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
  const sourceRefs = serializeRequiredSourceRefs(input.sourceRefs);
  const createdAtMs = input.nowMs ?? Date.now();

  db.prepare(
    `INSERT INTO operator_no_updates (
      no_update_id, scope_key, reason, source_refs_json, idempotency_key, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(noUpdateId, scopeKey, reason, JSON.stringify(sourceRefs), idempotencyKey, createdAtMs);

  return {
    noUpdateId,
    scopeKey,
    reason,
    sourceRefs,
    idempotencyKey,
    createdAtMs,
  };
}
