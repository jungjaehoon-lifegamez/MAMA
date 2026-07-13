import { describe, expect, it } from 'vitest';
import {
  acquireSubmissionLock,
  releaseSubmissionLock,
  shouldShowModal,
} from '../../ui/src/lib/trigger-drawer-state';

describe('Story M9.3: Trigger drawer state', () => {
  describe('AC #1: Opens only a closed dialog', () => {
    it('opens a dialog that is not already open', () => {
      expect(shouldShowModal(false)).toBe(true);
    });

    it('does not reopen a dialog that StrictMode left open', () => {
      expect(shouldShowModal(true)).toBe(false);
    });
  });

  describe('AC #2: Allows one submission until release', () => {
    it('allows only the first synchronous acquisition', () => {
      const lock = { current: false };

      expect(acquireSubmissionLock(lock)).toBe(true);
      expect(acquireSubmissionLock(lock)).toBe(false);
    });

    it('allows another acquisition after release', () => {
      const lock = { current: false };

      expect(acquireSubmissionLock(lock)).toBe(true);
      releaseSubmissionLock(lock);
      expect(acquireSubmissionLock(lock)).toBe(true);
    });
  });
});
