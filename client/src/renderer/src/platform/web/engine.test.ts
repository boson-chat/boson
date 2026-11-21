import { describe, expect, it, vi } from 'vitest';
import { WebEngine, type EngineWorkerRequest } from './engine';

// A stand-in for engine.worker.ts: echoes each session's frames back.
class FakeWorker extends EventTarget {
  terminated = false;
  ports: MessagePort[] = [];
  constructor(private readonly fail = false) { super(); }
  postMessage(m: EngineWorkerRequest): void {
    if (m.type === 'start') {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: this.fail ? { type: 'failed', error: 'no wasm' } : { type: 'ready' } })));
    } else {
      this.ports.push(m.port);
      m.port.onmessage = (ev) => {
        const d = ev.data as { frame?: string };
        if (d.frame) m.port.postMessage({ frame: `echo:${d.frame}` });
      };
    }
  }
  terminate(): void { this.terminated = true; for (const p of this.ports) p.close(); }
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('WebEngine', () => {
  it('opens a session per socket that carries frames both ways', async () => {
    const w = new FakeWorker();
    const engine = new WebEngine({ wasmUrl: 'e.wasm', gatewayUrl: 'ws://gw', createWorker: () => w as unknown as Worker });
    const Socket = engine.socketClass();
    const s = new Socket('web:engine');
    const opened = vi.fn();
    const got: string[] = [];
    s.onopen = opened;
    s.onmessage = (ev) => got.push(String(ev.data));
    await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    expect(s.readyState).toBe(1);
    expect(engine.session()).toBe(1);
    s.send('hello');
    await vi.waitFor(() => expect(got).toEqual(['echo:hello']));
    const closed = vi.fn();
    s.onclose = closed;
    s.close();
    expect(closed).toHaveBeenCalled();
    expect(engine.session()).toBe(0);
  });

  it('crash() fails open sockets and the next socket gets a new engine', async () => {
    const workers: FakeWorker[] = [];
    const engine = new WebEngine({ wasmUrl: 'e.wasm', gatewayUrl: 'ws://gw', createWorker: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; } });
    const Socket = engine.socketClass();
    const a = new Socket('x');
    await vi.waitFor(() => expect(a.readyState).toBe(1));
    const errored = vi.fn();
    const closed = vi.fn();
    a.onerror = errored;
    a.onclose = closed;
    expect(engine.crash()).toBe(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(errored).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
    const b = new Socket('x');
    await vi.waitFor(() => expect(b.readyState).toBe(1));
    expect(workers).toHaveLength(2);
    expect(engine.session()).toBe(2);
  });

  it('a failed start fails the socket and is retried by the next one', async () => {
    let n = 0;
    const engine = new WebEngine({ wasmUrl: 'e.wasm', gatewayUrl: 'ws://gw', createWorker: () => new FakeWorker(n++ === 0) as unknown as Worker });
    const Socket = engine.socketClass();
    const a = new Socket('x');
    const closed = vi.fn();
    a.onclose = closed;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    await tick();
    const b = new Socket('x');
    await vi.waitFor(() => expect(b.readyState).toBe(1));
  });
});
