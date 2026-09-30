/**
 * Shared board-authoring vocabulary.
 *
 * Every report producer (dashboard agent persona, its scheduled prompt, the
 * trigger loop's scheduled full report) injects THESE lines so the operator
 * report store receives the same 4-slot, card-based HTML regardless of which agent wrote it.
 * Agents write structure while report consumers own presentation.
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
    '  <div class="card-meta">WHEN</div>',
    '  <div class="card-action">CONCRETE NEXT ACTION</div></div>',
    '- card-meta is required on every card: the source time of the latest change the card reports,',
    "  in the owner's timezone stated by the turn, as month/day and HH:mm (for example 9/26 17:54), plus the due date when one exists.",
    '- Workflow badge classes: badge-danger (blocked), badge-warning (waiting/needs confirmation),',
    '  badge-info (in progress), badge-success (done/quiet).',
    '- Temporal badges are separate facts: badge-danger (overdue), badge-warning (due today),',
    '  badge-info (upcoming), badge-success (closed).',
    '- Pipeline table: <table class="report-table"><thead><tr><th>...</th></tr></thead><tbody>rows</tbody></table>',
    'The board sanitizes script, iframe, object, embed, form, link, meta and base tags plus event',
    'handlers out of every slot; inline styles fight the board stylesheet, so do not write them.',
  ];
}

/**
 * Per-slot shape the board expects. Single source for the legacy persona's
 * publish block and for the report.publish contract the standing owner
 * runtime reads through tool_describe at publish time.
 */
export function buildBoardSlotShapeLines(): string[] {
  return [
    '- pipeline: the agent-written current workflow table.',
    '- briefing: one report-summary block (title + stat highlights), then report-cards for the key situations only.',
    '- action_required: a report-section-title, then report-cards for what needs action now, most urgent first; every card-action states the concrete next step.',
    '- decisions: report-cards for items waiting on an owner decision or confirmation; omit filler when none exist,',
    '  but still publish the slot with a one-line quiet note.',
  ];
}

/**
 * The report.publish summary. The board's class vocabulary belongs
 * with the tool that publishes it, not in per-turn prompt text: an agent that
 * describes report.publish before calling it learns the shape the board styles.
 */
export function buildReportPublishToolContract(): string {
  const inline = (lines: string[]): string => lines.join(' ').replace(/\s+/g, ' ').trim();
  return inline([
    'Publish dashboard analysis as HTML.',
    'SLOT SHAPE:',
    ...buildBoardSlotShapeLines(),
    ...buildBoardHtmlVocabulary(),
    "Write slot CONTENT in the owner's language.",
    'A slot that contains none of report-summary / report-card / report-section-title / report-table',
    'is still published, but the result reports it back as a',
    'warning because the board renders it as plain text.',
  ]);
}

/**
 * The STRUCTURAL block classes: the ones the board stylesheet needs in order to
 * render a slot as a board block rather than plain text. Sub-element classes
 * (card-header, card-title, card-badge, badge-*, tag-*, summary-*) only decorate
 * a structural block, so they prove nothing on their own -- the live 19:59/20:06
 * slots carried `card`/`card-grid`/`badge-info` and still rendered unstyled.
 * Single source: `boardHtmlClassVocabulary().structural`.
 */
const BOARD_STRUCTURAL_CLASSES = [
  'report-summary',
  'report-section-title',
  'report-card',
  'report-table',
] as const;

/**
 * The class tokens the board stylesheet understands, derived from the SAME
 * vocabulary text the agent is shown. There is no second copy of the list: if
 * a class is added to buildBoardHtmlVocabulary() it becomes recognised here.
 * `structural` marks the subset that makes a slot count as board HTML.
 */
export function boardHtmlClassVocabulary(): Set<string> & { structural: Set<string> } {
  const classes = new Set<string>();
  for (const line of buildBoardHtmlVocabulary()) {
    for (const match of line.matchAll(/class="([^"]*)"/g)) {
      for (const token of match[1].split(/\s+/)) {
        if (token) classes.add(token);
      }
    }
    // badge-*/tag-* variants are enumerated in prose, not inside a class attribute.
    for (const match of line.matchAll(/\b(?:badge|tag)-[a-z]+\b/g)) {
      classes.add(match[0]);
    }
  }
  // The structural names must actually appear in the vocabulary the agent is
  // shown; a silent drift would make the predicate unreachable.
  const structural = new Set<string>();
  for (const name of BOARD_STRUCTURAL_CLASSES) {
    if (!classes.has(name)) {
      throw new Error(`Board vocabulary text no longer contains structural class ${name}`);
    }
    structural.add(name);
  }
  return Object.assign(classes, { structural });
}

/** The structural block classes, in vocabulary order. */
export function boardStructuralClasses(): readonly string[] {
  return BOARD_STRUCTURAL_CLASSES;
}

/**
 * True when slot HTML carries at least one STRUCTURAL board class token.
 * Exact: only class attribute tokens count, never substrings of prose. A slot
 * built out of sub-element classes alone (badge-*, tag-*, summary-*, card-*)
 * does NOT pass -- the board renders it as plain text.
 */
export function htmlUsesBoardVocabulary(html: string): boolean {
  if (typeof html !== 'string' || html.length === 0) return false;
  const { structural } = boardHtmlClassVocabulary();
  for (const match of html.matchAll(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const value = match[1] ?? match[2] ?? '';
    for (const token of value.split(/\s+/)) {
      if (token && structural.has(token)) return true;
    }
  }
  return false;
}
