// Test helper: drive an Operation through scripted reply batches.
import type { Operation } from './chanserv.types';

// Feed the replies line by line (like the runner), settling at the end of
// each batch; a follow-up command starts the next batch.
export function drive<T>(op: Operation<T>, replies: string[][]): { result: T; sent: string[] } {
  if (!op.first) {
    const v = op.step([], true);
    if (!v || !('final' in v)) throw new Error('an operation with nothing to send must decide at once');
    return { result: v.final, sent: [] };
  }
  const sent = [op.first];
  for (let batch = 0; batch < 6; batch++) {
    const lines: string[] = [];
    let v: ReturnType<Operation<T>['step']> = null;
    for (const line of replies[batch] ?? []) {
      lines.push(line);
      v = op.step(lines, false);
      if (v) break;
    }
    if (!v) v = op.step(lines, true);
    if (!v) throw new Error('settled step returned no verdict');
    if ('final' in v) return { result: v.final, sent };
    sent.push(v.send);
  }
  throw new Error('too many follow-ups');
}

