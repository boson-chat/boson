// Friends, blocks, privacy settings and private 1:1 calls: the auth
// service's API (auth docs/friends-calls.md), in the renderer's shapes.

export interface Person {
  userId: string;
  username: string;
  displayName: string;
  /** The account's profile picture, when it has one. */
  avatarUrl?: string;
}

export interface Friend extends Person {
  // My switch for them: they ring through Do not disturb and "Nobody".
  canCallAnytime: boolean;
  since: string;
}

export type RelationKind = 'friend' | 'incoming' | 'outgoing' | 'blocked' | 'none';
// Whether a call would go through: ok, or why not.
export type CallHint = 'ok' | 'friends_only' | 'calls_off' | 'you_blocked';

export interface Relation {
  user: Person;
  relation: RelationKind;
  canCallAnytime: boolean;
  call: CallHint;
}

export type CallPolicy = 'nobody' | 'friends' | 'everyone';
export type RequestPolicy = 'nobody' | 'servers' | 'everyone';

export interface Privacy {
  calls: CallPolicy;
  doNotDisturb: boolean;
  friendRequests: RequestPolicy;
}

export const DEFAULT_PRIVACY: Privacy = { calls: 'friends', doNotDisturb: false, friendRequests: 'everyone' };

export type CallState = 'ringing' | 'answered' | 'declined' | 'missed' | 'ended' | 'unavailable';

export interface CallInfo {
  id: string;
  // The voice (and video) room: call:<id>.
  room: string;
  video: boolean;
  state: CallState;
  direction: 'outgoing' | 'incoming';
  peer: Person;
  createdAt: number;
  expiresAt: number;
}

export interface VoiceGrant {
  token: string;
  room: string;
  expiresAt: number;
}

export interface FriendLists {
  friends: Friend[];
  incoming: Friend[];
  outgoing: Friend[];
  blocked: Friend[];
}

export type FeedEvent =
  | { type: 'call.ring'; call: CallInfo }
  | { type: 'call.update'; call: CallInfo }
  | { type: 'friends' }
  | { type: 'missed'; count: number };

export interface FeedSnapshot {
  ringing: CallInfo[];
  missed: number;
  pendingRequests: number;
}

export interface PollResult {
  cursor: string;
  reset: boolean;
  events: FeedEvent[];
  snapshot: FeedSnapshot | null;
}

// The auth service's API for one account.
export interface FriendsApi {
  lists(): Promise<FriendLists>;
  relation(username: string): Promise<Relation>;
  request(username: string): Promise<Relation>;
  accept(userId: string): Promise<void>;
  // Decline theirs or cancel mine.
  deleteRequest(userId: string): Promise<void>;
  remove(userId: string): Promise<void>;
  setAnytime(userId: string, on: boolean): Promise<void>;
  block(username: string): Promise<void>;
  unblock(userId: string): Promise<void>;
  privacy(): Promise<Privacy>;
  setPrivacy(patch: Partial<Privacy>): Promise<Privacy>;
  startCall(username: string, video: boolean): Promise<CallInfo>;
  acceptCall(id: string): Promise<{ call: CallInfo; voice: VoiceGrant }>;
  declineCall(id: string): Promise<CallInfo>;
  cancelCall(id: string): Promise<CallInfo>;
  endCall(id: string): Promise<CallInfo>;
  callToken(id: string): Promise<VoiceGrant>;
  missed(): Promise<{ count: number; calls: CallInfo[] }>;
  missedSeen(): Promise<void>;
  // The long poll (held up to ~25 s).
  poll(cursor: string): Promise<PollResult>;
}
