import { describe, it, expect, vi } from 'vitest';
import { ChatInputBloc, type ChatInputState } from './ChatInputBloc';

interface BlocHandle {
  bloc: ChatInputBloc;
  sent: string[][];
  setMembers: (m: { nick: string }[]) => void;
  setChannels: (c: string[]) => void;
}

function makeBloc({
  members = [] as { nick: string }[],
  channels = [] as string[],
}: { members?: { nick: string }[]; channels?: string[] } = {}): BlocHandle {
  let currentMembers = members;
  let currentChannels = channels;
  const sent: string[][] = [];
  const bloc = new ChatInputBloc({
    getMembers: () => currentMembers,
    getKnownChannels: () => currentChannels,
    onSend: (lines) => { sent.push([...lines]); },
  });
  return {
    bloc,
    sent,
    setMembers: (m) => { currentMembers = m; },
    setChannels: (c) => { currentChannels = c; },
  };
}

function makeKey(
  key: string,
  selectionStart: number | null = null,
  shiftKey = false,
): { key: string; shiftKey: boolean; preventDefault: () => void; selectionStart: number | null; preventDefaultCount: number } {
  let count = 0;
  return {
    key,
    shiftKey,
    selectionStart,
    preventDefault() { count++; },
    get preventDefaultCount() { return count; },
  };
}

