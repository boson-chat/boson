// Turns friend and call events into notifications: a friend request or an
// accepted request, a missed call, and a call starting in a voice channel
// you're in. Each lands in the bell's list and, per the settings, shows a
// toast (in-app) and a system notification (while Boson is in the
// background). Mentions and DMs come through the Notifier instead.
import { getFriendsController, onFriendsControllerChange, type FriendsController, type FriendsSnapshot } from '../friends';
import type { CallInfo } from '../friends/friends.types';
import { getVoiceController, type VoiceSnapshot } from '../voice';
import { getNotificationSettings } from '../ui/notifications.store';
import { getNotifier } from '../ui/notifier';
import { getNotificationFeed, type NotificationFeed, type ToastRoom } from './feed';
import { chime } from './chime';

// A server you're connected to: its voice host and the channels you're in.
export interface VoiceScope {
  host: string;
  serverId: string;
  serverName: string;
  // Joined channels, casefolded ('#boson').
  channels: readonly string[];
}

export interface BridgeOptions {
  scope: () => readonly VoiceScope[];
  // Opening a notification's subject (the bell's and the toasts' wiring).
  open?: {
    friends: () => void;
    calls: () => void;
    voice: (room: ToastRoom) => void;
  };
  feed?: NotificationFeed;
}

