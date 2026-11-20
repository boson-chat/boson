// Friends and private 1:1 calls in the renderer: the friends lists, privacy
// settings, the event feed that rings this app while it's open, and the
// call flow (calling, ringing, answering) on top of the voice controller.
//
// The auth service decides everything (who may call or friend whom); this
// keeps a snapshot for the UI and turns answered calls into voice joins of
// the call's private room, with the token the calls API hands out. The
// call itself then uses the app's usual voice + video call UI.
//
// Calls ring only while the app is open: the feed is a long poll through the
// app's API proxy, and nothing rings when it isn't polling (missed calls show
// next time).

import { AuthError } from '../auth';
import { normalizeAuthUrl, type VoiceController } from '../voice';
import type { VideoController } from '../video';
import {
  DEFAULT_PRIVACY, type CallInfo, type Friend, type FriendsApi, type FeedEvent, type Person, type Privacy, type Relation,
} from './friends.types';

export interface OutgoingCall {
  peer: Person;
  video: boolean;
  // calling: ringing (or being set up); then how it ended, shown briefly.
  status: 'calling' | 'declined' | 'missed' | 'unavailable' | 'failed';
  call: CallInfo | null;
  message?: string;
}

export interface ActiveCall {
  call: CallInfo;
  // When it connected (0 until then).
  since: number;
}

export interface FriendsSnapshot {
  // Signed in with an account: friends and calls are on.
  available: boolean;
  loaded: boolean;
  friends: Friend[];
  incoming: Friend[];
  outgoing: Friend[];
  blocked: Friend[];
  privacy: Privacy;
  // Unseen missed calls, and the latest of them once listed.
  missed: number;
  missedCalls: CallInfo[];
  // A call I'm making, calls ringing for me, the call I'm in.
  calling: OutgoingCall | null;
  ringing: CallInfo[];
  active: ActiveCall | null;
  // A short message ("Friend request sent to mira").
  toast: { id: number; text: string } | null;
  // Bumped when relations may have changed (menus re-ask).
  relationsVersion: number;
}

const EMPTY: FriendsSnapshot = {
  available: false, loaded: false, friends: [], incoming: [], outgoing: [], blocked: [], privacy: DEFAULT_PRIVACY,
  missed: 0, missedCalls: [], calling: null, ringing: [], active: null, toast: null, relationsVersion: 0,
};

export interface FriendsControllerOptions {
  api: FriendsApi;
  // The account's auth service (its voice servers carry the calls).
  authUrl: string;
  // Signed in with an account (not a guest)?
  signedIn: () => boolean;
  // The account's username (its IRC nick on the network).
  me: () => string;
  // Calls fn when signed-in state may have changed; returns an unsubscribe.
  onAccessChange: (fn: () => void) => () => void;
  voice: () => VoiceController | null;
  video: () => VideoController | null;
  // Shows the call's view (call-shared openCall).
  openCall: () => void;
  // Retry delays after a failed poll.
  backoffMs?: readonly number[];
  // How long to wait before asking an auth service without the feed again.
  unsupportedRetryMs?: number;
  toastMs?: number;
  // How long an ended outgoing call stays on screen.
  outcomeMs?: number;
}

const RELATION_TTL_MS = 30_000;

export class FriendsController {
  private snap: FriendsSnapshot = EMPTY;
  private readonly listeners = new Set<(s: FriendsSnapshot) => void>();
  private readonly opts: FriendsControllerOptions;
  private running = false;
  private gen = 0;
  private cursor = '';
  private relations = new Map<string, { at: number; p: Promise<Relation | null> }>();
  private toastSeq = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private outcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private offs: Array<() => void> = [];
  // Set once the voice call for the active call connected.
  private joined = false;
  private listsLoading: Promise<void> | null = null;

  constructor(opts: FriendsControllerOptions) {
    this.opts = opts;
  }

  get authUrl(): string {
    return this.opts.authUrl;
  }

  // Whether nick is me.
  isMe(nick: string): boolean {
    return nick.toLowerCase() === this.opts.me().toLowerCase();
  }

