/**
 * Shared board-authoring vocabulary (Kagemusha mechanism port).
 *
 * Every report producer (dashboard agent persona, its scheduled prompt, the
 * trigger loop's scheduled full report) injects THESE lines so the operator
 * board at /ui receives the same 4-slot, card-based HTML regardless of which
 * agent wrote it. The classes are styled by ui/src/styles/global.css --
 * agents write structure, the board owns look.
 *
 * Generic mechanism only: no personal strings, English source; the agent is
 * told to write CONTENT in the owner's language.
 */

export const BOARD_SLOT_ORDER = ['briefing', 'action_required', 'decisions', 'pipeline'] as const;

/** The exact HTML shapes the board stylesheet understands. */
export function buildBoardHtmlVocabulary(): string[] {
  return [
    'Slot HTML must use ONLY this class vocabulary (the board styles it; inline styles are unnecessary):',
    '- Summary header: <div class="report-summary"><div class="summary-title">TITLE</div>',
    '  <div class="summary-stats">label <span class="stat-highlight">N</span> / label <span class="stat-highlight">N</span></div></div>',
    '- Section heading: <div class="report-section-title">HEADING</div>',
    '- Item card: <div class="report-card"><div class="card-header"><div class="card-title">TITLE</div>',
    '  <span class="card-badge badge-warning">STATE</span></div>',
    '  <div class="card-tags"><span class="tag tag-channel">CHANNEL</span></div>',
    '  <div class="card-action">CONCRETE NEXT ACTION</div></div>',
    '- Workflow badge classes: badge-danger (blocked), badge-warning (waiting/needs confirmation),',
    '  badge-info (in progress), badge-success (done/quiet).',
    '- Temporal badges are separate facts: badge-danger (overdue), badge-warning (due today),',
    '  badge-info (upcoming), badge-success (closed).',
    '- Pipeline table: <table class="report-table"><thead><tr><th>...</th></tr></thead><tbody>rows</tbody></table>',
    'No <script>, <iframe>, or event handlers: the board sanitizes them out and the CSP blocks them.',
  ];
}

/**
 * Pipeline slot = item tracker projection (M8 Phase 3). Injected into EVERY
 * board writer (dashboard persona, cron prompt, the trigger loop's full
 * report) so both writers project the same tracker. The server-derived
 * temporal_state is the canonical time category; personas are static files
 * and must never recompute it from a baked-in date.
 */
export function buildPipelineTrackerInstructions(): string[] {
  return [
    'The pipeline slot is an ITEM TRACKER, not a summary. Build it from',
    'task_list({order: "deadline_priority", limit: 12}) -- the native task ledger is the',
    'projection source. Render one report-table with a row per open item:',
    '  #id | title | workflow status | temporal fact | D-day | assignee (or "unassigned") | source | latest event',
    '- Temporal fact: use temporal_state as the canonical category. Show exact_overdue as',
    '  "overdue since <due_at>" and date_overdue as "overdue since <deadline>".',
    '- Workflow judgment: render status independently; overdue never changes status to blocked.',
    '- System condition: report reconciliation retrying/authority unavailable separately; never',
    '  turn an infrastructure condition into a task lifecycle status.',
    '- D-day is an optional display aid computed from deadline and the run date; never use it',
    '  to replace or recompute temporal_state.',
    '- Never infer completion from calendar disappearance.',
    '- Never copy Trello or Kagemusha lifecycle status into the native ledger.',
    '- Unassigned AND due within 7 days -> badge-warning with the',
    '  literal word "unassigned" visible.',
    '- Items with auto_created true and confirmed false render "(unconfirmed)" after the title',
    '  so model-created items are visually distinct from owner-confirmed ones.',
    '- done/cancelled items never appear.',
    'When a briefing/action_required/decisions card refers to a tracked item, cite its #id.',
  ];
}

/** Instruction block that makes a report run also publish the board slots. */
export function buildBoardPublishLines(): string[] {
  return [
    'BEFORE writing your text report, update the operator board: call the report_publish',
    'gateway tool EXACTLY once with ALL four slots:',
    '  report_publish({ slots: { briefing: "<html>", action_required: "<html>", decisions: "<html>", pipeline: "<html>" } })',
    '- briefing: one report-summary block (title + stat highlights), then up to 4 item cards for the key situations.',
    '- action_required: a report-section-title, then up to 5 cards; every card-action states the concrete next step.',
    '- decisions: cards for items waiting on an owner decision or confirmation; omit filler when none exist,',
    '  but still publish the slot with a one-line quiet note.',
    ...buildPipelineTrackerInstructions(),
    ...buildBoardHtmlVocabulary(),
    "Write all slot CONTENT in the owner's language (match the channels); keep each slot under 6KB.",
    'The plain-text report you write afterwards is a separate output: no HTML in it.',
  ];
}
