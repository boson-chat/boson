import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';

interface FakeSession extends Pick<ServerSession,
  'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' |
  'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' |
  'onServicesFramework' | 'servicesFramework' | 'serverId'
> {
  emit(e: IrcEvent): void;
  raws: string[];
  privmsgs: { target: string; message: string }[];
  tagmsgs: { target: string; tags: Record<string, string> }[];
}

function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const raws: string[] = [];
  const privmsgs: { target: string; message: string }[] = [];
  const tagmsgs: { target: string; tags: Record<string, string> }[] = [];
  const f: FakeSession = {
    serverId: 'srv-test',
    join: () => {}, part: () => {},
    privmsg: (target, message) => { privmsgs.push({ target, message }); },
    names: () => {}, tagmsg: (target, tags) => { tagmsgs.push({ target, tags }); }, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line) => { raws.push(line); },
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e) => listener?.(e),
    raws,
    privmsgs,
    tagmsgs,
  };
  return f;
}

let saved: ReturnType<typeof getServiceCredentialsStore>;
beforeEach(() => {
  saved = getServiceCredentialsStore();
  setServiceCredentialsStore(new LocalStorageServiceCredentialsStore({
    getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  } as Storage));
});
afterEach(() => { setServiceCredentialsStore(saved); });

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function build(store = new MemoryChatHistoryStore()) {
  const session = makeFakeSession();
  const chat = new ChatService(session as unknown as ServerSession, 'me', { history: store, scope: { userId: 'u1', serverId: 'srv' } });
  chat.attach();
  return { chat, session, store };
}

const cap = (s: FakeSession, ...caps: string[]) =>
  s.emit({ Kind: 'CAP', From: '', Target: '', Message: caps.join(' '), Args: ['ACK'], Raw: '' });
const msg = (s: FakeSession, from: string, text: string, msgid: string, at: number, batch?: string) =>
  s.emit({ Kind: 'PRIVMSG', From: from, Target: '#c', Message: text, Tags: { msgid, time: iso(at), ...(batch ? { batch } : {}) }, Raw: '' });
const react = (s: FakeSession, from: string, target: string, emoji: string, at: number, opts: { off?: boolean; id?: string; batch?: string } = {}) =>
  s.emit({
    Kind: 'TAGMSG', From: from, Target: '#c', Message: '', Raw: '',
    Tags: {
      [opts.off ? '+draft/unreact' : '+draft/react']: emoji, '+draft/reply': target, time: iso(at),
      ...(opts.id ? { msgid: opts.id } : {}), ...(opts.batch ? { batch: opts.batch } : {}),
    },
  });
