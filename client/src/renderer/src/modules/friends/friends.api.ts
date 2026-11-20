import type { AuthService } from '../auth';
import type {
  CallInfo, FeedEvent, FriendLists, Friend, FriendsApi, Person, PollResult, Privacy, Relation, VoiceGrant,
} from './friends.types';

/* eslint-disable @typescript-eslint/no-explicit-any -- wire JSON */

const person = (p: any): Person => ({
  userId: p?.user_id ?? '', username: p?.username ?? '', displayName: p?.display_name ?? '',
  ...(typeof p?.avatar_url === 'string' && p.avatar_url ? { avatarUrl: p.avatar_url } : {}),
});
const friend = (p: any): Friend => ({ ...person(p), canCallAnytime: !!p?.can_call_anytime, since: p?.since ?? '' });
const list = (x: any): Friend[] => (Array.isArray(x) ? x.map(friend) : []);
const time = (s: unknown): number => (typeof s === 'string' ? Date.parse(s) || 0 : 0);

export function callFromWire(c: any): CallInfo {
  return {
    id: c?.id ?? '', room: c?.room ?? '', video: !!c?.video, state: c?.state ?? 'ended',
    direction: c?.direction === 'outgoing' ? 'outgoing' : 'incoming', peer: person(c?.peer),
    createdAt: time(c?.created_at), expiresAt: time(c?.expires_at),
  };
}

const relation = (r: any): Relation => ({
  user: person(r?.user), relation: r?.relation ?? 'none', canCallAnytime: !!r?.can_call_anytime, call: r?.call ?? 'ok',
});
const privacy = (p: any): Privacy => ({
  calls: p?.calls ?? 'friends', doNotDisturb: !!p?.do_not_disturb, friendRequests: p?.friend_requests ?? 'everyone',
});
const grant = (v: any): VoiceGrant => ({ token: v?.token ?? '', room: v?.room ?? '', expiresAt: Date.now() + (v?.expires_in ?? 300) * 1000 });

function event(e: any): FeedEvent | null {
  switch (e?.type) {
    case 'call.ring': return { type: 'call.ring', call: callFromWire(e.data) };
    case 'call.update': return { type: 'call.update', call: callFromWire(e.data) };
    case 'friends': return { type: 'friends' };
    case 'missed': return { type: 'missed', count: Number(e.data?.count ?? 0) };
  }
  return null; // newer event types: ignored
}

const enc = encodeURIComponent;

// FriendsApi over an AuthService session (its request() retries a 401
// after a refresh).
export class HttpFriendsApi implements FriendsApi {
  constructor(private readonly auth: Pick<AuthService, 'request'>) {}

  private req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return this.auth.request<T>(method, path, body);
  }

  async lists(): Promise<FriendLists> {
    const r = await this.req('GET', '/v1/friends');
    return { friends: list(r?.friends), incoming: list(r?.incoming), outgoing: list(r?.outgoing), blocked: list(r?.blocked) };
  }
  async relation(username: string): Promise<Relation> { return relation(await this.req('GET', `/v1/users/${enc(username)}/relation`)); }
  async request(username: string): Promise<Relation> { return relation(await this.req('POST', '/v1/friends/requests', { username })); }
  async accept(userId: string): Promise<void> { await this.req('POST', `/v1/friends/requests/${enc(userId)}/accept`); }
  async deleteRequest(userId: string): Promise<void> { await this.req('DELETE', `/v1/friends/requests/${enc(userId)}`); }
  async remove(userId: string): Promise<void> { await this.req('DELETE', `/v1/friends/${enc(userId)}`); }
  async setAnytime(userId: string, on: boolean): Promise<void> { await this.req('PATCH', `/v1/friends/${enc(userId)}`, { can_call_anytime: on }); }
  async block(username: string): Promise<void> { await this.req('POST', '/v1/blocks', { username }); }
  async unblock(userId: string): Promise<void> { await this.req('DELETE', `/v1/blocks/${enc(userId)}`); }
  async privacy(): Promise<Privacy> { return privacy(await this.req('GET', '/v1/me/privacy')); }
  async setPrivacy(p: Partial<Privacy>): Promise<Privacy> {
    const body: Record<string, unknown> = {};
    if (p.calls !== undefined) body.calls = p.calls;
    if (p.doNotDisturb !== undefined) body.do_not_disturb = p.doNotDisturb;
    if (p.friendRequests !== undefined) body.friend_requests = p.friendRequests;
    return privacy(await this.req('PATCH', '/v1/me/privacy', body));
  }
  async startCall(username: string, video: boolean): Promise<CallInfo> { return callFromWire((await this.req('POST', '/v1/calls', { username, video }))?.call); }
  async acceptCall(id: string): Promise<{ call: CallInfo; voice: VoiceGrant }> {
    const r = await this.req('POST', `/v1/calls/${enc(id)}/accept`);
    return { call: callFromWire(r?.call), voice: grant(r?.voice) };
  }
  async declineCall(id: string): Promise<CallInfo> { return callFromWire((await this.req('POST', `/v1/calls/${enc(id)}/decline`))?.call); }
  async cancelCall(id: string): Promise<CallInfo> { return callFromWire((await this.req('POST', `/v1/calls/${enc(id)}/cancel`))?.call); }
  async endCall(id: string): Promise<CallInfo> { return callFromWire((await this.req('POST', `/v1/calls/${enc(id)}/end`))?.call); }
  async callToken(id: string): Promise<VoiceGrant> { return grant((await this.req('POST', `/v1/calls/${enc(id)}/token`))?.voice); }
  async missed(): Promise<{ count: number; calls: CallInfo[] }> {
    const r = await this.req('GET', '/v1/calls/missed');
    return { count: Number(r?.count ?? 0), calls: Array.isArray(r?.calls) ? r.calls.map(callFromWire) : [] };
  }
  async missedSeen(): Promise<void> { await this.req('POST', '/v1/calls/missed/seen'); }
  async poll(cursor: string): Promise<PollResult> {
    const r = await this.req('GET', `/v1/events${cursor ? `?cursor=${enc(cursor)}` : ''}`);
    const events = (Array.isArray(r?.events) ? r.events : []).map(event).filter((e: FeedEvent | null): e is FeedEvent => e !== null);
    const snap = r?.snapshot;
    return {
      cursor: r?.cursor ?? '', reset: !!r?.reset, events,
      snapshot: snap ? {
        ringing: Array.isArray(snap.ringing) ? snap.ringing.map(callFromWire) : [],
        missed: Number(snap.missed ?? 0), pendingRequests: Number(snap.pending_requests ?? 0),
      } : null,
    };
  }
}