describe('ChatInputBloc', () => {
  describe('initial state', () => {
    it('starts with empty input and no popups open', () => {
      const { bloc } = makeBloc();
      const s = bloc.getState();
      expect(s.input).toBe('');
      expect(s.slashOpen).toBe(false);
      expect(s.mentionOpen).toBe(false);
      expect(s.channelOpen).toBe(false);
      expect(s.tokens).toEqual([]);
      expect(s.pendingCursor).toBeNull();
    });
  });

  describe('subscribe', () => {
    it('emits current state immediately and on changes', () => {
      const { bloc } = makeBloc();
      const calls: ChatInputState[] = [];
      const unsub = bloc.subscribe((s) => { calls.push(s); });
      expect(calls.length).toBe(1);
      expect(calls[0]!.input).toBe('');
      bloc.setInput('hello');
      expect(calls.length).toBe(2);
      expect(calls[1]!.input).toBe('hello');
      unsub();
      bloc.setInput('again');
      expect(calls.length).toBe(2);
    });
  });

  describe('setInput', () => {
    it('updates input and emits to subscribers', () => {
      const { bloc } = makeBloc();
      const fn = vi.fn();
      bloc.subscribe(fn);
      bloc.setInput('hello world');
      expect(bloc.getState().input).toBe('hello world');
      expect(fn).toHaveBeenLastCalledWith(
        expect.objectContaining({ input: 'hello world' }),
      );
    });

    it('re-arms slash autocomplete after a prior Escape dismiss', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/jo');
      expect(bloc.getState().slashOpen).toBe(true);
      bloc.dismissSlashPopup();
      expect(bloc.getState().slashOpen).toBe(false);
      bloc.setInput('/he');
      expect(bloc.getState().slashOpen).toBe(true);
    });

    it('drops any in-flight nick / mention / channel / command cycle', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }, { nick: 'arnold' }] });
      bloc.setInput('hi al');
      bloc.handleKeyDown(makeKey('Tab', 5));
      expect(bloc.getState().input).toBe('hi alice');
      // Re-typing the partial resets the cycle; next Tab restarts from
      // 'alice' (not 'arnold') even though we matched-then-cycled before.
      bloc.setInput('hi al');
      bloc.handleKeyDown(makeKey('Tab', 5));
      expect(bloc.getState().input).toBe('hi alice');
    });
  });

  describe('slash popup', () => {
    it("opens when input starts with '/' and there are matches", () => {
      const { bloc } = makeBloc();
      bloc.setInput('/jo');
      const s = bloc.getState();
      expect(s.slashOpen).toBe(true);
      expect(s.slashMatches.map((c) => c.name)).toContain('join');
    });

    it("does NOT open for '//' (literal-slash escape)", () => {
      const { bloc } = makeBloc();
      bloc.setInput('//hi');
      expect(bloc.getState().slashOpen).toBe(false);
    });

    it('does NOT open once a space has been typed', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/join ');
      expect(bloc.getState().slashOpen).toBe(false);
    });

    it('Tab commits the current selection + arms the cycle, end-of-input cursor', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/');
      const before = bloc.getState();
      expect(before.slashOpen).toBe(true);
      bloc.handleKeyDown(makeKey('Tab', 1));
      const after = bloc.getState();
      // The first command (join) gets committed.
      expect(after.input).toBe('/join ');
      expect(after.pendingCursor).toBe(after.input.length);
    });

    it('Tab cycles through matching commands after first commit', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/');
      bloc.handleKeyDown(makeKey('Tab', 1));
      const first = bloc.getState().input;
      // Cycle proceeds even though input now has a trailing space and the
      // popup useMemo would otherwise close.
      bloc.handleKeyDown(makeKey('Tab', first.length));
      const second = bloc.getState().input;
      expect(second).not.toBe(first);
      expect(second.startsWith('/')).toBe(true);
      expect(second.endsWith(' ')).toBe(true);
    });

    it('ArrowDown / ArrowUp moves the highlighted index', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/');
      const count = bloc.getState().slashMatches.length;
      expect(count).toBeGreaterThan(1);
      bloc.handleKeyDown(makeKey('ArrowDown', 1));
      expect(bloc.getState().slashSelected).toBe(1);
      bloc.handleKeyDown(makeKey('ArrowUp', 1));
      expect(bloc.getState().slashSelected).toBe(0);
      // Wrap-around.
      bloc.handleKeyDown(makeKey('ArrowUp', 1));
      expect(bloc.getState().slashSelected).toBe(count - 1);
    });

    it('Enter accepts the highlighted command', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/');
      bloc.setSlashSelected(1);
      const second = bloc.getState().slashMatches[1]!.name;
      bloc.handleKeyDown(makeKey('Enter', 1));
      expect(bloc.getState().input).toBe(`/${second} `);
    });

    it('Escape dismisses the popup without clearing the input', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/jo');
      bloc.handleKeyDown(makeKey('Escape', 3));
      const s = bloc.getState();
      expect(s.slashOpen).toBe(false);
      expect(s.input).toBe('/jo');
    });

    it('acceptSlash() works from a mouse click path', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/jo');
      bloc.acceptSlash();
      expect(bloc.getState().input).toBe('/join ');
    });
  });

  describe('@-mention popup', () => {
    it('opens for a known member prefix', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }, { nick: 'bob' }] });
      bloc.setInput('hey @al');
      const s = bloc.getState();
      expect(s.mentionOpen).toBe(true);
      expect(s.mentionMatches).toEqual(['alice']);
    });

    it('does NOT open inside an email-like substring', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('user@alice.com');
      expect(bloc.getState().mentionOpen).toBe(false);
    });

    it('Tab commits + arms the cycle for further Tabs', () => {
      const { bloc } = makeBloc({
        members: [{ nick: 'alice' }, { nick: 'arnold' }],
      });
      bloc.setInput('hi @a');
      // Cycle is empty before commit.
      bloc.handleKeyDown(makeKey('Tab', 5));
      const after = bloc.getState();
      // First match alphabetically.
      expect(after.input).toBe('hi @alice ');
      expect(after.pendingCursor).toBe(after.input.length);
      // Next Tab swaps to arnold (popup is closed because trailing space).
      bloc.handleKeyDown(makeKey('Tab', after.input.length));
      expect(bloc.getState().input).toBe('hi @arnold ');
    });

    it('Enter commits + arms cycle (same as Tab)', () => {
      const { bloc } = makeBloc({
        members: [{ nick: 'alice' }, { nick: 'arnold' }],
      });
      bloc.setInput('hi @a');
      bloc.setMentionSelected(1);
      bloc.handleKeyDown(makeKey('Enter', 5));
      expect(bloc.getState().input).toBe('hi @arnold ');
    });

    it('Escape adds a space to break the regex match', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('hi @al');
      bloc.handleKeyDown(makeKey('Escape', 6));
      expect(bloc.getState().input).toBe('hi @al ');
      expect(bloc.getState().mentionOpen).toBe(false);
    });

    it('Arrow keys cycle the selected index', () => {
      const { bloc } = makeBloc({
        members: [{ nick: 'alice' }, { nick: 'arnold' }],
      });
      bloc.setInput('@a');
      bloc.handleKeyDown(makeKey('ArrowDown', 2));
      expect(bloc.getState().mentionSelected).toBe(1);
      bloc.handleKeyDown(makeKey('ArrowDown', 2));
      expect(bloc.getState().mentionSelected).toBe(0); // wraps
    });
  });

  describe('#-channel popup', () => {
    it('opens for a leading sigil that matches a known channel', () => {
      const { bloc } = makeBloc({ channels: ['#dev', '#design'] });
      bloc.setInput('see #de');
      const s = bloc.getState();
      expect(s.channelOpen).toBe(true);
      expect(s.channelMatches).toEqual(['#design', '#dev']);
    });

    it('Tab commits and arms a cycle', () => {
      const { bloc } = makeBloc({ channels: ['#dev', '#design'] });
      bloc.setInput('see #de');
      bloc.handleKeyDown(makeKey('Tab', 7));
      const after = bloc.getState();
      expect(after.input).toBe('see #design ');
      bloc.handleKeyDown(makeKey('Tab', after.input.length));
      expect(bloc.getState().input).toBe('see #dev ');
    });
  });

  describe('bare-nick Tab-complete', () => {
    it('completes a partial nick at the cursor (no popup open)', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }, { nick: 'bob' }] });
      bloc.setInput('hello al');
      bloc.handleKeyDown(makeKey('Tab', 'hello al'.length));
      expect(bloc.getState().input).toBe('hello alice');
    });

    it('uses "nick: " at the start of a line', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('al');
      bloc.handleKeyDown(makeKey('Tab', 2));
      expect(bloc.getState().input).toBe('alice: ');
    });

    it('cycles through multiple matches on repeated Tabs', () => {
      const { bloc } = makeBloc({
        members: [{ nick: 'alice' }, { nick: 'arnold' }, { nick: 'andrew' }],
      });
      bloc.setInput('a');
      bloc.handleKeyDown(makeKey('Tab', 1));
      const first = bloc.getState().input;
      bloc.handleKeyDown(makeKey('Tab', first.length));
      const second = bloc.getState().input;
      bloc.handleKeyDown(makeKey('Tab', second.length));
      const third = bloc.getState().input;
      expect(new Set([first, second, third]).size).toBe(3);
      // Wraps back around.
      bloc.handleKeyDown(makeKey('Tab', third.length));
      expect(bloc.getState().input).toBe(first);
    });

    it('does nothing when there are no matches', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('xyz');
      bloc.handleKeyDown(makeKey('Tab', 3));
      expect(bloc.getState().input).toBe('xyz');
    });

    it('returns false (allows default) when there is no nick word at cursor', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      const ev = makeKey('Tab', 0);
      bloc.handleKeyDown(ev);
      // preventDefault not called because we let the Tab fall through.
      expect(ev.preventDefaultCount).toBe(0);
    });
  });

  describe('pendingCursor', () => {
    it('is populated after a slash commit', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/jo');
      bloc.acceptSlash();
      expect(bloc.getState().pendingCursor).toBe('/join '.length);
    });

    it('is populated after a mention commit', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('@a');
      bloc.acceptMention();
      const s = bloc.getState();
      expect(s.input).toBe('@alice ');
      expect(s.pendingCursor).toBe('@alice '.length);
    });

    it('is populated after a bare-nick Tab-complete', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('al');
      bloc.handleKeyDown(makeKey('Tab', 2));
      expect(bloc.getState().pendingCursor).toBe('alice: '.length);
    });

    it('clearPendingCursor() drops it back to null and emits', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('al');
      bloc.handleKeyDown(makeKey('Tab', 2));
      expect(bloc.getState().pendingCursor).not.toBeNull();
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.clearPendingCursor();
      expect(bloc.getState().pendingCursor).toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('clearPendingCursor() is a no-op (no emit) when already null', () => {
      const { bloc } = makeBloc();
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.clearPendingCursor();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('Enter (no shift) routes through send → onSend, clears input', () => {
      const { bloc, sent } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('hi there');
      bloc.handleKeyDown(makeKey('Enter'));
      expect(sent).toEqual([['hi there']]);
      expect(bloc.getState().input).toBe('');
    });

    it('Shift+Enter does NOT send (default newline behaviour)', () => {
      const { bloc, sent } = makeBloc();
      bloc.setInput('hi');
      bloc.handleKeyDown(makeKey('Enter', null, true));
      expect(sent).toEqual([]);
      expect(bloc.getState().input).toBe('hi');
    });

    it('strips known-member @nick before sending', () => {
      const { bloc, sent } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('hey @alice ping');
      bloc.send();
      expect(sent).toEqual([['hey alice ping']]);
    });

    it('multi-line input becomes one onSend(lines) call with N lines', () => {
      const { bloc, sent } = makeBloc();
      bloc.setInput('one\ntwo\n\nthree');
      bloc.send();
      expect(sent).toEqual([['one', 'two', 'three']]);
    });

    it('empty / whitespace-only input is a no-op', () => {
      const { bloc, sent } = makeBloc();
      bloc.setInput('   ');
      bloc.send();
      expect(sent).toEqual([]);
    });
  });

  describe('priority: slash > mention > channel', () => {
    it('slash takes precedence over an apparent @-trigger', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      // A leading slash means slash autocomplete is active; @ in the middle
      // of a slash command line does not trigger the mention popup until
      // the slash autocomplete closes.
      bloc.setInput('/me');
      expect(bloc.getState().slashOpen).toBe(true);
      expect(bloc.getState().mentionOpen).toBe(false);
    });

    it('mention takes precedence over channel popup', () => {
      const { bloc } = makeBloc({
        members: [{ nick: 'alice' }],
        channels: ['#general'],
      });
      // The trailing token here is @al, not #foo; mention wins.
      bloc.setInput('see #general @al');
      expect(bloc.getState().mentionOpen).toBe(true);
      expect(bloc.getState().channelOpen).toBe(false);
    });
  });

  describe('overlay tokens', () => {
    it('classifies known-member @nick as a mention token', () => {
      const { bloc } = makeBloc({ members: [{ nick: 'alice' }] });
      bloc.setInput('hi @alice');
      const tokens = bloc.getState().tokens;
      expect(tokens.some((t) => t.type === 'mention' && t.value === '@alice')).toBe(true);
    });

    it('classifies a leading /cmd as a command token', () => {
      const { bloc } = makeBloc();
      bloc.setInput('/join #x');
      const tokens = bloc.getState().tokens;
      expect(tokens[0]).toEqual({ type: 'command', value: '/join' });
    });
  });
});