const join = (s: FakeSession, ch = '#c') => s.emit({ Kind: 'JOIN', From: 'me', Target: ch, Message: '', Raw: '' });
const chips = (chat: ChatService, id: string) => {
  const entries = chat.reactionsSignal('#c').value.get(id) ?? [];
  return entries.filter((r) => r.on).map((r) => `${r.nick}:${r.emoji}`).sort();
};
const lines = (chat: ChatService) => chat.messagesSignal('#c')!.value;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ChatService reactions', () => {
  it('sends a react / unreact TAGMSG with the reply tag, only with message-tags and a msgid', () => {
    const { chat, session } = build();
    join(session);
    msg(session, 'alice', 'hi', 'm1', T0);
    const m = lines(chat).find((x) => x.msgid === 'm1')!;
    chat.react('#c', m, '👍');
    expect(session.tagmsgs).toEqual([]);
    expect(chat.reactionsSupported()).toBe(false);
    cap(session, 'message-tags');
    chat.react('#c', m, '👍');
    chat.react('#c', { ...m, msgid: undefined }, '👍');
    chat.react('#c', m, '👍', false);
    expect(session.tagmsgs).toEqual([
      { target: '#c', tags: { '+draft/react': '👍', '+draft/reply': 'm1' } },
      { target: '#c', tags: { '+draft/unreact': '👍', '+draft/reply': 'm1' } },
    ]);
    expect(session.privmsgs).toEqual([]); // no text fallback
  });

  it('aggregates live reactions; our own shows at once and its echo does not double it', () => {
    const { chat, session } = build();
    cap(session, 'message-tags', 'echo-message');
    join(session);
    msg(session, 'alice', 'hi', 'm1', T0);
    react(session, 'bob', 'm1', '👍', T0 + 1000, { id: 'r1' });
    chat.react('#c', lines(chat).find((x) => x.msgid === 'm1')!, '👍');
    expect(chips(chat, 'm1')).toEqual(['bob:👍', 'me:👍']);
    react(session, 'me', 'm1', '👍', Date.now(), { id: 'r2' }); // the echo
    expect(chips(chat, 'm1')).toEqual(['bob:👍', 'me:👍']);
    react(session, 'bob', 'm1', '👍', T0 + 5000, { off: true });
    expect(chips(chat, 'm1')).toEqual(['me:👍']);
    // Typing still works alongside.
    session.emit({ Kind: 'TAGMSG', From: 'bob', Target: '#c', Message: '', Tags: { '+typing': 'active' }, Raw: '' });
    expect(chat.getState().channels.find((c) => c.name === '#c')!.typing).toEqual(['bob']);
  });

  it('keeps reactions to a message not loaded yet until it arrives', () => {
    const { chat, session } = build();
    cap(session, 'message-tags');
    join(session);
    react(session, 'bob', 'later', '🎉', T0 + 2000);
    expect(lines(chat).some((x) => x.msgid === 'later')).toBe(false);
    expect(chips(chat, 'later')).toEqual(['bob:🎉']);
    msg(session, 'alice', 'finally', 'later', T0);
    expect(lines(chat).some((x) => x.msgid === 'later')).toBe(true);
    expect(chips(chat, 'later')).toEqual(['bob:🎉']);
  });

  it('applies reactions replayed in a CHATHISTORY batch (event-playback), in any order', () => {
    const { chat, session } = build();
    cap(session, 'message-tags', 'draft/chathistory', 'draft/event-playback', 'batch');
    join(session);
    // Live first: alice took her reaction back at T0+9s.
    react(session, 'alice', 'm1', '👍', T0 + 9000, { off: true, id: 'u1' });
    session.emit({ Kind: 'BATCH', From: '', Target: '', Message: '', Args: ['+b1', 'chathistory', '#c'], Raw: '' });
    msg(session, 'carol', 'old', 'm1', T0, 'b1');
    react(session, 'alice', 'm1', '👍', T0 + 1000, { id: 'r1', batch: 'b1' }); // older: stays undone
    react(session, 'dave', 'm1', '❤️', T0 + 2000, { id: 'r2', batch: 'b1' });
    session.emit({ Kind: 'BATCH', From: '', Target: '', Message: '', Args: ['-b1'], Raw: '' });
    expect(lines(chat).filter((x) => x.msgid === 'm1')).toHaveLength(1);
    expect(lines(chat).some((x) => x.text === '')).toBe(false); // TAGMSGs aren't lines
    expect(chips(chat, 'm1')).toEqual(['dave:❤️']);
    // The same page again (a reconnect) changes nothing.
    session.emit({ Kind: 'BATCH', From: '', Target: '', Message: '', Args: ['+b2', 'chathistory', '#c'], Raw: '' });
    react(session, 'dave', 'm1', '❤️', T0 + 2000, { id: 'r2', batch: 'b2' });
    session.emit({ Kind: 'BATCH', From: '', Target: '', Message: '', Args: ['-b2'], Raw: '' });
    expect(chips(chat, 'm1')).toEqual(['dave:❤️']);
  });

  it('persists reactions with the stored message and brings them back', async () => {
    const store = new MemoryChatHistoryStore();
    const a = build(store);
    cap(a.session, 'message-tags');
    join(a.session);
    msg(a.session, 'alice', 'hi', 'm1', T0);
    react(a.session, 'bob', 'm1', '👍', T0 + 1000);
    await flush();
    const stored = await store.load({ userId: 'u1', serverId: 'srv', channel: '#c' });
    expect(stored.find((x) => x.msgid === 'm1')?.reactions?.map((r) => r.nick)).toEqual(['bob']);
    expect(stored.filter((x) => x.msgid === 'm1')).toHaveLength(1);

    const b = build(store);
    join(b.session);
    await flush();
    expect(chips(b.chat, 'm1')).toEqual(['bob:👍']);
    // An update after hydration replaces the stored row, not a second one.
    react(b.session, 'carol', 'm1', '👍', T0 + 3000);
    await flush();
    const again = await store.load({ userId: 'u1', serverId: 'srv', channel: '#c' });
    expect(again.filter((x) => x.msgid === 'm1')).toHaveLength(1);
    expect(again.find((x) => x.msgid === 'm1')?.reactions).toHaveLength(2);
  });
});