  // Whether people on IRC server host are this account's network (its
  // voice takes this account): their names get friend and call actions.
  peopleHere(host: string | null | undefined): boolean {
    if (!this.snap.available || !host) return false;
    const auth = this.opts.voice()?.authOf(host);
    return !!auth && auth === normalizeAuthUrl(this.opts.authUrl);
  }

  getSnapshot(): FriendsSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: FriendsSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private set(patch: Partial<FriendsSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((fn) => fn(this.snap));
  }

  // ---- lifecycle ----

  start(): void {
    this.offs.push(this.opts.onAccessChange(() => this.sync()));
    const voice = this.opts.voice();
    if (voice) this.offs.push(voice.subscribe(() => this.watchVoice()));
    this.sync();
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.stopFeed();
  }

  private sync(): void {
    const on = this.opts.signedIn();
    if (on === this.running) return;
    if (on) {
      // On once the account's auth service answers the event feed (older
      // ones don't have friends and calls: the UI stays hidden).
      this.running = true;
      this.set(EMPTY);
      void this.feed(++this.gen);
    } else {
      this.stopFeed();
      this.set(EMPTY);
    }
  }

  private stopFeed(): void {
    this.running = false;
    this.gen++;
    this.cursor = '';
    this.relations.clear();
  }

  private async feed(gen: number): Promise<void> {
    const delays = this.opts.backoffMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
    let failures = 0;
    while (this.running && gen === this.gen) {
      try {
        const r = await this.opts.api.poll(this.cursor);
        if (gen !== this.gen) return;
        failures = 0;
        if (!this.snap.available) {
          this.set({ available: true });
          void this.loadPrivacy();
        }
        this.cursor = r.cursor;
        if (r.reset && r.snapshot) {
          this.set({ ringing: r.snapshot.ringing.filter((c) => c.state === 'ringing'), missed: r.snapshot.missed });
          this.armRingTimer();
          void this.refreshLists();
        }
        for (const e of r.events) this.onEvent(e);
      } catch (err) {
        if (gen !== this.gen) return;
        if (err instanceof AuthError && err.code === 'signed_out') { this.sync(); return; }
        // An auth service without friends and calls: look again later.
        const unsupported = (err as { status?: number } | null)?.status === 404 && !this.snap.available;
        const wait = unsupported ? (this.opts.unsupportedRetryMs ?? 10 * 60_000) : delays[Math.min(failures, delays.length - 1)] ?? 5_000;
        failures++;
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  }

  private onEvent(e: FeedEvent): void {
    switch (e.type) {
      case 'friends':
        this.relations.clear();
        this.set({ relationsVersion: this.snap.relationsVersion + 1 });
        void this.refreshLists();
        return;
      case 'missed':
        this.set({ missed: e.count });
        return;
      case 'call.ring':
        if (e.call.state !== 'ringing' || this.snap.ringing.some((c) => c.id === e.call.id)) return;
        this.set({ ringing: [...this.snap.ringing, e.call] });
        this.armRingTimer();
        return;
      case 'call.update':
        this.onCallUpdate(e.call);
    }
  }

  private onCallUpdate(c: CallInfo): void {
    // No longer ringing here (answered on another device, cancelled, missed).
    if (c.state !== 'ringing' && this.snap.ringing.some((r) => r.id === c.id)) {
      this.set({ ringing: this.snap.ringing.filter((r) => r.id !== c.id) });
    }
    const out = this.snap.calling;
    if (out?.call?.id === c.id && out.status === 'calling') {
      switch (c.state) {
        case 'answered':
          this.set({ calling: null });
          void this.joinAnswered(c);
          return;
        case 'declined': this.callOutcome('declined'); return;
        case 'missed': this.callOutcome('missed'); return;
        case 'unavailable': this.callOutcome('unavailable'); return;
        case 'ended': this.callOutcome('missed'); return;
      }
    }
    const act = this.snap.active;
    if (act?.call.id === c.id && c.state === 'ended') {
      // They hung up.
      this.finishActive(false);
    }
  }

  // ---- lists and settings ----

  refreshLists(): Promise<void> {
    if (this.listsLoading) return this.listsLoading;
    this.listsLoading = (async () => {
      try {
        const l = await this.opts.api.lists();
        if (this.running) this.set({ ...l, loaded: true });
      } catch { /* keep what we have; the next event retries */ } finally {
        this.listsLoading = null;
      }
    })();
    return this.listsLoading;
  }

  private async loadPrivacy(): Promise<void> {
    try {
      const p = await this.opts.api.privacy();
      if (this.running) this.set({ privacy: p });
    } catch { /* defaults until it loads */ }
  }

  // Who someone is to me, cached for a while (menus ask on open).
  relation(username: string, fresh = false): Promise<Relation | null> {
    const key = username.toLowerCase();
    const hit = this.relations.get(key);
    if (!fresh && hit && Date.now() - hit.at < RELATION_TTL_MS) return hit.p;
    const p = this.opts.api.relation(username).catch(() => null);
    this.relations.set(key, { at: Date.now(), p });
    return p;
  }

  private changed(): void {
    this.relations.clear();
    this.set({ relationsVersion: this.snap.relationsVersion + 1 });
    void this.refreshLists();
  }

  toast(text: string): void {
    const id = ++this.toastSeq;
    this.set({ toast: { id, text } });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { if (this.snap.toast?.id === id) this.set({ toast: null }); }, this.opts.toastMs ?? 2_600);
  }

  private fail(err: unknown, fallback: string): void {
    this.toast(friendlyError(err, fallback));
  }

  async sendRequest(username: string): Promise<boolean> {
    const name = username.trim().replace(/^@/, '');
    if (!name) return false;
    try {
      const r = await this.opts.api.request(name);
      this.toast(r.relation === 'friend' ? `You and ${r.user.username} are now friends` : `Friend request sent to ${r.user.username}`);
      this.changed();
      return true;
    } catch (err) {
      this.fail(err, `Couldn't send a friend request to ${name}`);
      return false;
    }
  }

  async acceptRequest(p: Person): Promise<void> {
    try {
      await this.opts.api.accept(p.userId);
      this.toast(`You and ${p.username} are now friends`);
      this.changed();
    } catch (err) { this.fail(err, "Couldn't accept the request"); }
  }

  // Decline their request, or cancel mine.
  async deleteRequest(p: Person): Promise<void> {
    try {
      await this.opts.api.deleteRequest(p.userId);
      this.changed();
    } catch (err) { this.fail(err, "Couldn't change the request"); }
  }

  async removeFriend(p: Person): Promise<void> {
    try {
      await this.opts.api.remove(p.userId);
      this.changed();
    } catch (err) { this.fail(err, `Couldn't remove ${p.username}`); }
  }

  async setAnytime(p: Person, on: boolean): Promise<void> {
    const prev = this.snap.friends;
    this.set({ friends: prev.map((f) => (f.userId === p.userId ? { ...f, canCallAnytime: on } : f)) });
    try {
      await this.opts.api.setAnytime(p.userId, on);
    } catch (err) {
      this.set({ friends: prev });
      this.fail(err, "Couldn't change that");
    }
  }

  async block(username: string): Promise<void> {
    try {
      await this.opts.api.block(username);
      this.toast(`${username} is blocked`);
      this.changed();
    } catch (err) { this.fail(err, `Couldn't block ${username}`); }
  }

  async unblock(p: Person): Promise<void> {
    try {
      await this.opts.api.unblock(p.userId);
      this.changed();
    } catch (err) { this.fail(err, `Couldn't unblock ${p.username}`); }
  }

  async setPrivacy(patch: Partial<Privacy>): Promise<void> {
    const prev = this.snap.privacy;
    this.set({ privacy: { ...prev, ...patch } });
    try {
      this.set({ privacy: await this.opts.api.setPrivacy(patch) });
      this.relations.clear();
    } catch (err) {
      this.set({ privacy: prev });
      this.fail(err, "Couldn't save the setting");
    }
  }

  // The missed calls (and marks them seen: the badge clears).
  async seeMissed(): Promise<void> {
    if (!this.snap.available) return;
    try {
      const m = await this.opts.api.missed();
      this.set({ missedCalls: m.calls });
      if (m.count > 0) {
        await this.opts.api.missedSeen();
        this.set({ missed: 0 });
      }
    } catch { /* the badge stays */ }
  }

  // ---- calls ----

  // Where a call can be joined: a voice server of this account's network.
  private callHost(): string | null {
    return this.opts.voice()?.hostForAccount(this.opts.authUrl) ?? null;
  }

  // Whether this app can make calls at all (the app, signed in, connected
  // to a server whose voice takes this account).
  get canCall(): boolean {
    return this.snap.available && !!this.callHost();
  }

  async call(username: string, video: boolean): Promise<void> {
    if (this.snap.calling?.status === 'calling') return;
    const peer: Person = { userId: '', username, displayName: '' };
    if (!this.callHost()) {
      this.toast(this.opts.voice() ? 'Connect to a server on your Boson network to call.' : 'Calls need the Boson app.');
      return;
    }
    this.set({ calling: { peer, video, status: 'calling', call: null } });
    let c: CallInfo;
    try {
      c = await this.opts.api.startCall(username, video);
    } catch (err) {
      this.set({ calling: null });
      this.fail(err, `Couldn't call ${username}`);
      return;
    }
    const cur = this.snap.calling;
    if (!cur || cur.status !== 'calling' || cur.call) {
      // Cancelled while it was being placed.
      if (c.state === 'ringing') void this.opts.api.cancelCall(c.id).catch(() => {});
      return;
    }
    if (c.state !== 'ringing') {
      this.set({ calling: { ...cur, peer: c.peer, call: c } });
      this.callOutcome('unavailable');
      return;
    }
    this.set({ calling: { ...cur, peer: c.peer, call: c } });
    // In case the feed never says (it ends ringing at 45 s).
    const id = c.id;
    setTimeout(() => {
      const now = this.snap.calling;
      if (now?.call?.id === id && now.status === 'calling') this.callOutcome('missed');
    }, Math.max(5_000, c.expiresAt - Date.now() + 8_000));
  }

  async cancelCall(): Promise<void> {
    const cur = this.snap.calling;
    if (!cur) return;
    this.set({ calling: null });
    if (cur.call && cur.status === 'calling') await this.opts.api.cancelCall(cur.call.id).catch(() => {});
  }

  private callOutcome(status: OutgoingCall['status']): void {
    const cur = this.snap.calling;
    if (!cur) return;
    this.set({ calling: { ...cur, status } });
    if (this.outcomeTimer) clearTimeout(this.outcomeTimer);
    this.outcomeTimer = setTimeout(() => {
      if (this.snap.calling?.status === status) this.set({ calling: null });
    }, this.opts.outcomeMs ?? 2_500);
  }

  async accept(id: string, video: boolean): Promise<void> {
    const c = this.snap.ringing.find((r) => r.id === id);
    this.set({ ringing: this.snap.ringing.filter((r) => r.id !== id) });
    if (!c) return;
    if (!this.callHost()) {
      this.toast('Connect to a server on your Boson network to answer.');
      void this.opts.api.declineCall(id).catch(() => {});
      return;
    }
    try {
      const r = await this.opts.api.acceptCall(id);
      await this.join(r.call, video, async () => r.voice.token);
    } catch (err) {
      this.fail(err, `Couldn't answer ${c.peer.username}`);
    }
  }

  async decline(id: string): Promise<void> {
    const c = this.snap.ringing.find((r) => r.id === id);
    this.set({ ringing: this.snap.ringing.filter((r) => r.id !== id) });
    if (!c) return;
    await this.opts.api.declineCall(id).catch(() => {});
  }

  // The call I made was answered: join its room.
  private async joinAnswered(c: CallInfo): Promise<void> {
    const video = this.snap.calling?.video ?? c.video;
    await this.join(c, video, async () => (await this.opts.api.callToken(c.id)).token);
  }

  private async join(c: CallInfo, video: boolean, token: () => Promise<string>): Promise<void> {
    const voice = this.opts.voice();
    const host = this.callHost();
    if (!voice || !host) {
      void this.opts.api.endCall(c.id).catch(() => {});
      this.toast("Couldn't connect the call.");
      return;
    }
    this.joined = false;
    this.set({ active: { call: c, since: 0 } });
    this.opts.video()?.setCameraOnJoin(video);
    await voice.join(host, { id: c.room, name: `Call with ${c.peer.username}` }, 'Private call', token);
    this.opts.openCall();
  }

  async hangup(): Promise<void> {
    const act = this.snap.active;
    if (!act) return;
    await this.opts.voice()?.leave();
    // watchVoice ends it.
    if (this.snap.active) this.finishActive(true);
  }

  // Follows the voice call: once the call's room is left (hang up, kicked,
  // joined something else) the call ends for both.
  private watchVoice(): void {
    const act = this.snap.active;
    const voice = this.opts.voice();
    if (!act || !voice) return;
    const v = voice.getSnapshot().call;
    const inRoom = v.room === act.call.room && v.host !== '';
    if (inRoom && v.status === 'connected') {
      if (!this.joined) {
        this.joined = true;
        this.set({ active: { ...act, since: Date.now() } });
      }
      return;
    }
    if (inRoom && v.status === 'connecting') return;
    if (inRoom && v.status === 'error') {
      this.toast(v.error ? `Call failed: ${v.error}` : 'The call failed.');
      this.finishActive(true, true);
      void voice.dismissError();
      return;
    }
    // Left the room.
    this.finishActive(true);
  }

  private finishActive(byMe: boolean, quiet = false): void {
    const act = this.snap.active;
    if (!act) return;
    this.set({ active: null });
    this.joined = false;
    if (byMe) void this.opts.api.endCall(act.call.id).catch(() => {});
    else {
      const voice = this.opts.voice();
      if (voice && voice.getSnapshot().call.room === act.call.room) void voice.leave();
    }
    if (!quiet) this.toast(act.since ? `Call ended · ${clock(Date.now() - act.since)}` : 'Call ended');
  }

  // Drops calls still listed as ringing past their end (the feed missed it).
  private armRingTimer(): void {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    if (this.snap.ringing.length === 0) return;
    const next = Math.min(...this.snap.ringing.map((c) => c.expiresAt));
    this.ringTimer = setTimeout(() => {
      const now = Date.now();
      const left = this.snap.ringing.filter((c) => c.expiresAt + 3_000 > now);
      if (left.length !== this.snap.ringing.length) this.set({ ringing: left });
      this.armRingTimer();
    }, Math.max(1_000, next - Date.now() + 3_000));
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

// What a refused or failed request means, for the user.
export function friendlyError(err: unknown, fallback: string): string {
  const e = err as { code?: string; message?: string } | null;
  switch (e?.code) {
    case 'friends_only':
    case 'calls_off':
    case 'requests_off':
    case 'requests_servers_only':
    case 'you_blocked':
      return capitalise(e.message ?? fallback);
    case 'user_not_found': return 'No one by that name.';
    case 'rate_limited': return 'Slow down a little and try again.';
    case 'network': return "Couldn't reach your Boson account.";
    case 'signed_out': return 'Sign in to your Boson account first.';
  }
  return fallback;
}

// Server messages start with a nick ("mira only takes…"): keep its case,
// add the full stop.
function capitalise(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const out = t.startsWith('you ') ? `Y${t.slice(1)}` : t;
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

let instance: FriendsController | null = null;

export function getFriendsController(): FriendsController | null {
  return instance;
}

export function setFriendsController(c: FriendsController | null): void {
  instance?.dispose();
  instance = c;
  controllerListeners.forEach((fn) => fn());
}

const controllerListeners = new Set<() => void>();

export function onFriendsControllerChange(fn: () => void): () => void {
  controllerListeners.add(fn);
  return () => { controllerListeners.delete(fn); };
}

export const EMPTY_FRIENDS = EMPTY;
