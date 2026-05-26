import { describe, it, expect, vi } from 'vitest';
import type { ChatChannel } from '../../modules/chat';
import {
  ChannelSidebarBloc,
  type ChannelSidebarState,
} from './ChannelSidebarBloc';

function makeChannel(name: string): ChatChannel {
  return { name, messages: [], joined: true, members: [], typing: [], unread: 0, mentions: 0 };
}

interface BlocHandle {
  bloc: ChannelSidebarBloc;
  joined: string[];
  setChannels: (channels: readonly ChatChannel[]) => void;
}

function makeBloc(initial: readonly ChatChannel[] = []): BlocHandle {
  let current = initial;
  const joined: string[] = [];
  const bloc = new ChannelSidebarBloc({
    getChannels: () => current,
    onJoin: (name) => { joined.push(name); },
  });
  return {
    bloc,
    joined,
    setChannels: (channels) => { current = channels; },
  };
}

describe('ChannelSidebarBloc', () => {
  describe('initial state', () => {
    it('starts empty with no modal and no error', () => {
      const { bloc } = makeBloc();
      const s = bloc.getState();
      expect(s.query).toBe('');
      expect(s.joinModalOpen).toBe(false);
      expect(s.joinDraft).toBe('');
      expect(s.joinError).toBeNull();
      expect(s.realChannels).toEqual([]);
      expect(s.dms).toEqual([]);
    });

    it('splits an initial channel list into real channels and DMs', () => {
      const { bloc } = makeBloc([
        makeChannel('#general'),
        makeChannel('&local'),
        makeChannel('alice'),
        makeChannel('bob'),
      ]);
      const s = bloc.getState();
      expect(s.realChannels.map((c) => c.name)).toEqual(['#general', '&local']);
      expect(s.dms.map((c) => c.name)).toEqual(['alice', 'bob']);
    });
  });

  describe('subscribe', () => {
    it('emits current state immediately and on changes, and unsubscribe works', () => {
      const { bloc } = makeBloc([makeChannel('#dev')]);
      const calls: ChannelSidebarState[] = [];
      const unsub = bloc.subscribe((s) => { calls.push(s); });
      expect(calls.length).toBe(1);
      expect(calls[0]!.realChannels.map((c) => c.name)).toEqual(['#dev']);
      bloc.setQuery('dev');
      expect(calls.length).toBe(2);
      expect(calls[1]!.query).toBe('dev');
      unsub();
      bloc.setQuery('other');
      expect(calls.length).toBe(2);
    });
  });

  describe('setQuery filtering', () => {
    it('filters channels by case-insensitive substring match', () => {
      const { bloc } = makeBloc([
        makeChannel('#general'),
        makeChannel('#dev'),
        makeChannel('#design'),
        makeChannel('alice'),
        makeChannel('bob'),
      ]);
      bloc.setQuery('de');
      const s = bloc.getState();
      expect(s.realChannels.map((c) => c.name)).toEqual(['#dev', '#design']);
      expect(s.dms.map((c) => c.name)).toEqual([]);
    });

    it('treats whitespace-only query as no filter', () => {
      const { bloc } = makeBloc([makeChannel('#general'), makeChannel('alice')]);
      bloc.setQuery('   ');
      const s = bloc.getState();
      expect(s.realChannels.map((c) => c.name)).toEqual(['#general']);
      expect(s.dms.map((c) => c.name)).toEqual(['alice']);
    });

    it('matches DM virtual channels too', () => {
      const { bloc } = makeBloc([
        makeChannel('#dev'),
        makeChannel('alice'),
        makeChannel('arnold'),
      ]);
      bloc.setQuery('al');
      const s = bloc.getState();
      expect(s.realChannels).toEqual([]);
      expect(s.dms.map((c) => c.name)).toEqual(['alice']);
    });

    it('returns empty groupings when nothing matches', () => {
      const { bloc } = makeBloc([makeChannel('#dev')]);
      bloc.setQuery('zzz');
      const s = bloc.getState();
      expect(s.realChannels).toEqual([]);
      expect(s.dms).toEqual([]);
    });

    it('is a no-op when the value is unchanged (no emit)', () => {
      const { bloc } = makeBloc();
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.setQuery('');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('join modal lifecycle', () => {
    it('openJoinModal() opens with empty draft and no error', () => {
      const { bloc } = makeBloc();
      bloc.openJoinModal();
      const s = bloc.getState();
      expect(s.joinModalOpen).toBe(true);
      expect(s.joinDraft).toBe('');
      expect(s.joinError).toBeNull();
    });

    it('openJoinModal() clears any leftover draft / error from a prior session', () => {
      const { bloc } = makeBloc();
      bloc.openJoinModal();
      bloc.setJoinDraft('#stale');
      bloc.submitJoin(); // valid, closes the modal
      // Simulate a stuck error by submitting empty next time.
      bloc.openJoinModal();
      bloc.submitJoin();
      expect(bloc.getState().joinError).toBe('Channel name is required.');
      bloc.closeJoinModal();
      bloc.openJoinModal();
      const s = bloc.getState();
      expect(s.joinDraft).toBe('');
      expect(s.joinError).toBeNull();
    });

    it('closeJoinModal() resets draft + error and emits', () => {
      const { bloc } = makeBloc();
      bloc.openJoinModal();
      bloc.setJoinDraft('#foo');
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.closeJoinModal();
      const s = bloc.getState();
      expect(s.joinModalOpen).toBe(false);
      expect(s.joinDraft).toBe('');
      expect(s.joinError).toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('closeJoinModal() is a no-op (no emit) when already fully closed', () => {
      const { bloc } = makeBloc();
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.closeJoinModal();
      expect(fn).not.toHaveBeenCalled();
    });

    it('setJoinDraft() updates the draft and emits', () => {
      const { bloc } = makeBloc();
      bloc.openJoinModal();
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.setJoinDraft('#general');
      expect(bloc.getState().joinDraft).toBe('#general');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('submitJoin validation', () => {
    it('rejects an empty draft with the required-name error and keeps modal open', () => {
      const { bloc, joined } = makeBloc();
      bloc.openJoinModal();
      bloc.submitJoin();
      const s = bloc.getState();
      expect(s.joinError).toBe('Channel name is required.');
      expect(s.joinModalOpen).toBe(true);
      expect(joined).toEqual([]);
    });

    it('rejects a whitespace-only draft with the required-name error', () => {
      const { bloc, joined } = makeBloc();
      bloc.openJoinModal();
      bloc.setJoinDraft('   ');
      bloc.submitJoin();
      expect(bloc.getState().joinError).toBe('Channel name is required.');
      expect(bloc.getState().joinModalOpen).toBe(true);
      expect(joined).toEqual([]);
    });

    it('rejects a draft containing inner spaces with the no-spaces error', () => {
      const { bloc, joined } = makeBloc();
      bloc.openJoinModal();
      bloc.setJoinDraft('#has space');
      bloc.submitJoin();
      expect(bloc.getState().joinError).toBe('Channel names cannot contain spaces.');
      expect(bloc.getState().joinModalOpen).toBe(true);
      expect(joined).toEqual([]);
    });

    it('accepts a valid draft, calls onJoin with the trimmed value, and closes the modal', () => {
      const { bloc, joined } = makeBloc();
      bloc.openJoinModal();
      bloc.setJoinDraft('  #general  ');
      bloc.submitJoin();
      expect(joined).toEqual(['#general']);
      const s = bloc.getState();
      expect(s.joinModalOpen).toBe(false);
      expect(s.joinDraft).toBe('');
      expect(s.joinError).toBeNull();
    });

    it('accepts a name without a leading # (ChatService auto-prefixes)', () => {
      const { bloc, joined } = makeBloc();
      bloc.openJoinModal();
      bloc.setJoinDraft('general');
      bloc.submitJoin();
      expect(joined).toEqual(['general']);
      expect(bloc.getState().joinModalOpen).toBe(false);
    });
  });

  describe('notifyChannelsChanged', () => {
    it('re-derives groupings when the underlying channel list changes', () => {
      const { bloc, setChannels } = makeBloc([makeChannel('#dev')]);
      const calls: ChannelSidebarState[] = [];
      bloc.subscribe((s) => { calls.push(s); });
      expect(calls[0]!.realChannels.map((c) => c.name)).toEqual(['#dev']);

      setChannels([makeChannel('#dev'), makeChannel('#design'), makeChannel('alice')]);
      bloc.notifyChannelsChanged();
      const latest = calls[calls.length - 1]!;
      expect(latest.realChannels.map((c) => c.name)).toEqual(['#dev', '#design']);
      expect(latest.dms.map((c) => c.name)).toEqual(['alice']);
    });

    it('re-applies the current query against the refreshed channel list', () => {
      const { bloc, setChannels } = makeBloc([makeChannel('#dev')]);
      bloc.setQuery('design');
      expect(bloc.getState().realChannels).toEqual([]);
      setChannels([makeChannel('#dev'), makeChannel('#design')]);
      bloc.notifyChannelsChanged();
      expect(bloc.getState().realChannels.map((c) => c.name)).toEqual(['#design']);
    });

    it('emits a fresh snapshot to subscribers', () => {
      const { bloc, setChannels } = makeBloc([]);
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      setChannels([makeChannel('#new')]);
      bloc.notifyChannelsChanged();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          realChannels: expect.arrayContaining([expect.objectContaining({ name: '#new' })]),
        }),
      );
    });
  });
});