describe('ChatService message redaction', () => {
  it('sends REDACT only when the server offers draft/message-redaction', () => {
    const { chat, session } = build();
    join(session);
    msg(session, 'me', 'oops', 'm1', T0);
    const m = lines(chat).find((x) => x.msgid === 'm1')!;
    chat.redact('#c', m);
    expect(session.raws.filter((r) => r.startsWith('REDACT'))).toEqual([]);
    cap(session, 'draft/message-redaction');
    expect(chat.redactionSupported()).toBe(true);
    chat.redact('#c', m);
    chat.redact('#c', m, 'typo\r\nsorry');
    expect(session.raws.filter((r) => r.startsWith('REDACT'))).toEqual(['REDACT #c m1', 'REDACT #c m1 :typo sorry']);
  });

  it('replaces a redacted message with a placeholder and drops its text from memory and the store', async () => {
    const store = new MemoryChatHistoryStore();
    const { chat, session } = build(store);
    cap(session, 'message-tags', 'draft/message-redaction');
    join(session);
    msg(session, 'alice', 'secret', 'm1', T0);
    react(session, 'bob', 'm1', '👍', T0 + 1000);
    session.emit({ Kind: 'REDACT', From: 'op', Target: '#c', Args: ['m1'], Message: 'spam', Raw: '' });
    const m = lines(chat).find((x) => x.msgid === 'm1')!;
    expect(m.redacted).toBe(true);
    expect(m.text).toBe('');
    expect(m.from).toBe('alice');
    expect(chips(chat, 'm1')).toEqual([]);
    await flush();
    const stored = await store.load({ userId: 'u1', serverId: 'srv', channel: '#c' });
    expect(JSON.stringify(stored)).not.toContain('secret');
    expect(stored.find((x) => x.msgid === 'm1')?.redacted).toBe(true);
    // A reaction to it afterwards is ignored.
    react(session, 'carol', 'm1', '🎉', T0 + 5000);
    expect(chips(chat, 'm1')).toEqual([]);
    // A copy that comes back (a bouncer replaying) stays deleted.
    session.emit({ Kind: 'BATCH', From: '', Target: '', Message: '', Args: ['+b1', 'chathistory', '#c'], Raw: '' });
    msg(session, 'alice', 'secret', 'm1', T0, 'b1');
    session.emit({ Kind: 'BATCH', From: '', Target: '', Message: '', Args: ['-b1'], Raw: '' });
    expect(lines(chat).filter((x) => x.msgid === 'm1').map((x) => x.text)).toEqual(['']);
  });

  it('a REDACT of a reaction TAGMSG takes that reaction back', () => {
    const { chat, session } = build();
    cap(session, 'message-tags', 'draft/message-redaction');
    join(session);
    msg(session, 'alice', 'hi', 'm1', T0);
    react(session, 'bob', 'm1', '👍', T0 + 1000, { id: 'r1' });
    session.emit({ Kind: 'REDACT', From: 'bob', Target: '#c', Args: ['r1'], Message: '', Raw: '' });
    expect(chips(chat, 'm1')).toEqual([]);
    expect(lines(chat).find((x) => x.msgid === 'm1')!.text).toBe('hi');
  });

  it('a REDACT in a DM applies to the conversation with the sender', () => {
    const { chat, session } = build();
    cap(session, 'draft/message-redaction');
    session.emit({ Kind: 'PRIVMSG', From: 'alice', Target: 'me', Message: 'psst', Tags: { msgid: 'd1', time: iso(T0) }, Raw: '' });
    session.emit({ Kind: 'REDACT', From: 'alice', Target: 'me', Args: ['d1'], Message: '', Raw: '' });
    expect(chat.messagesSignal('alice')!.value.find((x) => x.msgid === 'd1')!.redacted).toBe(true);
  });

  it('FAIL REDACT tells the user', () => {
    const { chat, session } = build();
    const seen: string[] = [];
    chat.onFeedback((f) => { if (f.kind === 'error') seen.push(f.text); });
    session.emit({ Kind: 'FAIL', From: 'irc', Target: '', Args: ['REDACT', 'REDACT_FORBIDDEN', '#c', 'm1'], Message: 'You are not authorized to delete this message', Raw: '' });
    expect(seen).toEqual(["You can't delete that message."]);
  });
});