export function startNotificationBridge(opts: BridgeOptions): () => void {
  const feed = opts.feed ?? getNotificationFeed();
  const stops: Array<() => void> = [];

  // ---- friends ----
  let ctlStop: (() => void) | null = null;
  let base: { incoming: Set<string>; outgoing: Set<string>; missed: Set<string> } | null = null;
  let missedCount = 0;
  const onFriends = (s: FriendsSnapshot): void => {
    if (!s.available || !s.loaded) { base = null; missedCount = 0; return; }
    // One read state everywhere: missed calls seen (the Calls page, or the
    // bell's Mark all read) are read in the bell too.
    if (missedCount > 0 && s.missed === 0) feed.markRead((i) => i.kind === 'call' && i.sub === 'missed');
    missedCount = s.missed;
    const incoming = new Set(s.incoming.map((f) => f.userId));
    const outgoing = new Set(s.outgoing.map((f) => f.userId));
    const friends = new Set(s.friends.map((f) => f.userId));
    const missed = new Set(s.missedCalls.map((c) => c.id));
    // Missed calls listed (the Calls page) that the bell doesn't have yet.
    for (const c of s.missedCalls) if (!feed.has(`call:${c.id}`)) addMissed(c, false);
    if (!base) { base = { incoming, outgoing, missed }; return; }
    const st = getNotificationSettings();
    for (const f of s.incoming) {
      if (base.incoming.has(f.userId)) continue;
      feed.add({ id: `friend:req:${f.userId}:${Date.now()}`, kind: 'friend', sub: 'request', title: f.username, where: 'friend request', body: 'wants to be your friend', nick: f.username });
      if (!st.friends) continue;
      if (st.inApp) { feed.toast({ kind: 'friend', title: f.username, where: 'friend request', body: 'wants to be your friend', nick: f.username, friend: f }); if (st.sound) chime(); }
      getNotifier().notifyOther({ title: `${f.username} wants to be your friend`, body: 'Accept or ignore in Friends.', tag: `friend:${f.userId}`, onClick: opts.open?.friends });
    }
    // A request answered (here, in a toast, on another device): its entry
    // in the bell is read.
    for (const id of base.incoming) {
      if (!incoming.has(id)) feed.markRead((i) => i.kind === 'friend' && i.sub === 'request' && i.id.startsWith(`friend:req:${id}:`));
    }
    for (const id of base.outgoing) {
      if (outgoing.has(id) || !friends.has(id)) continue;
      const f = s.friends.find((x) => x.userId === id)!;
      const title = `${f.username} accepted your friend request`;
      feed.add({ id: `friend:ok:${id}:${Date.now()}`, kind: 'friend', sub: 'accepted', title, where: '', body: 'You can call each other now.', nick: f.username });
      if (!st.friends) continue;
      if (st.inApp) { feed.toast({ kind: 'accepted', title, where: '', body: 'You can call each other now.', nick: f.username }); if (st.sound) chime(); }
      getNotifier().notifyOther({ title, body: 'You can call each other now.', tag: `friend-ok:${id}`, onClick: opts.open?.friends });
    }
    base = { incoming, outgoing, missed };
  };

  // A call that rang here and wasn't answered: in the list, and a toast
  // with Call back (and a system notification) when it just happened.
  const addMissed = (c: CallInfo, now: boolean): void => {
    const id = `call:${c.id}`;
    if (feed.has(id)) return;
    const body = `${c.video ? 'Video call' : 'Voice call'}`;
    feed.add({ id, kind: 'call', sub: 'missed', title: 'Missed call', where: c.peer.username, body, nick: c.peer.username, at: c.createdAt || Date.now(), call: { peer: c.peer.username, video: c.video } });
    if (!now) return;
    const st = getNotificationSettings();
    if (!st.calls) return;
    if (st.inApp) { feed.toast({ kind: 'missed', title: 'Missed call', where: c.peer.username, body: `${body} · just now`, nick: c.peer.username, call: { peer: c.peer.username, video: c.video }, feedId: id }); if (st.sound) chime(); }
    getNotifier().notifyOther({ title: `Missed call from ${c.peer.username}`, body, tag: id, onClick: opts.open?.calls });
  };

  const watch = (ctl: FriendsController | null): void => {
    ctlStop?.();
    ctlStop = null;
    base = null;
    if (!ctl) return;
    const unsub = ctl.subscribe(onFriends);
    const unMissed = ctl.onRingMissed((c) => addMissed(c, true));
    onFriends(ctl.getSnapshot());
    ctlStop = () => { unsub(); unMissed(); };
  };
  watch(getFriendsController());
  stops.push(onFriendsControllerChange(() => watch(getFriendsController())));
  stops.push(() => ctlStop?.());

  // ---- calls starting in voice channels you're in ----
  // A voice channel goes from empty to someone in it, on a server you're
  // on, under a channel you're in (or a server-wide one), and it isn't
  // your own call.
  const voice = getVoiceController();
  if (voice) {
    let seen: Map<string, number> | null = null;
    const onVoice = (v: VoiceSnapshot): void => {
      const next = new Map<string, number>();
      const scopes = opts.scope();
      for (const [host, srv] of Object.entries(v.servers)) {
        if (!srv.rooms) continue;
        for (const r of srv.rooms) {
          const key = `${host}\0${r.id}`;
          next.set(key, r.participants.length);
          if (!seen || !seen.has(key)) continue; // first look: no news
          if (seen.get(key)! > 0 || r.participants.length === 0) continue;
          if (r.id.startsWith('call:')) continue; // private 1:1 calls
          if (v.call.host === host && v.call.room === r.id) continue; // you started it
          const sc = scopes.find((x) => x.host === host);
          if (!sc) continue;
          const parent = r.parent ?? '';
          if (parent && !sc.channels.includes(parent)) continue;
          callStarted(sc, r.id, r.name, r.participants.map((p) => p.name));
        }
      }
      seen = next;
    };
    stops.push(voice.subscribe(onVoice));
    onVoice(voice.getSnapshot());
  }

  const callStarted = (sc: VoiceScope, roomId: string, name: string, people: string[]): void => {
    const room: ToastRoom = { host: sc.host, roomId, name, serverName: sc.serverName };
    const body = `${people.slice(0, 3).join(', ')}${people.length > 3 ? ` and ${people.length - 3} more` : ''} ${people.length === 1 ? 'is' : 'are'} in ${name}`;
    const id = `call:start:${sc.host}:${roomId}:${Date.now()}`;
    feed.add({ id, kind: 'call', sub: 'started', title: 'Call started', where: `${name} · ${sc.serverName}`, body, nick: people[0] ?? name, room });
    const st = getNotificationSettings();
    if (!st.calls) return;
    if (st.inApp) { feed.toast({ kind: 'started', title: 'Call started', where: `${name} · ${sc.serverName}`, body, nick: people[0] ?? name, room, feedId: id }); if (st.sound) chime(); }
    getNotifier().notifyOther({ title: `Call started in ${name}`, body, tag: id, onClick: () => opts.open?.voice(room) });
  };

  return () => { for (const s of stops) s(); };
}
