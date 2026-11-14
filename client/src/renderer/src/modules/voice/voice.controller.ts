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
  IDLE_VOICE_STATE, NO_ROOM_PERMISSIONS, type VoiceDevices, type VoiceRoom, type VoiceRoomChange,
  type VoiceRoomInput, type VoiceRoomPermissions, type VoiceRoomsErrorKind, type VoiceState,
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
  // Whether (and where) you may make voice channels here.
  permissions: VoiceRoomPermissions;
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
      host, discovery: 'unknown', audio: false, rooms: null, permissions: NO_ROOM_PERMISSIONS, roomsError: null, roomsErrorKind: null,
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
    this.patchServer(host, {
      rooms: r.rooms ?? [],
      permissions: normalizePermissions(r.permissions),
      roomsError: null,
      roomsErrorKind: null,
    });
  }

  // ---- managing voice channels ----

  // Makes a voice channel; resolves with the room, or rejects with a
  // VoiceRoomError whose message is for the user.
  async createRoom(rawHost: string, input: VoiceRoomInput): Promise<VoiceRoom> {
    const r = await this.change(rawHost, (b, host, token) => b.createRoom(host, token, input));
    if (!r.room) throw new VoiceRoomError('server', 'The voice server sent no channel back.');
    return r.room;
  }

  async updateRoom(rawHost: string, id: string, input: VoiceRoomInput): Promise<VoiceRoom | null> {
    return (await this.change(rawHost, (b, host, token) => b.updateRoom(host, token, id, input))).room ?? null;
  }

  async deleteRoom(rawHost: string, id: string): Promise<void> {
    await this.change(rawHost, (b, host, token) => b.deleteRoom(host, token, id));
  }

  // Moves a room one place up or down among its siblings (same parent).
  // Positions are renumbered 0..n-1 inside the group; only rooms you may
  // manage can be renumbered (canMove says whether this move can be done).
  async moveRoom(rawHost: string, id: string, dir: -1 | 1): Promise<void> {
    const host = rawHost.trim().toLowerCase();
    const plan = movePlan(this.servers[host]?.rooms ?? [], id, dir);
    if (!plan) throw new VoiceRoomError('forbidden', "That voice channel can't move there.");
    for (const step of plan) {
      await this.change(host, (b, h, token) => b.updateRoom(h, token, step.id, { position: step.position }), false);
    }
    await this.refreshRooms(host, true);
  }

  canMove(rawHost: string, id: string, dir: -1 | 1): boolean {
    return movePlan(this.servers[rawHost.trim().toLowerCase()]?.rooms ?? [], id, dir) !== null;
  }

  private async change(
    rawHost: string,
    fn: (b: VoiceBridge, host: string, token: string) => Promise<VoiceRoomChange>,
    refresh = true,
  ): Promise<VoiceRoomChange> {
    const host = rawHost.trim().toLowerCase();
    if (!this.bridge) throw new VoiceRoomError('unavailable_voice', 'Voice needs the desktop app.');
    let token: string;
    try {
      token = await this.listVoiceToken();
    } catch (err) {
      throw new VoiceRoomError('token', tokenErrorText(err));
    }
    let r: VoiceRoomChange;
    try {
      r = await fn(this.bridge, host, token);
    } catch (err) {
      throw new VoiceRoomError('server', errText(err));
    }
    if (r.code === 'unauthorized') this.listToken = null;
    if (r.error || r.code) throw new VoiceRoomError(r.code ?? 'server', roomErrorText(r), r.retryAfter);
    if (refresh) void this.refreshRooms(host, true);
    return r;
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

// A failed room change: code is the voice server's (conflict, forbidden, …).
export class VoiceRoomError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryAfter?: number) {
    super(message);
    this.name = 'VoiceRoomError';
  }
}

function roomErrorText(r: VoiceRoomChange): string {
  switch (r.code) {
    case 'conflict': return 'There is already a voice channel with that name here.';
    case 'static_room': return "This voice channel is set in the server's config and can't be changed here.";
    case 'limit': return "You've made as many voice channels as this server allows. Delete one first.";
    case 'not_found': return 'That voice channel no longer exists.';
    case 'forbidden': return r.error ? capitalise(r.error) : "You don't have permission to do that.";
    case 'unavailable': return `The voice server couldn't check your channel role. Try again in ${r.retryAfter ?? 5} seconds.`;
    case 'unauthorized': return "The voice server didn't accept your sign-in. Try again.";
    case 'unsupported': return "This voice server doesn't support managing channels yet.";
    default: return r.error ? capitalise(r.error) : 'The voice server refused the change.';
  }
}

function capitalise(s: string): string {
  const t = s.trim();
  const out = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

function normalizePermissions(p: VoiceRoomPermissions | undefined): VoiceRoomPermissions {
  if (!p) return NO_ROOM_PERMISSIONS;
  const scope = p.createScope === 'any' || p.createScope === 'founded_channels' ? p.createScope : 'none';
  return {
    policy: p.policy,
    canCreate: !!p.canCreate && scope !== 'none',
    createScope: scope,
    foundedChannels: (p.foundedChannels ?? []).map((c) => c.toLowerCase()),
  };
}

// The rooms under one parent ('' = top level), in display order.
export function roomsUnder(rooms: readonly VoiceRoom[], parent: string): VoiceRoom[] {
  const key = parent.toLowerCase();
  return rooms.filter((r) => (r.parent ?? '').toLowerCase() === key);
}

// The PATCHes that move `id` one step: its group renumbered 0..n-1 in the
// new order. null when it's already at that end, or a room that would need
// a new position isn't one you may manage.
export function movePlan(rooms: readonly VoiceRoom[], id: string, dir: -1 | 1): Array<{ id: string; position: number }> | null {
  const room = rooms.find((r) => r.id === id);
  if (!room || !room.canManage) return null;
  const group = roomsUnder(rooms, room.parent ?? '');
  const i = group.findIndex((r) => r.id === id);
  const j = i + dir;
  if (j < 0 || j >= group.length) return null;
  const order = [...group];
  [order[i], order[j]] = [order[j]!, order[i]!];
  const steps: Array<{ id: string; position: number }> = [];
  for (let k = 0; k < order.length; k++) {
    const r = order[k]!;
    if ((r.position ?? -1) === k) continue;
    if (!r.canManage || r.kind === 'static' || r.kind === 'adhoc') return null;
    steps.push({ id: r.id, position: k });
  }
  return steps.length > 0 ? steps : null;
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
