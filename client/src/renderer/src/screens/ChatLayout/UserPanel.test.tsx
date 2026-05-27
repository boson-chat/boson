import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { UserPanel } from './UserPanel';
import type { ChatChannel, ChatMember } from '../../modules/chat';

function makeChannel(overrides: Partial<ChatChannel> = {}): ChatChannel {
  return {
    name: '#general',
    messages: [],
    joined: true,
    members: [],
    typing: [],
    unread: 0,
    mentions: 0,
    topic: '',
    ...overrides,
  };
}

function makeMember(overrides: Partial<ChatMember> = {}): ChatMember {
  return { nick: 'alice', prefix: '', ...overrides };
}

afterEach(() => {
  vi.useRealTimers();
  // The hover card portals into document.body — clean up between tests
  // so a stale card from the previous test doesn't pollute the next.
  document.body.querySelectorAll('.nick-hovercard').forEach((n) => n.remove());
});

describe('UserPanel custom hover card', () => {
  it('does NOT set a native `title` attribute on member rows', () => {
    // Native title pops a yellow OS tooltip after ~1s with no styling
    // control. The custom hover card replaces it entirely.
    render(
      <UserPanel
        channel={makeChannel({
          members: [makeMember({ nick: 'bob', prefix: '@' })],
        })}
      />,
    );
    const row = document.querySelector('.user-panel-item');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('title')).toBeNull();
  });

  it('does not render any hover card until a member row is hovered', () => {
    render(
      <UserPanel
        channel={makeChannel({
          members: [makeMember({ nick: 'alice' }), makeMember({ nick: 'bob', prefix: '@' })],
        })}
      />,
    );
    expect(document.querySelectorAll('.nick-hovercard')).toHaveLength(0);
  });

  it('mouseenter on a row portals a single hover card for that member', () => {
    render(
      <UserPanel
        channel={makeChannel({
          members: [
            makeMember({ nick: 'alice', prefix: '@' }),
            makeMember({ nick: 'bob', prefix: '+' }),
          ],
        })}
      />,
    );
    const aliceRow = Array.from(document.querySelectorAll('.user-panel-item'))
      .find((el) => el.textContent?.includes('alice'))!;
    fireEvent.mouseEnter(aliceRow);
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('alice');
    expect(card.textContent).toContain('Operator');
  });

  it('mouseleave on the hovered row dismisses the card', () => {
    render(
      <UserPanel
        channel={makeChannel({
          members: [makeMember({ nick: 'alice', prefix: '@' })],
        })}
      />,
    );
    const row = document.querySelector('.user-panel-item')!;
    fireEvent.mouseEnter(row);
    expect(document.querySelectorAll('.nick-hovercard')).toHaveLength(1);
    fireEvent.mouseLeave(row);
    expect(document.querySelectorAll('.nick-hovercard')).toHaveLength(0);
  });

  it.each([
    ['~', 'Founder'],
    ['&', 'Admin'],
    ['@', 'Operator'],
    ['%', 'Half-op'],
    ['+', 'Voiced'],
    ['',  'Member'],
  ] as const)('prefix %s shows role label %s in the hovered card', (prefix, label) => {
    render(
      <UserPanel
        channel={makeChannel({
          members: [makeMember({ nick: 'alice', prefix })],
        })}
      />,
    );
    fireEvent.mouseEnter(document.querySelector('.user-panel-item')!);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('hovered card shows the activity line built from joinedAt / lastActiveAt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
    render(
      <UserPanel
        channel={makeChannel({
          members: [makeMember({ nick: 'alice', lastActiveAt: Date.now() - 120_000 })],
        })}
      />,
    );
    fireEvent.mouseEnter(document.querySelector('.user-panel-item')!);
    expect(screen.getByText('Last spoke 2m ago')).toBeInTheDocument();
  });

  it('hovered card lists every WHOIS field present on the member record', () => {
    render(
      <UserPanel
        channel={makeChannel({
          members: [
            makeMember({
              nick: 'alice',
              account: 'alice!ircaccount',
              hostname: 'unaffiliated/alice',
              realname: 'Alice Liddell',
              awayMessage: 'bbiab',
            }),
          ],
        })}
      />,
    );
    fireEvent.mouseEnter(document.querySelector('.user-panel-item')!);
    expect(screen.getByText('alice!ircaccount')).toBeInTheDocument();
    expect(screen.getByText('unaffiliated/alice')).toBeInTheDocument();
    expect(screen.getByText('Alice Liddell')).toBeInTheDocument();
    expect(screen.getByText('bbiab')).toBeInTheDocument();
  });

  it('hovered card omits the meta list entirely when no WHOIS data is known', () => {
    // Common case for a brand-new join before WHO/WHOIS comes back.
    render(
      <UserPanel
        channel={makeChannel({
          members: [makeMember({ nick: 'alice' })],
        })}
      />,
    );
    fireEvent.mouseEnter(document.querySelector('.user-panel-item')!);
    const card = screen.getByRole('tooltip');
    expect(card.querySelector('.nick-hovercard-meta')).toBeNull();
  });

  it('moving between rows replaces the card with the new member', () => {
    render(
      <UserPanel
        channel={makeChannel({
          members: [
            makeMember({ nick: 'alice', prefix: '@' }),
            makeMember({ nick: 'bob', prefix: '+' }),
          ],
        })}
      />,
    );
    const rows = Array.from(document.querySelectorAll('.user-panel-item'));
    fireEvent.mouseEnter(rows[0]!);
    expect(screen.getByRole('tooltip').textContent).toContain('alice');
    // Cursor moves to the next row: leave the first, enter the second.
    fireEvent.mouseLeave(rows[0]!);
    fireEvent.mouseEnter(rows[1]!);
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('bob');
    expect(card.textContent).not.toContain('alice');
  });
});
