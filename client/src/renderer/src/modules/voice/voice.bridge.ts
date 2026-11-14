import type {
  VoiceDevices, VoiceJoinRequest, VoiceRoomsResult, VoiceServerInfo, VoiceState,
} from './voice.types';

// window.bosonVoice: the desktop app's VoiceService (desktop/voice.go),
// installed by platform/wails.ts. Absent in a browser and on iOS/Android,
// where there's no voice.
export interface VoiceBridge {
  discover(host: string, refresh: boolean): Promise<VoiceServerInfo>;
  rooms(host: string, token: string): Promise<VoiceRoomsResult>;
  join(req: VoiceJoinRequest): Promise<VoiceState>;
  leave(): Promise<void>;
  dismissError(): Promise<void>;
  setMuted(muted: boolean): Promise<VoiceState>;
  setDeafened(deafened: boolean): Promise<VoiceState>;
  setInputMode(mode: 'vad' | 'ptt'): Promise<void>;
  ptt(down: boolean): Promise<void>;
  setVADThreshold(db: number): Promise<void>;
  setUserVolume(userId: string, percent: number): Promise<void>;
  devices(): Promise<VoiceDevices>;
  setDevices(inputId: string, outputId: string): Promise<string>;
  micTest(on: boolean): Promise<VoiceState>;
  state(): Promise<VoiceState>;
  onState(fn: (s: VoiceState) => void): () => void;
}

export function voiceBridge(): VoiceBridge | null {
  return (globalThis as { bosonVoice?: VoiceBridge }).bosonVoice ?? null;
}
