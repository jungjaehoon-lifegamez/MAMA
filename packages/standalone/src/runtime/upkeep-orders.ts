import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';

/**
 * Ledger upkeep orders (docs/development/work/ledger-upkeep.md). The host chooses the subjects,
 * the agent judges and writes in the common session, and the host checks each subject when the
 * order's run ends. Record orders (record-orders.ts) stay a separate lane: they follow live deltas
 * and carry batches; upkeep follows the ledger's own state.
 *
 *   tick(kind) ── scan ──> subjects not checked, not in an open order, under the attempt limit
 *        │                          │
 *        │                  accept(order on kind.channel)
 *        ▼                          ▼
 *   onResult / onLost ──> per subject: checked │ waiting (picked by the next tick) │ lost
 *
 * Checked and lost subjects are also written to upkeep_settled: the mailbox deletes acked order
 * rows after seven days, and a settled subject must never be ordered again.
 */

/** A subject is ordered at most this many times; then it is reported lost and left alone. */
export const UPKEEP_MAX_ATTEMPTS = 3;
/** How far back stored orders are read to count a subject's attempts. */
export const UPKEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Candidates per scan page. */
export const UPKEEP_SCAN_PAGE = 200;

/** Every order of a kind has an id with this prefix; its runs carry it as sourceMessageRef. */
export function upkeepOrderIdPrefix(kindName: string): string {
  return `upkeep:${kindName}:`;
}

export interface UpkeepSubject {
  /** Stable per subject: the same fact always gets the same key. */
  key: string;
  [field: string]: JsonValue;
}

export interface UpkeepKind {
  name: string;
  /** The order's mailbox channel, `operator:<name>`. */
  channel: string;
  /** How often the host scans. */
  intervalMs: number;
  maxPerOrder: number;
  /**
   * The subject's group, when the kind's subjects come in kinds of their own: maxPerOrder then
   * bounds each group, so one group never starves the other.
   */
  group?(subject: UpkeepSubject): string;
  /**
   * Candidate subjects, oldest first, one page at a time: the runner reads further pages while
   * settled subjects fill the earlier ones.
   */
  scan(adapter: DatabaseAdapter, now: number, page: number): UpkeepSubject[];
  /** Whether the subject's work is done, judged from the runs of the orders that carried it. */
  checked(adapter: DatabaseAdapter, subject: UpkeepSubject, runIds: readonly string[]): boolean;
  render(subjects: readonly UpkeepSubject[], now: Date): string;
}

export interface UpkeepOrderPayload {
  order: 'upkeep';
  kind: string;
  subjects: UpkeepSubject[];
}

export type UpkeepEvent =
  | { type: 'ordered'; kind: string; order: string; subjects: number }
  | { type: 'checked'; kind: string; subject: string }
  /** The subject is picked again by the kind's next tick. */
  | { type: 'waiting'; kind: string; subject: string; attempt: number; reason: string }
  | { type: 'lost'; kind: string; subject: string; attempt: number; reason: string };

export interface UpkeepOrdersOptions {
  adapter: DatabaseAdapter;
  accept(stimulus: Omit<Stimulus, 'principalId'>): StimulusReceipt;
  kinds: readonly UpkeepKind[];
  /** When this daemon process started: runs begun earlier can no longer write. */
  processStartedAt: number;
  onEvent?(event: UpkeepEvent): void;
  /** How long to wait for an order run's child runs to end before checking. */
  childWaitMs?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** The first scan after start, so work closed while the daemon was down is not left an hour. */
  firstTickDelayMs?: number;
}

export interface UpkeepOrders {
  isUpkeepRow(row: Pick<MailboxRow, 'kind' | 'channelKey'>): boolean;
  render(row: MailboxRow, now: Date): string;
  onResult(row: MailboxRow, modelRunId: string | null): void;
  /** An order row that went uncertain or dead: the same check, run at once. */
  onLost(row: MailboxRow, reason: string): void;
  /** Scan one kind and place its next order; at most one open order per kind. */
  tick(kindName: string): void;
  start(): void;
  stop(): void;
}

