import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatLayoutBloc, type ChatLayoutState } from './ChatLayoutBloc';
import type {
  ChatService,
  ChatFeedback,
  ChatFeedbackListener,
  SlashCommandSpec,
} from '../../modules/chat';

// Test harness — builds a fake ChatService whose onFeedback captures the
// listener so each test can emit synthetic feedback at will. We deliberately
// only stub the methods the bloc actually touches; the rest stay no-op.

interface FakeChatHandle {
  chat: ChatService;
  emit: (f: ChatFeedback) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  onFeedback: ReturnType<typeof vi.fn>;
}

function buildFakeChat(): FakeChatHandle {
  let listener: ChatFeedbackListener | null = null;
  const unsubscribe = vi.fn(() => { listener = null; });
  const onFeedback = vi.fn((fn: ChatFeedbackListener) => {
    listener = fn;
    return unsubscribe;
  });
  const chat = {
    getState: vi.fn(() => ({ channels: [], activeChannel: null })),
    subscribe: vi.fn(() => () => {}),
    onFeedback,
    join: vi.fn(),
    part: vi.fn(),
    send: vi.fn(),
    input: vi.fn(),
    setActive: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    setNick: vi.fn(),
  } as unknown as ChatService;
  return {
    chat,
    emit: (f) => {
      if (!listener) throw new Error('bloc did not subscribe to onFeedback');
      listener(f);
    },
    unsubscribe,
    onFeedback,
  };
}

const helpCommands: readonly SlashCommandSpec[] = [
  { name: 'join', usage: '/join <channel>', description: 'Join a channel' },
];

describe('ChatLayoutBloc', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('initial state + subscription wiring', () => {
    it('starts with no banner and no help-modal commands', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      expect(bloc.getState()).toEqual<ChatLayoutState>({
        bannerError: null,
        helpCommands: null,
      });
    });

    it('subscribes to chat.onFeedback immediately on construction', () => {
      const fake = buildFakeChat();
      new ChatLayoutBloc({ chat: fake.chat });
      expect(fake.onFeedback).toHaveBeenCalledOnce();
    });

    it('subscribe(fn) fires immediately with the current state', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      const seen: ChatLayoutState[] = [];
      bloc.subscribe((s) => seen.push(s));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ bannerError: null, helpCommands: null });
    });

    it('subscribe returns an unsubscriber that stops further notifications', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      const fn = vi.fn();
      const off = bloc.subscribe(fn);
      fn.mockClear();
      off();
      fake.emit({ kind: 'error', text: 'oops' });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('error feedback → banner', () => {
    it('sets bannerError to the feedback text and notifies subscribers', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      fake.emit({ kind: 'error', text: 'unknown command' });
      expect(bloc.getState().bannerError).toBe('unknown command');
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ bannerError: 'unknown command' }));
    });

    it('auto-dismisses the banner after the default 4500 ms', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      fake.emit({ kind: 'error', text: 'boom' });
      expect(bloc.getState().bannerError).toBe('boom');

      // Just before the deadline → still visible.
      vi.advanceTimersByTime(4499);
      expect(bloc.getState().bannerError).toBe('boom');

      // Hitting the deadline → cleared.
      vi.advanceTimersByTime(1);
      expect(bloc.getState().bannerError).toBeNull();
    });

    it('respects a custom autoDismissMs from deps', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat, autoDismissMs: 1000 });
      fake.emit({ kind: 'error', text: 'boom' });
      vi.advanceTimersByTime(999);
      expect(bloc.getState().bannerError).toBe('boom');
      vi.advanceTimersByTime(1);
      expect(bloc.getState().bannerError).toBeNull();
    });

    it('a fresh error restarts the auto-dismiss timer', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      fake.emit({ kind: 'error', text: 'first' });
      vi.advanceTimersByTime(4000);
      // Within the original window — fire a second error. The first timer
      // should be canceled and a fresh 4500ms window started for "second".
      fake.emit({ kind: 'error', text: 'second' });
      vi.advanceTimersByTime(4499);
      expect(bloc.getState().bannerError).toBe('second');
      vi.advanceTimersByTime(1);
      expect(bloc.getState().bannerError).toBeNull();
    });
  });

  describe('dismissBanner()', () => {
    it('clears bannerError immediately', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      fake.emit({ kind: 'error', text: 'oops' });
      expect(bloc.getState().bannerError).toBe('oops');
      bloc.dismissBanner();
      expect(bloc.getState().bannerError).toBeNull();
    });

    it('cancels the pending auto-dismiss timer so it does not fire later', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      const fn = vi.fn();
      fake.emit({ kind: 'error', text: 'oops' });
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.dismissBanner();
      const callsAfterDismiss = fn.mock.calls.length;
      // Push the clock past the original window — if the timer leaked we'd
      // see a second null-banner emission here.
      vi.advanceTimersByTime(5000);
      expect(fn.mock.calls.length).toBe(callsAfterDismiss);
    });

    it('is a no-op (no notification) when there is no banner', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.dismissBanner();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('help feedback → modal', () => {
    it('opens the modal by populating helpCommands', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      fake.emit({ kind: 'help', commands: helpCommands });
      expect(bloc.getState().helpCommands).toBe(helpCommands);
    });

    it('closeHelp() clears the helpCommands', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      fake.emit({ kind: 'help', commands: helpCommands });
      bloc.closeHelp();
      expect(bloc.getState().helpCommands).toBeNull();
    });

    it('closeHelp() is a no-op (no notification) when the modal is already closed', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.closeHelp();
      expect(fn).not.toHaveBeenCalled();
    });

    it('a help event does not touch bannerError', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      fake.emit({ kind: 'error', text: 'visible' });
      fake.emit({ kind: 'help', commands: helpCommands });
      expect(bloc.getState().bannerError).toBe('visible');
      expect(bloc.getState().helpCommands).toBe(helpCommands);
    });
  });

  describe('dispose()', () => {
    it('runs the chat.onFeedback unsubscribe function', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      expect(fake.unsubscribe).not.toHaveBeenCalled();
      bloc.dispose();
      expect(fake.unsubscribe).toHaveBeenCalledOnce();
    });

    it('clears any pending auto-dismiss timer (no leaked clearBanner emission)', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      const fn = vi.fn();
      fake.emit({ kind: 'error', text: 'oops' });
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.dispose();
      vi.advanceTimersByTime(10_000);
      expect(fn).not.toHaveBeenCalled();
    });

    it('is idempotent — second call does not double-unsubscribe', () => {
      const fake = buildFakeChat();
      const bloc = new ChatLayoutBloc({ chat: fake.chat });
      bloc.dispose();
      bloc.dispose();
      expect(fake.unsubscribe).toHaveBeenCalledOnce();
    });
  });
});
