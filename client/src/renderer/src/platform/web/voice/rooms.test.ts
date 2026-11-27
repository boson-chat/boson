import { describe, expect, it } from 'vitest';
import { roomFromWire } from './rooms';

describe('roomFromWire', () => {
  it("keeps the server's lock reason, and leaves it out when there is none", () => {
    const locked = roomFromWire({ id: 'boson-members', parent: '#boson', can_join: false, lock_reason: 'join #boson on IRC first' });
    expect(locked.canJoin).toBe(false);
    expect(locked.lockReason).toBe('join #boson on IRC first');
    const open = roomFromWire({ id: 'general', can_join: true });
    expect(open.canJoin).toBe(true);
    expect('lockReason' in open).toBe(false);
  });
});
