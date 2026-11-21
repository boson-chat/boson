// window.bosonVideo in the web build: the desktop VideoService
// (desktop/video.go) in TypeScript. With a voice call up, a video ticket
// from the voice server's control stream, then quicvideod over WebTransport
// (its /wt endpoint). Camera from getUserMedia and screens from
// getDisplayMedia (the browser's own picker), encoded by quicvideo's
// browser client (WebCodecs H.264). Received frames are converted to AVC
// and handed to the call view's decoder (video.controller.ts) through an
// in-page frame socket, with the same lip-sync offsets as the desktop.
import type { VideoBridge } from '../../../modules/video/video.bridge';
import type { VideoCamera, VideoShareState, VideoSource, VideoState, VideoTrack } from '../../../modules/video/video.types';
import { QuicVideoClient, TrackKind, type RawFrame, type Track } from '../quicvideo/client';
import { screenLayers } from '../quicvideo/layers';
import type { ControlMessage as VideoControl } from '../quicvideo/gen/quicvideo/v1/control_pb';
import type { ControlMessage as VoiceControl } from '../quicvoice/gen/control_pb';
import type { Conn as VoiceConn, VideoHooks } from '../voice/service';
import { FrameHub } from './frame-socket';
import { encodeFrameMsg, encodePreviewMsg, toAVC } from './frames';
import { cameraKind, cameraLayersFor, ticketCanPublish, ticketWebTransportUrl } from './layers';

export interface VoiceSync {
  // Per user id: local µs offset for a frame's capture time (voice avOffsets).
  avOffsets(): Map<string, number>;
  setAudioDelay(userId: string, ms: number): void;
}

interface Share {
  on: boolean;
  starting: boolean;
  paused?: boolean;
  id: string;
  name?: string;
  error?: string;
  gen: number;
  stream: MediaStream | null;
  pub: { stop(): void } | null;
}

interface Sess {
  client: QuicVideoClient;
  self: number;
  people: Map<number, { userId: string; name: string }>;
  tracks: Map<number, Track>;
  subs: Map<number, number>;
  refresh: ReturnType<typeof setInterval> | null;
  report: ReturnType<typeof setInterval> | null;
  stalls: Map<number, number>;
  frames: Map<number, number>;
}

interface Adapt { lates: number[]; extra: number; decided: number; changed: number; lastFrame: number }

const PREVIEW_W = 320;
const SYNC_MS = 200;
const ADAPT_EVERY = 1000;
const ADAPT_SETTLE = 2000;
const ADAPT_IDLE = 2000;
const ADAPT_MARGIN = 10;
const ADAPT_EASE = 20;
const ADAPT_EARLY = 50;
const ADAPT_MAX = 150;
const DECODE_BUDGET = 10;
const REFRESH_MS = 3.5 * 60_000;

export interface WebVideoOptions {
  dev: boolean;
  voice: VoiceSync;
  // Dev/e2e: a self-signed quicvideod's certificate hash, by host:port.
  certHash?: (hostPort: string) => Promise<string | undefined>;
  canSend: boolean; // WebCodecs H.264 encode + getUserMedia
  canWatch: boolean; // WebTransport + H.264 decode
}

const emptyShare = (gen = 0): Share => ({ on: false, starting: false, id: '', gen, stream: null, pub: null });

export class WebVideoService implements VideoBridge, VideoHooks {
  private listeners = new Set<(s: VideoState) => void>();
  readonly hub: FrameHub;
  /** The frame socket class the VideoController opens (main.tsx). */
  readonly frameSocket: typeof WebSocket;
  private seq = 0;
  private sess: Sess | null = null;
  private available = false;
  private status: VideoState['status'] = 'idle';
  private err = '';
  private canPublish = false;
  private camera: Share = emptyShare();
  private screen: Share = emptyShare();
  private preview: Share = emptyShare();
  private camWant = false;
  private camQuality = 'auto';
  private screenMode: 'detail' | 'motion' = 'motion';
  private dirty = false;
  private timer: ReturnType<typeof setInterval>;
  private lastSync = 0;
  private previewVideo: HTMLVideoElement | null = null;
  private previewTimer: ReturnType<typeof setInterval> | null = null;
  private userOffsets = new Map<string, number>();
  private adapt = new Map<string, Adapt>();

