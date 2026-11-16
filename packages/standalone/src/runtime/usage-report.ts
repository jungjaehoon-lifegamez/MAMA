import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { BackendLimits } from '@jungjaehoon/mama-core/runtime/backend-limits';
import { epochAtLocalDateTime, localDateKey } from './timezone.js';

/**
 * What each person's sessions used, from the runs and tool traces the daemon already records:
 * runs and tokens today and over the last seven days, per session, and the actions they ran by
 * tool name. No run input, output or trace text is read. Erased rows are left out.
 */

export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface SessionUsage extends UsageTotals {
  session: string;
}

export interface PersonUsage {
  /** `owner-agent` is the common session; a person's sessions are `member-agent:<principal>`. */
  agentId: string;
  principalId: string | null;
  name: string;
  today: UsageTotals;
  week: UsageTotals;
  /** The last seven days, most tokens first. */
  sessions: SessionUsage[];
  /** The last seven days, most used first. */
  actions: Array<{ tool: string; count: number }>;
}

export interface UsageReport {
  /** Start of today in the configured time zone, epoch milliseconds. */
  dayStart: number;
  /** Start of the seven-day window, epoch milliseconds. */
  weekStart: number;
  people: PersonUsage[];
}

const COMMON_AGENT_ID = 'owner-agent';
const MEMBER_AGENT_PREFIX = 'member-agent:';
const DAY_MS = 86_400_000;

function empty(): UsageTotals {
  return { runs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

function add(totals: UsageTotals, row: UsageTotals): void {
  totals.runs += row.runs;
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  totals.cachedTokens += row.cachedTokens;
}

/** `agentIds` limits the report to those sessions; omitted, every person is read. */
export function readUsage(
  adapter: DatabaseAdapter,
  now: number,
  timeZone: string,
  agentIds?: readonly string[]
): UsageReport {
  const dayStart = epochAtLocalDateTime(`${localDateKey(now, timeZone)}T00:00:00`, timeZone);
  const weekStart = dayStart - 6 * DAY_MS;
  const listed = agentIds === undefined ? null : agentIds.map(() => '?').join(', ') || 'NULL';
  const runFilter = listed === null ? '' : ` AND agent_id IN (${listed})`;
  const traceFilter = listed === null ? '' : ` AND m.agent_id IN (${listed})`;
  const runs = adapter
    .prepare(
      `SELECT agent_id AS agentId, COALESCE(instance_id, '') AS session,
              SUM(created_at >= ?) AS todayRuns,
              SUM(CASE WHEN created_at >= ? THEN COALESCE(input_tokens, 0) ELSE 0 END) AS todayInput,
              SUM(CASE WHEN created_at >= ? THEN COALESCE(output_tokens, 0) ELSE 0 END) AS todayOutput,
              SUM(CASE WHEN created_at >= ? THEN COALESCE(cache_read_input_tokens, 0) ELSE 0 END) AS todayCached,
              COUNT(*) AS runs, SUM(COALESCE(input_tokens, 0)) AS inputTokens,
              SUM(COALESCE(output_tokens, 0)) AS outputTokens,
              SUM(COALESCE(cache_read_input_tokens, 0)) AS cachedTokens
         FROM model_runs
        WHERE created_at >= ? AND erased_at IS NULL${runFilter}
        GROUP BY agent_id, instance_id`
    )
    .all(dayStart, dayStart, dayStart, dayStart, weekStart, ...(agentIds ?? [])) as Array<
    SessionUsage & {
      agentId: string;
      todayRuns: number;
      todayInput: number;
      todayOutput: number;
      todayCached: number;
    }
  >;
  const actions = adapter
    .prepare(
      `SELECT m.agent_id AS agentId, t.tool_name AS tool, COUNT(*) AS count
         FROM model_runs m JOIN tool_traces t ON t.model_run_id = m.model_run_id
        WHERE m.created_at >= ? AND m.erased_at IS NULL AND t.erased_at IS NULL${traceFilter}
        GROUP BY m.agent_id, t.tool_name ORDER BY count DESC, tool`
    )
    .all(weekStart, ...(agentIds ?? [])) as Array<{ agentId: string; tool: string; count: number }>;
  const names = new Map(
    (
      adapter
        .prepare(`SELECT principal_id AS id, display_name AS name FROM principals`)
        .all() as Array<{
        id: string;
        name: string | null;
      }>
    ).map((row) => [row.id, row.name])
  );

  const people = new Map<string, PersonUsage>();
  const person = (agentId: string): PersonUsage => {
    let found = people.get(agentId);
    if (!found) {
      const principalId = agentId.startsWith(MEMBER_AGENT_PREFIX)
        ? agentId.slice(MEMBER_AGENT_PREFIX.length)
        : null;
      found = {
        agentId,
        principalId,
        name:
          agentId === COMMON_AGENT_ID
            ? 'common session'
            : ((principalId !== null ? names.get(principalId) : null) ?? principalId ?? agentId),
        today: empty(),
        week: empty(),
        sessions: [],
        actions: [],
      };
      people.set(agentId, found);
    }
    return found;
  };
  for (const row of runs) {
    const entry = person(row.agentId);
    add(entry.today, {
      runs: row.todayRuns,
      inputTokens: row.todayInput,
      outputTokens: row.todayOutput,
      cachedTokens: row.todayCached,
    });
    const session: SessionUsage = {
      session: row.session,
      runs: row.runs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
    };
    add(entry.week, session);
    entry.sessions.push(session);
  }
  for (const row of actions) person(row.agentId).actions.push({ tool: row.tool, count: row.count });
  for (const entry of people.values())
    entry.sessions.sort(
      (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
    );
  return {
    dayStart,
    weekStart,
    people: [...people.values()].sort(
      (a, b) =>
        Number(b.agentId === COMMON_AGENT_ID) - Number(a.agentId === COMMON_AGENT_ID) ||
        b.week.inputTokens + b.week.outputTokens - (a.week.inputTokens + a.week.outputTokens)
    ),
  };
}

/** A token count for a line of text: 1234567 → 1.2M. */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function totalsText(totals: UsageTotals): string {
  return `${totals.runs} runs, ${compactTokens(totals.inputTokens)} in (${compactTokens(totals.cachedTokens)} cached), ${compactTokens(totals.outputTokens)} out`;
}

/** One line per person: today, and the last seven days. */
export function usageLines(report: UsageReport | undefined): string[] {
  if (!report) return [];
  if (report.people.length === 0) return ['usage: no runs in the last 7 days'];
  return report.people.map(
    (person) =>
      `usage ${person.name}: today ${totalsText(person.today)}; 7 days ${totalsText(person.week)}`
  );
}

/** What each backend login has left, as its CLI last reported it. */
export function limitLines(
  limits: readonly BackendLimits[] | undefined,
  time: (ms: number) => string
): string[] {
  if (!limits) return [];
  if (limits.length === 0) return ['limit: not reported yet (each CLI reports it during a turn)'];
  return limits.map(
    (limit) =>
      `limit ${limit.backend}: ` +
      limit.windows
        .map(
          (window) =>
            `${window.window} ${window.usedPercent}% used` +
            (window.resetsAt === null ? '' : `, resets ${time(window.resetsAt)}`)
        )
        .join('; ') +
      ` (reported ${time(limit.observedAt)})`
  );
}