export function parseUpkeepOrder(payload: JsonValue | undefined): UpkeepOrderPayload {
  const value = payload as Partial<UpkeepOrderPayload> | null | undefined;
  if (
    !value ||
    value.order !== 'upkeep' ||
    typeof value.kind !== 'string' ||
    !Array.isArray(value.subjects) ||
    value.subjects.length === 0 ||
    value.subjects.some((subject) => typeof subject?.key !== 'string' || subject.key === '')
  )
    throw new Error('Upkeep order requires { order: upkeep, kind, subjects: [{ key }] }');
  return value as UpkeepOrderPayload;
}

/** The runs an order produced: its own turn and the child runs that turn started. */
export function orderRunIds(adapter: DatabaseAdapter, orderIds: readonly string[]): string[] {
  if (orderIds.length === 0) return [];
  const marks = orderIds.map(() => '?').join(',');
  return (
    adapter
      .prepare(
        `SELECT r.model_run_id AS id FROM model_runs r
          WHERE json_extract(r.input_refs_json, '$.sourceMessageRef') IN (${marks})
         UNION
         SELECT c.model_run_id FROM model_runs c JOIN model_runs p ON c.parent_model_run_id = p.model_run_id
          WHERE json_extract(p.input_refs_json, '$.sourceMessageRef') IN (${marks})`
      )
      .all(...orderIds, ...orderIds) as Array<{ id: string }>
  ).map((row) => row.id);
}

/**
 * A completed work.no_update in these runs. With `cites`, the no-update must name one of the
 * values in that input field (`commitmentIds` for a work item, `observationRefs` for a source);
 * with `cites` null, any no-update in the runs counts. The field name is a fixed union, never
 * caller text, so it interpolates into the json path safely.
 */
export function noUpdateCites(
  adapter: DatabaseAdapter,
  runIds: readonly string[],
  cites: { field: 'commitmentIds' | 'observationRefs'; values: readonly string[] } | null
): boolean {
  if (runIds.length === 0) return false;
  if (cites !== null && cites.values.length === 0) return false;
  const citing =
    cites === null
      ? ''
      : `AND EXISTS (
            SELECT 1 FROM json_each(CASE WHEN json_valid(t.input_summary)
                THEN json_extract(t.input_summary, '$.${cites.field}') END) ref
             WHERE ref.value IN (${cites.values.map(() => '?').join(',')}))`;
  return (
    adapter
      .prepare(
        `SELECT 1 FROM tool_traces t
          WHERE t.tool_name = 'work.no_update' AND t.execution_status = 'completed'
            AND t.model_run_id IN (${runIds.map(() => '?').join(',')})
            ${citing}
          LIMIT 1`
      )
      .get(...runIds, ...(cites?.values ?? [])) !== undefined
  );
}

interface SubjectState {
  subject: UpkeepSubject;
  /** Every order that carried the subject, oldest first. */
  orders: string[];
  /** An order carrying it is still queued or running. */
  open: boolean;
}

/** The kind's subjects as its stored orders of the last week show them. */
function storedSubjects(adapter: DatabaseAdapter, kind: UpkeepKind, now: number) {
  const rows = adapter
    .prepare(
      `SELECT m.stimulus_id, m.payload_json, m.status, n.state AS native_state
         FROM mailbox_inputs m LEFT JOIN native_input_deliveries n ON n.input_id = m.id
        WHERE m.kind = 'scheduled' AND m.channel_key = ? AND m.created_at >= ?
        ORDER BY m.created_at, m.id`
    )
    .all(kind.channel, now - UPKEEP_WINDOW_MS) as Array<{
    stimulus_id: string;
    payload_json: string;
    status: string;
    native_state: string | null;
  }>;
  const states = new Map<string, SubjectState>();
  let anyOpen = false;
  for (const row of rows) {
    const order = parseUpkeepOrder(JSON.parse(row.payload_json) as JsonValue);
    // A row parked uncertain stays claimed; it is settled through onLost, not left open.
    const open =
      (row.status === 'pending' || row.status === 'claimed') && row.native_state !== 'uncertain';
    anyOpen ||= open;
    for (const subject of order.subjects) {
      const current = states.get(subject.key);
      states.set(subject.key, {
        subject,
        orders: [...(current?.orders ?? []), row.stimulus_id],
        open: (current?.open ?? false) || open,
      });
    }
  }
  return { states, anyOpen };
}

