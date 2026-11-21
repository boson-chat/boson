/// <reference lib="webworker" />
// The engine's Worker: loads Go's wasm_exec.js glue and engine.wasm
// (engine/cmd/wasm), then serves one engine session per MessagePort the
// page sends (platform/web/engine.ts).
import 'boson-wasm-exec';
import type { EngineWorkerReply, EngineWorkerRequest, SessionMessage } from './engine';

interface GoEngine {
  setGateway(url: string): void;
  open(onFrame: (frame: string) => void, onClosed: () => void): { send(frame: string): void; close(): void };
}

declare const self: DedicatedWorkerGlobalScope & {
  Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> };
  bosonEngine?: GoEngine;
  bosonEngineReady?: () => void;
};

let engine: Promise<GoEngine> | null = null;

function reply(m: EngineWorkerReply): void {
  self.postMessage(m);
}

async function load(wasmUrl: string, gatewayUrl: string): Promise<GoEngine> {
  const go = new self.Go();
  const ready = new Promise<void>((resolve) => { self.bosonEngineReady = resolve; });
  const res = fetch(wasmUrl);
  const { instance } = await WebAssembly.instantiateStreaming(res, go.importObject).catch(async () => {
    // A server that doesn't send application/wasm.
    const buf = await (await fetch(wasmUrl)).arrayBuffer();
    return WebAssembly.instantiate(buf, go.importObject);
  });
  void go.run(instance);
  await ready;
  const e = self.bosonEngine!;
  e.setGateway(gatewayUrl);
  return e;
}

function serve(e: GoEngine, port: MessagePort): void {
  let open = true;
  const session = e.open(
    (frame) => { if (open) port.postMessage({ frame } satisfies SessionMessage); },
    () => {
      if (!open) return;
      open = false;
      port.postMessage({ closed: true } satisfies SessionMessage);
      port.close();
    },
  );
  port.onmessage = (ev: MessageEvent<SessionMessage>) => {
    const m = ev.data;
    if ('frame' in m) session.send(m.frame);
    else if ('closed' in m && open) {
      open = false;
      session.close();
      port.close();
    }
  };
}

self.onmessage = (ev: MessageEvent<EngineWorkerRequest>) => {
  const m = ev.data;
  if (m.type === 'start') {
    engine ??= load(m.wasmUrl, m.gatewayUrl);
    engine.then(() => reply({ type: 'ready' }), (err) => reply({ type: 'failed', error: String(err) }));
  } else if (m.type === 'open') {
    if (!engine) {
      m.port.postMessage({ closed: true } satisfies SessionMessage);
      return;
    }
    void engine.then((e) => serve(e, m.port), () => m.port.postMessage({ closed: true } satisfies SessionMessage));
  }
};
