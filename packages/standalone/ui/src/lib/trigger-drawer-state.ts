export interface SubmissionLock {
  current: boolean;
}

export function shouldShowModal(dialogOpen: boolean): boolean {
  return !dialogOpen;
}

export function acquireSubmissionLock(lock: SubmissionLock): boolean {
  if (lock.current) {
    return false;
  }
  lock.current = true;
  return true;
}

export function releaseSubmissionLock(lock: SubmissionLock): void {
  lock.current = false;
}
