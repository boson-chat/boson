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

export interface VoiceRoom {
  id: string;
  name: string;
  participants: VoiceRoomParticipant[];
}

export type VoiceRoomsErrorKind = 'token' | 'unavailable' | 'unreachable' | 'server';

export interface VoiceRoomsResult {
  rooms: VoiceRoom[] | null;
  error?: string;
  errorKind?: VoiceRoomsErrorKind;
}

export interface VoiceParticipant extends VoiceRoomParticipant {
  self: boolean;
  // Playback volume, percent (100 = as sent).
  volume: number;
}

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'error';
export type VoiceErrorKind = 'mic' | 'device' | 'token' | 'unreachable' | 'server' | 'dropped' | 'unavailable';
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
