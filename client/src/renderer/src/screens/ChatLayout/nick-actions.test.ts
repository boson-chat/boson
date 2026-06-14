import { describe, it, expect, vi } from 'vitest';
import { buildNickContextActions, type ChannelOpActions, type NickActions } from './nick-actions';

const labels = (na?: NickActions, nick = 'bob') =>
  buildNickContextActions(nick, na).map((a) => a.label);

function ops(over: Partial<ChannelOpActions> = {}): ChannelOpActions {
  return {
    myRank: 3,
    prefixOf: () => '',
    op: vi.fn(), halfop: vi.fn(), voice: vi.fn(),
    kick: vi.fn(), ban: vi.fn(), kickBan: vi.fn(),
    ...over,
  };
}

describe('buildNickContextActions', () => {
  it('always offers Copy nickname; DM/Mention when wired', () => {
    expect(labels()).toEqual(['Copy nickname']);
    expect(labels({ onSendMessage: vi.fn(), onMention: vi.fn() }))
      .toEqual(['Copy nickname', 'Send message', 'Mention']);
  });

  it('shows the full op set for an operator over a regular member', () => {
    const l = labels({ ops: ops({ myRank: 3, prefixOf: () => '' }) });
    expect(l).toContain('Give voice (+v)');
    expect(l).toContain('Give half-op (+h)');
    expect(l).toContain('Give op (+o)');
    expect(l).toContain('Kick…');
    expect(l).toContain('Ban');
    expect(l).toContain('Kick + Ban…');
  });

  it('shows NO op items when we hold no status', () => {
    const l = labels({ ops: ops({ myRank: 0 }) });
    expect(l).toEqual(['Copy nickname']);
  });

  it('flips give/take labels based on the target current prefix', () => {
    const l = labels({ ops: ops({ myRank: 3, prefixOf: () => '@' }) });
    expect(l).toContain('Take op (-o)');
    expect(l).not.toContain('Give op (+o)');
  });

  it('hides Kick on a target we do not outrank', () => {
    // half-op acting on an op: voice/halfop are op-gated (hidden), kick needs
    // outranking (hidden), so only the base item remains.
    const l = labels({ ops: ops({ myRank: 2, prefixOf: () => '@' }) });
    expect(l).not.toContain('Kick…');
    expect(l).not.toContain('Ban');
  });

  it('half-op can voice + kick a regular member but cannot op/ban', () => {
    const l = labels({ ops: ops({ myRank: 2, prefixOf: () => '' }) });
    expect(l).toContain('Give voice (+v)');
    expect(l).toContain('Kick…');
    expect(l).not.toContain('Give op (+o)');
    expect(l).not.toContain('Ban');
  });

  it('owner/admin grants only appear when supported and we rank high enough', () => {
    const base = { myRank: 5, prefixOf: () => '' as const };
    expect(labels({ ops: ops({ ...base, supportsOwnerAdmin: false, admin: vi.fn(), owner: vi.fn() }) }))
      .not.toContain('Give admin (+a)');
    const l = labels({ ops: ops({ ...base, supportsOwnerAdmin: true, admin: vi.fn(), owner: vi.fn() }) });
    expect(l).toContain('Give admin (+a)');
    expect(l).toContain('Give owner (+q)');
  });

  it('clicking an op item calls the bound callback with the right on-state', () => {
    const voice = vi.fn();
    const actions = buildNickContextActions('bob', { ops: ops({ myRank: 3, prefixOf: () => '', voice }) });
    actions.find((a) => a.label === 'Give voice (+v)')!.onClick();
    expect(voice).toHaveBeenCalledWith('bob', true);
  });
});
