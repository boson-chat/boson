import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js';
import { argon2id } from 'hash-wasm';

// Argon2id key derivation for the identity envelope (see ./crypto).
//
// WASM (hash-wasm), not pure JS: the previous @noble/hashes implementation
// took ~8.5s per derivation for our parameters (64 MiB, t=3) and ran on the
// renderer's main thread, freezing the UI on every sign-in, unlock and
// recovery. hash-wasm computes the identical RFC 9106 Argon2id output (see
// argon2.test.ts) in ~0.7s, and we run it in a dedicated Web Worker so the UI
// stays responsive. Where Workers don't exist (unit tests, Node-side test
// helpers) it runs inline. Electron's BoringSSL has no native Argon2, so
// there's no faster built-in to defer to.

export interface Argon2Params {
  t: number; // iterations
  m: number; // memory, KiB
  p: number; // parallelism
  dkLen: number; // output bytes
}

export interface Argon2Request {
  id: number;
  password: string;
  salt: Uint8Array;
  params: Argon2Params;
}

export type Argon2Response = { id: number; key: Uint8Array } | { id: number; error: string };

export function argon2idInline(password: string, salt: Uint8Array, params: Argon2Params): Promise<Uint8Array> {
  // hash-wasm refuses an empty password; the pure-JS implementation (the one
  // existing blobs were made with) accepts it. Never hit in practice
  // (passwords are ≥6 chars, recovery codes non-empty) but keeps the KDF
  // total and byte-compatible.
  if (password === '') return Promise.resolve(nobleArgon2id(password, salt, params));
  return argon2id({
    password,
    salt,
    iterations: params.t,
    memorySize: params.m,
    parallelism: params.p,
    hashLength: params.dkLen,
    outputType: 'binary',
  });
}

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (k: Uint8Array) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (ev: MessageEvent<Argon2Response>) => {
    const req = pending.get(ev.data.id);
    if (!req) return;
    pending.delete(ev.data.id);
    if ('key' in ev.data) req.resolve(ev.data.key);
    else req.reject(new Error(ev.data.error));
  };
  worker.onerror = () => {
    // The worker failed to load or crashed: fail over to inline for this and
    // every later derivation rather than leave sign-in hanging.
    workerBroken = true;
    worker?.terminate();
    worker = null;
    const stranded = [...pending.values()];
    pending.clear();
    for (const req of stranded) req.reject(new Error('argon2 worker failed'));
  };
  return worker;
}

export async function argon2idKey(password: string, salt: Uint8Array, params: Argon2Params): Promise<Uint8Array> {
  const w = getWorker();
  if (!w) return argon2idInline(password, salt, params);
  const id = nextId++;
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, password, salt, params } satisfies Argon2Request);
    });
  } catch {
    return argon2idInline(password, salt, params);
  }
}
