// An in-memory stand-in for the auth service's friends and calls API, for
// the screenshot harness and tests. It applies the same call and friend
// request rules as the server (auth internal/services/social/policy.go).

import type {
  CallInfo, CallPolicy, FeedEvent, Friend, FriendLists, FriendsApi, Person, PollResult, Privacy, Relation, RelationKind, RequestPolicy, VoiceGrant,
} from './friends.types';
import { DEFAULT_PRIVACY } from './friends.types';

export interface FakePerson {
  username: string;
  // Their settings (for calls and requests to them).
  calls?: CallPolicy;
  requests?: RequestPolicy;
  dnd?: boolean;
  online?: boolean;
  // Their relation to me.
  rel?: RelationKind;
  // I let them call me anytime.
  anytime?: boolean;
  // They blocked me (calls silently go nowhere).
  blockedMe?: boolean;
}

export interface FakeFriendsOptions {
  people: FakePerson[];
  privacy?: Partial<Privacy>;
  missed?: Array<{ from: string; video: boolean; minutesAgo: number }>;
  // Answer outgoing calls after this long (ms); undefined: never.
  answerAfter?: number;
  // Decline instead of answering.
  decline?: boolean;
  pollWaitMs?: number;
}

export class FakeFriendsApi implements FriendsApi {
  private people = new Map<string, FakePerson & { id: string }>();
  private privacyState: Privacy;
  private queue: FeedEvent[] = [];
  private wake: (() => void) | null = null;
  private calls = new Map<string, CallInfo>();
  private seq = 0;
  private missedCalls: CallInfo[] = [];
  private reset = true;
  readonly log: string[] = [];

  constructor(private readonly opts: FakeFriendsOptions) {
    for (const p of opts.people) this.people.set(p.username.toLowerCase(), { ...p, id: `usr_${p.username}` });
    this.privacyState = { ...DEFAULT_PRIVACY, ...opts.privacy };
    this.missedCalls = (opts.missed ?? []).map((m) => this.mkCall(m.from, m.video, 'incoming', 'missed', Date.now() - m.minutesAgo * 60_000));
  }

  private person(p: FakePerson & { id: string }): Person {
    return { userId: p.id, username: p.username, displayName: '' };
  }

  private find(name: string): FakePerson & { id: string } {
    const p = this.people.get(name.replace(/^usr_/, '').toLowerCase()) ?? [...this.people.values()].find((x) => x.id === name);
    if (!p) throw Object.assign(new Error('no user with that name'), { code: 'user_not_found', status: 404 });
    return p;
  }

  private push(e: FeedEvent): void {
    this.queue.push(e);
    this.wake?.();
  }

  private mkCall(username: string, video: boolean, direction: CallInfo['direction'], state: CallInfo['state'], at = Date.now()): CallInfo {
    const p = this.find(username);
    const id = `cal_${++this.seq}`;
    return { id, room: `call:${id}`, video, state, direction, peer: this.person(p), createdAt: at, expiresAt: at + 45_000 };
  }

  private callHint(p: FakePerson): Relation['call'] {
    if (p.rel === 'blocked') return 'you_blocked';
    const calls = p.calls ?? 'friends';
    if (calls === 'nobody') return 'calls_off';
    if (calls === 'friends' && p.rel !== 'friend') return 'friends_only';
    return 'ok';
  }

  private relationOf(p: FakePerson & { id: string }): Relation {
    return { user: this.person(p), relation: p.rel ?? 'none', canCallAnytime: p.rel === 'friend' && !!p.anytime, call: this.callHint(p) };
  }

  // Someone calls me (as the server would ring this app).
  ring(username: string, video: boolean): CallInfo {
    const c = this.mkCall(username, video, 'incoming', 'ringing');
    this.calls.set(c.id, c);
    this.push({ type: 'call.ring', call: c });
    return c;
  }

  async lists(): Promise<FriendLists> {
    const all = [...this.people.values()];
    const f = (k: RelationKind): Friend[] => all.filter((p) => (p.rel ?? 'none') === k)
      .map((p) => ({ ...this.person(p), canCallAnytime: !!p.anytime, since: '2026-11-01T00:00:00Z' }));
    return { friends: f('friend'), incoming: f('incoming'), outgoing: f('outgoing'), blocked: f('blocked') };
  }

  async relation(username: string): Promise<Relation> { return this.relationOf(this.find(username)); }

