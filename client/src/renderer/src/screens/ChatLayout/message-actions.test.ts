import { describe, it, expect } from 'vitest';
import { signal } from '@preact/signals';
import type { ChatMessage, ChatService } from '../../modules/chat';
import { messageActionsFor, type MessageActionsContext } from './message-actions';

const chat = { reactionsSignal: () => signal(new Map()), react: () => {}, redact: () => {} } as unknown as ChatService;
const line = (from: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: from, kind: 'message', from, text: 'hi', timestamp: 1, msgid: `id-${from}`, ...extra });
const ctx = (over: Partial<MessageActionsContext> = {}): MessageActionsContext =>
  ({ reactions: true, redaction: true, myNick: 'ada', myAccount: 'ada', myRank: 0, isChannel: true, ...over });
const canDelete = (c: MessageActionsContext, m: ChatMessage, conv = '#dev') => messageActionsFor(chat, conv, c)!.canDelete(m);

describe('messageActionsFor: Delete', () => {
  it('own lines, signed in, with the cap', () => {
    expect(canDelete(ctx(), line('ada'))).toBe(true);
    expect(canDelete(ctx(), line('ADA'))).toBe(true);
    expect(canDelete(ctx(), line('nova'))).toBe(false);
  });

  it('never for a guest (no account), even their own line or as op', () => {
    expect(canDelete(ctx({ myAccount: undefined }), line('ada'))).toBe(false);
    expect(canDelete(ctx({ myAccount: undefined, myRank: 5 }), line('nova'))).toBe(false);
  });

  it("anyone's line in a channel where we're +o or higher; not half-op", () => {
    expect(canDelete(ctx({ myRank: 3 }), line('nova'))).toBe(true); // @
    expect(canDelete(ctx({ myRank: 4 }), line('nova'))).toBe(true); // &
    expect(canDelete(ctx({ myRank: 5 }), line('nova'))).toBe(true); // ~
    expect(canDelete(ctx({ myRank: 2 }), line('nova'))).toBe(false); // %
    expect(canDelete(ctx({ myRank: 1 }), line('nova'))).toBe(false); // +
  });

  it('in a DM only our own lines', () => {
    expect(canDelete(ctx({ isChannel: false, myRank: 0 }), line('nova'), 'nova')).toBe(false);
    expect(canDelete(ctx({ isChannel: false, myRank: 0 }), line('ada'), 'nova')).toBe(true);
  });

  it('not without the cap, a msgid, or for joins and system lines', () => {
    expect(canDelete(ctx({ redaction: false }), line('ada'))).toBe(false);
    expect(canDelete(ctx(), line('ada', { msgid: undefined }))).toBe(false);
    expect(canDelete(ctx({ myRank: 5 }), line('nova', { kind: 'join' }))).toBe(false);
    expect(canDelete(ctx({ myRank: 5 }), line('nova', { kind: 'system' }))).toBe(false);
  });

  it('no actions at all without message-tags or redaction', () => {
    expect(messageActionsFor(chat, '#dev', ctx({ reactions: false, redaction: false }))).toBeUndefined();
  });
});
