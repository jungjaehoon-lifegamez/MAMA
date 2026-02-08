import { describe, it, expect } from 'vitest';
import { TodoTracker } from '../../src/enforcement/todo-tracker.js';
import type { TodoTrackerResult } from '../../src/enforcement/todo-tracker.js';

describe('Story M3.5: TodoTracker — Task Completion Detection', () => {
  const tracker = new TodoTracker();

  describe('AC #1: Disabled tracker passes everything through', () => {
    it('TT-001: should return allComplete=true when disabled', () => {
      const disabledTracker = new TodoTracker({ enabled: false });
      const result: TodoTrackerResult = disabledTracker.checkCompletion(
        'incomplete response with no markers',
        'EXPECTED OUTCOME:\n- Item one\n- Item two'
      );

      expect(result.allComplete).toBe(true);
      expect(result.completionMarkers).toEqual([]);
      expect(result.pendingItems).toEqual([]);
      expect(result.reminder).toBe('');
    });

    it('TT-001b: disabled tracker ignores expected outcome entirely', () => {
      const disabledTracker = new TodoTracker({ enabled: false });
      const result = disabledTracker.checkCompletion('', 'EXPECTED OUTCOME:\n- Critical task');

      expect(result.allComplete).toBe(true);
      expect(result.pendingItems).toEqual([]);
    });
  });

  describe('AC #2: Detects English completion markers', () => {
    it('TT-002a: should detect DONE marker', () => {
      const result = tracker.checkCompletion('All tasks are DONE.');

      expect(result.completionMarkers).toContain('DONE');
    });

    it('TT-002b: should detect TASK_COMPLETE marker', () => {
      const result = tracker.checkCompletion('Status: TASK_COMPLETE');

      expect(result.completionMarkers).toContain('TASK_COMPLETE');
    });

    it('TT-002c: should detect finished and completed markers', () => {
      const result = tracker.checkCompletion(
        'I have finished the implementation. All tests completed.'
      );

      expect(result.completionMarkers).toContain('finished');
      expect(result.completionMarkers).toContain('completed');
    });

    it('TT-002d: should detect all done marker', () => {
      const result = tracker.checkCompletion('Everything is all done now.');

      expect(result.completionMarkers).toContain('all done');
    });
  });

  describe('AC #3: Detects Korean completion markers', () => {
    it('TT-003a: should detect 완료 marker', () => {
      const result = tracker.checkCompletion('작업이 완료되었습니다.');

      expect(result.completionMarkers).toContain('완료');
    });

    it('TT-003b: should detect 끝 marker', () => {
      const result = tracker.checkCompletion('모든 작업이 끝났습니다.');

      expect(result.completionMarkers).toContain('끝');
    });

    it('TT-003c: should detect 다 했습니다 marker', () => {
      const result = tracker.checkCompletion('다 했습니다. 확인해 주세요.');

      expect(result.completionMarkers).toContain('다 했습니다');
    });

    it('TT-003d: should detect 작업 완료 marker', () => {
      const result = tracker.checkCompletion('작업 완료했습니다.');

      expect(result.completionMarkers).toContain('작업 완료');
    });
  });

  describe('AC #4: Detects symbol completion markers (✓, ✅, [x])', () => {
    it('TT-004a: should detect ✓ checkmark', () => {
      const result = tracker.checkCompletion('✓ All tests passing');

      expect(result.completionMarkers).toContain('✓');
    });

    it('TT-004b: should detect ✅ emoji', () => {
      const result = tracker.checkCompletion('✅ Build succeeded');

      expect(result.completionMarkers).toContain('✅');
    });

    it('TT-004c: should detect ☑ ballot box', () => {
      const result = tracker.checkCompletion('☑ Deployed to staging');

      expect(result.completionMarkers).toContain('☑');
    });

    it('TT-004d: should detect [x] markdown checkbox', () => {
      const result = tracker.checkCompletion('- [x] Write unit tests');

      expect(result.completionMarkers).toContain('[x]');
    });

    it('TT-004e: should detect [X] uppercase markdown checkbox', () => {
      const result = tracker.checkCompletion('- [X] Deploy to production');

      expect(result.completionMarkers).toContain('[x]');
    });
  });

  describe('AC #5: Parses EXPECTED OUTCOME sections', () => {
    it('TT-005a: should parse "EXPECTED OUTCOME:" header', () => {
      const outcome = [
        'EXPECTED OUTCOME:',
        '- Create the database schema',
        '- Write migration scripts',
        '- Add seed data',
      ].join('\n');

      const result = tracker.checkCompletion(
        'I created the database schema and wrote migration scripts. Added seed data. DONE',
        outcome
      );

      expect(result.allComplete).toBe(true);
      expect(result.pendingItems).toEqual([]);
    });

    it('TT-005b: should parse "## Expected Outcome" header', () => {
      const outcome = [
        '## Expected Outcome',
        '- Implement authentication module',
        '- Add JWT token validation',
      ].join('\n');

      const result = tracker.checkCompletion(
        'Implemented authentication module with JWT token validation. DONE',
        outcome
      );

      expect(result.allComplete).toBe(true);
    });

    it('TT-005c: should parse "**EXPECTED OUTCOME**" header', () => {
      const outcome = [
        '**EXPECTED OUTCOME**',
        '* Deploy the service',
        '* Verify health endpoint',
      ].join('\n');

      const result = tracker.checkCompletion(
        'Deployed the service and verified health endpoint. DONE',
        outcome
      );

      expect(result.allComplete).toBe(true);
    });

    it('TT-005d: should parse numbered list items', () => {
      const outcome = [
        'EXPECTED OUTCOME:',
        '1. Create user registration endpoint',
        '2. Add email verification',
        '3. Write integration tests',
      ].join('\n');

      const result = tracker.checkCompletion(
        'Created user registration endpoint with email verification. Wrote integration tests. DONE',
        outcome
      );

      expect(result.allComplete).toBe(true);
    });
  });

  describe('AC #6: Identifies pending items from expected outcome', () => {
    it('TT-006a: should identify items not addressed in response', () => {
      const outcome = [
        'EXPECTED OUTCOME:',
        '- Create the API endpoint',
        '- Write comprehensive tests',
        '- Update documentation',
      ].join('\n');

      const result = tracker.checkCompletion('Created the API endpoint. DONE', outcome);

      expect(result.allComplete).toBe(false);
      expect(result.pendingItems.length).toBeGreaterThanOrEqual(1);
      expect(result.pendingItems).toContain('Update documentation');
    });

    it('TT-006b: should identify multiple pending items', () => {
      const outcome = [
        'EXPECTED OUTCOME:',
        '- Implement caching layer',
        '- Add Redis integration',
        '- Write performance benchmarks',
        '- Update deployment config',
      ].join('\n');

      const result = tracker.checkCompletion('Implemented caching layer. DONE', outcome);

      expect(result.allComplete).toBe(false);
      expect(result.pendingItems.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('AC #7: Generates reminders for incomplete tasks', () => {
    it('TT-007a: should generate reminder with pending items', () => {
      const outcome = [
        'EXPECTED OUTCOME:',
        '- Create database migration',
        '- Update API documentation',
      ].join('\n');

      const result = tracker.checkCompletion('Created database migration. DONE', outcome);

      expect(result.reminder).toContain('⚠️');
      expect(result.reminder).toContain('Incomplete tasks detected');
      expect(result.reminder).toContain('Update API documentation');
      expect(result.reminder).toContain('Please complete before marking done');
    });

    it('TT-007b: should not generate reminder when generateReminders is false', () => {
      const noReminderTracker = new TodoTracker({ generateReminders: false });
      const outcome = [
        'EXPECTED OUTCOME:',
        '- Create database migration',
        '- Update API documentation',
      ].join('\n');

      const result = noReminderTracker.checkCompletion('Created database migration. DONE', outcome);

      expect(result.reminder).toBe('');
      expect(result.pendingItems.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('AC #8: No reminder when all tasks complete', () => {
    it('TT-008: should return empty reminder when all items addressed', () => {
      const outcome = [
        'EXPECTED OUTCOME:',
        '- Write the authentication module',
        '- Add password hashing',
      ].join('\n');

      const result = tracker.checkCompletion(
        'Wrote the authentication module with password hashing. DONE',
        outcome
      );

      expect(result.allComplete).toBe(true);
      expect(result.reminder).toBe('');
      expect(result.pendingItems).toEqual([]);
    });
  });

  describe('AC #9: Handles empty/whitespace responses', () => {
    it('TT-009a: should handle empty response string', () => {
      const result = tracker.checkCompletion('');

      expect(result.allComplete).toBe(false);
      expect(result.completionMarkers).toEqual([]);
      expect(result.pendingItems).toEqual([]);
      expect(result.reminder).toBe('');
    });

    it('TT-009b: should handle whitespace-only response', () => {
      const result = tracker.checkCompletion('   \n\t  ');

      expect(result.allComplete).toBe(false);
      expect(result.completionMarkers).toEqual([]);
    });

    it('TT-009c: should handle empty response with expected outcome', () => {
      const outcome = 'EXPECTED OUTCOME:\n- Some task';
      const result = tracker.checkCompletion('', outcome);

      expect(result.allComplete).toBe(false);
      expect(result.pendingItems.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('AC #10: Handles missing expected outcome (no pendingItems)', () => {
    it('TT-010a: should return no pending items when expectedOutcome is undefined', () => {
      const result = tracker.checkCompletion('All work is DONE.');

      expect(result.allComplete).toBe(true);
      expect(result.pendingItems).toEqual([]);
      expect(result.reminder).toBe('');
    });

    it('TT-010b: should return no pending items when expectedOutcome is empty', () => {
      const result = tracker.checkCompletion('Task completed.', '');

      expect(result.allComplete).toBe(true);
      expect(result.pendingItems).toEqual([]);
    });

    it('TT-010c: should return allComplete=true with markers and no expected outcome', () => {
      const result = tracker.checkCompletion('✅ All tests pass. DONE');

      expect(result.allComplete).toBe(true);
      expect(result.completionMarkers).toContain('✅');
      expect(result.completionMarkers).toContain('DONE');
    });
  });

  describe('AC #11: Mixed Korean/English completion markers detected together', () => {
    it('TT-011: should detect markers from multiple languages simultaneously', () => {
      const result = tracker.checkCompletion('작업 완료! All tasks finished. ✅ DONE');

      expect(result.completionMarkers).toContain('작업 완료');
      expect(result.completionMarkers).toContain('완료');
      expect(result.completionMarkers).toContain('finished');
      expect(result.completionMarkers).toContain('✅');
      expect(result.completionMarkers).toContain('DONE');
      expect(result.allComplete).toBe(true);
    });
  });

  describe('AC #12: Deduplicated completion markers', () => {
    it('TT-012: should not duplicate markers when pattern appears multiple times', () => {
      const result = tracker.checkCompletion('DONE and DONE again. Everything is DONE.');

      const doneCount = result.completionMarkers.filter((m) => m === 'DONE').length;
      expect(doneCount).toBe(1);
    });
  });

  describe('AC #13: Expected outcome without recognized header', () => {
    it('TT-013: should parse bullets even without a recognized header', () => {
      const outcome = ['- Implement the feature', '- Write tests for the feature'].join('\n');

      const result = tracker.checkCompletion('Implemented the feature. DONE', outcome);

      expect(result.pendingItems.length).toBeGreaterThanOrEqual(1);
      expect(result.allComplete).toBe(false);
    });
  });

  describe('AC #14: Default config values', () => {
    it('TT-014a: should default to enabled=true', () => {
      const defaultTracker = new TodoTracker();
      const result = defaultTracker.checkCompletion('No markers here');

      expect(result.allComplete).toBe(false);
    });

    it('TT-014b: should default to generateReminders=true', () => {
      const defaultTracker = new TodoTracker();
      const outcome = 'EXPECTED OUTCOME:\n- Unaddressed task item here';
      const result = defaultTracker.checkCompletion('DONE', outcome);

      expect(result.reminder).toContain('⚠️');
    });
  });

  describe('AC #15: Partial config override', () => {
    it('TT-015: should merge partial config with defaults', () => {
      const partialTracker = new TodoTracker({ generateReminders: false });
      const outcome = 'EXPECTED OUTCOME:\n- Missing task xyz';
      const result = partialTracker.checkCompletion('DONE', outcome);

      expect(result.reminder).toBe('');
      expect(result.pendingItems.length).toBeGreaterThanOrEqual(1);
    });
  });
});
