import { describe, it, expect, beforeEach } from 'vitest';
import { PresenceService, type PresenceDeps } from './presence.service';
import type { ChatService } from './chat.service';
import type { ChatState, ChatMember } from './chat.types';
import type { PresenceMatch } from '../directory/directory.types';
import { getAvatar, setAvatar } from './avatar-cache';

type Self = { nick: string; host?: string; account?: string };

function fakeChat(network: string | undefined, self: Self, members: ChatMember[]): Pick<ChatService, 'getState' | 'selfIdentity' | 'subscribe'> {
  return {
    getState: () => ({ channels: [{ members }], serverInfo: { network } } as unknown as ChatState),
    selfIdentity: () => self,
    subscribe: (_listener: (s: ChatState) => void) => () => {},
  } as Pick<ChatService, 'getState' | 'selfIdentity' | 'subscribe'>;
}

function member(nick: string, extra: Partial<ChatMember> = {}): ChatMember {
  return { nick, prefix: '', ...extra };
}

function deps(over: Partial<PresenceDeps> & { matches?: PresenceMatch[] } = {}): {
  deps: PresenceDeps; publishCalls: any[]; lookupCalls: any[];
} {
  const publishCalls: any[] = [];
  const lookupCalls: any[] = [];
  return {
    publishCalls, lookupCalls,
    deps: {
      publishPresence: over.publishPresence ?? (async (i) => { publishCalls.push(i); }),
      lookupPresence: over.lookupPresence ?? (async (network, members) => { lookupCalls.push({ network, members }); return over.matches ?? []; }),
      ownAvatarUrl: over.ownAvatarUrl ?? (() => undefined),
    },
  };
}

const SIGNED_IN = () => true;

describe('PresenceService — publish', () => {
  beforeEach(() => { setAvatar('s1', 'me', null); });

  it('publishes our identity when signed in + network known', async () => {
    const { deps: d, publishCalls } = deps();
    const svc = new PresenceService(fakeChat('Libera', { nick: 'me', host: 'h', account: 'acct' }, []), d, 's1', 'irc.x', SIGNED_IN);
    await svc.publishNow();
    expect(publishCalls).toEqual([{ network: 'Libera', nick: 'me', host: 'h', account: 'acct' }]);
  });

  it('falls back to the server hostname when no NETWORK token', async () => {
    const { deps: d, publishCalls } = deps();
    const svc = new PresenceService(fakeChat(undefined, { nick: 'me' }, []), d, 's1', 'irc.example', SIGNED_IN);
    await svc.publishNow();
    expect(publishCalls[0].network).toBe('irc.example');
  });

  it('dedupes — same identity publishes once', async () => {
    const { deps: d, publishCalls } = deps();
    const svc = new PresenceService(fakeChat('Libera', { nick: 'me' }, []), d, 's1', 'irc.x', SIGNED_IN);
    await svc.publishNow();
    await svc.publishNow();
    expect(publishCalls).toHaveLength(1);
  });

  it('no-ops when signed out', async () => {
    const { deps: d, publishCalls } = deps();
    const svc = new PresenceService(fakeChat('Libera', { nick: 'me' }, []), d, 's1', 'irc.x', () => false);
    await svc.publishNow();
    expect(publishCalls).toHaveLength(0);
  });

  it('pins our own avatar into the cache under our current nick', async () => {
    const { deps: d } = deps({ ownAvatarUrl: () => 'https://cdn/me.png' });
    const svc = new PresenceService(fakeChat('Libera', { nick: 'me' }, []), d, 's1', 'irc.x', SIGNED_IN);
    await svc.publishNow();
    expect(getAvatar('s1', 'me')).toBe('https://cdn/me.png');
  });
});

describe('PresenceService — lookup', () => {
  beforeEach(() => { setAvatar('s1', 'alice', null); setAvatar('s1', 'bob', null); });

  it('looks up members (excluding self) + populates the avatar cache for matches', async () => {
    const { deps: d, lookupCalls } = deps({ matches: [{ nick: 'alice', handle: 'alice', avatar_url: 'https://cdn/a.png' }] });
    const svc = new PresenceService(
      fakeChat('Libera', { nick: 'me' }, [member('alice', { hostname: 'ha', account: 'aa' }), member('bob'), member('me')]),
      d, 's1', 'irc.x', SIGNED_IN,
    );
    await svc.lookupNow();
    // self excluded, alice + bob queried.
    expect(lookupCalls[0].members.map((m: any) => m.nick).sort()).toEqual(['alice', 'bob']);
    expect(getAvatar('s1', 'alice')).toBe('https://cdn/a.png');
    expect(getAvatar('s1', 'bob')).toBeUndefined(); // not a member
  });

  it('does not re-query members whose identity is unchanged', async () => {
    const { deps: d, lookupCalls } = deps({ matches: [] });
    const svc = new PresenceService(
      fakeChat('Libera', { nick: 'me' }, [member('alice', { hostname: 'ha' })]),
      d, 's1', 'irc.x', SIGNED_IN,
    );
    await svc.lookupNow();
    await svc.lookupNow();
    expect(lookupCalls).toHaveLength(1);
  });

  it('re-queries a member when their identity (host/account) changes', async () => {
    const { deps: d, lookupCalls } = deps({ matches: [] });
    const chat = fakeChat('Libera', { nick: 'me' }, [member('alice', { hostname: 'ha' })]);
    const svc = new PresenceService(chat, d, 's1', 'irc.x', SIGNED_IN);
    await svc.lookupNow();
    // alice identifies → account changes → re-query.
    (chat.getState().channels[0]!.members as ChatMember[])[0] = member('alice', { hostname: 'ha', account: 'aliceacct' });
    await svc.lookupNow();
    expect(lookupCalls).toHaveLength(2);
  });

  it('no-ops when signed out', async () => {
    const { deps: d, lookupCalls } = deps();
    const svc = new PresenceService(fakeChat('Libera', { nick: 'me' }, [member('alice')]), d, 's1', 'irc.x', () => false);
    await svc.lookupNow();
    expect(lookupCalls).toHaveLength(0);
  });
});
