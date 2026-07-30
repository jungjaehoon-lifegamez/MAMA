/**
 * Name the hashed failure digests (S2 Task 0, report-only — no writes).
 *
 * Sanitized traces read `gateway_tool_failed;sha256=<digest>;length=N`. The
 * ORIGINAL messages still exist in agent_activity rows written by unsanitized
 * surfaces — hashing every distinct error_message against the top digests
 * names them. 2026-07-31 run named all three dominant digests:
 *   e4f04370 = [memory_scope_out_of_scope] Envelope policy denied this tool call
 *   fb98ff8e = context_compile failed: Context ref kind must be a string
 *   f9242e19 = [connector_out_of_scope] Envelope policy denied this tool call
 * Forward-looking data no longer needs this: tool_traces.failure_code carries
 * the thrower's code from v0.31.0 on.
 *
 * Run: npx tsx scripts/crack-failure-digests.ts [~/.mama/mama-sessions.db]
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.argv[2] ?? join(homedir(), '.mama', 'mama-sessions.db');
const db = new Database(dbPath, { readonly: true });

const digestRows = db
  .prepare(
    `SELECT substr(COALESCE(error_message, output_summary, ''),
                   instr(COALESCE(error_message, output_summary, ''), 'sha256=') + 7, 64) AS digest,
            COUNT(*) AS n
       FROM agent_activity
      WHERE COALESCE(error_message, output_summary, '') LIKE '%sha256=%'
      GROUP BY digest ORDER BY n DESC LIMIT 10`
  )
  .all() as Array<{ digest: string; n: number }>;

const candidates = db
  .prepare(
    `SELECT DISTINCT error_message FROM agent_activity
      WHERE error_message IS NOT NULL AND length(error_message) BETWEEN 10 AND 300`
  )
  .all() as Array<{ error_message: string }>;

const byHash = new Map<string, string>();
for (const { error_message } of candidates) {
  byHash.set(createHash('sha256').update(error_message).digest('hex'), error_message);
}

for (const { digest, n } of digestRows) {
  const named = byHash.get(digest);
  console.log(
    named
      ? `${digest.slice(0, 8)} x${n} = ${JSON.stringify(named)}`
      : `${digest.slice(0, 8)} x${n} = (unnamed - widen the candidate window or check daemon logs)`
  );
}
db.close();
