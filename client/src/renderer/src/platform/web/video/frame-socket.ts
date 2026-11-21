// The call view's frame socket, in the page: the desktop's VideoService
// serves frames on a loopback WebSocket (state.frameUrl); here the web
// VideoService hands the same messages to a WebSocket-like object the
// VideoController opens (bosonVideo.frameSocket). Text messages from the
// view (keyframe requests, error logs) come back to the hub.

export interface HubListener {
  keyframe(trackId: number): void;
}

const QUEUE = 64;

export class FrameHub {
  private sockets = new Set<PageSocket>();
  readonly url = 'web-frames:video';

  constructor(private listener: HubListener) {}

  /** The WebSocket constructor for the VideoController. */
  socketClass(): typeof WebSocket {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const hub = this;
    class Socket extends PageSocket {
      constructor(url: string) { super(hub, url); }
    }
    return Socket as unknown as typeof WebSocket;
  }

  attach(s: PageSocket): void { this.sockets.add(s); }
  detach(s: PageSocket): void { this.sockets.delete(s); }
  connected(): number { return this.sockets.size; }

  /** A frame to every view; a view that's behind skips that track to its next keyframe. */
  frame(trackId: number, keyframe: boolean, hasDesc: boolean, msg: ArrayBuffer): void {
    for (const s of this.sockets) {
      if (s.needKey.has(trackId)) {
        if (!keyframe || !hasDesc) continue;
        s.needKey.delete(trackId);
      }
      if (!s.enqueue(msg)) {
        s.needKey.add(trackId);
        this.listener.keyframe(trackId);
      }
    }
  }

  /** Periodic messages (lip sync, previews): dropped for a view that's behind. */
  broadcast(msg: ArrayBuffer | string): void {
    for (const s of this.sockets) s.enqueue(msg);
  }

  fromPage(text: string): void {
    try {
      const m = JSON.parse(text) as { type?: string; trackId?: number; where?: string; msg?: string };
      if (m.type === 'keyframe' && typeof m.trackId === 'number') this.listener.keyframe(m.trackId);
      else if (m.type === 'log') console.warn(`[video] ${m.where}: ${String(m.msg).slice(0, 500)}`);
    } catch { /* not ours */ }
  }
}

export class PageSocket {
  readyState = 0;
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  needKey = new Set<number>();
  private queue: Array<ArrayBuffer | string> = [];
  private scheduled = false;

  constructor(private hub: FrameHub, readonly url: string) {
    hub.attach(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }

  enqueue(msg: ArrayBuffer | string): boolean {
    if (this.readyState > 1) return true;
    if (this.queue.length >= QUEUE) return false;
    this.queue.push(msg);
    if (!this.scheduled) {
      this.scheduled = true;
      setTimeout(() => this.flush(), 0);
    }
    return true;
  }

  private flush(): void {
    this.scheduled = false;
    const q = this.queue;
    this.queue = [];
    for (const data of q) {
      if (this.readyState > 1) return;
      this.onmessage?.(new MessageEvent('message', { data }));
    }
  }

  send(data: string): void {
    if (this.readyState === 1 && typeof data === 'string') this.hub.fromPage(data);
  }

  close(): void {
    if (this.readyState > 1) return;
    this.readyState = 3;
    this.hub.detach(this);
    this.queue = [];
    this.onclose?.(new CloseEvent('close'));
  }
}
