// Voice channels in the renderer: which servers have voice, their room
// lists (polled while a server's panel shows them), the one voice
// connection, push to talk and the settings. Audio and the connection live
// in the desktop app (desktop/voice.go); this drives it over the bridge and
// keeps a snapshot the UI renders.
//
// Voice is per IRC server and only offered when the server's voice uses the
// boson auth service the user is signed in to (its tokens are what the
// voice server accepts). Other servers show no voice UI.

import type { VoiceBridge } from './voice.bridge';
import {
  getVoiceSettings, onVoiceSettingsChange, setVoiceSettings, type VoiceSettings,
} from './voice.settings';
import {
  IDLE_VOICE_STATE, type VoiceDevices, type VoiceRoom, type VoiceRoomsErrorKind, type VoiceState,
} from './voice.types';

export interface VoiceServerView {
  host: string;
  // unknown → checking → available | none
  discovery: 'unknown' | 'checking' | 'available' | 'none';
  // This build can play voice (false: show the channels, can't join).
  audio: boolean;
  audioError?: string;
  // null until the first list arrives.
  rooms: VoiceRoom[] | null;
  roomsError: string | null;
  roomsErrorKind: VoiceRoomsErrorKind | null;
}

export interface VoiceSnapshot {
  servers: Readonly<Record<string, VoiceServerView>>;
  call: VoiceState;
  // The display name of the server the call is on (given at join).
  callServerName: string;
}

export interface VoiceToken {
  token: string;
  expiresAt: number;
}

export interface VoiceControllerOptions {
  // The boson auth service the app signs in to (VITE_AUTH_URL).
  authUrl: string;
  // A voice token from that service (AuthService.voiceToken).
  voiceToken: (rooms?: string[]) => Promise<VoiceToken>;
  // Room list poll interval while a server's panel is open.
  pollMs?: number;
  now?: () => number;
  // Where key events come from (push to talk); window by default.
  keyTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

export const VOICE_POLL_MS = 5_000;
// Discovery is re-checked this often while the app runs (and on reconnect).
const REDISCOVER_MS = 24 * 3600_000;
// A list token is reused until this long before it expires.
const TOKEN_MARGIN_MS = 60_000;

export function normalizeAuthUrl(u: string | undefined | null): string {
  if (!u) return '';
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return u.replace(/\/+$/, '');
  }
}

