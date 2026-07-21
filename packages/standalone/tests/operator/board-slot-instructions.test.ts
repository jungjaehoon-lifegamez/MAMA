/**
 * Board slot authoring vocabulary (Kagemusha mechanism port) -- the shared
 * instruction text that makes every report producer publish the same 4-slot,
 * card-based board HTML. Generic mechanism only; no personal strings.
 */

import { describe, it, expect } from 'vitest';
import {
  BOARD_SLOT_ORDER,
  buildBoardHtmlVocabulary,
  buildBoardPublishLines,
} from '../../src/operator/board-slot-instructions.js';

describe('board slot instructions', () => {
  it('pins the four-slot order the board renders', () => {
    expect([...BOARD_SLOT_ORDER]).toEqual(['briefing', 'action_required', 'decisions', 'pipeline']);
  });

  it('vocabulary names every CSS class the board stylesheet defines', () => {
    const vocab = buildBoardHtmlVocabulary().join('\n');
    for (const cls of [
      'report-summary',
      'summary-title',
      'summary-stats',
      'stat-highlight',
      'report-section-title',
      'report-card',
      'card-header',
      'card-title',
      'card-badge',
      'badge-danger',
      'badge-warning',
      'badge-info',
      'badge-success',
      'card-tags',
      'tag-channel',
      'card-action',
      'report-table',
    ]) {
      expect(vocab).toContain(cls);
    }
  });

  it('publish lines instruct one report_publish call carrying all four slots', () => {
    const lines = buildBoardPublishLines().join('\n');
    expect(lines).toContain('report_publish');
    for (const slot of BOARD_SLOT_ORDER) {
      expect(lines).toContain(slot);
    }
    // content language follows the owner, source stays English
    expect(lines.toLowerCase()).toContain("owner's language");
    // no scripts/styles: the board sanitizes and the CSP blocks them anyway
    expect(lines).toContain('class');
  });

  it('keeps temporal facts separate from workflow and system judgments', () => {
    const lines = buildBoardPublishLines().join('\n');
    expect(lines).toContain('temporal_state');
    expect(lines).toContain('Temporal fact');
    expect(lines).toContain('Workflow judgment');
    expect(lines).toContain('System condition');
    expect(lines).toContain('calendar disappearance');
    expect(lines).toContain('Never copy Trello or Kagemusha lifecycle status');
    expect(lines).toContain('D-day is an optional display aid');
    expect(lines).toContain('never use it');
    expect(lines).not.toContain('blocked/overdue');
  });
});
