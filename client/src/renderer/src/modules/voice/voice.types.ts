// Voice channels: the shapes the desktop app's VoiceService (desktop/voice.go)
// sends over the bridge.

export interface VoiceServerInfo {
  host: string;
  // The server has voice the app can use with its boson account.
  available: boolean;
  // The auth service that issues its voice tokens.
  authUrl?: string;
  // This build can do voice audio (false in a build without it).
  audio: boolean;
  audioError?: string;
}

export interface VoiceRoomParticipant {
  sessionId: number;
  userId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
}

// IRC channel privilege levels, lowest first: what a voice channel can be
// locked to. member = anyone signed in; oper = network admins.
export const VOICE_ROLES = ['member', 'voice', 'halfop', 'op', 'admin', 'founder', 'oper'] as const;
export type VoiceRole = typeof VOICE_ROLES[number];

export interface VoiceRoom {
  id: string;
  name: string;
  // static: set in the voice server's config (can't be changed here);
  // dynamic: made by someone; adhoc: a live room outside the registry.
  // Absent on servers before room management (treated as static).
  kind?: 'static' | 'dynamic' | 'adhoc';
  // The IRC channel it sits under, casefolded ('#boson'); '' for none.
  parent?: string;
  owner?: { userId: string; name: string } | null;
  position?: number;
  createdAt?: string;
  minRole?: VoiceRole;
  speakRole?: VoiceRole;
  requireChannelMembership?: boolean;
  // Absent = false / true / true (an old server: open rooms, no management).
  canManage?: boolean;
  canJoin?: boolean;
  canSpeak?: boolean;
  participants: VoiceRoomParticipant[];
}

// Whether (and where) you may make voice channels on this server.
export interface VoiceRoomPermissions {
  policy?: string;
  canCreate: boolean;
  // any: anywhere; founded_channels: only under foundedChannels; none.
  createScope: 'any' | 'founded_channels' | 'none';
  foundedChannels: string[] | null;
}

export const NO_ROOM_PERMISSIONS: VoiceRoomPermissions = { canCreate: false, createScope: 'none', foundedChannels: [] };

export type VoiceRoomsErrorKind = 'token' | 'unavailable' | 'unreachable' | 'server';

export interface VoiceRoomsResult {
  rooms: VoiceRoom[] | null;
  permissions?: VoiceRoomPermissions;
  error?: string;
  errorKind?: VoiceRoomsErrorKind;
}

// A new voice channel, or what to change on one (absent = keep).
export interface VoiceRoomInput {
  name?: string;
  // Create only; can't be changed afterwards.
  parent?: string;
  position?: number;
  minRole?: VoiceRole;
  speakRole?: VoiceRole;
  requireChannelMembership?: boolean;
}

// The voice server's error codes for room changes, plus unreachable /
// server (anything else) and unavailable_voice (no voice here).
export type VoiceRoomErrorCode =
  | 'invalid' | 'unauthorized' | 'forbidden' | 'static_room' | 'limit' | 'not_found' | 'conflict'
  | 'unavailable' | 'unsupported' | 'unreachable' | 'server' | 'unavailable_voice' | 'token';

export interface VoiceRoomChange {
  room?: VoiceRoom | null;
  error?: string;
  code?: VoiceRoomErrorCode;
  retryAfter?: number;
}

export interface VoiceParticipant extends VoiceRoomParticipant {
  self: boolean;
  // In the room below its speak role: nobody hears them.
  listener?: boolean;
  // Playback volume, percent (100 = as sent).
  volume: number;
}

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'error';
// kicked: the server put us out of the room (it was deleted); not a failure.
export type VoiceErrorKind = 'mic' | 'device' | 'token' | 'unreachable' | 'server' | 'dropped' | 'unavailable' | 'kicked';
export type VoiceQuality = 'good' | 'ok' | 'poor' | 'unknown';

// The one voice connection (and the mic test).
export interface VoiceState {
  status: VoiceStatus;
  host: string;
  room: string;
  roomName: string;
  error?: string;
  errorKind?: VoiceErrorKind;
  participants: VoiceParticipant[];
  muted: boolean;
  deafened: boolean;
  // Joined as a listener (below the room's speak role): the mic isn't heard.
  listener?: boolean;
  pushToTalk: boolean;
  micTest: boolean;
  micTestError?: string;
  // 0..1 over -60..0 dBFS.
  micLevel: number;
  transmitting: boolean;
  rttMs: number;
  lossPercent: number;
  quality: VoiceQuality;
  audioError?: string;
}

export interface VoiceDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface VoiceDevices {
  inputs: VoiceDevice[] | null;
  outputs: VoiceDevice[] | null;
  error?: string;
}

export interface VoiceJoinRequest {
  host: string;
  room: string;
  roomName: string;
  token: string;
}

export const IDLE_VOICE_STATE: VoiceState = {
  status: 'idle', host: '', room: '', roomName: '', participants: [],
  muted: false, deafened: false, pushToTalk: false, micTest: false,
  micLevel: 0, transmitting: false, rttMs: 0, lossPercent: 0, quality: 'unknown',
};
