// The engine in the web build: the Go engine compiled to WebAssembly
// (engine/cmd/wasm), running in a dedicated Worker (engine.worker.ts). This
// stands in for the WebSocket the engine client would otherwise open, as
// platform/wails.ts does over Wails events: each socket is one engine
// session carrying the same JSON frames, over a MessagePort.
import type { WebSocketLike } from '../../modules/engine/engine.client';

export type WorkerFactory = () => Worker;

// Worker → page messages.
export type EngineWorkerReply =
  | { type: 'ready' }
  | { type: 'failed'; error: string };

// Page → worker messages (the port carries one session's frames).
export type EngineWorkerRequest =
  | { type: 'start'; wasmUrl: string; gatewayUrl: string }
  | { type: 'open'; port: MessagePort };

// Port messages: frames both ways, then `closed` from the engine.
export type SessionMessage = { frame: string } | { closed: true };

/** One worker per page, started on first use; sessions share it. */
export class WebEngine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  // e2e: the open session's id (0: none), and how to fail the open sockets
  // when the worker is killed.
  private seq = 0;
  private current = 0;
  private live = new Set<() => void>();

  constructor(
    private readonly opts: { wasmUrl: string; gatewayUrl: string; createWorker: WorkerFactory },
  ) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = this.opts.createWorker();
    this.worker = worker;
    const t0 = performance.now();
    this.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (ev: MessageEvent<EngineWorkerReply>): void => {
        if (ev.data?.type === 'ready') {
          console.info(`[engine] ready in ${Math.round(performance.now() - t0)} ms`);
          resolve();
        }
        else if (ev.data?.type === 'failed') reject(new Error(ev.data.error));
        else return;
        worker.removeEventListener('message', onMessage);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', (e) => reject(new Error(e.message || 'engine worker failed')));
      const req: EngineWorkerRequest = { type: 'start', wasmUrl: this.opts.wasmUrl, gatewayUrl: this.opts.gatewayUrl };
      worker.postMessage(req);
    });
    // A failed start is retried by the next socket (the engine client
    // reconnects with backoff).
    this.ready.catch(() => {
      this.worker?.terminate();
      this.worker = null;
      this.ready = null;
    });
    return this.ready;
  }

  /** The open engine session's id (0: none); a new one after a crash. */
  session(): number {
    return this.current;
  }

  /**
   * Kills the engine the hard way, as a crashed engine process would: the
   * worker is terminated (its IRC sockets drop), the renderer's sockets
   * fail, and the next socket starts a new engine. Returns the ended
   * session's id. For the e2e suite.
   */
  crash(): number {
    const ended = this.current;
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.current = 0;
    for (const fail of [...this.live]) fail();
    return ended;
  }

  async openSession(): Promise<MessagePort> {
    await this.start();
    const ch = new MessageChannel();
    const req: EngineWorkerRequest = { type: 'open', port: ch.port2 };
    this.worker!.postMessage(req, [ch.port2]);
    return ch.port1;
  }

  /** The WebSocketLike constructor the engine client opens. */
  socketClass(): new (url: string) => WebSocketLike {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const engine = this;
    return class WebEngineSocket implements WebSocketLike {
      readyState = 0;
      onopen: WebSocketLike['onopen'] = null;
      onclose: WebSocketLike['onclose'] = null;
      onerror: WebSocketLike['onerror'] = null;
      onmessage: WebSocketLike['onmessage'] = null;
      private port: MessagePort | null = null;
      private session = 0;
      private readonly failFn = (): void => this.fail();

      constructor(_url: string) {
        engine.openSession().then(
          (port) => {
            if (this.readyState !== 0) {
              port.postMessage({ closed: true });
              port.close();
              return;
            }
            this.port = port;
            engine.current = ++engine.seq;
            this.session = engine.current;
            engine.live.add(this.failFn);
            port.onmessage = (ev: MessageEvent<SessionMessage>) => {
              const m = ev.data;
              if ('frame' in m) {
                if (this.readyState === 1) this.onmessage?.call(this, new MessageEvent('message', { data: m.frame }));
              } else if ('closed' in m) {
                this.fail();
              }
            };
            this.readyState = 1;
            this.onopen?.call(this, new Event('open'));
          },
          (err) => {
            console.warn('engine: could not start', err);
            this.fail();
          },
        );
      }

      send(data: string): void {
        if (this.readyState !== 1 || !this.port) return;
        this.port.postMessage({ frame: data });
      }

      close(): void {
        if (this.readyState >= 2) return;
        this.port?.postMessage({ closed: true });
        this.finish();
      }

      private fail(): void {
        if (this.readyState >= 2) return;
        this.onerror?.call(this, new Event('error'));
        this.finish();
      }

      private finish(): void {
        engine.live.delete(this.failFn);
        if (engine.current === this.session) engine.current = 0;
        this.readyState = 3;
        this.port?.close();
        this.port = null;
        this.onclose?.call(this, new CloseEvent('close'));
      }
    };
  }
}