  async request(username: string): Promise<Relation> {
    const p = this.find(username);
    if ((p.requests ?? 'everyone') === 'nobody') throw Object.assign(new Error(`${p.username} isn't taking friend requests`), { code: 'requests_off', status: 403 });
    p.rel = p.rel === 'incoming' ? 'friend' : p.rel === 'friend' ? 'friend' : 'outgoing';
    this.push({ type: 'friends' });
    return this.relationOf(p);
  }

  async accept(userId: string): Promise<void> { this.find(userId).rel = 'friend'; this.push({ type: 'friends' }); }
  async deleteRequest(userId: string): Promise<void> { this.find(userId).rel = 'none'; this.push({ type: 'friends' }); }
  async remove(userId: string): Promise<void> { this.find(userId).rel = 'none'; this.push({ type: 'friends' }); }
  async setAnytime(userId: string, on: boolean): Promise<void> { this.find(userId).anytime = on; }
  async block(username: string): Promise<void> { this.find(username).rel = 'blocked'; this.push({ type: 'friends' }); }
  async unblock(userId: string): Promise<void> { this.find(userId).rel = 'none'; this.push({ type: 'friends' }); }
  async privacy(): Promise<Privacy> { return this.privacyState; }
  async setPrivacy(p: Partial<Privacy>): Promise<Privacy> { this.privacyState = { ...this.privacyState, ...p }; return this.privacyState; }

  async startCall(username: string, video: boolean): Promise<CallInfo> {
    const p = this.find(username);
    const hint = this.callHint(p);
    if (hint !== 'ok') {
      const msg = hint === 'friends_only' ? `${p.username} only takes calls from friends` : hint === 'calls_off' ? `${p.username} isn't taking calls` : `you blocked ${p.username}; unblock them first`;
      throw Object.assign(new Error(msg), { code: hint, status: 403 });
    }
    this.log.push(`call ${p.username} ${video ? 'video' : 'voice'}`);
    if (p.blockedMe || p.dnd || p.online === false) return this.mkCall(username, video, 'outgoing', 'unavailable');
    const c = this.mkCall(username, video, 'outgoing', 'ringing');
    this.calls.set(c.id, c);
    if (this.opts.answerAfter !== undefined) {
      setTimeout(() => {
        const cur = this.calls.get(c.id);
        if (cur?.state !== 'ringing') return;
        const next = { ...cur, state: this.opts.decline ? 'declined' as const : 'answered' as const };
        this.calls.set(c.id, next);
        this.push({ type: 'call.update', call: next });
      }, this.opts.answerAfter);
    }
    return c;
  }

  private update(id: string, state: CallInfo['state']): CallInfo {
    const c = this.calls.get(id);
    if (!c) throw Object.assign(new Error('no such call'), { code: 'not_found', status: 404 });
    const next = { ...c, state };
    this.calls.set(id, next);
    this.log.push(`${state} ${id}`);
    return next;
  }

  async acceptCall(id: string): Promise<{ call: CallInfo; voice: VoiceGrant }> {
    const call = this.update(id, 'answered');
    return { call, voice: { token: 't', room: call.room, expiresAt: Date.now() + 300_000 } };
  }
  async declineCall(id: string): Promise<CallInfo> { return this.update(id, 'declined'); }
  async cancelCall(id: string): Promise<CallInfo> { return this.update(id, 'missed'); }
  async endCall(id: string): Promise<CallInfo> { return this.update(id, 'ended'); }
  async callToken(id: string): Promise<VoiceGrant> { return { token: 't', room: this.calls.get(id)?.room ?? '', expiresAt: Date.now() + 300_000 }; }
  async missed(): Promise<{ count: number; calls: CallInfo[] }> { return { count: this.missedCalls.length, calls: this.missedCalls }; }
  async missedSeen(): Promise<void> { this.push({ type: 'missed', count: 0 }); }

  async poll(cursor: string): Promise<PollResult> {
    if (this.reset || !cursor) {
      this.reset = false;
      return { cursor: 'c', reset: true, events: [], snapshot: { ringing: [], missed: this.missedCalls.length, pendingRequests: 0 } };
    }
    if (this.queue.length === 0) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, this.opts.pollWaitMs ?? 1_000);
        this.wake = () => { clearTimeout(t); res(); };
      });
      this.wake = null;
    }
    const events = this.queue;
    this.queue = [];
    return { cursor: 'c', reset: false, events, snapshot: null };
  }
}
