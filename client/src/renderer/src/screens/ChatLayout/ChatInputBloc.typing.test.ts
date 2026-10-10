import { describe, it, expect } from 'vitest';
import { ChatInputBloc } from './ChatInputBloc';

// The IRCv3 typing signal the composer emits (ChatService turns each call into
// a +typing TAGMSG on the wire, which the IRC library rate-limits together
// with real messages — so stray signals cost the user send latency).
function makeBloc(): { bloc: ChatInputBloc; typing: string[]; sent: string[][] } {
  const typing: string[] = [];
  const sent: string[][] = [];
  const bloc = new ChatInputBloc({
    getMembers: () => [],
    getKnownChannels: () => [],
    onSend: (lines) => { sent.push(lines); },
    onTyping: (s) => { typing.push(s); },
  });
  return { bloc, typing, sent };
}

describe('ChatInputBloc typing signal', () => {
  it('signals active while typing and done on send', () => {
    const { bloc, typing, sent } = makeBloc();
    bloc.setInput('h');
    bloc.setInput('hi');
    bloc.send();
    expect(sent).toEqual([['hi']]);
    expect(typing).toEqual(['active', 'active', 'done']);
  });

  it('signals done when a typed draft is cleared by hand', () => {
    const { bloc, typing } = makeBloc();
    bloc.setInput('hi');
    bloc.setInput('');
    expect(typing).toEqual(['active', 'done']);
  });

  it('sends no typing signal at all for a slash command', () => {
    const { bloc, typing, sent } = makeBloc();
    bloc.setInput('/');
    bloc.setInput('/help');
    bloc.send();
    expect(sent).toEqual([['/help']]);
    expect(typing).toEqual([]);
  });

  it('still clears typing when a typed draft is turned into a command', () => {
    const { bloc, typing } = makeBloc();
    bloc.setInput('hello');
    bloc.setInput('/me hello');
    bloc.send();
    expect(typing).toEqual(['active', 'done']);
  });

  it('signals done only once per announced typing run', () => {
    const { bloc, typing } = makeBloc();
    bloc.setInput('one');
    bloc.send();
    bloc.setInput('/away');
    bloc.send();
    expect(typing).toEqual(['active', 'done']);
  });
});