  constructor(private opts: WebVideoOptions) {
    this.hub = new FrameHub({ keyframe: (id) => this.keyframeNeeded(id) });
    this.frameSocket = this.hub.socketClass();
    this.timer = setInterval(() => this.tick(), 100);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  // ---- voice hooks ----

  voiceJoined(conn: VoiceConn): void {
    void this.stopPreview();
    const seq = ++this.seq;
    void this.start(seq, conn);
  }

  voiceLeft(): void {
    void this.stopPreview();
    this.seq++;
    const sess = this.sess;
    this.sess = null;
    this.stopShare(this.camera);
    this.stopShare(this.screen);
    this.camera = emptyShare(this.camera.gen + 1);
    this.screen = emptyShare(this.screen.gen + 1);
    this.camWant = false;
    this.available = false;
    this.status = 'idle';
    this.err = '';
    this.adapt.clear();
    this.userOffsets.clear();
    this.dirty = true;
    if (sess) this.closeSess(sess);
  }

  private async ticket(conn: VoiceConn): Promise<{ token: string; room: string; url: string } | null> {
    try {
      const reply = conn.waitFor((m: VoiceControl) => m.msg.case === 'videoTicket' || m.msg.case === 'error', 5000);
      await conn.send({ case: 'videoTicketRequest', value: {} } as VoiceControl['msg']);
      const m = await reply;
      if (m.msg.case !== 'videoTicket') return null;
      const t = m.msg.value;
      const url = ticketWebTransportUrl({ webtransportUrl: t.webtransportUrl, quicUrl: t.quicUrl });
      return url ? { token: t.token, room: t.room, url } : null;
    } catch {
      return null; // no video on this voice server
    }
  }

  private async start(seq: number, conn: VoiceConn): Promise<void> {
    const t = await this.ticket(conn);
    if (!t || this.seq !== seq) return;
    if (!this.opts.canWatch) {
      // Video is offered here, but this browser can't play it.
      this.available = true;
      this.status = 'error';
      this.err = 'Video needs a browser with WebTransport and H.264 (Chrome, Edge or Firefox).';
      this.dirty = true;
      return;
    }
    this.available = true;
    this.status = 'connecting';
    this.err = '';
    this.canPublish = ticketCanPublish(t.token);
    this.dirty = true;
    let client: QuicVideoClient;
    try {
      const u = new URL(t.url);
      const certHash = this.opts.dev ? await this.opts.certHash?.(u.host) : undefined;
      client = await QuicVideoClient.connect(t.url, t.token, { certHash });
    } catch {
      if (this.seq === seq) this.fail("Couldn't reach the video server.");
      return;
    }
    if (this.seq !== seq) { client.close(); return; }
    let state;
    try {
      state = await client.join(t.room);
    } catch (e) {
      client.close();
      if (this.seq === seq) this.fail(`The video server refused: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.seq !== seq) { client.close(); return; }
    const sess: Sess = {
      client, self: state.yourSessionId, people: new Map(), tracks: new Map(), subs: new Map(),
      refresh: null, report: null, stalls: new Map(), frames: new Map(),
    };
    for (const p of state.participants) sess.people.set(p.sessionId, { userId: p.userId, name: p.displayName });
    for (const tr of state.tracks) sess.tracks.set(tr.trackId, tr);
    client.onRawFrame = (f) => { if (this.sess === sess) this.onFrame(sess, f); };
    client.on('control', (m) => { if (this.sess === sess) this.onControl(sess, m); });
    client.on('closed', () => {
      if (this.sess !== sess) return;
      this.sess = null;
      this.status = 'error';
      this.err = 'Lost the connection to the video server.';
      this.stopShare(this.camera);
      this.stopShare(this.screen);
      this.camera = emptyShare(this.camera.gen + 1);
      this.screen = emptyShare(this.screen.gen + 1);
      this.dirty = true;
      this.closeSess(sess);
    });
    // Tickets last 5 minutes: a fresh one from voice, then Refresh.
    sess.refresh = setInterval(() => {
      void this.ticket(conn).then((nt) => {
        if (nt && this.sess === sess) void client.send({ case: 'refresh', value: { token: nt.token } }).catch(() => {});
      });
    }, REFRESH_MS);
    sess.report = setInterval(() => this.report(sess), 1000);
    this.sess = sess;
    this.status = 'connected';
    this.dirty = true;
  }

  private fail(msg: string): void {
    this.status = 'error';
    this.err = msg;
    this.dirty = true;
  }

  private closeSess(sess: Sess): void {
    if (sess.refresh) clearInterval(sess.refresh);
    if (sess.report) clearInterval(sess.report);
    sess.client.onRawFrame = null;
    try { sess.client.close(); } catch { /* closed */ }
  }

  private onControl(sess: Sess, m: VideoControl): void {
    switch (m.msg.case) {
      case 'participantJoined': {
        const p = m.msg.value.participant;
        if (p) sess.people.set(p.sessionId, { userId: p.userId, name: p.displayName });
        break;
      }
      case 'participantLeft':
        sess.people.delete(m.msg.value.sessionId);
        break;
      case 'trackAdded':
        if (m.msg.value.track) sess.tracks.set(m.msg.value.track.trackId, m.msg.value.track);
        break;
      case 'trackRemoved':
        sess.tracks.delete(m.msg.value.trackId);
        sess.subs.delete(m.msg.value.trackId);
        break;
      case 'error':
        if (m.msg.value.code === 7 /* KICKED */) {
          queueMicrotask(() => {
            if (this.sess !== sess) return;
            this.sess = null;
            this.status = 'idle';
            this.stopShare(this.camera);
            this.stopShare(this.screen);
            this.camera = emptyShare(this.camera.gen + 1);
            this.screen = emptyShare(this.screen.gen + 1);
            this.closeSess(sess);
            this.dirty = true;
          });
        }
        break;
      default:
        return;
    }
    this.dirty = true;
  }

  // ---- receiving ----

  private onFrame(sess: Sess, f: RawFrame): void {
    const tr = sess.tracks.get(f.trackId);
    if (!tr || tr.kind === 3 /* SCREEN_AUDIO: not played on the web yet */) return;
    sess.frames.set(f.trackId, (sess.frames.get(f.trackId) ?? 0) + 1);
    const captureUS = Number(f.captureUS);
    this.noteLateness(sess, f.trackId, captureUS);
    const av = toAVC(f.payload);
    if (!av) return;
    if (f.first && !av.desc) av.keyframe = true; // a group starts on a keyframe
    this.hub.frame(f.trackId, av.keyframe, !!av.desc, encodeFrameMsg(f.trackId, f.layer, captureUS, av));
  }

  private keyframeNeeded(trackId: number): void {
    const sess = this.sess;
    if (sess) sess.stalls.set(trackId, (sess.stalls.get(trackId) ?? 0) + 1);
  }

  /** ReceiverReports: frames received and decode stalls (the server asks the sender for a keyframe). */
  private report(sess: Sess): void {
    for (const [trackId, layer] of sess.subs) {
      const frames = sess.frames.get(trackId) ?? 0;
      const stalls = sess.stalls.get(trackId) ?? 0;
      void sess.client.send({
        case: 'receiverReport',
        value: { trackId, layer, framesReceived: frames, decodeStalls: stalls, intervalMs: 1000 },
      } as never).catch(() => {});
      sess.frames.set(trackId, 0);
      sess.stalls.set(trackId, 0);
    }
  }

  async subscribe(trackId: number, layer: number): Promise<void> {
    const sess = this.sess;
    if (!sess || !sess.tracks.has(trackId)) return;
    if (sess.subs.get(trackId) === layer) return;
    sess.subs.set(trackId, layer);
    await sess.client.subscribeRaw(trackId, layer).catch(() => {});
  }

  async unsubscribe(trackId: number): Promise<void> {
    const sess = this.sess;
    if (!sess || !sess.subs.has(trackId)) return;
    sess.subs.delete(trackId);
    await sess.client.unsubscribe(trackId).catch(() => {});
  }

  // ---- lip sync ----

  private sendSync(): void {
    const sess = this.sess;
    if (!sess || this.hub.connected() === 0) return;
    const byUser = this.opts.voice.avOffsets();
    this.userOffsets = byUser;
    const offsets: Record<string, number> = {};
    for (const [id, tr] of sess.tracks) {
      const off = byUser.get(sess.people.get(tr.sessionId)?.userId ?? '');
      if (off !== undefined && tr.kind === TrackKind.CAMERA) offsets[id] = off;
    }
    this.hub.broadcast(JSON.stringify({ type: 'sync', offsets }));
  }

  private noteLateness(sess: Sess, trackId: number, captureUS: number): void {
    const tr = sess.tracks.get(trackId);
    if (!tr || tr.kind !== TrackKind.CAMERA) return;
    const user = sess.people.get(tr.sessionId)?.userId ?? '';
    const off = this.userOffsets.get(user);
    if (!user || off === undefined) return;
    const now = Date.now();
    const late = (now * 1000 - (captureUS + off)) / 1000 + DECODE_BUDGET;
    let a = this.adapt.get(user);
    if (!a) { a = { lates: [], extra: 0, decided: now, changed: 0, lastFrame: now }; this.adapt.set(user, a); }
    if (a.lates.length < 512) a.lates.push(late);
    a.lastFrame = now;
  }

  private adaptDelays(): void {
    const now = Date.now();
    for (const [user, a] of this.adapt) {
      if (now - a.lastFrame > ADAPT_IDLE) {
        if (a.extra > 0) this.opts.voice.setAudioDelay(user, 0);
        this.adapt.delete(user);
        continue;
      }
      if (now - a.decided < ADAPT_EVERY) continue;
      if (a.changed && now - a.changed < ADAPT_SETTLE) { a.lates = []; a.decided = now; continue; }
      if (a.lates.length === 0) continue;
      a.lates.sort((x, y) => x - y);
      const p90 = a.lates[Math.floor(((a.lates.length - 1) * 9) / 10)]!;
      let want = a.extra;
      if (p90 > 0) want += p90 + ADAPT_MARGIN;
      else if (p90 < -ADAPT_EARLY) want -= Math.min(ADAPT_EASE, -p90 - ADAPT_EARLY);
      want = Math.min(Math.max(want, 0), ADAPT_MAX);
      a.lates = [];
      a.decided = now;
      if (want !== a.extra) {
        a.extra = want;
        a.changed = now;
        this.opts.voice.setAudioDelay(user, want);
      }
    }
  }

  // ---- sending ----

  async cameras(): Promise<VideoCamera[]> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({
        id: d.deviceId, name: d.label || `Camera ${i + 1}`, kind: cameraKind(d.label), facing: '' as const, default: i === 0,
      }));
    } catch {
      return [];
    }
  }

  async screenSources(): Promise<VideoSource[]> {
    // The browser shows its own picker (screens, windows, tabs).
    return this.canShareScreen() ? [{ id: '', name: "Your browser's picker", kind: 'picker' }] : [];
  }

  private canShareScreen(): boolean {
    return this.opts.canSend && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  async setCamera(on: boolean, cameraId: string): Promise<VideoState> {
    await this.setShare(true, on, cameraId);
    return this.snapshot();
  }

  async setScreen(on: boolean, sourceId: string): Promise<VideoState> {
    return this.shareScreen(on, sourceId, 'motion');
  }

  async shareScreen(on: boolean, sourceId: string, mode: 'detail' | 'motion', _sound?: boolean): Promise<VideoState> {
    if (on) this.screenMode = mode === 'detail' ? 'detail' : 'motion';
    await this.setShare(false, on, sourceId);
    return this.snapshot();
  }

  async switchScreen(sourceId: string): Promise<VideoState> {
    // The browser's picker again; the share restarts on the new source.
    await this.setShare(false, true, sourceId);
    return this.snapshot();
  }

  async setShareVolume(_trackId: number, _percent: number): Promise<VideoState> {
    return this.snapshot();
  }

  async resumeCamera(): Promise<VideoState> {
    if (this.camWant && this.sess && !this.camera.on && !this.camera.starting) await this.setShare(true, true, this.camera.id);
    return this.snapshot();
  }

  async setCameraQuality(q: string): Promise<VideoState> {
    const quality = q === 'saver' || q === 'high' ? q : 'auto';
    if (quality !== this.camQuality) {
      this.camQuality = quality;
      this.dirty = true;
      if (this.camera.on) await this.setShare(true, true, this.camera.id);
    }
    return this.snapshot();
  }

  async screenThumbnails(_ids: string[]): Promise<Record<string, string>> {
    return {};
  }

  async stopThumbnails(): Promise<void> {}

  private stopShare(s: Share): void {
    try { s.pub?.stop(); } catch { /* gone */ }
    for (const t of s.stream?.getTracks() ?? []) t.stop();
  }

  private async setShare(camera: boolean, on: boolean, id: string): Promise<void> {
    const old = camera ? this.camera : this.screen;
    const gen = old.gen + 1;
    const sl: Share = { ...emptyShare(gen), id };
    if (camera) this.camWant = on;
    if (camera && on) await this.stopPreview();
    const sess = this.sess;
    if (on) {
      if (!this.opts.canSend) { sl.error = "This browser can't send video."; on = false; }
      else if (!sess) { sl.error = 'Not in a call.'; on = false; }
      else if (!this.canPublish) { sl.error = "You can't send video in this channel."; on = false; }
      else sl.starting = true;
      if (camera && !on) this.camWant = false;
    }
    if (camera) this.camera = sl; else this.screen = sl;
    this.dirty = true;
    this.stopShare(old);
    if (!on || !sess) return;
    const current = (): boolean => (camera ? this.camera : this.screen).gen === gen && this.sess === sess;
    let stream: MediaStream;
    try {
      stream = camera
        ? await navigator.mediaDevices.getUserMedia({ video: { deviceId: id ? { exact: id } : undefined, width: { ideal: this.camQuality === 'high' ? 1920 : 1280 }, height: { ideal: this.camQuality === 'high' ? 1080 : 720 }, frameRate: { ideal: 30 } } })
        : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: this.screenMode === 'detail' ? 15 : 30 } }, audio: false });
    } catch (e) {
      if (!current()) return;
      const name = (e as { name?: string }).name;
      const what = camera ? 'The camera' : 'Screen sharing';
      const msg = name === 'NotAllowedError'
        ? (camera ? "Boson can't use your camera. Allow it for this site in your browser, then try again." : 'Screen sharing was cancelled.')
        : `${what} couldn't start: ${e instanceof Error ? e.message : String(e)}`;
      if (camera) { this.camera = { ...emptyShare(gen), id, error: msg }; this.camWant = false; } else this.screen = { ...emptyShare(gen), id, error: name === 'NotAllowedError' ? undefined : msg };
      this.dirty = true;
      return;
    }
    if (!current()) { for (const t of stream.getTracks()) t.stop(); return; }
    const track = stream.getVideoTracks()[0]!;
    const st = track.getSettings();
    if (!camera) (track as MediaStreamTrack & { contentHint: string }).contentHint = this.screenMode === 'detail' ? 'text' : 'motion';
    const layers = camera
      ? cameraLayersFor(st.width ?? 1280, st.height ?? 720, st.frameRate ?? 30, this.camQuality)
      : screenLayers(st.width ?? 1920, st.height ?? 1080);
    let pub;
    try {
      pub = await sess.client.publish(camera ? TrackKind.CAMERA : TrackKind.SCREEN, track, layers);
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      if (!current()) return;
      const msg = `${camera ? 'The camera' : 'Screen sharing'} couldn't start: ${e instanceof Error ? e.message : String(e)}`;
      if (camera) { this.camera = { ...emptyShare(gen), id, error: msg }; this.camWant = false; } else this.screen = { ...emptyShare(gen), id, error: msg };
      this.dirty = true;
      return;
    }
    if (!current()) { pub.stop(); return; }
    const done: Share = { on: true, starting: false, id, gen, name: track.label, stream, pub };
    if (camera) this.camera = done; else this.screen = done;
    // Stopped outside the app (the browser's "Stop sharing", a camera unplugged).
    track.addEventListener('ended', () => {
      const cur = camera ? this.camera : this.screen;
      if (cur.gen !== gen) return;
      this.stopShare(cur);
      const ended: Share = { ...emptyShare(gen + 1), id, error: camera ? 'The camera stopped.' : undefined };
      if (camera) { this.camera = ended; this.camWant = false; } else this.screen = ended;
      this.dirty = true;
    });
    if (camera) this.startSelfView(stream);
    this.dirty = true;
  }

  // ---- the self-view (and the pre-join preview) ----

  async previewCamera(on: boolean, cameraId: string): Promise<VideoState> {
    await this.stopPreview();
    const gen = this.preview.gen + 1;
    this.preview = { ...emptyShare(gen), id: cameraId };
    if (on) {
      if (!this.opts.canSend && typeof navigator.mediaDevices?.getUserMedia !== 'function') this.preview.error = "This browser can't use the camera.";
      else if (this.camera.on || this.camera.starting) { /* the call's camera is the preview */ }
      else {
        this.preview.starting = true;
        this.dirty = true;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: cameraId ? { exact: cameraId } : undefined } });
          if (this.preview.gen !== gen) { for (const t of stream.getTracks()) t.stop(); return this.snapshot(); }
          this.preview = { ...emptyShare(gen), id: cameraId, on: true, stream };
          this.startSelfView(stream);
        } catch (e) {
          if (this.preview.gen === gen) this.preview = { ...emptyShare(gen), id: cameraId, error: e instanceof Error ? e.message : String(e) };
        }
      }
    }
    this.dirty = true;
    return this.snapshot();
  }

  private async stopPreview(): Promise<void> {
    for (const t of this.preview.stream?.getTracks() ?? []) t.stop();
    this.preview = emptyShare(this.preview.gen + 1);
    this.dirty = true;
  }

  // Small RGBA pictures of our camera over the frame socket, as the
  // desktop's capture sends them (the call view draws them into our tile).
  private startSelfView(stream: MediaStream): void {
    this.stopSelfView();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    this.previewVideo = video;
    this.previewTimer = setInterval(() => {
      if (stream.getVideoTracks().every((t) => t.readyState === 'ended')) { this.stopSelfView(); return; }
      if (!video.videoWidth || this.hub.connected() === 0) return;
      const w = PREVIEW_W;
      const h = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * w) & ~1);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      this.hub.broadcast(encodePreviewMsg(w, h, ctx.getImageData(0, 0, w, h).data));
    }, 66);
  }

  private stopSelfView(): void {
    if (this.previewTimer) clearInterval(this.previewTimer);
    this.previewTimer = null;
    if (this.previewVideo) this.previewVideo.srcObject = null;
    this.previewVideo = null;
  }

  // ---- state ----

  async state(): Promise<VideoState> {
    return this.snapshot();
  }

  snapshot(): VideoState {
    const share = (s: Share): VideoShareState => ({ on: s.on, starting: s.starting, paused: s.paused, id: s.id || undefined, name: s.name, error: s.error, facing: '' });
    const st: VideoState = {
      available: this.available, status: this.status, error: this.err || undefined,
      canCapture: this.opts.canSend, canPublish: this.canPublish, canShareScreen: this.canShareScreen(),
      canPickScreen: false, canShareAudio: false,
      camera: share(this.camera), screen: share(this.screen), preview: share(this.preview),
      tracks: [], metered: false, cameraQuality: this.camQuality,
    };
    if (st.screen.on || st.screen.starting) st.screen.mode = this.screenMode;
    if (this.preview.on || this.preview.starting || this.available) st.frameUrl = this.hub.url;
    const sess = this.sess;
    if (!this.available || !sess) return st;
    const tracks: VideoTrack[] = [];
    for (const [id, tr] of sess.tracks) {
      if (tr.kind !== TrackKind.CAMERA && tr.kind !== TrackKind.SCREEN) continue;
      const p = sess.people.get(tr.sessionId);
      tracks.push({
        trackId: id, userId: p?.userId ?? '', name: p?.name ?? '', kind: tr.kind === TrackKind.SCREEN ? 'screen' : 'camera',
        self: tr.sessionId === sess.self,
        layers: tr.layers.map((l) => ({ id: l.id, width: l.width, height: l.height, fps: l.fps })),
      });
    }
    tracks.sort((a, b) => a.trackId - b.trackId);
    st.tracks = tracks;
    return st;
  }

  onState(fn: (s: VideoState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private tick(): void {
    const now = Date.now();
    if (this.sess && now - this.lastSync >= SYNC_MS) {
      this.lastSync = now;
      this.sendSync();
      this.adaptDelays();
    }
    if (!this.dirty) return;
    this.dirty = false;
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }
}