export class VoiceController {
  private readonly bridge: VoiceBridge | null;
  private readonly opts: VoiceControllerOptions;
  private readonly now: () => number;
  private servers: Record<string, VoiceServerView> = {};
  private discoveredAt: Record<string, number> = {};
  private discovering = new Map<string, Promise<void>>();
  private call: VoiceState = IDLE_VOICE_STATE;
  private snapshot: VoiceSnapshot = { servers: {}, call: IDLE_VOICE_STATE, callServerName: '' };
  private callServerName = '';
  private readonly listeners = new Set<(s: VoiceSnapshot) => void>();
  private watchers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> | null }>();
  private listToken: VoiceToken | null = null;
  private pttDown = false;
  private offs: Array<() => void> = [];
  private settings: VoiceSettings;

  constructor(bridge: VoiceBridge | null, opts: VoiceControllerOptions) {
    this.bridge = bridge;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.settings = getVoiceSettings();
    if (!bridge) return;
    this.offs.push(bridge.onState((s) => this.setCall(s)));
    void bridge.state().then((s) => this.setCall(s), () => {});
    this.pushSettings(this.settings, null);
    this.offs.push(onVoiceSettingsChange((s) => {
      const prev = this.settings;
      this.settings = s;
      this.pushSettings(s, prev);
    }));
    const target = opts.keyTarget === undefined ? (typeof window === 'undefined' ? null : window) : opts.keyTarget;
    if (target) {
      const down = (e: Event): void => this.onKey(e as KeyboardEvent, true);
      const up = (e: Event): void => this.onKey(e as KeyboardEvent, false);
      const blur = (): void => this.releasePTT();
      target.addEventListener('keydown', down);
      target.addEventListener('keyup', up);
      target.addEventListener('blur', blur);
      this.offs.push(() => {
        target.removeEventListener('keydown', down);
        target.removeEventListener('keyup', up);
        target.removeEventListener('blur', blur);
      });
    }
  }

  // Whether this app can do voice at all (the desktop app; not a browser,
  // not iOS/Android).
  get supported(): boolean {
    return this.bridge !== null;
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    for (const w of this.watchers.values()) if (w.timer) clearInterval(w.timer);
    this.watchers.clear();
  }

  getSnapshot(): VoiceSnapshot {
    return this.snapshot;
  }

  subscribe(fn: (s: VoiceSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    this.snapshot = { servers: { ...this.servers }, call: this.call, callServerName: this.call.host ? this.callServerName : '' };
    this.listeners.forEach((fn) => fn(this.snapshot));
  }

  private setCall(s: VoiceState): void {
    this.call = { ...IDLE_VOICE_STATE, ...s, participants: s.participants ?? [] };
    if (this.pttDown && this.call.status === 'idle' && !this.call.micTest) this.releasePTT();
    this.emit();
  }

  private patchServer(host: string, patch: Partial<VoiceServerView>): void {
    const prev = this.servers[host] ?? {
      host, discovery: 'unknown', audio: false, rooms: null, roomsError: null, roomsErrorKind: null,
    };
    this.servers = { ...this.servers, [host]: { ...prev, ...patch } };
    this.emit();
  }

  // ---- discovery ----

  // Finds out whether `host` (an IRC server's hostname) has voice. refresh
  // re-checks (on reconnect); otherwise a result under a day old stands.
  discover(rawHost: string, refresh = false): Promise<void> {
    const host = rawHost.trim().toLowerCase();
    if (!this.bridge || !host) return Promise.resolve();
    const fresh = this.discoveredAt[host] !== undefined && this.now() - this.discoveredAt[host]! < REDISCOVER_MS;
    if (!refresh && fresh) return Promise.resolve();
    const running = this.discovering.get(host);
    if (running) return running;
    if (!this.servers[host] || this.servers[host]!.discovery === 'unknown') this.patchServer(host, { discovery: 'checking' });
    const p = (async () => {
      try {
        const info = await this.bridge!.discover(host, refresh);
        // Only voice tied to the boson account the app signs in to.
        const ours = info.available && normalizeAuthUrl(info.authUrl) === normalizeAuthUrl(this.opts.authUrl);
        this.discoveredAt[host] = this.now();
        this.patchServer(host, {
          discovery: ours ? 'available' : 'none',
          audio: ours && info.audio,
          audioError: info.audioError,
        });
        if (ours && this.watchers.get(host)?.count) void this.refreshRooms(host);
      } catch {
        this.patchServer(host, { discovery: 'none' });
      } finally {
        this.discovering.delete(host);
      }
    })();
    this.discovering.set(host, p);
    return p;
  }

  // ---- room lists ----

  // Polls host's room list while the returned function hasn't been called
  // (the server's panel is showing).
  watchRooms(rawHost: string): () => void {
    const host = rawHost.trim().toLowerCase();
    if (!this.bridge || !host) return () => {};
    let w = this.watchers.get(host);
    if (!w) {
      w = { count: 0, timer: null };
      this.watchers.set(host, w);
    }
    w.count++;
    if (w.count === 1) {
      void this.refreshRooms(host);
      w.timer = setInterval(() => { void this.refreshRooms(host); }, this.opts.pollMs ?? VOICE_POLL_MS);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const cur = this.watchers.get(host);
      if (!cur) return;
      cur.count--;
      if (cur.count <= 0) {
        if (cur.timer) clearInterval(cur.timer);
        this.watchers.delete(host);
      }
    };
  }

  async refreshRooms(rawHost: string, force = false): Promise<void> {
    const host = rawHost.trim().toLowerCase();
    if (!this.bridge || this.servers[host]?.discovery !== 'available') return;
    // Not while the window is hidden (minimised, another space).
    if (!force && typeof document !== 'undefined' && document.hidden) return;
    let token: string;
    try {
      token = await this.listVoiceToken();
    } catch (err) {
      this.patchServer(host, { roomsError: tokenErrorText(err), roomsErrorKind: 'token' });
      return;
    }
    let r;
    try {
      r = await this.bridge.rooms(host, token);
    } catch (err) {
      this.patchServer(host, { roomsError: errText(err), roomsErrorKind: 'server' });
      return;
    }
    if (r.errorKind === 'token') this.listToken = null;
    if (r.error) {
      this.patchServer(host, { roomsError: r.error, roomsErrorKind: r.errorKind ?? 'server' });
      return;
    }
    this.patchServer(host, { rooms: r.rooms ?? [], roomsError: null, roomsErrorKind: null });
  }

  // A token for listing rooms (any room), reused while it's good for
  // another minute. Joining always gets its own, for that room.
  private async listVoiceToken(): Promise<string> {
    if (this.listToken && this.listToken.expiresAt - TOKEN_MARGIN_MS > this.now()) return this.listToken.token;
    this.listToken = await this.opts.voiceToken();
    return this.listToken.token;
  }

  // ---- the call ----

  async join(rawHost: string, room: Pick<VoiceRoom, 'id' | 'name'>, serverName = ''): Promise<void> {
    const host = rawHost.trim().toLowerCase();
    if (!this.bridge) return;
    if (this.call.status === 'connected' && this.call.host === host && this.call.room === room.id) return;
    this.callServerName = serverName || host;
    // Show "connecting" at once; the token comes first.
    this.setCall({
      ...this.call, status: 'connecting', host, room: room.id, roomName: room.name,
      error: undefined, errorKind: undefined, participants: this.call.host === host && this.call.room === room.id ? this.call.participants : [],
    });
    let token: string;
    try {
      token = (await this.opts.voiceToken([room.id])).token;
    } catch (err) {
      this.setCall({ ...this.call, status: 'error', error: tokenErrorText(err), errorKind: 'token' });
      return;
    }
    try {
      this.setCall(await this.bridge.join({ host, room: room.id, roomName: room.name, token }));
    } catch (err) {
      this.setCall({ ...this.call, status: 'error', error: errText(err), errorKind: 'server' });
    }
  }

  async leave(): Promise<void> {
    if (!this.bridge) return;
    this.releasePTT();
    this.setCall({ ...this.call, status: 'idle', host: '', room: '', roomName: '', participants: [], error: undefined, errorKind: undefined });
    await this.bridge.leave().catch(() => {});
  }

  async dismissError(): Promise<void> {
    if (!this.bridge) return;
    this.setCall({ ...this.call, status: 'idle', host: '', room: '', roomName: '', error: undefined, errorKind: undefined });
    await this.bridge.dismissError().catch(() => {});
  }

  async setMuted(muted: boolean): Promise<void> {
    if (!this.bridge) return;
    this.setCall({ ...this.call, muted, deafened: muted ? this.call.deafened : false });
    this.setCall(await this.bridge.setMuted(muted).catch(() => this.call));
  }

  async setDeafened(deafened: boolean): Promise<void> {
    if (!this.bridge) return;
    this.setCall({ ...this.call, deafened });
    this.setCall(await this.bridge.setDeafened(deafened).catch(() => this.call));
  }

  // ---- settings ----

  async devices(): Promise<VoiceDevices> {
    if (!this.bridge) return { inputs: [], outputs: [], error: 'Voice needs the desktop app.' };
    try {
      return await this.bridge.devices();
    } catch (err) {
      return { inputs: [], outputs: [], error: errText(err) };
    }
  }

  async micTest(on: boolean): Promise<void> {
    if (!this.bridge) return;
    try {
      this.setCall(await this.bridge.micTest(on));
    } catch (err) {
      this.setCall({ ...this.call, micTest: false, micTestError: errText(err) });
    }
  }

  // A user's playback volume (percent), remembered across calls and runs.
  setUserVolume(userId: string, percent: number): void {
    if (!userId) return;
    const v = Math.max(0, Math.min(200, Math.round(percent)));
    setVoiceSettings({ userVolumes: { ...getVoiceSettings().userVolumes, [userId]: v } });
  }

  userVolume(userId: string): number {
    return getVoiceSettings().userVolumes[userId] ?? 100;
  }

  private pushSettings(s: VoiceSettings, prev: VoiceSettings | null): void {
    const b = this.bridge;
    if (!b) return;
    const ignore = (): void => {};
    if (!prev || prev.inputId !== s.inputId || prev.outputId !== s.outputId) void b.setDevices(s.inputId, s.outputId).catch(ignore);
    if (!prev || prev.mode !== s.mode) {
      this.releasePTT();
      void b.setInputMode(s.mode).catch(ignore);
    }
    if (!prev || prev.vadDb !== s.vadDb) void b.setVADThreshold(s.vadDb).catch(ignore);
    for (const [user, v] of Object.entries(s.userVolumes)) {
      if (!prev || prev.userVolumes[user] !== v) void b.setUserVolume(user, v).catch(ignore);
    }
  }

  // ---- push to talk (while the window has focus) ----

  private onKey(e: KeyboardEvent, down: boolean): void {
    const s = this.settings;
    if (s.mode !== 'ptt' || !s.pttCode || e.code !== s.pttCode) return;
    // Only while it can matter: in a call or testing the mic.
    const live = this.call.status === 'connected' || this.call.status === 'connecting' || this.call.micTest;
    if (!live && !this.pttDown) return;
    if (down && (e.repeat || this.pttDown)) return;
    if (!down && !this.pttDown) return;
    // The key talks rather than types — unless the user is typing in a
    // field and the key is a character.
    if (!(isEditable(e.target) && e.key.length === 1)) e.preventDefault();
    this.pttDown = down;
    void this.bridge?.ptt(down).catch(() => {});
  }

  private releasePTT(): void {
    if (!this.pttDown) return;
    this.pttDown = false;
    void this.bridge?.ptt(false).catch(() => {});
  }
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tokenErrorText(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'signed_out') return 'Sign in to your Boson account to use voice.';
  if (code === 'network') return "Couldn't reach the sign-in service for a voice token.";
  return `Couldn't get a voice token: ${errText(err)}`;
}

// The app's controller (main.tsx sets it up; tests and the screenshot
// harness install their own).
let instance: VoiceController | null = null;

export function getVoiceController(): VoiceController | null {
  return instance;
}

export function setVoiceController(c: VoiceController | null): void {
  instance?.dispose();
  instance = c;
}
