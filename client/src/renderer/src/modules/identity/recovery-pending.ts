// Sign-up shows the recovery code once, after the handle step. A reload (or
// a crash) on that screen used to skip it for good: the code only lived in
// memory. This flag, set when the account row is created and cleared when
// the user confirms they saved the code, brings the step back on the next
// load, with a fresh code (the old one can't be shown again).
const PREFIX = 'boson:recovery-pending:';

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function markRecoveryPending(userId: string): void {
  if (!userId) return;
  try { storage()?.setItem(PREFIX + userId, '1'); } catch { /* best effort */ }
}

export function clearRecoveryPending(userId: string): void {
  if (!userId) return;
  try { storage()?.removeItem(PREFIX + userId); } catch { /* best effort */ }
}

export function isRecoveryPending(userId: string): boolean {
  if (!userId) return false;
  try { return storage()?.getItem(PREFIX + userId) === '1'; } catch { return false; }
}