/** Child runs of an order run that this process started and that have not ended yet. */
export function runningChildren(
  adapter: DatabaseAdapter,
  modelRunId: string,
  startedAt: number
): number {
  const row = adapter
    .prepare(
      `SELECT count(*) AS n FROM model_runs
        WHERE parent_model_run_id = ? AND status NOT IN ('committed', 'failed') AND created_at >= ?`
    )
    .get(modelRunId, startedAt) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function createUpkeepOrders(options: UpkeepOrdersOptions): UpkeepOrders {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const childWaitMs = options.childWaitMs ?? 10 * 60 * 1000;
  const byName = new Map(options.kinds.map((kind) => [kind.name, kind]));
  const byChannel = new Map(options.kinds.map((kind) => [kind.channel, kind]));
  const timers: Array<{ cancel(): void }> = [];
  // Orders whose check is still waiting for child runs: their subjects are not ordered again yet.
  const checking = new Set<string>();
  // An order is settled once: a row parked uncertain and then closed reports here twice.
  const settledOrders = new Set<string>();
  let stopped = false;

  const kindOf = (row: Pick<MailboxRow, 'channelKey'>): UpkeepKind => {
    const kind = byChannel.get(row.channelKey);
    if (!kind) throw new Error(`No upkeep kind serves channel ${row.channelKey}`);
    return kind;
  };

  const settle = (
    kind: UpkeepKind,
    orderId: string,
    order: UpkeepOrderPayload,
    reason: string
  ): void => {
    if (settledOrders.has(orderId)) return;
    settledOrders.add(orderId);
    const at = now();
    const { states } = storedSubjects(options.adapter, kind, at);
    const record = options.adapter.prepare(
      `INSERT OR REPLACE INTO upkeep_settled (kind, subject_key, state, settled_at) VALUES (?, ?, ?, ?)`
    );
    for (const subject of order.subjects) {
      const orders = states.get(subject.key)?.orders ?? [];
      if (kind.checked(options.adapter, subject, orderRunIds(options.adapter, orders))) {
        record.run(kind.name, subject.key, 'checked', at);
        options.onEvent?.({ type: 'checked', kind: kind.name, subject: subject.key });
        continue;
      }
      const attempt = orders.length;
      if (attempt >= UPKEEP_MAX_ATTEMPTS) {
        record.run(kind.name, subject.key, 'lost', at);
        options.onEvent?.({ type: 'lost', kind: kind.name, subject: subject.key, attempt, reason });
      } else
        options.onEvent?.({
          type: 'waiting',
          kind: kind.name,
          subject: subject.key,
          attempt,
          reason,
        });
    }
  };

  const tick = (kindName: string): void => {
    const kind = byName.get(kindName);
    if (!kind) throw new Error(`Unknown upkeep kind ${kindName}`);
    if (stopped) return;
    const at = now();
    const { states, anyOpen } = storedSubjects(options.adapter, kind, at);
    // One order of a kind at a time keeps the common session's queue for the owner; an order whose
    // child runs may still write is not over yet.
    if (anyOpen || [...checking].some((id) => id.startsWith(upkeepOrderIdPrefix(kind.name))))
      return;
    const settled = new Set(
      (
        options.adapter
          .prepare(`SELECT subject_key FROM upkeep_settled WHERE kind = ?`)
          .all(kind.name) as Array<{ subject_key: string }>
      ).map((row) => row.subject_key)
    );
    const due: UpkeepSubject[] = [];
    const perGroup = new Map<string, number>();
    const candidates = function* (): Generator<UpkeepSubject> {
      for (let page = 0; ; page += 1) {
        const rows = kind.scan(options.adapter, at, page);
        yield* rows;
        if (rows.length < UPKEEP_SCAN_PAGE) return;
      }
    };
    for (const subject of candidates()) {
      if (kind.group === undefined && due.length >= kind.maxPerOrder) break;
      const group = kind.group?.(subject);
      if (group !== undefined && (perGroup.get(group) ?? 0) >= kind.maxPerOrder) continue;
      if (settled.has(subject.key)) continue;
      const state = states.get(subject.key);
      const orders = state?.orders ?? [];
      // Reported lost when its last order was settled; it is never ordered again.
      if (orders.length >= UPKEEP_MAX_ATTEMPTS) continue;
      if (
        orders.length > 0 &&
        kind.checked(options.adapter, subject, orderRunIds(options.adapter, orders))
      )
        continue;
      due.push(subject);
      if (group !== undefined) perGroup.set(group, (perGroup.get(group) ?? 0) + 1);
    }
    if (due.length === 0) return;
    const id = `${upkeepOrderIdPrefix(kind.name)}${at}:${randomUUID().slice(0, 8)}`;
    const payload: UpkeepOrderPayload = { order: 'upkeep', kind: kind.name, subjects: due };
    const receipt = options.accept({
      id,
      kind: 'scheduled',
      channelKey: kind.channel,
      occurredAt: at,
      payload: payload as unknown as Stimulus['payload'],
    });
    if (receipt.state !== 'duplicate')
      options.onEvent?.({ type: 'ordered', kind: kind.name, order: id, subjects: due.length });
  };

  return {
    isUpkeepRow: (row) => row.kind === 'scheduled' && byChannel.has(row.channelKey),
    render: (row, at) => kindOf(row).render(parseUpkeepOrder(row.payload).subjects, at),
    // The check waits for child runs in the background so the owner's queue is never held.
    onResult: (row, modelRunId) => {
      const kind = kindOf(row);
      const order = parseUpkeepOrder(row.payload);
      checking.add(row.stimulusId);
      void (async () => {
        if (modelRunId !== null) {
          const deadline = Date.now() + childWaitMs;
          while (
            !stopped &&
            runningChildren(options.adapter, modelRunId, options.processStartedAt) > 0 &&
            Date.now() < deadline
          )
            await sleep(5_000);
        }
        if (stopped) return;
        settle(
          kind,
          row.stimulusId,
          order,
          'the order ended without the expected write or a no-update naming it'
        );
      })()
        .catch((error: unknown) => {
          // A check cut off by shutdown is not a loss: the next tick finds the subject again.
          if (stopped) return;
          for (const subject of order.subjects)
            options.onEvent?.({
              type: 'lost',
              kind: kind.name,
              subject: subject.key,
              attempt: 0,
              reason: `upkeep check failed: ${error instanceof Error ? error.message : String(error)}`,
            });
        })
        .finally(() => checking.delete(row.stimulusId));
    },
    onLost: (row, reason) => {
      const kind = kindOf(row);
      settle(kind, row.stimulusId, parseUpkeepOrder(row.payload), reason);
    },
    tick,
    start: () => {
      if (timers.length > 0 || stopped) return;
      for (const kind of options.kinds) {
        const run = () => {
          try {
            tick(kind.name);
          } catch (error) {
            // A scan that fails names its kind; no subject was ordered, so the next scan retries.
            options.onEvent?.({
              type: 'lost',
              kind: kind.name,
              subject: '*',
              attempt: 0,
              reason: `upkeep scan failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        };
        const first = setTimeout(run, options.firstTickDelayMs ?? 60_000);
        const every = setInterval(run, kind.intervalMs);
        first.unref?.();
        every.unref?.();
        timers.push({ cancel: () => clearTimeout(first) }, { cancel: () => clearInterval(every) });
      }
    },
    stop: () => {
      stopped = true;
      for (const timer of timers.splice(0)) timer.cancel();
    },
  };
}
