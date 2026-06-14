// Pure helpers for channel-operator features: rank ordering, ban-mask
// construction, and permission gating. Kept separate from ChatService so the
// UI (context menu, Channel Settings modal) can import them without pulling in
// the service, and so the gating rules are unit-testable in isolation.
import type { MemberPrefix } from './chat.types';

// Rank ladder for member status sigils. Higher = more privileged. Mirrors the
// standard PREFIX order `(qaohv)~&@%+`. Networks without halfop simply never
// hand out `%`; the ordering still holds.
export function prefixRank(p: MemberPrefix): number {
  switch (p) {
    case '~': return 5; // founder / owner (+q)
    case '&': return 4; // admin / protected (+a)
    case '@': return 3; // operator (+o)
    case '%': return 2; // half-op (+h)
    case '+': return 1; // voice (+v)
    default:  return 0; // regular
  }
}

// Numeric thresholds used by the gating predicates below.
export const OP = 3;     // '@' operator
export const HALFOP = 2; // '%' half-op

// Build a ban mask for a nick. Prefer `*!*@host` when we know the host (so a
// rename doesn't dodge the ban); fall back to `nick!*@*`. Masks the user
// already typed (containing ! @ or *) are passed through by the caller, not here.
export function banMask(nick: string, host?: string): string {
  return host ? `*!*@${host}` : `${nick}!*@*`;
}

// Gating input: my rank in the channel, and the target member's rank.
export interface OpGate {
  myRank: number;
  targetRank: number;
}

// Pragmatic rules — not an exact model of every network's policy (the server
// is always authoritative; these only decide what the UI offers).
//   - kick:  half-op+ AND must outrank the target (a half-op can't kick an op)
//   - ban / op / halfop:  operator+
//   - voice / invite:  half-op+
export const canKick = (g: OpGate): boolean => g.myRank >= HALFOP && g.myRank > g.targetRank;
export const canBan = (g: OpGate): boolean => g.myRank >= OP;
export const canOp = (g: OpGate): boolean => g.myRank >= OP;
export const canHalfop = (g: OpGate): boolean => g.myRank >= OP;
export const canVoice = (g: OpGate): boolean => g.myRank >= HALFOP;
export const canInvite = (myRank: number): boolean => myRank >= HALFOP;

// Channel-wide modes (+m/+i/+k/+l/…) require operator.
export const canSetChannelMode = (myRank: number): boolean => myRank >= OP;

// Topic is open to everyone unless +t (topic-lock) is set, in which case it
// needs operator.
export const canSetTopic = (myRank: number, topicLocked: boolean): boolean =>
  !topicLocked || myRank >= OP;
