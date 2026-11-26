import { describe, it, expect } from 'vitest';
import {
  applyReaction, mergeReactions, reactionChips, reactionOf, redactReaction, whoReacted,
  type ReactionEntry, type ReactionEvent,
} from './reactions';

const ev = (nick: string, emoji: string, on: boolean, at: number, id?: string): ReactionEvent =>
  ({ target: 'm1', nick, emoji, on, at, ...(id ? { id } : {}) });

// Apply events in order, ignoring "no change".
function run(events: ReactionEvent[], start: ReactionEntry[] = []): ReactionEntry[] {
  let cur = start;
  for (const e of events) cur = applyReaction(cur, e) ?? cur;
  return cur;
}

describe('reactionOf', () => {
  it('reads react and unreact, draft and ratified names', () => {
    expect(reactionOf({ '+draft/react': '👍' }, 'm1')).toEqual({ emoji: '👍', on: true });
    expect(reactionOf({ '+react': '👍' }, 'm1')).toEqual({ emoji: '👍', on: true });
    expect(reactionOf({ '+draft/unreact': '👍' }, 'm1')).toEqual({ emoji: '👍', on: false });
    expect(reactionOf({ '+unreact': 'lol' }, 'm1')).toEqual({ emoji: 'lol', on: false });
  });
  it('ignores typing, a react without a reply target, both tags at once, over-long values', () => {
    expect(reactionOf({ '+typing': 'active' }, 'm1')).toBeNull();
    expect(reactionOf({ '+draft/react': '👍' }, undefined)).toBeNull();
    expect(reactionOf({ '+draft/react': '👍', '+draft/unreact': '👍' }, 'm1')).toBeNull();
    expect(reactionOf({ '+draft/react': 'x'.repeat(100) }, 'm1')).toBeNull();
  });
});

describe('applyReaction', () => {
  it('adds reactions and counts them per emoji', () => {
    const entries = run([ev('alice', '👍', true, 1), ev('bob', '👍', true, 2), ev('carol', '🎉', true, 3)]);
    expect(reactionChips(entries, 'bob')).toEqual([
      { emoji: '👍', count: 2, nicks: ['alice', 'bob'], mine: true },
      { emoji: '🎉', count: 1, nicks: ['carol'], mine: false },
    ]);
  });

  it('removes on unreact', () => {
    const entries = run([ev('alice', '👍', true, 1), ev('bob', '👍', true, 2), ev('alice', '👍', false, 3)]);
    expect(reactionChips(entries, '')).toEqual([{ emoji: '👍', count: 1, nicks: ['bob'], mine: false }]);
    expect(reactionChips(run([ev('alice', '👍', true, 1), ev('alice', '👍', false, 2)]), '')).toEqual([]);
  });

  it('is idempotent: a replay of the same events changes nothing', () => {
    const events = [ev('alice', '👍', true, 1, 'a'), ev('bob', '❤️', true, 2, 'b'), ev('alice', '👍', false, 3, 'c')];
    const once = run(events);
    for (const e of events) expect(applyReaction(once, e)).toBeNull();
    expect(run(events, once)).toEqual(once);
  });

  it('out of order: an older react replayed after a newer unreact stays undone', () => {
    // Live: unreact at 5. Then history replays the react from 2.
    const entries = run([ev('alice', '👍', false, 5), ev('alice', '👍', true, 2)]);
    expect(reactionChips(entries, '')).toEqual([]);
    // And a newer react after both wins.
    expect(reactionChips(run([ev('alice', '👍', true, 9)], entries), '')).toHaveLength(1);
  });

  it('out of order: an unreact arriving before its react (replay order) still wins', () => {
    const entries = run([ev('alice', '😂', false, 4), ev('alice', '😂', true, 1), ev('bob', '😂', true, 3)]);
    expect(reactionChips(entries, '')).toEqual([{ emoji: '😂', count: 1, nicks: ['bob'], mine: false }]);
  });

  it('matches nicks case-insensitively and our own chip regardless of case', () => {
    const entries = run([ev('Alice', '👍', true, 1), ev('alice', '👍', true, 2)]);
    expect(reactionChips(entries, 'ALICE')).toEqual([{ emoji: '👍', count: 1, nicks: ['alice'], mine: true }]);
  });

  it('takes the msgid from our echo for a react shown before it', () => {
    const local = run([ev('me', '👍', true, 10)]);
    const echoed = applyReaction(local, ev('me', '👍', true, 10, 'x1'));
    expect(echoed?.[0]?.id).toBe('x1');
    expect(reactionChips(echoed!, 'me')[0]!.count).toBe(1);
  });
});

describe('mergeReactions (stored entries back into the log)', () => {
  it('keeps the newest statement from either side', () => {
    const live = run([ev('alice', '👍', true, 10)]);
    const stored: ReactionEntry[] = [{ nick: 'alice', emoji: '👍', on: false, at: 5 }, { nick: 'bob', emoji: '🎉', on: true, at: 6 }];
    const merged = mergeReactions(live, stored)!;
    expect(reactionChips(merged, '').map((c) => c.emoji)).toEqual(['🎉', '👍']);
  });
});

describe('redactReaction', () => {
  it('takes back the reaction whose TAGMSG was redacted', () => {
    const entries = run([ev('alice', '👍', true, 1, 'r1'), ev('bob', '👍', true, 2, 'r2')]);
    const next = redactReaction(entries, 'r1')!;
    expect(reactionChips(next, '')).toEqual([{ emoji: '👍', count: 1, nicks: ['bob'], mine: false }]);
    expect(redactReaction(next, 'nope')).toBeNull();
  });
});

describe('whoReacted', () => {
  it('names who reacted, You for us, and folds a long list', () => {
    expect(whoReacted({ emoji: '👍', count: 1, nicks: ['alice'], mine: false }, 'me')).toBe('alice reacted with 👍');
    expect(whoReacted({ emoji: '👍', count: 2, nicks: ['alice', 'me'], mine: true }, 'me')).toBe('alice and You reacted with 👍');
    const many = { emoji: '🎉', count: 4, nicks: ['a', 'b', 'c', 'd'], mine: false };
    expect(whoReacted(many, '', 2)).toBe('a, b and 2 others reacted with 🎉');
  });
});
