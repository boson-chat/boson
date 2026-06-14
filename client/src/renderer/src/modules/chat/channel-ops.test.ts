import { describe, it, expect } from 'vitest';
import {
  prefixRank, banMask, OP, HALFOP,
  canKick, canBan, canOp, canHalfop, canVoice, canInvite,
  canSetChannelMode, canSetTopic,
} from './channel-ops';

describe('prefixRank', () => {
  it('orders the status ladder', () => {
    expect(prefixRank('~')).toBe(5);
    expect(prefixRank('&')).toBe(4);
    expect(prefixRank('@')).toBe(3);
    expect(prefixRank('%')).toBe(2);
    expect(prefixRank('+')).toBe(1);
    expect(prefixRank('')).toBe(0);
  });
});

describe('banMask', () => {
  it('uses nick!*@* without a host', () => {
    expect(banMask('troll')).toBe('troll!*@*');
  });
  it('prefers *!*@host when the host is known', () => {
    expect(banMask('troll', '1.2.3.4')).toBe('*!*@1.2.3.4');
  });
});

describe('gating predicates', () => {
  it('kick: half-op or above AND must outrank the target', () => {
    expect(canKick({ myRank: OP, targetRank: 0 })).toBe(true);
    expect(canKick({ myRank: HALFOP, targetRank: 1 })).toBe(true);   // %  kicks +
    expect(canKick({ myRank: HALFOP, targetRank: OP })).toBe(false); // % can't kick @
    expect(canKick({ myRank: OP, targetRank: OP })).toBe(false);     // equal rank
    expect(canKick({ myRank: 1, targetRank: 0 })).toBe(false);       // voice can't kick
  });

  it('ban / op / halfop require operator', () => {
    for (const can of [canBan, canOp, canHalfop]) {
      expect(can({ myRank: OP, targetRank: 0 })).toBe(true);
      expect(can({ myRank: HALFOP, targetRank: 0 })).toBe(false);
    }
  });

  it('voice requires half-op; invite requires half-op', () => {
    expect(canVoice({ myRank: HALFOP, targetRank: 0 })).toBe(true);
    expect(canVoice({ myRank: 1, targetRank: 0 })).toBe(false);
    expect(canInvite(HALFOP)).toBe(true);
    expect(canInvite(1)).toBe(false);
  });

  it('channel modes require operator; topic gated only when +t locked', () => {
    expect(canSetChannelMode(OP)).toBe(true);
    expect(canSetChannelMode(HALFOP)).toBe(false);
    expect(canSetTopic(0, false)).toBe(true);   // open topic, anyone
    expect(canSetTopic(0, true)).toBe(false);   // +t locked, non-op blocked
    expect(canSetTopic(OP, true)).toBe(true);   // +t locked, op allowed
  });
});
