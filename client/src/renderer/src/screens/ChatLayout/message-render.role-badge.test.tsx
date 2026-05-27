import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { MessageRow } from './message-render';
import type { ChatMember, ChatMessage } from '../../modules/chat';

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '1',
    kind: 'message',
    from: 'alice',
    text: 'hello',
    timestamp: new Date('2026-05-26T12:00:00Z').getTime(),
    ...overrides,
  };
}

function makeMember(nick: string, prefix: ChatMember['prefix']): ChatMember {
  return { nick, prefix };
}

describe('MessageRow role badge', () => {
  it.each([
    ['~', 'FOUNDER'],
    ['&', 'ADMIN'],
    ['@', 'OPS'],
    ['%', 'MOD'],
    ['+', 'V'],
  ] as const)('prefix %s → renders %s badge', (prefix, label) => {
    render(
      <MessageRow
        msg={makeMsg({ from: 'alice' })}
        myNick="me"
        members={[makeMember('alice', prefix)]}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('regular member (no prefix) renders no role badge', () => {
    render(
      <MessageRow
        msg={makeMsg({ from: 'alice' })}
        myNick="me"
        members={[makeMember('alice', '')]}
      />,
    );
    // Nick is rendered, but no role pill.
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(document.querySelector('.message-row-role')).toBeNull();
  });

  it('grouped subsequent message hides the header — no role badge on the follow-up', () => {
    // Grouping consolidates rapid-fire messages from the same author; the
    // header (name + badge + handle + time) only appears on the first
    // message of the group.
    render(
      <MessageRow
        msg={makeMsg({ from: 'alice' })}
        myNick="me"
        members={[makeMember('alice', '@')]}
        grouped
      />,
    );
    expect(document.querySelector('.message-row-header')).toBeNull();
    expect(document.querySelector('.message-row-role')).toBeNull();
  });

  it('badge class follows the role kind so colors match the design system', () => {
    render(
      <MessageRow
        msg={makeMsg({ from: 'alice' })}
        myNick="me"
        members={[makeMember('alice', '@')]}
      />,
    );
    const pill = document.querySelector('.message-row-role');
    expect(pill?.className).toContain('message-row-role-op');
  });

  it('falls back to no badge when the speaker is not in the channel member list', () => {
    // Can happen for legacy logs / cross-channel messages where the
    // member who spoke has since parted.
    render(
      <MessageRow
        msg={makeMsg({ from: 'someone-who-left' })}
        myNick="me"
        members={[makeMember('alice', '@')]}
      />,
    );
    expect(document.querySelector('.message-row-role')).toBeNull();
  });
});
